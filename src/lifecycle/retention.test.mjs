// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRetentionStore,
  DEFAULT_TRASH_RETENTION_DAYS,
  RETENTION_ITEM_STATES,
  RETENTION_METRIC_NAMES,
} from './retention.mjs';

const tenant = 'acme';
const alice = 'alice';

function makeClock(value = '2026-08-22T00:00:00.000Z') {
  let current = new Date(value);
  return {
    now: () => new Date(current),
    set(valueToSet) {
      current = new Date(valueToSet);
    },
    get value() {
      return new Date(current);
    },
  };
}

function oldDate(clock, days = DEFAULT_TRASH_RETENTION_DAYS) {
  return new Date(clock.value.getTime() - (days * 24 * 60 * 60 * 1000));
}

test('trash is not purged before 28 days and is purged at the boundary', () => {
  const clock = makeClock();
  const store = createRetentionStore({ now: clock.now });
  const deletedAt = oldDate(clock);
  store.markDeleted({
    tenantId: tenant,
    userId: alice,
    itemId: 'mail-001',
    resourceType: 'mail',
    deletedAt,
    idempotencyKey: 'delete-001',
  });

  clock.set(new Date(clock.value.getTime() - 1));
  assert.deepEqual(store.listCandidates({ tenantId: tenant, userId: alice }), []);
  const early = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-early', tenantId: tenant, userId: alice });
  assert.equal(early.purged, 0);
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-001' }).state, RETENTION_ITEM_STATES.TRASHED);

  clock.set('2026-08-22T00:00:00.000Z');
  assert.equal(store.listCandidates({ tenantId: tenant, userId: alice }).length, 1);
  const final = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-boundary', tenantId: tenant, userId: alice });
  assert.equal(final.purged, 1);
  assert.equal(final.failed, 0);
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-001' }).state, RETENTION_ITEM_STATES.PURGED);
  assert.equal(final.items[0].itemId, 'mail-001');
  assert.equal(Object.hasOwn(final.items[0], 'body'), false);
});

