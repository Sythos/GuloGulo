// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { createTenantContext } from '../../integrations/tenant-context.mjs';

const SESSION_ID_BYTES = 32;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const COOKIE_HEADER_MAX_BYTES = 8 * 1024;
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLEAR_COOKIE_EXPIRES = 'Thu, 01 Jan 1970 00:00:00 GMT';

export const DEFAULT_SESSION_COOKIE_NAME = '__Host-gulogulo-session';

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

function normalizeRandomBytes(randomBytesFn) {
  const generated = randomBytesFn(SESSION_ID_BYTES);
  if (!Buffer.isBuffer(generated) || generated.length !== SESSION_ID_BYTES) {
    throw securityError('randomBytesFn must return 32 bytes', 'INVALID_RANDOM_SOURCE');
  }
  return generated.toString('base64url');
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw securityError('session identifier is invalid', 'SESSION_INVALID');
  }
  return sessionId;
}

function assertUserId(userId) {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw securityError('user identifier is invalid', 'INVALID_IDENTITY');
  }
  return userId;
}

function assertTtl(ttlMs, name = 'ttlMs') {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw securityError(`${name} must be between 1 millisecond and 30 days`, 'INVALID_TTL');
  }
  return ttlMs;
}

function assertCookieConfiguration({ cookieName, secure, sameSite, path, domain }) {
  if (typeof cookieName !== 'string' || !COOKIE_NAME_PATTERN.test(cookieName)) {
    throw securityError('cookieName is invalid', 'INVALID_COOKIE_CONFIGURATION');
  }
  if (typeof secure !== 'boolean' || !secure) {
    throw securityError('secure must be boolean', 'INVALID_COOKIE_CONFIGURATION');
  }
  if (!['Strict', 'Lax', 'None'].includes(sameSite)) {
    throw securityError('sameSite must be Strict, Lax, or None', 'INVALID_COOKIE_CONFIGURATION');
  }
  if (typeof path !== 'string' || path !== '/') {
    throw securityError('session cookies must use the root path', 'INVALID_COOKIE_CONFIGURATION');
  }
  if (domain !== undefined) {
    throw securityError('session cookies must not set a Domain attribute', 'INVALID_COOKIE_CONFIGURATION');
  }
  if (cookieName.startsWith('__Host-') && (!secure || path !== '/' || domain !== undefined)) {
    throw securityError('__Host- cookies require Secure, Path=/, and no Domain', 'INVALID_COOKIE_CONFIGURATION');
  }
  if (sameSite === 'None' && !secure) {
    throw securityError('SameSite=None requires Secure', 'INVALID_COOKIE_CONFIGURATION');
  }
}

function parseCookieHeader(cookieHeader, cookieName) {
  if (typeof cookieHeader !== 'string' || Buffer.byteLength(cookieHeader, 'utf8') > COOKIE_HEADER_MAX_BYTES) {
    return null;
  }

  let selected;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) {
      continue;
    }
    if (selected !== undefined) {
      return null;
    }
    selected = part.slice(separator + 1).trim();
  }
  return selected === undefined ? null : selected;
}

function cookieDate(time) {
  return new Date(time).toUTCString();
}

/**
 * Create an in-memory secure-cookie session contract.
 *
 * The storage interface is deliberately small so a later PostgreSQL-backed
 * adapter can preserve the same security semantics. Session identifiers are
 * opaque random values and never contain tenant or user data.
 */
