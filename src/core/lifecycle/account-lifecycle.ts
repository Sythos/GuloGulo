// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID } from 'node:crypto';

/**
 * Account deletion lifecycle contract. This is an auditable state machine, not
 * a destructive account deleter; adapters own permanent resource deletion.
 */
export const ACCOUNT_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_ACCOUNT_RECOVERY_DAYS = 28;
export const ACCOUNT_STATES = Object.freeze({
  ACTIVE: 'active',
  DELETION_REQUESTED: 'deletion_requested',
  SOFT_DELETED: 'soft_deleted',
  PURGE_PENDING: 'purge_pending',
  PURGED: 'purged',
} as const);
export const ACCOUNT_RESOURCE_TYPES = Object.freeze([
  'aliases', 'delegations', 'factors', 'backups', 'mailbox', 'dav_collections', 'preferences',
] as const);

export type AccountState = typeof ACCOUNT_STATES[keyof typeof ACCOUNT_STATES];
export type AccountResourceType = typeof ACCOUNT_RESOURCE_TYPES[number];
export type DateInput = Date | string | number;
export interface AccountScope { readonly tenantId: string; readonly userId: string; }
export interface AccountAuditEvent extends AccountScope {
  readonly schemaVersion: typeof ACCOUNT_LIFECYCLE_SCHEMA_VERSION;
  readonly event: string; readonly occurredAt: string; readonly actorId: string; readonly actorRole: string;
  readonly operationId?: string; readonly metadata: Readonly<Record<string, unknown>>;
}
export interface PublicAccount extends AccountScope {
  readonly schemaVersion: typeof ACCOUNT_LIFECYCLE_SCHEMA_VERSION; readonly accountType: string; readonly state: AccountState;
  readonly createdAt: string; readonly deletionRequestedAt: string | null; readonly softDeletedAt: string | null;
  readonly recoveryUntil: string | null; readonly purgeQueuedAt: string | null; readonly purgedAt: string | null;
  readonly cleanupPlan: readonly AccountResourceType[]; readonly activeHoldIds: readonly string[]; readonly deletionRequestId: string | null;
}
export interface AccountOperation {
  readonly schemaVersion: typeof ACCOUNT_LIFECYCLE_SCHEMA_VERSION; readonly operation: string; readonly account: PublicAccount;
  readonly audit?: AccountAuditEvent; readonly requestId?: string; readonly operationId?: string; readonly holdId?: string; readonly idempotent?: boolean;
}

