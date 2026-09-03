// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetentionStore } from './retention.ts';
import { resolveDefaultRetentionStore, runPurgeBatchOnce, sanitizeWorkerId } from './run-purge-batch.ts';

function fakeLog() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { log: (line: string) => lines.push(line), error: (line: string) => errors.push(line), lines, errors };
}

test('resolveDefaultRetentionStore reports the in-memory store as non-persistent', () => {
  const resolution = resolveDefaultRetentionStore();
  assert.equal(resolution.persistent, false);
  assert.equal(typeof resolution.store.runPurgeBatch, 'function');
});

test('runPurgeBatchOnce is a safe no-op when no persistent store is configured', async () => {
  const log = fakeLog();
  const outcome = await runPurgeBatchOnce({ log });
  assert.deepEqual(outcome, { ran: false, result: null });
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /no persistent retention store configured/);
});

test('runPurgeBatchOnce runs a real batch against an injected persistent store', async () => {
  let clock = new Date('2026-08-01T00:00:00Z');
  const store = createRetentionStore({ now: () => clock });
  store.markDeleted({ tenantId: 'acme', userId: 'alice', itemId: 'message-001', resourceType: 'mail', deletedAt: '2026-06-01T00:00:00Z' });
  clock = new Date('2026-08-29T00:00:00Z');
  const log = fakeLog();

  const outcome = await runPurgeBatchOnce({
    workerId: 'test-worker-001',
    resolveStore: () => ({ store, persistent: true }),
    log,
  });

  assert.equal(outcome.ran, true);
  assert.equal(outcome.result?.purged, 1);
  assert.equal(store.getItem({ tenantId: 'acme', userId: 'alice', itemId: 'message-001' }).state, 'purged');
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /scanned=1 purged=1/);
  assert.equal(log.errors.length, 0);
});

test('runPurgeBatchOnce scopes the batch to tenantId/userId and forwards a limit', async () => {
  let clock = new Date('2026-08-01T00:00:00Z');
  const store = createRetentionStore({ now: () => clock });
  store.markDeleted({ tenantId: 'acme', userId: 'alice', itemId: 'message-001', resourceType: 'mail', deletedAt: '2026-06-01T00:00:00Z' });
  store.markDeleted({ tenantId: 'other-tenant', userId: 'bob', itemId: 'message-002', resourceType: 'mail', deletedAt: '2026-06-01T00:00:00Z' });
  clock = new Date('2026-08-29T00:00:00Z');

  const outcome = await runPurgeBatchOnce({
    tenantId: 'acme',
    userId: 'alice',
    limit: 10,
    resolveStore: () => ({ store, persistent: true }),
    log: fakeLog(),
  });

  assert.equal(outcome.result?.purged, 1);
  assert.equal(store.getItem({ tenantId: 'other-tenant', userId: 'bob', itemId: 'message-002' }).state, 'trashed');
});

test('runPurgeBatchOnce logs an error line when the batch reports failures', async () => {
  let clock = new Date('2026-08-01T00:00:00Z');
  const store = createRetentionStore({ now: () => clock, purgeItem: () => { throw Object.assign(new Error('boom'), { code: 'ADAPTER_DOWN' }); } });
  store.markDeleted({ tenantId: 'acme', userId: 'alice', itemId: 'message-001', resourceType: 'mail', deletedAt: '2026-06-01T00:00:00Z' });
  clock = new Date('2026-08-29T00:00:00Z');
  const log = fakeLog();

  const outcome = await runPurgeBatchOnce({ resolveStore: () => ({ store, persistent: true }), log });

  assert.equal(outcome.result?.failed, 1);
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /1 item\(s\) failed/);
});

test('sanitizeWorkerId keeps retention.ts\'s id charset and always starts with an alphanumeric', () => {
  assert.equal(sanitizeWorkerId('purge-host.example.test-4242'), 'purge-host.example.test-4242');
  assert.equal(sanitizeWorkerId('purge-h@st!-42'), 'purge-h@st--42');
  assert.match(sanitizeWorkerId('!!!weird-host!!!'), /^[A-Za-z0-9]/u);
});
