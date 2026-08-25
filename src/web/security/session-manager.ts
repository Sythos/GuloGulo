// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { createTenantContext } from '../../integrations/tenant-context.ts';
import type { TenantContext, TenantRole } from '../../integrations/types.ts';

const SESSION_ID_BYTES = 32;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const COOKIE_HEADER_MAX_BYTES = 8 * 1024;
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLEAR_COOKIE_EXPIRES = 'Thu, 01 Jan 1970 00:00:00 GMT';

export const DEFAULT_SESSION_COOKIE_NAME = '__Host-gulogulo-session';

export class WebSecurityError extends Error {
  readonly code: string;

  constructor(message: string, code = 'WEB_SECURITY_ERROR') {
    super(`Web security error: ${message}`);
    this.name = 'WebSecurityError';
    this.code = code;
  }
}

export interface SessionIdentity {
  tenantId: string;
  domain: string;
  userId: string;
  role?: TenantRole;
  actorId?: string;
}

export interface WebSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly domain: string;
  readonly actorId: string | null;
  readonly role: TenantRole;
  readonly context: TenantContext;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

export interface SessionStore {
  readonly size?: number;
  get(sessionId: string): WebSession | undefined;
  set(sessionId: string, session: WebSession): unknown;
  delete(sessionId: string): boolean;
  entries(): IterableIterator<[string, WebSession]>;
}

export interface SessionManagerOptions {
  clock?: () => number | Date;
  randomBytesFn?: (size: number) => Buffer;
  ttlMs?: number;
  cookieName?: string;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: '/';
  domain?: never;
  store?: SessionStore;
}

function securityError(message: string, code = 'WEB_SECURITY_ERROR'): WebSecurityError {
  return new WebSecurityError(message, code);
}

function readClock(clock: () => number | Date): number {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0) {
    throw securityError('clock must return a valid time', 'INVALID_CLOCK');
  }
  return Math.trunc(time);
}

function normalizeRandomBytes(randomBytesFn: (size: number) => Buffer): string {
  const generated = randomBytesFn(SESSION_ID_BYTES);
  if (!Buffer.isBuffer(generated) || generated.length !== SESSION_ID_BYTES) {
    throw securityError('randomBytesFn must return 32 bytes', 'INVALID_RANDOM_SOURCE');
  }
  return generated.toString('base64url');
}

function assertSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw securityError('session identifier is invalid', 'SESSION_INVALID');
  }
  return sessionId;
}

function assertUserId(userId: unknown): string {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw securityError('user identifier is invalid', 'INVALID_IDENTITY');
  }
  return userId;
}

function assertTtl(ttlMs: number, name = 'ttlMs'): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw securityError(`${name} must be between 1 millisecond and 30 days`, 'INVALID_TTL');
  }
  return ttlMs;
}

function assertCookieConfiguration(options: Required<Pick<SessionManagerOptions, 'cookieName' | 'secure' | 'sameSite' | 'path'>> & Pick<SessionManagerOptions, 'domain'>): void {
  const { cookieName, secure, sameSite, path, domain } = options;
  if (!COOKIE_NAME_PATTERN.test(cookieName) || !secure || !['Strict', 'Lax', 'None'].includes(sameSite) || path !== '/' || domain !== undefined) {
    throw securityError('session cookie configuration is unsafe', 'INVALID_COOKIE_CONFIGURATION');
  }
}

function parseCookieHeader(cookieHeader: unknown, cookieName: string): string | null {
  if (typeof cookieHeader !== 'string' || Buffer.byteLength(cookieHeader, 'utf8') > COOKIE_HEADER_MAX_BYTES) return null;
  let selected: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== cookieName) continue;
    if (selected !== undefined) return null;
    selected = part.slice(separator + 1).trim();
  }
  return selected ?? null;
}

