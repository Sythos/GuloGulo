// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNT_STATES, createAccountLifecycleStore } from './account-lifecycle.ts';
import { createRetentionStore } from './retention.ts';
import { createAccountLifecycleWiring } from './account-lifecycle-wiring.ts';
import type { BackupStorageAdapter } from '../backup/filesystem-backup-adapter.ts';
import type { ResourcePurgeInput } from './account-lifecycle-wiring.ts';

const scope = { tenantId: 'acme', userId: 'alice' };

/** A fake `BackupStorageAdapter` that records calls instead of touching disk — the wiring test stays filesystem-free per the task's own instruction. */
function fakeBackupAdapter(): BackupStorageAdapter & { readonly deletedFor: { tenantId: string; userId: string }[] } {
  const deletedFor: { tenantId: string; userId: string }[] = [];
  return {
    kind: 'fake',
    basePath: '/fake',
    writeArchive: async () => { throw new Error('not used in this test'); },
    readManifest: async () => { throw new Error('not used in this test'); },
    readEntry: async () => { throw new Error('not used in this test'); },
    readEncryptedMetadata: async () => null,
    deleteArchive: async () => ({ deleted: false }),
    deleteAccountArchives: async (input) => { deletedFor.push(input); return { deletedArchiveIds: ['archive-001'] }; },
    listArchives: async () => ['archive-001'],
    deletedFor,
  };
}

