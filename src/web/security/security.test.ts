// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebSecurity, type SessionIdentity, WebSecurityError } from './index.ts';

function createClock(start = 1_756_000_000_000) {
  let now = start;
  return { clock: () => now, advance(milliseconds: number) { now += milliseconds; } };
}

function createDeterministicRandomBytes() {
  let counter = 0;
  return (size: number) => { counter += 1; return Buffer.alloc(size, counter); };
}

function createIdentity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return { tenantId: 'acme', domain: 'acme.example', userId: 'alice', actorId: 'alice', role: 'user', ...overrides };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WebSecurityError && error.code === code;
}

test('sessions use opaque identifiers and secure host-only cookie attributes', () => {
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  const { session, setCookie } = security.createAuthenticatedSession(createIdentity());
  assert.match(session.sessionId, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(session.sessionId.includes('alice') || session.sessionId.includes('acme'), false);
  assert.match(setCookie, /^__Host-gulogulo-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax;/u);
  assert.equal(setCookie.includes('Domain='), false);
  assert.equal(security.authenticate(setCookie), session);
});

test('cookie authentication rejects tampering, oversized headers, and duplicates', () => {
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  const { setCookie } = security.createAuthenticatedSession(createIdentity());
  const cookie = setCookie.split(';', 1)[0];
  const sessionId = cookie.slice(cookie.indexOf('=') + 1);
  assert.equal(security.authenticate(`${cookie}; __Host-gulogulo-session=${'A'.repeat(43)}`), null);
  assert.equal(security.authenticate(`__Host-gulogulo-session=${sessionId.slice(0, -1)}A`), null);
  assert.equal(security.authenticate(`${cookie}${'x'.repeat(8192)}`), null);
});

test('expiry and logout fail closed and revoke all bearer material', () => {
  const clock = createClock();
  const security = createWebSecurity({ clock: clock.clock, ttlMs: 1_000, randomBytesFn: createDeterministicRandomBytes() });
  const first = security.createAuthenticatedSession(createIdentity());
  const token = security.csrf.issue(first.session);
  clock.advance(1_000);
  assert.equal(security.authenticate(first.setCookie), null);
  assert.throws(() => security.csrf.validate(first.session, token.token), hasCode('CSRF_INVALID'));

  const second = security.createAuthenticatedSession(createIdentity());
  const secondToken = security.csrf.issue(second.session);
  const result = security.logout(second.setCookie);
  assert.equal(result.invalidated, true);
  assert.match(result.clearCookie, /Max-Age=0/u);
  assert.equal(security.authenticate(second.setCookie), null);
  assert.throws(() => security.csrf.validate(second.session, secondToken.token), hasCode('CSRF_INVALID'));
});

test('CSRF tokens are session-bound, single-use, expiring, and reject conflicts', () => {
  const clock = createClock();
  const security = createWebSecurity({ clock: clock.clock, tokenTtlMs: 1_000, randomBytesFn: createDeterministicRandomBytes() });
  const alice = security.createAuthenticatedSession(createIdentity());
  const bob = security.createAuthenticatedSession(createIdentity({ userId: 'bob', actorId: 'bob' }));
  const token = security.csrf.issue(alice.session).token;
  assert.throws(() => security.csrf.validateRequest(alice.session), hasCode('CSRF_INVALID'));
  assert.throws(() => security.csrf.validate(bob.session, token), hasCode('CSRF_INVALID'));
  assert.throws(() => security.csrf.validateRequest(alice.session, { headerToken: token, bodyToken: 'A'.repeat(43) }), hasCode('CSRF_INVALID'));
  assert.equal(security.csrf.validate(alice.session, token), true);
  assert.throws(() => security.csrf.validate(alice.session, token), hasCode('CSRF_INVALID'));
  const expiring = security.csrf.issue(alice.session).token;
  clock.advance(1_000);
  assert.throws(() => security.csrf.validate(alice.session, expiring), hasCode('CSRF_INVALID'));
});

test('session rotation preserves tenant/user binding and invalidates the old bearer', () => {
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  const original = security.createAuthenticatedSession(createIdentity());
  const rotated = security.sessions.rotate(original.session.sessionId);
  assert.equal(security.sessions.getActiveSession(original.session.sessionId), null);
  assert.equal(rotated.tenantId, 'acme');
  assert.equal(rotated.userId, 'alice');
  assert.throws(() => security.sessions.rotate(rotated.sessionId, { tenantId: 'other' }), hasCode('SESSION_BINDING_VIOLATION'));
});

test('identity, random source, and cookie configuration fail closed', () => {
  assert.throws(() => createWebSecurity({ secure: false }), hasCode('INVALID_COOKIE_CONFIGURATION'));
  assert.throws(() => createWebSecurity({ randomBytesFn: () => Buffer.alloc(1) }).createAuthenticatedSession(createIdentity()), hasCode('INVALID_RANDOM_SOURCE'));
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  assert.throws(() => security.createAuthenticatedSession(createIdentity({ tenantId: 'Acme' })), hasCode('INVALID_IDENTITY'));
  assert.throws(() => security.createAuthenticatedSession(createIdentity({ userId: ' alice' })), hasCode('INVALID_IDENTITY'));
});
