// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_OUTSTANDING = 32;

export const CSRF_HEADER_NAME = 'x-csrf-token';

function securityError(message, code = 'WEB_SECURITY_ERROR') {
  const error = new Error(`Web security error: ${message}`);
  error.code = code;
  return error;
}

function readClock(clock) {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0) {
    throw securityError('clock must return a valid time', 'INVALID_CLOCK');
  }
  return Math.trunc(time);
}

function assertTtl(ttlMs) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TOKEN_TTL_MS) {
    throw securityError('tokenTtlMs must be between 1 millisecond and 1 hour', 'INVALID_TTL');
  }
  return ttlMs;
}

function assertSession(session) {
  if (session === null || typeof session !== 'object' || typeof session.sessionId !== 'string' || !SESSION_ID_PATTERN.test(session.sessionId)) {
    throw securityError('an authenticated session is required', 'SESSION_INVALID');
  }
  return session;
}

function digestToken(token) {
  return createHash('sha256').update(token, 'ascii').digest();
}

function generateToken(randomBytesFn) {
  const generated = randomBytesFn(TOKEN_BYTES);
  if (!Buffer.isBuffer(generated) || generated.length !== TOKEN_BYTES) {
    throw securityError('randomBytesFn must return 32 bytes', 'INVALID_RANDOM_SOURCE');
  }
  return generated.toString('base64url');
}

function findDigest(bucket, suppliedDigest) {
  for (const entry of bucket.values()) {
    if (timingSafeEqual(entry.digest, suppliedDigest)) {
      return entry;
    }
  }
  return null;
}

/**
 * Create a synchronizer-token CSRF contract.
 *
 * Tokens are stored only as SHA-256 digests, bound to the authenticated
 * session identifier, expire quickly, and are single-use by default. The
 * active-session callback prevents tokens surviving logout or invalidation.
 */
export function createCsrfManager({
  clock = () => Date.now(),
  randomBytesFn = nodeRandomBytes,
  tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
  maxOutstandingTokens = DEFAULT_MAX_OUTSTANDING,
  isSessionActive = () => true,
} = {}) {
  const csrfTtlMs = assertTtl(tokenTtlMs);
  if (!Number.isSafeInteger(maxOutstandingTokens) || maxOutstandingTokens < 1 || maxOutstandingTokens > 256) {
    throw securityError('maxOutstandingTokens must be between 1 and 256', 'INVALID_CONFIGURATION');
  }
  if (typeof isSessionActive !== 'function') {
    throw securityError('isSessionActive must be a function', 'INVALID_CONFIGURATION');
  }

  const tokensBySession = new Map();

  function active(session) {
    assertSession(session);
    if (readClock(clock) >= session.expiresAt) {
      return false;
    }
    try {
      return isSessionActive(session.sessionId) === true;
    } catch {
      return false;
    }
  }

  function removeExpired(bucket, now) {
    for (const [key, entry] of bucket.entries()) {
      if (now >= entry.expiresAt) {
        bucket.delete(key);
      }
    }
  }

  function issue(session) {
    if (!active(session)) {
      throw securityError('cannot issue a token for an inactive session', 'SESSION_INVALID');
    }
    const now = readClock(clock);
    const token = generateToken(randomBytesFn);
    const digest = digestToken(token);
    const key = digest.toString('base64url');
    const bucket = tokensBySession.get(session.sessionId) ?? new Map();
    removeExpired(bucket, now);
    while (bucket.size >= maxOutstandingTokens) {
      const oldestKey = bucket.keys().next().value;
      bucket.delete(oldestKey);
    }
    bucket.set(key, Object.freeze({ digest, issuedAt: now, expiresAt: now + csrfTtlMs }));
    tokensBySession.set(session.sessionId, bucket);
    return Object.freeze({ token, issuedAt: now, expiresAt: now + csrfTtlMs });
  }

  function validate(session, token, { consume = true } = {}) {
    if (!active(session) || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw securityError('CSRF token is invalid or expired', 'CSRF_INVALID');
    }
    const bucket = tokensBySession.get(session.sessionId);
    if (bucket === undefined) {
      throw securityError('CSRF token is invalid or expired', 'CSRF_INVALID');
    }
    const now = readClock(clock);
    removeExpired(bucket, now);
    const suppliedDigest = digestToken(token);
    const matched = findDigest(bucket, suppliedDigest);
    if (matched === null || now >= matched.expiresAt) {
      throw securityError('CSRF token is invalid or expired', 'CSRF_INVALID');
    }
    if (consume) {
      bucket.delete(matched.digest.toString('base64url'));
      if (bucket.size === 0) {
        tokensBySession.delete(session.sessionId);
      }
    }
    return true;
  }

  function validateRequest(session, { headerToken, bodyToken, consume = true } = {}) {
    if (headerToken !== undefined && bodyToken !== undefined && headerToken !== bodyToken) {
      throw securityError('CSRF header and body tokens differ', 'CSRF_INVALID');
    }
    const token = headerToken ?? bodyToken;
    return validate(session, token, { consume });
  }

  function revokeSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return false;
    }
    return tokensBySession.delete(sessionId);
  }

  function purgeExpired() {
    const now = readClock(clock);
    let count = 0;
    for (const [sessionId, bucket] of tokensBySession.entries()) {
      const before = bucket.size;
      removeExpired(bucket, now);
      count += before - bucket.size;
      if (bucket.size === 0) {
        tokensBySession.delete(sessionId);
      }
    }
    return count;
  }

  return Object.freeze({
    issue,
    validate,
    validateRequest,
    revokeSession,
    purgeExpired,
    get size() {
      let count = 0;
      for (const bucket of tokensBySession.values()) {
        count += bucket.size;
      }
      return count;
    },
  });
}

export const csrfSecurityConstants = Object.freeze({
  tokenBytes: TOKEN_BYTES,
  tokenPattern: TOKEN_PATTERN,
  defaultTokenTtlMs: DEFAULT_TOKEN_TTL_MS,
  maxTokenTtlMs: MAX_TOKEN_TTL_MS,
  defaultMaxOutstandingTokens: DEFAULT_MAX_OUTSTANDING,
});