export function createSessionManager(options: SessionManagerOptions = {}) {
  const {
    clock = () => Date.now(), randomBytesFn = nodeRandomBytes, ttlMs = DEFAULT_TTL_MS,
    cookieName = DEFAULT_SESSION_COOKIE_NAME, secure = true, sameSite = 'Lax', path = '/', domain,
    store = new Map<string, WebSession>(),
  } = options;
  const sessionTtlMs = assertTtl(ttlMs);
  assertCookieConfiguration({ cookieName, secure, sameSite, path, domain });
  if (store === null || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.delete !== 'function' || typeof store.entries !== 'function') {
    throw securityError('store must implement get, set, delete, and entries', 'INVALID_STORE');
  }

  function createSession(identity?: SessionIdentity): WebSession {
    if (identity === undefined) throw securityError('tenant identity is invalid', 'INVALID_IDENTITY');
    const canonicalUserId = assertUserId(identity.userId);
    let context: TenantContext;
    try {
      context = createTenantContext({
        tenantId: identity.tenantId, domain: identity.domain, actorId: identity.actorId ?? identity.userId,
        role: identity.role ?? 'user',
      });
    } catch {
      throw securityError('tenant identity is invalid', 'INVALID_IDENTITY');
    }
    const now = readClock(clock);
    let sessionId: string | undefined;
    for (let attempts = 0; attempts < 4; attempts += 1) {
      const candidate = normalizeRandomBytes(randomBytesFn);
      if (store.get(candidate) === undefined) { sessionId = candidate; break; }
    }
    if (sessionId === undefined) throw securityError('random session identifier collision', 'SESSION_GENERATION_FAILED');
    const session: WebSession = Object.freeze({
      sessionId, userId: canonicalUserId, tenantId: context.tenantId, domain: context.domain,
      actorId: context.actorId, role: context.role, context, createdAt: now, lastSeenAt: now,
      expiresAt: now + sessionTtlMs,
    });
    store.set(sessionId, session);
    return session;
  }

  function getActiveSession(sessionId: unknown): WebSession | null {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
    const session = store.get(sessionId);
    if (session === undefined) return null;
    if (readClock(clock) >= session.expiresAt) { store.delete(sessionId); return null; }
    return session;
  }

  function serializeSessionCookie(session: WebSession): string {
    const sessionId = assertSessionId(session?.sessionId);
    if (getActiveSession(sessionId) !== session) throw securityError('cannot serialize an inactive or foreign session', 'SESSION_INVALID');
    const maxAge = Math.max(0, Math.ceil((session.expiresAt - readClock(clock)) / 1000));
    return `${cookieName}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}; Expires=${new Date(session.expiresAt).toUTCString()}`;
  }

  function clearSessionCookie(): string {
    return `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0; Expires=${CLEAR_COOKIE_EXPIRES}`;
  }

  function authenticateCookie(cookieHeader: unknown): WebSession | null {
    const sessionId = parseCookieHeader(cookieHeader, cookieName);
    return sessionId === null ? null : getActiveSession(sessionId);
  }

  function requireSession(cookieHeader: unknown): WebSession {
    const session = authenticateCookie(cookieHeader);
    if (session === null) throw securityError('session is missing, expired, or invalid', 'SESSION_INVALID');
    return session;
  }

  function invalidate(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) && store.delete(sessionId);
  }

  function logout(cookieHeader: unknown) {
    const sessionId = parseCookieHeader(cookieHeader, cookieName);
    return Object.freeze({ sessionId, invalidated: sessionId === null ? false : invalidate(sessionId), clearCookie: clearSessionCookie() });
  }

  function rotate(sessionId: unknown, overrides: Partial<SessionIdentity> = {}): WebSession {
    const oldSession = getActiveSession(sessionId);
    if (oldSession === null) throw securityError('cannot rotate an inactive session', 'SESSION_INVALID');
    const nextIdentity: SessionIdentity = {
      tenantId: overrides.tenantId ?? oldSession.tenantId, domain: overrides.domain ?? oldSession.domain,
      userId: overrides.userId ?? oldSession.userId, role: overrides.role ?? oldSession.role,
      actorId: overrides.actorId ?? oldSession.actorId ?? oldSession.userId,
    };
    if (nextIdentity.tenantId !== oldSession.tenantId || nextIdentity.domain !== oldSession.domain || nextIdentity.userId !== oldSession.userId || nextIdentity.role !== oldSession.role || nextIdentity.actorId !== oldSession.actorId) {
      throw securityError('session rotation cannot change tenant or user binding', 'SESSION_BINDING_VIOLATION');
    }
    const next = createSession(nextIdentity);
    invalidate(oldSession.sessionId);
    return next;
  }

  function invalidateUserSessions({ tenantId, userId }: { tenantId?: string; userId?: string } = {}): number {
    const canonicalUserId = assertUserId(userId);
    let count = 0;
    for (const [sessionId, session] of store.entries()) {
      if (session.tenantId === tenantId && session.userId === canonicalUserId && store.delete(sessionId)) count += 1;
    }
    return count;
  }

  function purgeExpired(): number {
    const now = readClock(clock);
    let count = 0;
    for (const [sessionId, session] of store.entries()) if (now >= session.expiresAt && store.delete(sessionId)) count += 1;
    return count;
  }

  return Object.freeze({
    createSession, getActiveSession, authenticateCookie, requireSession, serializeSessionCookie,
    clearSessionCookie, invalidate, logout, rotate, invalidateUserSessions, purgeExpired,
    get size() { return store.size; },
  });
}

export type SessionManager = ReturnType<typeof createSessionManager>;

export const sessionSecurityConstants = Object.freeze({
  sessionIdBytes: SESSION_ID_BYTES, sessionIdPattern: SESSION_ID_PATTERN, defaultTtlMs: DEFAULT_TTL_MS,
  maxTtlMs: MAX_TTL_MS, cookieHeaderMaxBytes: COOKIE_HEADER_MAX_BYTES,
});
