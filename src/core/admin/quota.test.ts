// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuotaLedger } from './quota.ts';

const alice = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', userId: 'alice', role: 'user' });
const master = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });
const provider = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'provider', role: 'provider' });
const otherTenant = Object.freeze({ tenantId: 'other', domain: 'other.example', actorId: 'master', role: 'tenant_master' });

test('quota ledger registers users and exposes gross and per-user allocation metadata', () => {
  const ledger = createQuotaLedger({
    tenantId: 'acme',
    grossQuotaBytes: 1_000,
    initialUsers: [{ userId: 'alice', allocatedQuotaBytes: 600 }, { userId: 'bob', allocatedQuotaBytes: 300 }],
  });
  assert.equal(ledger.grossQuota(), 1_000);
  assert.deepEqual(ledger.read(alice), {
    tenantId: 'acme',
    userId: 'alice',
    allocatedQuotaBytes: 600,
    usedBytes: 0,
    remainingBytes: 600,
  });
  const snapshot = ledger.snapshot(master);
  assert.equal(snapshot.grossQuotaBytes, 1_000);
  assert.equal(snapshot.allocatedQuotaBytes, 900);
  assert.equal(snapshot.remainingQuotaBytes, 100);
  assert.equal(snapshot.users.length, 2);
});

test('master quota allocation is atomic and cannot oversubscribe the immutable gross ceiling', () => {
  const ledger = createQuotaLedger({
    tenantId: 'acme',
    grossQuotaBytes: 1_000,
    initialUsers: [{ userId: 'alice', allocatedQuotaBytes: 600 }, { userId: 'bob', allocatedQuotaBytes: 400 }],
  });
  assert.throws(
    () => ledger.allocate(master, { userId: 'alice', allocatedQuotaBytes: 700 }),
    (error) => error.code === 'QUOTA_EXCEEDED' && error.status === 409,
  );
  assert.equal(ledger.read(alice).allocatedQuotaBytes, 600);
  assert.equal(ledger.snapshot(master).allocatedQuotaBytes, 1_000);
  const updated = ledger.allocate(master, { userId: 'alice', allocatedQuotaBytes: 550 });
  assert.equal(updated.allocatedQuotaBytes, 550);
});

test('registering and allocating users require administrative permission', () => {
  const ledger = createQuotaLedger({ tenantId: 'acme', grossQuotaBytes: 1_000 });
  assert.equal(ledger.registerUser(master, { userId: 'alice', allocatedQuotaBytes: 400 }).allocatedQuotaBytes, 400);
  assert.equal(ledger.registerUser(provider, { userId: 'bob', allocatedQuotaBytes: 500 }).allocatedQuotaBytes, 500);
  assert.throws(() => ledger.registerUser(alice, { userId: 'carol', allocatedQuotaBytes: 1 }), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(() => ledger.allocate(alice, { userId: 'bob', allocatedQuotaBytes: 300 }), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(() => ledger.registerUser(master, { userId: 'alice', allocatedQuotaBytes: 1 }), (error) => error.code === 'CONFLICT');
});

test('mail/DAV reservations reject usage beyond allocation and release idempotently', () => {
  const ledger = createQuotaLedger({ tenantId: 'acme', grossQuotaBytes: 1_000, initialUsers: [{ userId: 'alice', allocatedQuotaBytes: 500 }] });
  const first = ledger.reserve(alice, { userId: 'alice', sizeBytes: 300 });
  assert.equal(first.accepted, true);
  assert.equal(ledger.read(alice).usedBytes, 300);
  const rejected = ledger.reserve(alice, { userId: 'alice', sizeBytes: 201 });
  assert.deepEqual(rejected, { accepted: false, reason: 'quota_exceeded', tenantId: 'acme', userId: 'alice' });
  assert.equal(ledger.read(alice).usedBytes, 300);
  assert.deepEqual(ledger.release(alice, first.reservationId), { released: true, alreadyReleased: false, reservationId: first.reservationId });
  assert.deepEqual(ledger.release(alice, first.reservationId), { released: false, alreadyReleased: true, reservationId: first.reservationId });
  assert.equal(ledger.read(alice).usedBytes, 0);
});

test('all quota operations fail closed on cross-tenant or unknown user access', () => {
  const ledger = createQuotaLedger({ tenantId: 'acme', grossQuotaBytes: 1_000, initialUsers: [{ userId: 'alice', allocatedQuotaBytes: 500 }] });
  assert.throws(() => ledger.snapshot(otherTenant), (error) => error.code === 'CROSS_TENANT_DENIED');
  assert.throws(() => ledger.read(master, { userId: 'unknown' }), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => ledger.reserve(otherTenant, { userId: 'alice', sizeBytes: 1 }), (error) => error.code === 'CROSS_TENANT_DENIED');
  assert.throws(() => ledger.allocate(master, { userId: 'unknown', allocatedQuotaBytes: 1 }), (error) => error.code === 'NOT_FOUND');
});
