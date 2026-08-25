// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventCoalescer, normalizeImapIdleEvent, normalizeSseEvent, normalizeWebSocketEvent, RealtimeEventError } from './event-normalizer.ts';

const context = { tenantId: 'tenant-a', userId: 'alice', clock: () => new Date('2026-08-22T12:00:00.000Z') };
const hasCode = (code: string) => (error: unknown) => error instanceof RealtimeEventError && error.code === code;

test('normalizes SSE/WebSocket envelopes without exposing content', () => {
  const sse = normalizeSseEvent({ id: 'sse-1', event: 'mail.changed', data: JSON.stringify({ tenantId: 'tenant-a', userId: 'alice', mailbox: 'INBOX', data: { mailbox: 'INBOX', uidNext: 42, body: 'secret' } }) }, context);
  assert.equal(sse.data.uidNext, 42);
  assert.equal(Object.hasOwn(sse.data, 'body'), false);
  const contentFree = normalizeWebSocketEvent(JSON.stringify({ eventId: 'ws-2', type: 'mail.changed', tenantId: 'tenant-a', userId: 'alice', data: 'private message body' }), context);
  assert.deepEqual(contentFree.data, {});
  assert.throws(() => normalizeSseEvent({ event: 'mail.changed', data: JSON.stringify({ tenantId: 'other', userId: 'alice' }) }, context), hasCode('TENANT_MISMATCH'));
});

test('normalizes IMAP IDLE and coalesces duplicate-free bursts without polling', () => {
  const batches: Array<readonly unknown[]> = [];
  const coalescer = createEventCoalescer({ windowMs: 60_000, maxWaitMs: 60_000, onFlush: (batch) => batches.push(batch) });
  const first = normalizeImapIdleEvent({ eventId: 'idle-1', tenantId: 'tenant-a', userId: 'alice', mailbox: 'INBOX', uidNext: 7 }, context);
  const second = normalizeImapIdleEvent({ eventId: 'idle-2', tenantId: 'tenant-a', userId: 'alice', mailbox: 'INBOX', uidNext: 8 }, context);
  assert.equal(first.data.operation, 'exists');
  const accepted = coalescer.push(first);
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) assert.equal(accepted.coalesced, false);
  const duplicate = coalescer.push(first);
  assert.equal(duplicate.accepted, false);
  if (!duplicate.accepted) assert.equal(duplicate.reason, 'duplicate');
  const coalesced = coalescer.push(second);
  assert.equal(coalesced.accepted, true);
  if (coalesced.accepted) assert.equal(coalesced.coalesced, true);
  const flushed = coalescer.flush();
  assert.equal(flushed[0]?.coalescedCount, 2);
  assert.equal(flushed[0]?.data.uidNext, 8);
  assert.equal(batches.length, 1);
  coalescer.close();
});

test('normalization rejects missing subscription scope', () => {
  assert.throws(() => normalizeWebSocketEvent({ eventId: 'ws-1', type: 'mail.changed' }), hasCode('INVALID_EVENT'));
});
