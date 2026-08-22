// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventCoalescer, normalizeImapIdleEvent, normalizeSseEvent, normalizeWebSocketEvent } from './event-normalizer.mjs';

const context = { tenantId: 'tenant-a', userId: 'alice', clock: () => new Date('2026-08-22T12:00:00.000Z') };

test('normalizes SSE and WebSocket envelopes without exposing message content', () => {
  const sse = normalizeSseEvent({ id: 'sse-1', event: 'mail.changed', data: JSON.stringify({ tenantId: 'tenant-a', userId: 'alice', mailbox: 'INBOX', data: { mailbox: 'INBOX', uidNext: 42, body: 'secret' } }) }, context);
  assert.equal(sse.source, 'sse');
  assert.equal(sse.data.uidNext, 42);
  assert.equal(Object.hasOwn(sse.data, 'body'), false);
  const contentFree = normalizeWebSocketEvent(JSON.stringify({ eventId: 'ws-2', type: 'mail.changed', tenantId: 'tenant-a', userId: 'alice', data: 'private message body' }), context);
  assert.deepEqual(contentFree.data, {});
  const websocket = normalizeWebSocketEvent(JSON.stringify({ eventId: 'ws-1', type: 'calendar.changed', tenantId: 'tenant-a', userId: 'alice', resourceId: 'calendar-1', data: { resourceId: 'calendar-1', operation: 'updated' } }), context);
  assert.equal(websocket.source, 'websocket');
  assert.equal(websocket.data.operation, 'updated');
  assert.throws(() => normalizeSseEvent({ event: 'mail.changed', data: JSON.stringify({ tenantId: 'other', userId: 'alice' }) }, context), (error) => error.code === 'TENANT_MISMATCH');
});

test('normalizes IMAP IDLE events into the same tenant-scoped envelope', () => {
  const event = normalizeImapIdleEvent({ eventId: 'idle-1', tenantId: 'tenant-a', userId: 'alice', mailbox: 'INBOX', kind: 'exists', uidNext: 7, sequence: 3 }, context);
  assert.equal(event.type, 'mail.changed');
  assert.equal(event.source, 'imap-idle');
  assert.equal(event.data.uidNext, 7);
  assert.equal(event.data.operation, 'exists');
});

test('coalesces event bursts, drops duplicates, and flushes without polling', () => {
  const batches = [];
  const coalescer = createEventCoalescer({ windowMs: 60_000, maxWaitMs: 60_000, onFlush: (batch) => batches.push(batch) });
  const first = normalizeImapIdleEvent({ eventId: 'idle-1', tenantId: 'tenant-a', userId: 'alice', mailbox: 'INBOX', uidNext: 7 }, context);
  const second = normalizeImapIdleEvent({ eventId: 'idle-2', tenantId: 'tenant-a', userId: 'alice', mailbox: 'INBOX', uidNext: 8 }, context);
  assert.equal(coalescer.push(first).coalesced, false);
  assert.equal(coalescer.push(first).reason, 'duplicate');
  assert.equal(coalescer.push(second).coalesced, true);
  const flushed = coalescer.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].coalescedCount, 2);
  assert.equal(flushed[0].data.uidNext, 8);
  assert.equal(batches.length, 1);
  coalescer.close();
});
