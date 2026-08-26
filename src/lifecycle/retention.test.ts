// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetentionStore } from './retention.ts';

const scope = { tenantId: 'acme', userId: 'alice', itemId: 'message-001' };

test('retention enforces the 28-day boundary and resumes idempotently after an adapter failure', () => {
  let clock = new Date('2026-08-01T00:00:00Z');
  let attempts = 0;
  const store = createRetentionStore({ now: () => clock, purgeItem: () => { attempts += 1; return attempts > 1; } });
  store.markDeleted({ ...scope, resourceType: 'mail', idempotencyKey: 'delete-001' });
  clock = new Date('2026-08-28T23:59:59.999Z');
  assert.equal(store.runPurgeBatch({ workerId: 'worker-001', operationId: 'before-boundary' }).purged, 0);
  clock = new Date('2026-08-29T00:00:00Z');
  const failed = store.runPurgeBatch({ workerId: 'worker-001', operationId: 'failed-batch' });
  assert.equal(failed.failed, 1);
  const completed = store.runPurgeBatch({ workerId: 'worker-001', operationId: 'resumed-batch' });
  assert.equal(completed.purged, 1);
  assert.deepEqual(store.runPurgeBatch({ workerId: 'worker-001', operationId: 'resumed-batch' }), completed);
});

test('holds, locks, restores, tenant scope and audit stay safe and metadata-only', () => {
  let clock = new Date('2026-08-01T00:00:00Z');
  const store = createRetentionStore({ now: () => clock });
  store.markDeleted({ ...scope, resourceType: 'mail', idempotencyKey: 'delete-002' });
  store.addHold({ ...scope, holdId: 'hold-001', reasonCode: 'legal_hold' });
  clock = new Date('2026-08-29T00:00:00Z');
  assert.equal(store.listCandidates().length, 0);
  store.releaseHold({ ...scope, holdId: 'hold-001' });
  store.acquireLock({ ...scope, lockId: 'lock-001', owner: 'worker-lock' });
  assert.equal(store.listCandidates().length, 0);
  store.releaseLock({ ...scope, lockId: 'lock-001', owner: 'worker-lock' });
  store.restoreItem({ ...scope, idempotencyKey: 'restore-001' });
  assert.equal(store.listCandidates().length, 0);
  assert.throws(() => store.getItem({ ...scope, tenantId: 'other-tenant' }), (error: unknown) => (error as { code?: string }).code === 'ITEM_NOT_FOUND');
  for (const event of store.getAuditEvents({ tenantId: scope.tenantId, userId: scope.userId })) {
    assert.equal(Object.hasOwn(event, 'content'), false);
    assert.equal(Object.hasOwn(event.metadata, 'content'), false);
  }
});
