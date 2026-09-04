// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionCredentialStore } from './session-credential.ts';
import { WebSecurityError } from './session-manager.ts';

const SESSION_A = 'A'.repeat(43);
const SESSION_B = 'B'.repeat(43);

function createClock(start = 1_756_000_000_000) {
  let now = start;
  return { clock: () => now, advance(milliseconds: number) { now += milliseconds; } };
}

function createDeterministicRandomBytes() {
  let counter = 0;
  return (size: number) => { counter += 1; return Buffer.alloc(size, counter); };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WebSecurityError && error.code === code;
}

test('a stored credential round-trips for the same session', () => {
  const { clock } = createClock();
  const store = createSessionCredentialStore({ clock, randomBytesFn: createDeterministicRandomBytes() });
  store.set(SESSION_A, 'super-secret-password', clock() + 60_000);
  assert.equal(store.get(SESSION_A), 'super-secret-password');
});

test('a credential is never readable under a different session identifier', () => {
  const { clock } = createClock();
  const store = createSessionCredentialStore({ clock, randomBytesFn: createDeterministicRandomBytes() });
  store.set(SESSION_A, 'super-secret-password', clock() + 60_000);
  assert.equal(store.get(SESSION_B), null);
});

test('a credential is discarded once it expires', () => {
  const timeClock = createClock();
  const store = createSessionCredentialStore({ clock: timeClock.clock, randomBytesFn: createDeterministicRandomBytes() });
  store.set(SESSION_A, 'super-secret-password', timeClock.clock() + 1_000);
  timeClock.advance(1_000);
  assert.equal(store.get(SESSION_A), null);
  assert.equal(store.size, 0);
});

test('deleting a session discards its credential immediately', () => {
  const { clock } = createClock();
  const store = createSessionCredentialStore({ clock, randomBytesFn: createDeterministicRandomBytes() });
  store.set(SESSION_A, 'super-secret-password', clock() + 60_000);
  assert.equal(store.delete(SESSION_A), true);
  assert.equal(store.get(SESSION_A), null);
});

test('setting a new credential for a session replaces the previous one', () => {
  const { clock } = createClock();
  const store = createSessionCredentialStore({ clock, randomBytesFn: createDeterministicRandomBytes() });
  store.set(SESSION_A, 'first-password', clock() + 60_000);
  store.set(SESSION_A, 'second-password', clock() + 60_000);
  assert.equal(store.get(SESSION_A), 'second-password');
  assert.equal(store.size, 1);
});

test('an oversized credential is rejected', () => {
  const store = createSessionCredentialStore();
  assert.throws(() => store.set(SESSION_A, 'x'.repeat(1025), Date.now() + 60_000), hasCode('INVALID_CREDENTIAL'));
});

test('an invalid session identifier is rejected', () => {
  const store = createSessionCredentialStore();
  assert.throws(() => store.set('not-a-session-id', 'password', Date.now() + 60_000), hasCode('SESSION_INVALID'));
  assert.throws(() => store.get('not-a-session-id'), hasCode('SESSION_INVALID'));
});

test('an expiresAt not in the future is rejected', () => {
  const { clock } = createClock();
  const store = createSessionCredentialStore({ clock });
  assert.throws(() => store.set(SESSION_A, 'password', clock()), hasCode('INVALID_TTL'));
});
