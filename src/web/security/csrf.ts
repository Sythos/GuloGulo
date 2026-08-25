// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

import { WebSecurityError, type WebSession } from './session-manager.ts';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_OUTSTANDING = 32;

export const CSRF_HEADER_NAME = 'x-csrf-token';

interface TokenRecord {
  readonly digest: Buffer;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CsrfManagerOptions {
  clock?: () => number | Date;
  randomBytesFn?: (size: number) => Buffer;
  tokenTtlMs?: number;
  maxOutstandingTokens?: number;
  isSessionActive?: (sessionId: string) => boolean;
}

function securityError(message: string, code = 'WEB_SECURITY_ERROR'): WebSecurityError {
  return new WebSecurityError(message, code);
}

function readClock(clock: () => number | Date): number {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0) throw securityError('clock must return a valid time', 'INVALID_CLOCK');
  return Math.trunc(time);
}

function assertTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TOKEN_TTL_MS) {
    throw securityError('tokenTtlMs must be between 1 millisecond and 1 hour', 'INVALID_TTL');
  }
  return ttlMs;
}

function assertSession(session: unknown): WebSession {
  if (session === null || typeof session !== 'object') throw securityError('an authenticated session is required', 'SESSION_INVALID');
  const candidate = session as Partial<WebSession>;
  if (typeof candidate.sessionId !== 'string' || !SESSION_ID_PATTERN.test(candidate.sessionId) || typeof candidate.expiresAt !== 'number') {
    throw securityError('an authenticated session is required', 'SESSION_INVALID');
  }
  return candidate as WebSession;
}

function digestToken(token: string): Buffer { return createHash('sha256').update(token, 'ascii').digest(); }

export function createCsrfManager(options: CsrfManagerOptions = {}) {
  const {
    clock = () => Date.now(), randomBytesFn = nodeRandomBytes, tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
    maxOutstandingTokens = DEFAULT_MAX_OUTSTANDING, isSessionActive = () => true,
  } = options;
  const csrfTtlMs = assertTtl(tokenTtlMs);
  if (!Number.isSafeInteger(maxOutstandingTokens) || maxOutstandingTokens < 1 || maxOutstandingTokens > 256 || typeof isSessionActive !== 'function') {
    throw securityError('CSRF configuration is invalid', 'INVALID_CONFIGURATION');
  }
  const tokensBySession = new Map<string, Map<string, TokenRecord>>();

  function active(sessionValue: unknown): sessionValue is WebSession {
    const session = assertSession(sessionValue);
    if (readClock(clock) >= session.expiresAt) return false;
    try { return isSessionActive(session.sessionId) === true; } catch { return false; }
  }

  function removeExpired(bucket: Map<string, TokenRecord>, now: number): void {
    for (const [key, entry] of bucket.entries()) if (now >= entry.expiresAt) bucket.delete(key);
  }

  function issue(session: WebSession) {
    if (!active(session)) throw securityError('cannot issue a token for an inactive session', 'SESSION_INVALID');
    const now = readClock(clock);
    const generated = randomBytesFn(TOKEN_BYTES);
    if (!Buffer.isBuffer(generated) || generated.length !== TOKEN_BYTES) throw securityError('randomBytesFn must return 32 bytes', 'INVALID_RANDOM_SOURCE');
    const token = generated.toString('base64url');
    const digest = digestToken(token);
    const key = digest.toString('base64url');
    const bucket = tokensBySession.get(session.sessionId) ?? new Map<string, TokenRecord>();
    removeExpired(bucket, now);
    while (bucket.size >= maxOutstandingTokens) {
      const oldestKey = bucket.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      bucket.delete(oldestKey);
    }
    bucket.set(key, Object.freeze({ digest, issuedAt: now, expiresAt: now + csrfTtlMs }));
    tokensBySession.set(session.sessionId, bucket);
    return Object.freeze({ token, issuedAt: now, expiresAt: now + csrfTtlMs });
  }

  function validate(session: WebSession, token: unknown, { consume = true }: { consume?: boolean } = {}): true {
    if (!active(session) || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw securityError('CSRF token is invalid or expired', 'CSRF_INVALID');
    const bucket = tokensBySession.get(session.sessionId);
    if (bucket === undefined) throw securityError('CSRF token is invalid or expired', 'CSRF_INVALID');
    const now = readClock(clock);
    removeExpired(bucket, now);
    const suppliedDigest = digestToken(token);
    let matchedKey: string | null = null;
    let matched: TokenRecord | null = null;
    for (const [key, entry] of bucket.entries()) {
      if (timingSafeEqual(entry.digest, suppliedDigest)) { matchedKey = key; matched = entry; }
    }
    if (matched === null || matchedKey === null || now >= matched.expiresAt) throw securityError('CSRF token is invalid or expired', 'CSRF_INVALID');
    if (consume) {
      bucket.delete(matchedKey);
      if (bucket.size === 0) tokensBySession.delete(session.sessionId);
    }
    return true;
  }

  function validateRequest(session: WebSession, { headerToken, bodyToken, consume = true }: { headerToken?: unknown; bodyToken?: unknown; consume?: boolean } = {}): true {
    if (headerToken !== undefined && bodyToken !== undefined && headerToken !== bodyToken) throw securityError('CSRF header and body tokens differ', 'CSRF_INVALID');
    return validate(session, headerToken ?? bodyToken, { consume });
  }

  function revokeSession(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) && tokensBySession.delete(sessionId);
  }

  function purgeExpired(): number {
    const now = readClock(clock);
    let count = 0;
    for (const [sessionId, bucket] of tokensBySession.entries()) {
      const before = bucket.size;
      removeExpired(bucket, now);
      count += before - bucket.size;
      if (bucket.size === 0) tokensBySession.delete(sessionId);
    }
    return count;
  }

  return Object.freeze({
    issue, validate, validateRequest, revokeSession, purgeExpired,
    get size() { let count = 0; for (const bucket of tokensBySession.values()) count += bucket.size; return count; },
  });
}

export type CsrfManager = ReturnType<typeof createCsrfManager>;

export const csrfSecurityConstants = Object.freeze({
  tokenBytes: TOKEN_BYTES, tokenPattern: TOKEN_PATTERN, defaultTokenTtlMs: DEFAULT_TOKEN_TTL_MS,
  maxTokenTtlMs: MAX_TOKEN_TTL_MS, defaultMaxOutstandingTokens: DEFAULT_MAX_OUTSTANDING,
});