export function createSessionManager({
  clock = () => Date.now(),
  randomBytesFn = nodeRandomBytes,
  ttlMs = DEFAULT_TTL_MS,
  cookieName = DEFAULT_SESSION_COOKIE_NAME,
  secure = true,
  sameSite = 'Lax',
  path = '/',
  domain,
  store = new Map(),
} = {}) {
  const sessionTtlMs = assertTtl(ttlMs);
  assertCookieConfiguration({ cookieName, secure, sameSite, path, domain });
  if (store === null || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.delete !== 'function') {
    throw securityError('store must implement get, set, and delete', 'INVALID_STORE');
  }

  function createSession({ tenantId, domain: tenantDomain, userId, role = 'user', actorId = userId } = {}) {
    const canonicalUserId = assertUserId(userId);
    let context;
    try {
      context = createTenantContext({ tenantId, domain: tenantDomain, actorId, role });
    } catch {
      throw securityError('tenant identity is invalid', 'INVALID_IDENTITY');
    }
    const now = readClock(clock);
    let sessionId;
    for (let attempts = 0; attempts < 4; attempts += 1) {
      const candidate = normalizeRandomBytes(randomBytesFn);
      if (store.get(candidate) === undefined) {
        sessionId = candidate;
        break;
      }
    }
    if (sessionId === undefined) {
      throw securityError('random session identifier collision', 'SESSION_GENERATION_FAILED');
    }
    const session = Object.freeze({
      sessionId,
      userId: canonicalUserId,
      tenantId: context.tenantId,
      domain: context.domain,
      actorId: context.actorId,
      role: context.role,
      context,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + sessionTtlMs,
    });
    store.set(sessionId, session);
    return session;
  }

  function getActiveSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return null;
    }
    const session = store.get(sessionId);
    if (session === undefined) {
      return null;
    }
    if (readClock(clock) >= session.expiresAt) {
      store.delete(sessionId);
      return null;
    }
    return session;
  }

  function serializeSessionCookie(session) {
    if (session === null || typeof session !== 'object') {
      throw securityError('session is required', 'SESSION_INVALID');
    }
    const sessionId = assertSessionId(session.sessionId);
    if (getActiveSession(sessionId) !== session) {
      throw securityError('cannot serialize an inactive or foreign session', 'SESSION_INVALID');
    }
    const remainingMs = session.expiresAt - readClock(clock);
    const maxAge = Math.max(0, Math.ceil(remainingMs / 1000));
    return `${cookieName}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}; Expires=${cookieDate(session.expiresAt)}`;
  }

  function clearSessionCookie() {
    return `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0; Expires=${CLEAR_COOKIE_EXPIRES}`;
  }

  function authenticateCookie(cookieHeader) {
    const sessionId = parseCookieHeader(cookieHeader, cookieName);
    return sessionId === null ? null : getActiveSession(sessionId);
  }

  function requireSession(cookieHeader) {
    const session = authenticateCookie(cookieHeader);
    if (session === null) {
      throw securityError('session is missing, expired, or invalid', 'SESSION_INVALID');
    }
    return session;
  }

  function invalidate(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return false;
    }
    return store.delete(sessionId);
  }

  function logout(cookieHeader) {
    const sessionId = parseCookieHeader(cookieHeader, cookieName);
    const invalidated = sessionId === null ? false : invalidate(sessionId);
    return Object.freeze({
      sessionId,
      invalidated,
      clearCookie: clearSessionCookie(),
    });
  }

  function rotate(sessionId, overrides = {}) {
    const oldSession = getActiveSession(sessionId);
    if (oldSession === null) {
      throw securityError('cannot rotate an inactive session', 'SESSION_INVALID');
    }
    const requestedIdentity = {
      tenantId: overrides.tenantId ?? oldSession.tenantId,
      domain: overrides.domain ?? oldSession.domain,
      userId: overrides.userId ?? oldSession.userId,
      role: overrides.role ?? oldSession.role,
      actorId: overrides.actorId ?? oldSession.actorId,
    };
    if (requestedIdentity.tenantId !== oldSession.tenantId
      || requestedIdentity.domain !== oldSession.domain
      || requestedIdentity.userId !== oldSession.userId
      || requestedIdentity.role !== oldSession.role
      || requestedIdentity.actorId !== oldSession.actorId) {
      throw securityError('session rotation cannot change tenant or user binding', 'SESSION_BINDING_VIOLATION');
    }
    const next = createSession({
      ...requestedIdentity,
    });
    invalidate(oldSession.sessionId);
    return next;
  }

  function invalidateUserSessions({ tenantId, userId } = {}) {
    const canonicalUserId = assertUserId(userId);
    let count = 0;
    for (const [sessionId, session] of store.entries()) {
      if (session.tenantId === tenantId && session.userId === canonicalUserId) {
        if (store.delete(sessionId)) {
          count += 1;
        }
      }
    }
    return count;
  }

  function purgeExpired() {
    const now = readClock(clock);
    let count = 0;
    for (const [sessionId, session] of store.entries()) {
      if (now >= session.expiresAt && store.delete(sessionId)) {
        count += 1;
      }
    }
    return count;
  }

  return Object.freeze({
    createSession,
    getActiveSession,
    authenticateCookie,
    requireSession,
    serializeSessionCookie,
    clearSessionCookie,
    invalidate,
    logout,
    rotate,
    invalidateUserSessions,
    purgeExpired,
    get size() {
      return typeof store.size === 'number' ? store.size : undefined;
    },
  });
}

export const sessionSecurityConstants = Object.freeze({
  sessionIdBytes: SESSION_ID_BYTES,
  sessionIdPattern: SESSION_ID_PATTERN,
  defaultTtlMs: DEFAULT_TTL_MS,
  maxTtlMs: MAX_TTL_MS,
  cookieHeaderMaxBytes: COOKIE_HEADER_MAX_BYTES,
});