test('purge is bounded, resumable, and idempotent by operation id', () => {
  const clock = makeClock();
  const store = createRetentionStore({ now: clock.now, maxBatchSize: 2 });
  for (const itemId of ['mail-001', 'mail-002', 'mail-003']) {
    store.markDeleted({
      tenantId: tenant,
      userId: alice,
      itemId,
      resourceType: 'mail',
      deletedAt: oldDate(clock),
      idempotencyKey: `delete-${itemId}`,
    });
  }
  const first = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-batch-001', limit: 2 });
  assert.equal(first.batchSize, 2);
  assert.equal(first.scanned, 2);
  assert.equal(first.purged, 2);
  assert.equal(first.remaining, 1);
  assert.deepEqual(store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-batch-001', limit: 2 }), first);

  const second = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-batch-002', limit: 2 });
  assert.equal(second.purged, 1);
  assert.equal(second.remaining, 0);
  assert.equal(store.getMetrics()[RETENTION_METRIC_NAMES.ITEMS_PURGED], 3);
});

test('holds and active locks prevent purge until released', () => {
  const clock = makeClock();
  const store = createRetentionStore({ now: clock.now });
  for (const itemId of ['mail-held', 'mail-locked']) {
    store.markDeleted({
      tenantId: tenant,
      userId: alice,
      itemId,
      resourceType: 'mail',
      deletedAt: oldDate(clock),
      idempotencyKey: `delete-${itemId}`,
    });
  }
  store.addHold({ tenantId: tenant, userId: alice, itemId: 'mail-held', holdId: 'hold-001', reasonCode: 'legal_hold' });
  store.acquireLock({ tenantId: tenant, userId: alice, itemId: 'mail-locked', lockId: 'lock-001', owner: 'other-worker' });
  const blocked = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-blocked' });
  assert.equal(blocked.purged, 0);
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-held' }).state, RETENTION_ITEM_STATES.TRASHED);
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-locked' }).state, RETENTION_ITEM_STATES.TRASHED);

  store.releaseHold({ tenantId: tenant, userId: alice, itemId: 'mail-held', holdId: 'hold-001' });
  store.releaseLock({ tenantId: tenant, userId: alice, itemId: 'mail-locked', lockId: 'lock-001', owner: 'other-worker' });
  const unblocked = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-unblocked' });
  assert.equal(unblocked.purged, 2);
});

test('restoration wins over an old purge candidate and a later deletion gets a new generation', () => {
  const clock = makeClock();
  const store = createRetentionStore({ now: clock.now });
  const deletedAt = oldDate(clock);
  store.markDeleted({ tenantId: tenant, userId: alice, itemId: 'mail-restore', resourceType: 'mail', deletedAt, idempotencyKey: 'delete-001' });
  store.restoreItem({ tenantId: tenant, userId: alice, itemId: 'mail-restore', idempotencyKey: 'restore-001' });
  const afterRestore = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-restored' });
  assert.equal(afterRestore.purged, 0);
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-restore' }).state, RETENTION_ITEM_STATES.RESTORED);

  store.markDeleted({ tenantId: tenant, userId: alice, itemId: 'mail-restore', resourceType: 'mail', deletedAt, idempotencyKey: 'delete-002' });
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-restore' }).generation, 2);
  const afterNewDelete = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-generation-2' });
  assert.equal(afterNewDelete.purged, 1);
});

test('adapter failures leave content trashable and are retried safely', () => {
  const clock = makeClock();
  let shouldFail = true;
  const seen = [];
  const store = createRetentionStore({
    now: clock.now,
    purgeItem(item) {
      seen.push(item);
      if (shouldFail) throw Object.assign(new Error('temporary storage failure'), { code: 'STORAGE_UNAVAILABLE' });
      return true;
    },
  });
  store.markDeleted({ tenantId: tenant, userId: alice, itemId: 'mail-retry', resourceType: 'mail', deletedAt: oldDate(clock), idempotencyKey: 'delete-retry' });
  const failed = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-failed' });
  assert.equal(failed.failed, 1);
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-retry' }).state, RETENTION_ITEM_STATES.TRASHED);
  shouldFail = false;
  const retried = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-retry' });
  assert.equal(retried.purged, 1);
  assert.equal(seen[0].itemId, 'mail-retry');
  assert.equal(Object.hasOwn(seen[0], 'body'), false);
  assert.equal(store.getAuditEvents({ tenantId: tenant, userId: alice, event: 'retention.purge_failed' }).length, 1);
});

test('a restore or hold introduced during the purge callback wins the final safety check', () => {
  const clock = makeClock();
  let store;
  store = createRetentionStore({
    now: clock.now,
    purgeItem() {
      store.restoreItem({ tenantId: tenant, userId: alice, itemId: 'mail-reentrant', idempotencyKey: 'restore-reentrant' });
      return true;
    },
  });
  store.markDeleted({ tenantId: tenant, userId: alice, itemId: 'mail-reentrant', resourceType: 'mail', deletedAt: oldDate(clock), idempotencyKey: 'delete-reentrant' });
  const result = store.runPurgeBatch({ workerId: 'worker-a', operationId: 'purge-reentrant' });
  assert.equal(result.purged, 0);
  assert.equal(store.getItem({ tenantId: tenant, userId: alice, itemId: 'mail-reentrant' }).state, RETENTION_ITEM_STATES.RESTORED);
});

test('retention operations remain tenant and user scoped', () => {
  const store = createRetentionStore({ now: () => new Date('2026-08-22T00:00:00Z') });
  store.markDeleted({ tenantId: tenant, userId: alice, itemId: 'mail-scope', resourceType: 'mail', deletedAt: '2026-07-01T00:00:00Z', idempotencyKey: 'delete-scope' });
  assert.throws(
    () => store.getItem({ tenantId: 'other-tenant', userId: alice, itemId: 'mail-scope' }),
    (error) => error.code === 'ITEM_NOT_FOUND',
  );
  assert.equal(store.getAuditEvents({ tenantId: 'other-tenant' }).length, 0);
});
