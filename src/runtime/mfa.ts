// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash, randomBytes } from 'node:crypto';

import { createAesGcmSecretProtector, createRecoveryCodeManager, createTotpManager } from '../core/auth/index.ts';
import type { SessionIdentity } from '../web/security/session-manager.ts';

/**
 * Server-side second-factor gate for the web login.
 *
 * A correct password never creates a web session on its own when the
 * configured policy needs a second factor: `begin()` parks the verified
 * identity in a short-lived, single-use, in-memory challenge, and only
 * `complete` results hand it back so the caller can create the real session.
 * No cookie exists in between, so nothing protected can be reached.
 *
 * Meaning of the policy values (`webAuth.totp` / `webAuth.webauthn`):
 * - `disabled`: never used.
 * - `optional`: not demanded, but once the user has an active factor of that
 *   type it is demanded at every login.
 * - `required`: always demanded; a user without one must enroll it first.
 * When several factors are demanded, ALL of them must be satisfied in the
 * same challenge. A recovery code satisfies exactly one outstanding factor
 * the user has already enrolled; it never replaces an enrollment.
 */

export type MfaFactorType = 'totp' | 'webauthn';
export type MfaPolicyMode = 'disabled' | 'optional' | 'required';

export interface MfaPolicy {
  readonly totp: MfaPolicyMode;
  readonly webauthn: MfaPolicyMode;
  readonly recoveryCodes: boolean;
}

interface FactorMetadata { readonly factorId: string; readonly status?: string; readonly revokedAt?: number; readonly remainingCodes?: number }
interface CredentialMetadata { readonly credentialId: string; readonly revokedAt?: number }
interface StepResult { readonly verified?: boolean; readonly confirmed?: boolean; readonly recovered?: boolean; readonly registered?: boolean }

export interface MfaTotpManager {
  enroll(input: { tenantId: string; userId: string; label?: string }): { readonly factor: FactorMetadata; readonly secret: string; readonly otpauthUri: string };
  confirmEnrollment(input: { factorId: string; tenantId: string; userId: string; code: string }): StepResult;
  verify(input: { factorId: string; tenantId: string; userId: string; code: string }): StepResult;
  listFactorMetadata(input: { tenantId: string; userId: string }): readonly FactorMetadata[];
}

export interface MfaRecoveryManager {
  enroll(input: { tenantId: string; userId: string }): { readonly factor: FactorMetadata; readonly codes: readonly string[] };
  consume(input: { factorId: string; tenantId: string; userId: string; code: string }): StepResult;
  listFactorMetadata(input: { tenantId: string; userId: string }): readonly FactorMetadata[];
}

export interface MfaWebAuthnManager {
  beginRegistration(input: { tenantId: string; userId: string }): unknown;
  completeRegistration(input: Record<string, unknown>): StepResult;
  beginAssertion(input: { tenantId: string; userId: string }): unknown;
  completeAssertion(input: Record<string, unknown>): StepResult;
  listCredentialMetadata(input: { tenantId: string; userId: string }): readonly CredentialMetadata[];
}

export interface MfaGateOptions {
  readonly policy: MfaPolicy;
  readonly clock?: () => Date;
  readonly totp?: MfaTotpManager;
  readonly recovery?: MfaRecoveryManager;
  readonly webauthn?: MfaWebAuthnManager;
  readonly challengeTtlMs?: number;
  readonly maxFailures?: number;
  readonly maxPending?: number;
}

export interface MfaLoginInput {
  readonly identity: SessionIdentity;
  readonly email: string;
  readonly password: string;
  readonly rememberMe: boolean;
}

export interface MfaFactorState {
  readonly type: MfaFactorType;
  readonly required: boolean;
  readonly enrolled: boolean;
  readonly satisfied: boolean;
}

export interface MfaChallenge {
  readonly mfaToken: string;
  readonly expiresAt: string;
  readonly requirement: 'all_listed_factors';
  readonly factors: readonly MfaFactorState[];
  readonly recoveryAvailable: boolean;
}

