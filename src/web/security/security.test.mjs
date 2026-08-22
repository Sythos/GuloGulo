// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebSecurity } from './index.mjs';

function createClock(start = 1_756_000_000_000) {
  let now = start;
  return {
    clock: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function createDeterministicRandomBytes() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Buffer.alloc(size, counter);
  };
}

function createIdentity(overrides = {}) {
  return {
    tenantId: 'acme',
    domain: 'acme.example',
    userId: 'alice',
    actorId: 'alice',
    role: 'user',
    ...overrides,
  };
}

test('sessions use opaque safe identifiers and secure __Host cookie attributes', () => {
  const clock = createClock();
  const security = createWebSecurity({ clock: clock.clock, randomBytesFn: createDeterministicRandomBytes() });
  const { session, setCookie } = security.createAuthenticatedSession(createIdentity());

  assert.match(session.sessionId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.sessionId.includes('alice'), false);
  assert.equal(session.sessionId.includes('acme'), false);
  assert.match(setCookie, /^__Host-gulogulo-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800;/);
  assert.equal(setCookie.includes('Domain='), false);
  assert.equal(security.authenticate(setCookie), session);
});

test('cookie parsing rejects tampering, oversized headers, and duplicate session cookies', () => {
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  const { setCookie } = security.createAuthenticatedSession(createIdentity());
  const cookie = setCookie.split(';', 1)[0];
  const sessionId = cookie.slice(cookie.indexOf('=') + 1);

  assert.equal(security.authenticate(`${cookie}; __Host-gulogulo-session=${'A'.repeat(43)}`), null);
  assert.equal(security.authenticate(`__Host-gulogulo-session=${sessionId.slice(0, -1)}A`), null);
  assert.equal(security.authenticate(`${cookie}${'x'.repeat(8192)}`), null);
});

test('session expiry is absolute and expired sessions are removed from the store', () => {
  const clock = createClock();
  const security = createWebSecurity({ clock: clock.clock, ttlMs: 1000, randomBytesFn: createDeterministicRandomBytes() });
  const { session, setCookie } = security.createAuthenticatedSession(createIdentity());

  assert.equal(security.sessions.size, 1);
  clock.advance(999);
  assert.equal(security.authenticate(setCookie), session);
  clock.advance(1);
  assert.equal(security.authenticate(setCookie), null);
  assert.equal(security.sessions.size, 0);
});

test('logout invalidates the session, revokes CSRF tokens, and clears the cookie', () => {
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  const { session, setCookie } = security.createAuthenticatedSession(createIdentity());
  const csrf = security.csrf.issue(session);
  const result = security.logout(setCookie);

  assert.equal(result.invalidated, true);
  assert.match(result.clearCookie, /Max-Age=0/);
  assert.equal(security.authenticate(setCookie), null);
  assert.equal(security.csrf.size, 0);
  assert.throws(() => security.csrf.validate(session, csrf.token), (error) => error.code === 'CSRF_INVALID');
});

test('CSRF tokens are session-bound, expire, and cannot be replayed after consumption', () => {
  const clock = createClock();
  const security = createWebSecurity({ clock: clock.clock, tokenTtlMs: 1000, randomBytesFn: createDeterministicRandomBytes() });
  const first = security.createAuthenticatedSession(createIdentity({ userId: 'alice', actorId: 'alice' }));
  const second = security.createAuthenticatedSession(createIdentity({ userId: 'bob', actorId: 'bob' }));
  const token = security.csrf.issue(first.session);

  assert.equal(security.csrf.validate(first.session, token.token), true);
  assert.throws(() => security.csrf.validate(first.session, token.token), (error) => error.code === 'CSRF_INVALID');
  const secondToken = security.csrf.issue(first.session);
  assert.throws(() => security.csrf.validate(second.session, secondToken.token), (error) => error.code === 'CSRF_INVALID');
  clock.advance(1000);
  assert.throws(() => security.csrf.validate(first.session, secondToken.token), (error) => error.code === 'CSRF_INVALID');
});

test('CSRF request validation rejects missing, conflicting, and malformed tokens', () => {
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  const { session } = security.createAuthenticatedSession(createIdentity());
  const token = security.csrf.issue(session).token;

  assert.throws(() => security.csrf.validateRequest(session), (error) => error.code === 'CSRF_INVALID');
  assert.throws(() => security.csrf.validateRequest(session, { headerToken: token, bodyToken: `${token.slice(0, -1)}A` }), (error) => error.code === 'CSRF_INVALID');
  assert.throws(() => security.csrf.validate(session, 'not-a-token'), (error) => error.code === 'CSRF_INVALID');
  assert.equal(security.csrf.validateRequest(session, { headerToken: token }), true);
});

test('session rotation invalidates the old bearer and preserves explicit tenant and user binding', () => {
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  const original = security.createAuthenticatedSession(createIdentity());
  const rotated = security.sessions.rotate(original.session.sessionId);

  assert.notEqual(rotated.sessionId, original.session.sessionId);
  assert.equal(rotated.tenantId, 'acme');
  assert.equal(rotated.userId, 'alice');
  assert.equal(security.sessions.getActiveSession(original.session.sessionId), null);
  assert.equal(security.sessions.getActiveSession(rotated.sessionId), rotated);
  assert.throws(() => security.sessions.requireSession(original.setCookie), (error) => error.code === 'SESSION_INVALID');
  assert.throws(() => security.sessions.rotate(rotated.sessionId, { tenantId: 'other' }), (error) => error.code === 'SESSION_BINDING_VIOLATION');
});

test('identity and cookie configuration fail closed', () => {
  assert.throws(() => createWebSecurity({ secure: false }), (error) => error.code === 'INVALID_COOKIE_CONFIGURATION');
  assert.throws(() => createWebSecurity({ sameSite: 'Invalid' }), (error) => error.code === 'INVALID_COOKIE_CONFIGURATION');
  const security = createWebSecurity({ randomBytesFn: createDeterministicRandomBytes() });
  assert.throws(() => security.createAuthenticatedSession(createIdentity({ tenantId: 'Acme' })), (error) => error.code === 'INVALID_IDENTITY');
  assert.throws(() => security.createAuthenticatedSession(createIdentity({ userId: ' alice', actorId: 'alice' })), (error) => error.code === 'INVALID_IDENTITY');
});