function advanceToPurgePending(clockRef: { current: Date }) {
  const store = createAccountLifecycleStore({ now: () => clockRef.current });
  store.registerAccount({ ...scope, cleanupPlan: ['aliases', 'backups', 'mailbox'] });
  store.requestDeletion({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-001' });
  store.softDeleteAccount({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-001' });
  clockRef.current = new Date('2026-08-29T00:00:00Z');
  return store;
}

test('completePurge routes the backups resource to the injected backup adapter and everything else to purgeResource', async () => {
  const clockRef = { current: new Date('2026-08-01T00:00:00Z') };
  const lifecycleStore = advanceToPurgePending(clockRef);
  const backupAdapter = fakeBackupAdapter();
  const purgedResources: ResourcePurgeInput[] = [];
  const wiring = createAccountLifecycleWiring({
    lifecycleStore,
    backupAdapter,
    purgeResource: async (input) => { purgedResources.push(input); return 'purged'; },
  });

  await wiring.queuePurge({ ...scope, operationId: 'queue-001' });
  const result = await wiring.completePurge({ ...scope, confirmation: 'PURGE:alice', operationId: 'purge-001' });

  assert.equal(result.operation.account.state, ACCOUNT_STATES.PURGED);
  assert.deepEqual(result.resourceResults, { aliases: 'purged', backups: 'purged', mailbox: 'purged' });
  // 'backups' went through the backup adapter, not the generic executor.
  assert.deepEqual(purgedResources.map((entry) => entry.resource).sort(), ['aliases', 'mailbox']);
  assert.deepEqual(backupAdapter.deletedFor, [scope]);
});

test('completePurge also runs a scoped retention purge batch when a retentionStore is injected', async () => {
  const clockRef = { current: new Date('2026-08-01T00:00:00Z') };
  const lifecycleStore = advanceToPurgePending(clockRef);
  lifecycleStore.queuePurge({ ...scope, operationId: 'queue-000' });
  const retentionStore = createRetentionStore({ now: () => clockRef.current });
  retentionStore.markDeleted({ tenantId: 'acme', userId: 'alice', itemId: 'message-001', resourceType: 'mail', deletedAt: '2026-06-01T00:00:00Z' });
  const wiring = createAccountLifecycleWiring({
    lifecycleStore,
    retentionStore,
    purgeResource: async () => 'purged',
  });

  const result = await wiring.completePurge({ ...scope, confirmation: 'PURGE:alice', operationId: 'purge-002' });

  assert.ok(result.retentionPurge);
  assert.equal(result.retentionPurge.purged, 1);
  assert.equal(retentionStore.getItem({ tenantId: 'acme', userId: 'alice', itemId: 'message-001' }).state, 'purged');
});

test('completePurge fails closed on the wrong state without calling any adapter', async () => {
  const lifecycleStore = createAccountLifecycleStore();
  lifecycleStore.registerAccount({ ...scope, cleanupPlan: ['aliases'] });
  const backupAdapter = fakeBackupAdapter();
  let purgeResourceCalls = 0;
  const wiring = createAccountLifecycleWiring({
    lifecycleStore,
    backupAdapter,
    purgeResource: async () => { purgeResourceCalls += 1; return 'purged'; },
  });

  await assert.rejects(
    () => wiring.completePurge({ ...scope, confirmation: 'PURGE:alice', operationId: 'purge-003' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE_TRANSITION',
  );
  assert.equal(purgeResourceCalls, 0);
  assert.equal(backupAdapter.deletedFor.length, 0);
});

test('completePurge fails closed on a missing/incorrect confirmation without calling any adapter', async () => {
  const clockRef = { current: new Date('2026-08-01T00:00:00Z') };
  const lifecycleStore = advanceToPurgePending(clockRef);
  lifecycleStore.queuePurge({ ...scope, operationId: 'queue-000' });
  const backupAdapter = fakeBackupAdapter();
  let purgeResourceCalls = 0;
  const wiring = createAccountLifecycleWiring({
    lifecycleStore,
    backupAdapter,
    purgeResource: async () => { purgeResourceCalls += 1; return 'purged'; },
  });

  await assert.rejects(
    () => wiring.completePurge({ ...scope, operationId: 'purge-004' }),
    (error: unknown) => (error as { code?: string }).code === 'STRONG_CONFIRMATION_REQUIRED',
  );
  assert.equal(purgeResourceCalls, 0);
  assert.equal(backupAdapter.deletedFor.length, 0);
});

test('completePurge fails closed while an account hold is active without calling any adapter', async () => {
  const clockRef = { current: new Date('2026-08-01T00:00:00Z') };
  const lifecycleStore = advanceToPurgePending(clockRef);
  lifecycleStore.queuePurge({ ...scope, operationId: 'queue-000' });
  lifecycleStore.addAccountHold({ ...scope, holdId: 'hold-001', reasonCode: 'legal_hold' });
  const backupAdapter = fakeBackupAdapter();
  let purgeResourceCalls = 0;
  const wiring = createAccountLifecycleWiring({
    lifecycleStore,
    backupAdapter,
    purgeResource: async () => { purgeResourceCalls += 1; return 'purged'; },
  });

  await assert.rejects(
    () => wiring.completePurge({ ...scope, confirmation: 'PURGE:alice', operationId: 'purge-005' }),
    (error: unknown) => (error as { code?: string }).code === 'ACCOUNT_ON_HOLD',
  );
  assert.equal(purgeResourceCalls, 0);
  assert.equal(backupAdapter.deletedFor.length, 0);
});

test('queuePurge logs the existing backup archive count without mutating anything beyond the underlying store', async () => {
  const clockRef = { current: new Date('2026-08-01T00:00:00Z') };
  const lifecycleStore = createAccountLifecycleStore({ now: () => clockRef.current });
  lifecycleStore.registerAccount({ ...scope, cleanupPlan: ['aliases'] });
  lifecycleStore.requestDeletion({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-001' });
  lifecycleStore.softDeleteAccount({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-001' });
  clockRef.current = new Date('2026-08-29T00:00:00Z');
  const backupAdapter = fakeBackupAdapter();
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const wiring = createAccountLifecycleWiring({
    lifecycleStore,
    backupAdapter,
    purgeResource: async () => 'purged',
    logger: { info: (event, details) => events.push({ event, details }) },
  });

  const operation = await wiring.queuePurge({ ...scope, operationId: 'queue-002' });

  assert.equal(operation.account.state, ACCOUNT_STATES.PURGE_PENDING);
  assert.deepEqual(events, [{ event: 'account_lifecycle.purge_queued', details: { tenantId: 'acme', userId: 'alice', existingBackupArchives: 1 } }]);
});