export type MfaBeginResult = { readonly required: false } | { readonly required: true; readonly challenge: MfaChallenge };

export type MfaStepResult =
  | { readonly status: 'invalid' }
  | { readonly status: 'not_allowed' }
  | { readonly status: 'failed' }
  | { readonly status: 'pending'; readonly challenge: MfaChallenge; readonly recoveryCodes?: readonly string[] }
  | { readonly status: 'complete'; readonly login: MfaLoginInput; readonly recoveryCodes?: readonly string[] };

export class MfaUnavailableError extends Error {
  readonly code = 'MFA_UNAVAILABLE';
  constructor(message: string) {
    super(`MFA unavailable: ${message}`);
    this.name = 'MfaUnavailableError';
  }
}

interface PendingLogin {
  readonly token: string;
  readonly login: MfaLoginInput;
  readonly tenantId: string;
  readonly userId: string;
  readonly expiresAt: number;
  readonly needs: ReadonlySet<MfaFactorType>;
  readonly required: ReadonlySet<MfaFactorType>;
  readonly enrolled: Set<MfaFactorType>;
  readonly satisfied: Set<MfaFactorType>;
  failures: number;
  totpEnrollmentFactorId?: string;
  recoveryIssued: boolean;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_MAX_PENDING = 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9._:@/-]{0,127}$/u;
const FACTOR_TYPES: readonly MfaFactorType[] = ['totp', 'webauthn'];
const WEBAUTHN_REGISTRATION_FIELDS = ['challenge', 'credentialId', 'clientDataJSON', 'authenticatorData', 'credentialPublicKey', 'signature', 'attestationObject', 'label', 'transports'] as const;
const WEBAUTHN_ASSERTION_FIELDS = ['challenge', 'credentialId', 'clientDataJSON', 'authenticatorData', 'signature'] as const;

/**
 * The auth managers only accept lowercase ids of a restricted alphabet, while
 * identity sources may return others (underscores, upper case, ...). Ids that
 * already fit are used as is; any other id maps to a stable hash, so an unusual
 * user id can never make a login fail or share a factor scope.
 */