type UnknownRecord = Record<string, unknown>;
type AccountHold = { readonly holdId: string; readonly reasonCode: string; readonly addedAt: string };
type AccountRecord = {
  tenantId: string; userId: string; accountType: string; state: AccountState; createdAt: string;
  deletionRequestedAt: string | null; softDeletedAt: string | null; recoveryUntil: string | null;
  purgeQueuedAt: string | null; purgedAt: string | null; cleanupPlan: AccountResourceType[];
  holds: Map<string, AccountHold>; deletionRequestId: string | null;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON_PATTERN = /^[^\r\n]{1,256}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

export function accountError(message: string, code = 'ACCOUNT_LIFECYCLE_ERROR'): Error & { code: string } {
  const error = new Error(`Account lifecycle error: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}
function isObject(value: unknown): value is UnknownRecord { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function assertObject(value: unknown, field: string): UnknownRecord { if (!isObject(value)) throw accountError(`${field} must be an object`, 'INVALID_INPUT'); return value; }
function assertId(value: unknown, field: string): string { if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw accountError(`${field} is invalid`, 'INVALID_IDENTITY'); return value; }
function assertOperationId(value: unknown, field = 'operationId'): string { if (typeof value !== 'string' || !OPERATION_PATTERN.test(value)) throw accountError(`${field} is invalid`, 'INVALID_OPERATION_ID'); return value; }
function assertReason(value: unknown, field = 'reason'): string { if (typeof value !== 'string' || !REASON_PATTERN.test(value)) throw accountError(`${field} must be a single-line value of 1-256 characters`, 'INVALID_REASON'); return value; }
function parseDate(value: unknown, field: string, fallback?: DateInput): Date {
  const candidate = value === undefined ? fallback : value;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate as string | number);
  if (Number.isNaN(date.getTime())) throw accountError(`${field} is invalid`, 'INVALID_TIMESTAMP');
  return date;
}
function iso(value: unknown, field: string, fallback?: DateInput): string { return parseDate(value, field, fallback).toISOString(); }
function assertRecoveryDays(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 3650) throw accountError('recoveryDays must be an integer between 1 and 3650', 'INVALID_RECOVERY_POLICY');
  return value as number;
}
function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => deepFreeze(item))) as unknown as Readonly<T>;
  if (isObject(value)) { const copy: UnknownRecord = {}; for (const [key, item] of Object.entries(value)) copy[key] = deepFreeze(item); return Object.freeze(copy) as Readonly<T>; }
  return value;
}
function normalizeActor(actor: unknown, fallbackId?: string): Readonly<{ actorId: string; role: string }> {
  if (actor === undefined) return Object.freeze({ actorId: fallbackId ?? 'account-lifecycle', role: fallbackId ? 'user' : 'system' });
  const input = assertObject(actor, 'actor');
  return Object.freeze({ actorId: assertId(input.actorId, 'actor.actorId'), role: assertId(input.role ?? 'system', 'actor.role') });
}
function accountKey(tenantId: string, userId: string): string { return `${tenantId}\u0000${userId}`; }
export function confirmationFor(userId: string): string { return `DELETE:${userId}`; }
function publicAccount(account: AccountRecord): PublicAccount {
  return deepFreeze({ schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION, tenantId: account.tenantId, userId: account.userId, accountType: account.accountType, state: account.state, createdAt: account.createdAt, deletionRequestedAt: account.deletionRequestedAt, softDeletedAt: account.softDeletedAt, recoveryUntil: account.recoveryUntil, purgeQueuedAt: account.purgeQueuedAt, purgedAt: account.purgedAt, cleanupPlan: [...account.cleanupPlan], activeHoldIds: [...account.holds.keys()], deletionRequestId: account.deletionRequestId });
}
function createAuditEvent({ event, account, actor, occurredAt, operationId, metadata = {} }: { event: string; account: AccountRecord; actor: { actorId: string; role: string }; occurredAt: unknown; operationId?: string; metadata?: UnknownRecord }): AccountAuditEvent {
  return deepFreeze({ schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION, event, occurredAt: iso(occurredAt, 'occurredAt'), tenantId: account.tenantId, userId: account.userId, actorId: actor.actorId, actorRole: actor.role, ...(operationId ? { operationId } : {}), metadata });
}
function normalizeCleanupPlan(plan: unknown): AccountResourceType[] {
  const selected: unknown[] = plan === undefined ? [...ACCOUNT_RESOURCE_TYPES] : Array.isArray(plan) ? plan : [];
  if (selected.length === 0) throw accountError('cleanupPlan must be a non-empty list', 'INVALID_CLEANUP_PLAN');
  const unique = [...new Set(selected)];
  if (unique.some((item) => typeof item !== 'string' || !(ACCOUNT_RESOURCE_TYPES as readonly string[]).includes(item))) throw accountError('cleanupPlan contains an unsupported resource type', 'INVALID_CLEANUP_PLAN');
  return unique as AccountResourceType[];
}
function normalizeResourceResults(account: AccountRecord, value: unknown): Readonly<Record<AccountResourceType, 'purged'>> {
  const input = assertObject(value, 'resourceResults'); const result = {} as Record<AccountResourceType, 'purged'>;
  for (const resource of account.cleanupPlan) { if (input[resource] !== 'purged') throw accountError(`resource purge is incomplete: ${resource}`, 'PURGE_INCOMPLETE'); result[resource] = 'purged'; }
  return result;
}
function requireState(account: AccountRecord, expected: AccountState): void { if (account.state !== expected) throw accountError(`account must be ${expected}, not ${account.state}`, 'INVALID_STATE_TRANSITION'); }
function assertAccountScope(input: unknown): AccountScope { const scope = assertObject(input, 'scope'); return { tenantId: assertId(scope.tenantId, 'tenantId'), userId: assertId(scope.userId, 'userId') }; }

export interface AccountLifecycleStore {
  readonly recoveryDays: number; registerAccount(input?: UnknownRecord): AccountOperation; requestDeletion(input?: UnknownRecord): AccountOperation; softDeleteAccount(input?: UnknownRecord): AccountOperation; restoreAccount(input?: UnknownRecord): AccountOperation; addAccountHold(input?: UnknownRecord): AccountOperation; releaseAccountHold(input?: UnknownRecord): AccountOperation; queuePurge(input?: UnknownRecord): AccountOperation; completePurge(input?: UnknownRecord): AccountOperation; getAccount(scope: AccountScope): PublicAccount; getAuditEvents(input?: UnknownRecord): readonly AccountAuditEvent[]; exportState(): Readonly<{ schemaVersion: typeof ACCOUNT_LIFECYCLE_SCHEMA_VERSION; recoveryDays: number; accounts: readonly PublicAccount[] }>; confirmationFor(userId: string): string;
}
export function createAccountLifecycleStore({ now = () => new Date(), recoveryDays = DEFAULT_ACCOUNT_RECOVERY_DAYS }: { now?: () => DateInput; recoveryDays?: number } = {}): AccountLifecycleStore {
  if (typeof now !== 'function') throw accountError('now must be a function', 'INVALID_CLOCK');
  const defaultRecoveryDays = assertRecoveryDays(recoveryDays); const accounts = new Map<string, AccountRecord>(); const operationResults = new Map<string, AccountOperation>(); const auditEvents: AccountAuditEvent[] = [];
  const currentDate = (): Date => parseDate(now(), 'clock');
  const requireAccount = (scope: unknown): { normalized: AccountScope; account: AccountRecord } => { const normalized = assertAccountScope(scope); const account = accounts.get(accountKey(normalized.tenantId, normalized.userId)); if (!account) throw accountError('account does not exist', 'ACCOUNT_NOT_FOUND'); return { normalized, account }; };
  const appendAudit = (event: AccountAuditEvent): AccountAuditEvent => { auditEvents.push(event); return event; };
  const result = (operation: string, account: AccountRecord, audit?: AccountAuditEvent, extra: UnknownRecord = {}): AccountOperation => deepFreeze({ schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION, operation, account: publicAccount(account), ...(audit ? { audit } : {}), ...extra });
  const registerAccount = (input: UnknownRecord = {}): AccountOperation => {
    const scope = assertAccountScope(input); const type = assertId(input.accountType ?? 'user', 'accountType'); const key = accountKey(scope.tenantId, scope.userId); if (accounts.has(key)) throw accountError('account already exists', 'ACCOUNT_EXISTS');
    const account: AccountRecord = { ...scope, accountType: type, state: ACCOUNT_STATES.ACTIVE, createdAt: iso(input.createdAt, 'createdAt', currentDate()), deletionRequestedAt: null, softDeletedAt: null, recoveryUntil: null, purgeQueuedAt: null, purgedAt: null, cleanupPlan: normalizeCleanupPlan(input.cleanupPlan), holds: new Map(), deletionRequestId: null }; accounts.set(key, account);
    const audit = appendAudit(createAuditEvent({ event: 'account.registered', account, actor: normalizeActor(input.actor, scope.userId), occurredAt: input.createdAt ?? currentDate(), metadata: { accountType: type, cleanupPlan: account.cleanupPlan } })); return result('account_registered', account, audit);
  };
  const requestDeletion = (input: UnknownRecord = {}): AccountOperation => {
    const scope = assertAccountScope(input); const request = assertOperationId(input.requestId ?? randomUUID(), 'requestId'); const key = `request\u0000${scope.tenantId}\u0000${scope.userId}\u0000${request}`; const prior = operationResults.get(key); if (prior) return prior; if (input.confirmation !== confirmationFor(scope.userId)) throw accountError('strong deletion confirmation is required', 'STRONG_CONFIRMATION_REQUIRED');
    const actor = normalizeActor(input.actor, scope.userId); const reason = assertReason(input.reason ?? 'user_requested'); const days = assertRecoveryDays(input.recoveryDays ?? defaultRecoveryDays); const date = parseDate(input.requestedAt, 'requestedAt', currentDate()); const { account } = requireAccount(scope); requireState(account, ACCOUNT_STATES.ACTIVE); if (account.holds.size > 0) throw accountError('account has an active hold', 'ACCOUNT_ON_HOLD'); account.state = ACCOUNT_STATES.DELETION_REQUESTED; account.deletionRequestedAt = date.toISOString(); account.recoveryUntil = new Date(date.getTime() + days * DAY_MS).toISOString(); account.cleanupPlan = normalizeCleanupPlan(input.cleanupPlan ?? account.cleanupPlan); account.deletionRequestId = request;
    const audit = appendAudit(createAuditEvent({ event: 'account.deletion_requested', account, actor, occurredAt: date, operationId: request, metadata: { reason, recoveryUntil: account.recoveryUntil, recoveryDays: days, cleanupPlan: account.cleanupPlan } })); const output = result('deletion_requested', account, audit, { requestId: request }); operationResults.set(key, output); return output;
  };
  const softDeleteAccount = (input: UnknownRecord = {}): AccountOperation => {
    const scope = assertAccountScope(input); const { account } = requireAccount(scope); requireState(account, ACCOUNT_STATES.DELETION_REQUESTED); if (input.confirmation !== confirmationFor(scope.userId)) throw accountError('strong deletion confirmation is required', 'STRONG_CONFIRMATION_REQUIRED'); if (input.requestId !== undefined && input.requestId !== account.deletionRequestId) throw accountError('requestId does not match the pending deletion', 'DELETION_REQUEST_MISMATCH'); const date = parseDate(input.deletedAt, 'deletedAt', currentDate()); account.state = ACCOUNT_STATES.SOFT_DELETED; account.softDeletedAt = date.toISOString();
    const audit = appendAudit(createAuditEvent({ event: 'account.soft_deleted', account, actor: normalizeActor(input.actor, scope.userId), occurredAt: date, operationId: account.deletionRequestId ?? undefined, metadata: { recoveryUntil: account.recoveryUntil, cleanupPlan: account.cleanupPlan } })); return result('soft_deleted', account, audit);
  };
  const restoreAccount = (input: UnknownRecord = {}): AccountOperation => {
    const scope = assertAccountScope(input); const id = assertOperationId(input.operationId ?? randomUUID()); const key = `restore\u0000${scope.tenantId}\u0000${scope.userId}\u0000${id}`; const prior = operationResults.get(key); if (prior) return prior; const { account } = requireAccount(scope); if (account.state !== ACCOUNT_STATES.DELETION_REQUESTED && account.state !== ACCOUNT_STATES.SOFT_DELETED && account.state !== ACCOUNT_STATES.PURGE_PENDING) throw accountError('account is not recoverable in its current state', 'ACCOUNT_NOT_RECOVERABLE'); const date = parseDate(input.restoredAt, 'restoredAt', currentDate()); if (account.recoveryUntil && date.getTime() > new Date(account.recoveryUntil).getTime()) throw accountError('the account recovery window has elapsed', 'RECOVERY_WINDOW_EXPIRED'); account.state = ACCOUNT_STATES.ACTIVE; account.recoveryUntil = null; account.purgeQueuedAt = null; account.deletionRequestedAt = null; account.softDeletedAt = null; account.deletionRequestId = null;
    const audit = appendAudit(createAuditEvent({ event: 'account.restored', account, actor: normalizeActor(input.actor, scope.userId), occurredAt: date, operationId: id, metadata: { reason: assertReason(input.reason ?? 'account_recovery') } })); const output = result('account_restored', account, audit, { operationId: id }); operationResults.set(key, output); return output;
  };
  const addAccountHold = (input: UnknownRecord = {}): AccountOperation => { const scope = assertAccountScope(input); const holdId = assertOperationId(input.holdId, 'holdId'); const reason = assertReason(input.reasonCode ?? 'administrative_hold', 'reasonCode'); const { account } = requireAccount(scope); if (account.holds.has(holdId)) return result('account_hold_added', account, undefined, { holdId, idempotent: true }); account.holds.set(holdId, { holdId, reasonCode: reason, addedAt: iso(input.addedAt, 'addedAt', currentDate()) }); const audit = appendAudit(createAuditEvent({ event: 'account.hold_added', account, actor: normalizeActor(input.actor), occurredAt: input.addedAt ?? currentDate(), metadata: { holdId, reasonCode: reason } })); return result('account_hold_added', account, audit, { holdId }); };
  const releaseAccountHold = (input: UnknownRecord = {}): AccountOperation => { const scope = assertAccountScope(input); const holdId = assertOperationId(input.holdId, 'holdId'); const { account } = requireAccount(scope); if (!account.holds.delete(holdId)) return result('account_hold_released', account, undefined, { holdId, idempotent: true }); const audit = appendAudit(createAuditEvent({ event: 'account.hold_released', account, actor: normalizeActor(input.actor), occurredAt: input.releasedAt ?? currentDate(), metadata: { holdId } })); return result('account_hold_released', account, audit, { holdId }); };
  const queuePurge = (input: UnknownRecord = {}): AccountOperation => {
    const scope = assertAccountScope(input); const id = assertOperationId(input.operationId ?? randomUUID()); const key = `queue\u0000${scope.tenantId}\u0000${scope.userId}\u0000${id}`; const prior = operationResults.get(key); if (prior) return prior; const { account } = requireAccount(scope); requireState(account, ACCOUNT_STATES.SOFT_DELETED); const date = parseDate(input.queuedAt, 'queuedAt', currentDate()); if (!account.recoveryUntil || date.getTime() < new Date(account.recoveryUntil).getTime()) throw accountError('the account recovery window has not elapsed', 'RECOVERY_WINDOW_ACTIVE'); if (account.holds.size > 0) throw accountError('account has an active hold', 'ACCOUNT_ON_HOLD'); account.state = ACCOUNT_STATES.PURGE_PENDING; account.purgeQueuedAt = date.toISOString(); const audit = appendAudit(createAuditEvent({ event: 'account.purge_queued', account, actor: normalizeActor(input.actor), occurredAt: date, operationId: id, metadata: { cleanupPlan: account.cleanupPlan } })); const output = result('purge_queued', account, audit, { operationId: id }); operationResults.set(key, output); return output;
  };
  const completePurge = (input: UnknownRecord = {}): AccountOperation => {
    const scope = assertAccountScope(input); const id = assertOperationId(input.operationId ?? randomUUID()); const key = `complete\u0000${scope.tenantId}\u0000${scope.userId}\u0000${id}`; const prior = operationResults.get(key); if (prior) return prior; const { account } = requireAccount(scope); requireState(account, ACCOUNT_STATES.PURGE_PENDING); if (input.confirmation !== `PURGE:${scope.userId}`) throw accountError('strong purge confirmation is required', 'STRONG_CONFIRMATION_REQUIRED'); if (account.holds.size > 0) throw accountError('account has an active hold', 'ACCOUNT_ON_HOLD'); const resourceResults = normalizeResourceResults(account, input.resourceResults ?? {}); const date = parseDate(input.completedAt, 'completedAt', currentDate()); account.state = ACCOUNT_STATES.PURGED; account.purgedAt = date.toISOString(); const audit = appendAudit(createAuditEvent({ event: 'account.purged', account, actor: normalizeActor(input.actor), occurredAt: date, operationId: id, metadata: { cleanupPlan: account.cleanupPlan, resourceResults } })); const output = result('account_purged', account, audit, { operationId: id }); operationResults.set(key, output); return output;
  };
  const getAccount = (scope: AccountScope): PublicAccount => publicAccount(requireAccount(scope).account);
  const getAuditEvents = (input: UnknownRecord = {}): readonly AccountAuditEvent[] => { const tenant = input.tenantId === undefined ? undefined : assertId(input.tenantId, 'tenantId'); const user = input.userId === undefined ? undefined : assertId(input.userId, 'userId'); if (user && !tenant) throw accountError('tenantId is required with userId', 'INVALID_SCOPE'); if (input.event !== undefined && (typeof input.event !== 'string' || !/^account\.[a-z_]+$/u.test(input.event))) throw accountError('event is invalid', 'INVALID_AUDIT_FILTER'); return deepFreeze(auditEvents.filter((entry) => (tenant === undefined || entry.tenantId === tenant) && (user === undefined || entry.userId === user) && (input.event === undefined || entry.event === input.event))); };
  const exportState = (): Readonly<{ schemaVersion: typeof ACCOUNT_LIFECYCLE_SCHEMA_VERSION; recoveryDays: number; accounts: readonly PublicAccount[] }> => deepFreeze({ schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION, recoveryDays: defaultRecoveryDays, accounts: [...accounts.values()].map(publicAccount) });
  return Object.freeze({ recoveryDays: defaultRecoveryDays, registerAccount, requestDeletion, softDeleteAccount, restoreAccount, addAccountHold, releaseAccountHold, queuePurge, completePurge, getAccount, getAuditEvents, exportState, confirmationFor });
}
