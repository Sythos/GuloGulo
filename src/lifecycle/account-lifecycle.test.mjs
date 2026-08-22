// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_STATES,
  createAccountLifecycleStore,
} from './account-lifecycle.mjs';

const scope = { tenantId: 'acme', userId: 'alice' };
const confirmation = 'DELETE:alice';

function makeClock(value = '2026-08-22T00:00:00.000Z') {
  let current = new Date(value);
  return {
    now: () => new Date(current),
    set(next) {
      current = new Date(next);
    },
  };
}

test('account deletion requires strong confirmation and separates request from soft delete', () => {
  const clock = makeClock();
  const store = createAccountLifecycleStore({ now: clock.now });
  store.registerAccount({ ...scope });
  assert.throws(
    () => store.requestDeletion({ ...scope, confirmation: 'yes', requestId: 'delete-request-001' }),
    (error) => error.code === 'STRONG_CONFIRMATION_REQUIRED',
  );
  const requested = store.requestDeletion({
    ...scope,
    confirmation,
    requestId: 'delete-request-001',
    requestedAt: '2026-08-22T00:00:00Z',
    reason: 'user_requested',
  });
  assert.equal(requested.account.state, ACCOUNT_STATES.DELETION_REQUESTED);
  assert.equal(requested.account.recoveryUntil, '2026-09-19T00:00:00.000Z');
  assert.deepEqual(store.requestDeletion({ ...scope, confirmation, requestId: 'delete-request-001' }), requested);
  const softDeleted = store.softDeleteAccount({ ...scope, confirmation, requestId: 'delete-request-001', deletedAt: '2026-08-22T00:01:00Z' });
  assert.equal(softDeleted.account.state, ACCOUNT_STATES.SOFT_DELETED);
  assert.deepEqual(store.getAccount(scope).cleanupPlan, [
    'aliases',
    'delegations',
    'factors',
    'backups',
    'mailbox',
    'dav_collections',
    'preferences',
  ]);
});

test('account can be restored during its recovery window and cannot be restored after it', () => {
  const clock = makeClock();
  const store = createAccountLifecycleStore({ now: clock.now, recoveryDays: 2 });
  store.registerAccount({ ...scope });
  store.requestDeletion({ ...scope, confirmation, requestId: 'delete-request-002', requestedAt: '2026-08-22T00:00:00Z' });
  store.softDeleteAccount({ ...scope, confirmation, requestId: 'delete-request-002', deletedAt: '2026-08-22T00:00:00Z' });
  const restored = store.restoreAccount({ ...scope, operationId: 'restore-001', restoredAt: '2026-08-23T00:00:00Z' });
  assert.equal(restored.account.state, ACCOUNT_STATES.ACTIVE);

  store.requestDeletion({ ...scope, confirmation, requestId: 'delete-request-003', requestedAt: '2026-08-22T00:00:00Z' });
  store.softDeleteAccount({ ...scope, confirmation, requestId: 'delete-request-003', deletedAt: '2026-08-22T00:00:00Z' });
  clock.set('2026-08-25T00:00:00Z');
  assert.throws(
    () => store.restoreAccount({ ...scope, operationId: 'restore-too-late', restoredAt: clock.now() }),
    (error) => error.code === 'RECOVERY_WINDOW_EXPIRED',
  );
});

test('account purge is queued only after the recovery window and completes only for every planned resource', () => {
  const clock = makeClock();
  const store = createAccountLifecycleStore({ now: clock.now, recoveryDays: 1 });
  store.registerAccount({ ...scope, cleanupPlan: ['aliases', 'mailbox', 'dav_collections'] });
  store.requestDeletion({ ...scope, confirmation, requestId: 'delete-request-004', requestedAt: '2026-08-22T00:00:00Z' });
  store.softDeleteAccount({ ...scope, confirmation, requestId: 'delete-request-004', deletedAt: '2026-08-22T00:00:00Z' });
  assert.throws(
    () => store.queuePurge({ ...scope, operationId: 'queue-too-early', queuedAt: '2026-08-22T23:59:59Z' }),
    (error) => error.code === 'RECOVERY_WINDOW_ACTIVE',
  );
  const queued = store.queuePurge({ ...scope, operationId: 'queue-001', queuedAt: '2026-08-23T00:00:00Z' });
  assert.equal(queued.account.state, ACCOUNT_STATES.PURGE_PENDING);
  assert.throws(
    () => store.completePurge({ ...scope, confirmation: 'PURGE:alice', operationId: 'complete-incomplete', completedAt: '2026-08-23T00:01:00Z', resourceResults: { aliases: 'purged' } }),
    (error) => error.code === 'PURGE_INCOMPLETE',
  );
  const purged = store.completePurge({
    ...scope,
    confirmation: 'PURGE:alice',
    operationId: 'complete-001',
    completedAt: '2026-08-23T00:02:00Z',
    resourceResults: { aliases: 'purged', mailbox: 'purged', dav_collections: 'purged' },
  });
  assert.equal(purged.account.state, ACCOUNT_STATES.PURGED);
  assert.deepEqual(store.completePurge({
    ...scope,
    confirmation: 'PURGE:alice',
    operationId: 'complete-001',
    resourceResults: { aliases: 'purged', mailbox: 'purged', dav_collections: 'purged' },
  }), purged);
});

test('account holds block deletion and purge, and all operations produce metadata-only audit events', () => {
  const clock = makeClock();
  const store = createAccountLifecycleStore({ now: clock.now });
  store.registerAccount({ ...scope });
  store.addAccountHold({ ...scope, holdId: 'hold-001', reasonCode: 'legal_hold' });
  assert.throws(
    () => store.requestDeletion({ ...scope, confirmation, requestId: 'delete-held' }),
    (error) => error.code === 'ACCOUNT_ON_HOLD',
  );
  store.releaseAccountHold({ ...scope, holdId: 'hold-001' });
  store.requestDeletion({ ...scope, confirmation, requestId: 'delete-request-005', requestedAt: '2026-08-22T00:00:00Z' });
  store.softDeleteAccount({ ...scope, confirmation, requestId: 'delete-request-005', deletedAt: '2026-08-22T00:00:00Z' });
  clock.set('2026-09-19T00:00:00Z');
  store.queuePurge({ ...scope, operationId: 'queue-002', queuedAt: clock.now() });
  const events = store.getAuditEvents({ tenantId: scope.tenantId, userId: scope.userId });
  assert.ok(events.some((event) => event.event === 'account.deletion_requested'));
  assert.ok(events.some((event) => event.event === 'account.soft_deleted'));
  assert.ok(events.some((event) => event.event === 'account.purge_queued'));
  for (const event of events) {
    assert.equal(Object.hasOwn(event, 'password'), false);
    assert.equal(Object.hasOwn(event, 'secret'), false);
    assert.equal(Object.hasOwn(event, 'content'), false);
  }
});

test('account records remain tenant scoped', () => {
  const store = createAccountLifecycleStore();
  store.registerAccount({ ...scope });
  assert.throws(
    () => store.getAccount({ tenantId: 'other-tenant', userId: scope.userId }),
    (error) => error.code === 'ACCOUNT_NOT_FOUND',
  );
  assert.equal(store.getAuditEvents({ tenantId: 'other-tenant' }).length, 0);
});