function mfaScopeId(value: string): string {
  const lowered = value.toLowerCase();
  return SCOPE_ID_PATTERN.test(lowered) ? lowered : `x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) if (source[field] !== undefined) result[field] = source[field];
  return result;
}

export function createMfaGate({
  policy,
  clock = () => new Date(),
  totp,
  recovery,
  webauthn,
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
  maxPending = DEFAULT_MAX_PENDING,
}: MfaGateOptions) {
  const pending = new Map<string, PendingLogin>();
  const managers = { totp, webauthn };
  const recoveryEnabled = policy.recoveryCodes && recovery !== undefined;

  function now(): number {
    return clock().getTime();
  }

  function purgeExpired(): void {
    const current = now();
    for (const [token, entry] of pending) if (entry.expiresAt <= current) pending.delete(token);
  }

  function lookup(token: unknown): PendingLogin | null {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const entry = pending.get(token);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now()) {
      pending.delete(token);
      return null;
    }
    return entry;
  }

  function activeTotpFactor(entry: PendingLogin): FactorMetadata | undefined {
    return totp?.listFactorMetadata({ tenantId: entry.tenantId, userId: entry.userId }).find((factor) => factor.status === 'active');
  }

  function activeRecoveryFactor(entry: PendingLogin): FactorMetadata | undefined {
    return recovery?.listFactorMetadata({ tenantId: entry.tenantId, userId: entry.userId })
      .find((factor) => factor.revokedAt === undefined && (factor.remainingCodes ?? 0) > 0);
  }

  function isEnrolled(type: MfaFactorType, tenantId: string, userId: string): boolean {
    if (type === 'totp') return (totp?.listFactorMetadata({ tenantId, userId }) ?? []).some((factor) => factor.status === 'active');
    return (webauthn?.listCredentialMetadata({ tenantId, userId }) ?? []).some((credential) => credential.revokedAt === undefined);
  }

  function challengeView(entry: PendingLogin): MfaChallenge {
    return Object.freeze({
      mfaToken: entry.token,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      requirement: 'all_listed_factors' as const,
      factors: Object.freeze(FACTOR_TYPES.filter((type) => entry.needs.has(type)).map((type) => Object.freeze({
        type,
        required: entry.required.has(type),
        enrolled: entry.enrolled.has(type),
        satisfied: entry.satisfied.has(type),
      }))),
      recoveryAvailable: recoveryEnabled && activeRecoveryFactor(entry) !== undefined,
    });
  }

  /** First-factor bootstrap: a new factor may only be added once every factor the user already has is satisfied in this challenge. */
  function mayEnroll(entry: PendingLogin, type: MfaFactorType): boolean {
    return entry.needs.has(type) && !entry.enrolled.has(type) && [...entry.enrolled].every((enrolled) => entry.satisfied.has(enrolled));
  }

  function issueRecoveryCodes(entry: PendingLogin): readonly string[] | undefined {
    if (!recoveryEnabled || recovery === undefined || entry.recoveryIssued || activeRecoveryFactor(entry) !== undefined) return undefined;
    entry.recoveryIssued = true;
    return recovery.enroll({ tenantId: entry.tenantId, userId: entry.userId }).codes;
  }

  function failure(entry: PendingLogin): MfaStepResult {
    entry.failures += 1;
    if (entry.failures >= maxFailures) pending.delete(entry.token);
    return { status: 'failed' };
  }

  function advance(entry: PendingLogin, recoveryCodes?: readonly string[]): MfaStepResult {
    const outstanding = [...entry.needs].some((type) => !entry.satisfied.has(type));
    if (outstanding) {
      return recoveryCodes === undefined
        ? { status: 'pending', challenge: challengeView(entry) }
        : { status: 'pending', challenge: challengeView(entry), recoveryCodes };
    }
    pending.delete(entry.token);
    return recoveryCodes === undefined
      ? { status: 'complete', login: entry.login }
      : { status: 'complete', login: entry.login, recoveryCodes };
  }

  function begin(login: MfaLoginInput): MfaBeginResult {
    purgeExpired();
    const tenantId = mfaScopeId(login.identity.tenantId);
    const userId = mfaScopeId(login.identity.userId);
    const needs = new Set<MfaFactorType>();
    const required = new Set<MfaFactorType>();
    const enrolled = new Set<MfaFactorType>();
    try {
      for (const type of FACTOR_TYPES) {
        const mode = policy[type];
        if (mode === 'disabled') continue;
        const manager = managers[type];
        if (manager === undefined) {
          if (mode === 'required') throw new MfaUnavailableError(`${type} is required but no verifier is configured`);
          continue;
        }
        const has = isEnrolled(type, tenantId, userId);
        if (has) enrolled.add(type);
        if (mode === 'required') required.add(type);
        if (mode === 'required' || has) needs.add(type);
      }
    } catch (error) {
      if (error instanceof MfaUnavailableError) throw error;
      throw new MfaUnavailableError('factor state could not be read');
    }
    if (needs.size === 0) return { required: false };
    if (pending.size >= maxPending) throw new MfaUnavailableError('too many pending challenges');
    const token = randomBytes(32).toString('base64url');
    const entry: PendingLogin = {
      token, login, tenantId, userId, expiresAt: now() + challengeTtlMs,
      needs, required, enrolled, satisfied: new Set(), failures: 0, recoveryIssued: false,
    };
    pending.set(token, entry);
    return { required: true, challenge: challengeView(entry) };
  }

  function enrollTotp(token: unknown): { status: 'invalid' | 'not_allowed' } | { status: 'ok'; factorId: string; secret: string; otpauthUri: string } {
    const entry = lookup(token);
    if (entry === null) return { status: 'invalid' };
    if (totp === undefined || !mayEnroll(entry, 'totp')) return { status: 'not_allowed' };
    try {
      const enrollment = totp.enroll({ tenantId: entry.tenantId, userId: entry.userId });
      entry.totpEnrollmentFactorId = enrollment.factor.factorId;
      return { status: 'ok', factorId: enrollment.factor.factorId, secret: enrollment.secret, otpauthUri: enrollment.otpauthUri };
    } catch {
      return { status: 'not_allowed' };
    }
  }

  function verifyTotp(token: unknown, code: unknown): MfaStepResult {
    const entry = lookup(token);
    if (entry === null) return { status: 'invalid' };
    if (totp === undefined || !entry.needs.has('totp') || entry.satisfied.has('totp') || typeof code !== 'string') return { status: 'not_allowed' };
    try {
      if (entry.enrolled.has('totp')) {
        const factor = activeTotpFactor(entry);
        if (factor === undefined) return failure(entry);
        const result = totp.verify({ factorId: factor.factorId, tenantId: entry.tenantId, userId: entry.userId, code });
        if (result.verified !== true) return failure(entry);
        entry.satisfied.add('totp');
        return advance(entry);
      }
      if (entry.totpEnrollmentFactorId === undefined || !mayEnroll(entry, 'totp')) return { status: 'not_allowed' };
      const result = totp.confirmEnrollment({ factorId: entry.totpEnrollmentFactorId, tenantId: entry.tenantId, userId: entry.userId, code });
      if (result.confirmed !== true) return failure(entry);
      entry.enrolled.add('totp');
      entry.satisfied.add('totp');
      return advance(entry, issueRecoveryCodes(entry));
    } catch {
      return failure(entry);
    }
  }

  function verifyRecovery(token: unknown, code: unknown): MfaStepResult {
    const entry = lookup(token);
    if (entry === null) return { status: 'invalid' };
    if (!recoveryEnabled || recovery === undefined || typeof code !== 'string') return { status: 'not_allowed' };
    // A recovery code only stands in for a factor the user already has; it can never replace an enrollment.
    const target = FACTOR_TYPES.find((type) => entry.needs.has(type) && entry.enrolled.has(type) && !entry.satisfied.has(type));
    if (target === undefined) return { status: 'not_allowed' };
    try {
      const factor = activeRecoveryFactor(entry);
      if (factor === undefined) return failure(entry);
      const result = recovery.consume({ factorId: factor.factorId, tenantId: entry.tenantId, userId: entry.userId, code });
      if (result.recovered !== true) return failure(entry);
      entry.satisfied.add(target);
      return advance(entry);
    } catch {
      return failure(entry);
    }
  }

  function webauthnOptions(token: unknown): { status: 'invalid' | 'not_allowed' } | { status: 'ok'; ceremony: 'assertion' | 'registration'; options: unknown } {
    const entry = lookup(token);
    if (entry === null) return { status: 'invalid' };
    if (webauthn === undefined || !entry.needs.has('webauthn') || entry.satisfied.has('webauthn')) return { status: 'not_allowed' };
    try {
      if (entry.enrolled.has('webauthn')) {
        return { status: 'ok', ceremony: 'assertion', options: webauthn.beginAssertion({ tenantId: entry.tenantId, userId: entry.userId }) };
      }
      if (!mayEnroll(entry, 'webauthn')) return { status: 'not_allowed' };
      return { status: 'ok', ceremony: 'registration', options: webauthn.beginRegistration({ tenantId: entry.tenantId, userId: entry.userId }) };
    } catch {
      return { status: 'not_allowed' };
    }
  }

  function webauthnComplete(token: unknown, body: Record<string, unknown>): MfaStepResult {
    const entry = lookup(token);
    if (entry === null) return { status: 'invalid' };
    if (webauthn === undefined || !entry.needs.has('webauthn') || entry.satisfied.has('webauthn')) return { status: 'not_allowed' };
    try {
      const scope = { tenantId: entry.tenantId, userId: entry.userId };
      if (entry.enrolled.has('webauthn')) {
        const result = webauthn.completeAssertion({ ...pick(body, WEBAUTHN_ASSERTION_FIELDS), ...scope });
        if (result.verified !== true) return failure(entry);
        entry.satisfied.add('webauthn');
        return advance(entry);
      }
      if (!mayEnroll(entry, 'webauthn')) return { status: 'not_allowed' };
      const result = webauthn.completeRegistration({ ...pick(body, WEBAUTHN_REGISTRATION_FIELDS), ...scope });
      if (result.registered !== true) return failure(entry);
      entry.enrolled.add('webauthn');
      entry.satisfied.add('webauthn');
      return advance(entry, issueRecoveryCodes(entry));
    } catch {
      return failure(entry);
    }
  }

  return Object.freeze({
    begin,
    enrollTotp,
    verifyTotp,
    verifyRecovery,
    webauthnOptions,
    webauthnComplete,
    get pendingCount() { return pending.size; },
  });
}

export type MfaGate = ReturnType<typeof createMfaGate>;

/** Reads `webAuth` from the loaded configuration; absent values keep the schema defaults. */
export function mfaPolicyFromConfig(config: unknown): MfaPolicy {
  const record = config !== null && typeof config === 'object' ? config as Record<string, unknown> : {};
  const contract = record.contract !== null && typeof record.contract === 'object' ? record.contract as Record<string, unknown> : record;
  const webAuth = contract.webAuth !== null && typeof contract.webAuth === 'object' ? contract.webAuth as Record<string, unknown> : {};
  const mode = (value: unknown): MfaPolicyMode => (value === 'disabled' || value === 'required' ? value : 'optional');
  return Object.freeze({ totp: mode(webAuth.totp), webauthn: mode(webAuth.webauthn), recoveryCodes: webAuth.recoveryCodes !== false });
}

// The auth managers are `@ts-nocheck` modules whose inferred option types omit
// parameters without a default (`secretProtector`, `key`); these narrow casts
// restore the real option shapes for typed callers.
type ManagerOptions = Record<string, unknown>;

/** In-memory TOTP manager whose secrets are sealed with the given 32-byte AES-GCM key. */
export function createInMemoryTotpManager({ clock, key }: { clock: () => number; key: Buffer }): MfaTotpManager {
  const protector = (createAesGcmSecretProtector as unknown as (options: ManagerOptions) => unknown)({ key });
  return (createTotpManager as unknown as (options: ManagerOptions) => MfaTotpManager)({ clock, secretProtector: protector });
}

/** In-memory one-time recovery-code manager. */
export function createInMemoryRecoveryManager({ clock }: { clock: () => number }): MfaRecoveryManager {
  return (createRecoveryCodeManager as unknown as (options: ManagerOptions) => MfaRecoveryManager)({ clock });
}

/**
 * Default runtime gate: in-memory TOTP and recovery-code stores under an
 * ephemeral secret key, so enrolled factors do not survive a restart. WebAuthn
 * needs a `credentialVerifier` (CBOR/COSE) that this repository does not ship,
 * so it is only active when a manager is injected; a `required` WebAuthn
 * policy without one fails closed at login.
 */
export function createDefaultMfaGate({ config, clock, webauthn }: { config: unknown; clock?: () => Date; webauthn?: MfaWebAuthnManager }): MfaGate {
  const policy = mfaPolicyFromConfig(config);
  const clockFn = clock ?? (() => new Date());
  const totpClock = () => clockFn().getTime();
  return createMfaGate({
    policy,
    clock: clockFn,
    ...(policy.totp === 'disabled' ? {} : {
      totp: createInMemoryTotpManager({ clock: totpClock, key: randomBytes(32) }),
    }),
    ...(policy.recoveryCodes ? { recovery: createInMemoryRecoveryManager({ clock: totpClock }) } : {}),
    ...(webauthn === undefined || policy.webauthn === 'disabled' ? {} : { webauthn }),
  });
}
