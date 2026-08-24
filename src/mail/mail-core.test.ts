// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Transitional typing waiver: the LP2-LP9 recovery plan closes this debt at
// the final server-language audit after each protocol slice is operational.
// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';

import { createImapIdleBroker } from './imap-idle.mjs';
import { createMailCore } from './mail-core.ts';
import { createMailPolicy } from './mail-policy.ts';
import { createMailQueue } from './mail-queue.ts';

const tenantContext = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', role: 'user' });
const masterContext = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });
const users = [
  { userId: 'alice', address: 'alice@acme.example' },
  { userId: 'bob', address: 'bob@acme.example' },
];
const aliases = [
  { address: 'sales@acme.example', destinations: ['alice', 'bob'] },
];

function createTestCore({ rspamd = { async scan() { return { action: 'accept', score: -1, symbols: [] }; } }, clamav = { async scan() { return { status: 'clean' }; } }, lmtp } = {}) {
  const audits = [];
  const policy = createMailPolicy({ tenantId: 'acme', domain: 'acme.example' });
  const auditedPolicy = Object.freeze({
    ...policy,
    audit(details) {
      const event = policy.audit(details);
      audits.push(event);
      return event;
    },
  });
  const queue = createMailQueue({ retryBaseMs: 1_000 });
  const idle = createImapIdleBroker({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  const core = createMailCore({
    policy: auditedPolicy,
    rspamd,
    clamav,
    lmtp: lmtp ?? { async deliver() { return { status: 'delivered', mailbox: 'INBOX', uidNext: 42 }; } },
    quota: { async reserve() { return { accepted: true }; } },
    queue,
    idle,
  });
  return { core, queue, idle, audits };
}

test('inbound delivery resolves explicit aliases and rejects unknown recipients without catch-all', async () => {
  const { core } = createTestCore();
  const idleEvents = [];
  const subscription = core.subscribeIdle(tenantContext, { userId: 'alice', onEvent: (event) => idleEvents.push(event) });

  const delivered = await core.receiveInbound(tenantContext, {
    sender: 'external@example.net',
    recipients: ['sales@acme.example'],
    users,
    aliases,
    sizeBytes: 512,
    messageRef: 'opaque-message-1',
  });

  assert.equal(delivered.status, 'delivered');
  assert.deepEqual(delivered.delivered, ['alice@acme.example', 'bob@acme.example']);
  assert.equal(idleEvents.length, 1);
  assert.equal(idleEvents[0].mailbox, 'INBOX');
  assert.equal(Object.hasOwn(idleEvents[0], 'messageRef'), false);
  subscription.close();

  await assert.rejects(
    core.receiveInbound(tenantContext, {
      sender: 'external@example.net',
      recipients: ['does-not-exist@acme.example'],
      users,
      aliases,
      sizeBytes: 512,
    }),
    (error) => error.code === 'RECIPIENT_REJECTED',
  );
});

test('unauthenticated submission is rejected and a user cannot configure forwarding', async () => {
  const { core } = createTestCore();
  await assert.rejects(
    core.submit(tenantContext, {
      authenticated: false,
      authenticatedUserId: 'alice',
      sender: 'alice@acme.example',
      recipients: ['outside.example@remote.test'],
      users,
      aliases,
      sizeBytes: 128,
    }),
    (error) => error.code === 'OPEN_RELAY_DISABLED',
  );
  assert.throws(() => core.validateSieve(tenantContext, 'redirect "other@example.net";'), (error) => error.code === 'FORWARDING_DISABLED');
});

test('submission rejects unknown internal recipients and enforces the per-user rate limit', async () => {
  const policy = createMailPolicy({ tenantId: 'acme', domain: 'acme.example', maxMessagesPerUserPerMinute: 1 });
  const core = createMailCore({
    policy,
    rspamd: { async scan() { return { action: 'accept' }; } },
    clamav: { async scan() { return { status: 'clean' }; } },
  });
  await assert.rejects(
    core.submit(tenantContext, {
      authenticated: true,
      authenticatedUserId: 'alice',
      sender: 'alice@acme.example',
      recipients: ['missing@acme.example'],
      users,
      aliases,
      sizeBytes: 10,
    }),
    (error) => error.code === 'RECIPIENT_REJECTED',
  );
  const first = await core.submit(tenantContext, {
    authenticated: true,
    authenticatedUserId: 'alice',
    sender: 'alice@acme.example',
    recipients: ['external@example.net'],
    users,
    aliases,
    sizeBytes: 10,
  });
  assert.equal(first.status, 'queued');
  await assert.rejects(
    core.submit(tenantContext, {
      authenticated: true,
      authenticatedUserId: 'alice',
      sender: 'alice@acme.example',
      recipients: ['external@example.net'],
      users,
      aliases,
      sizeBytes: 10,
    }),
    (error) => error.code === 'RATE_LIMITED',
  );
});

test('authenticated submission is queued and queue views never expose message content', async () => {
  const { core } = createTestCore();
  const result = await core.submit(tenantContext, {
    authenticated: true,
    authenticatedUserId: 'alice',
    sender: 'alice@acme.example',
    recipients: ['external@example.net'],
    users,
    aliases,
    sizeBytes: 2048,
    messageRef: 'private-message-body-handle',
  });
  assert.equal(result.status, 'queued');
  assert.equal(result.queue.state, 'queued');
  assert.equal(Object.hasOwn(result.queue, 'messageRef'), false);

  const visible = core.viewQueue(masterContext);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].queueId, result.queue.queueId);
  assert.equal(Object.hasOwn(visible[0], 'messageRef'), false);
  assert.equal(JSON.stringify(visible).includes('private-message-body-handle'), false);
});

test('Rspamd and ClamAV failures are observable and fail closed', async () => {
  const spam = createTestCore({ rspamd: { async scan() { return { action: 'reject', score: 12.3, symbols: ['SPAM'] }; } } });
  const spamResult = await spam.core.receiveInbound(tenantContext, {
    sender: 'external@example.net', recipients: ['alice@acme.example'], users, aliases, sizeBytes: 100,
  });
  assert.equal(spamResult.status, 'rejected');
  assert.equal(spamResult.reason, 'spam_policy');
  assert.equal(spam.audits[0].eventType, 'mail.delivery.failed');

  const malware = createTestCore({ clamav: { async scan() { return { status: 'infected', signature: 'Eicar.Test' }; } } });
  const malwareResult = await malware.core.receiveInbound(tenantContext, {
    sender: 'external@example.net', recipients: ['alice@acme.example'], users, aliases, sizeBytes: 100,
  });
  assert.equal(malwareResult.status, 'quarantined');
  assert.equal(malwareResult.reason, 'malware_detected');

  const unavailable = createTestCore({ rspamd: { async scan() { return { action: 'unavailable' }; } } });
  const unavailableResult = await unavailable.core.receiveInbound(tenantContext, {
    sender: 'external@example.net', recipients: ['alice@acme.example'], users, aliases, sizeBytes: 100,
  });
  assert.equal(unavailableResult.status, 'deferred');
  assert.equal(unavailableResult.queue.state, 'queued');
});

test('LMTP temporary failures enter retry queue and exhaustion becomes a bounce', async () => {
  const { core, queue } = createTestCore({ lmtp: { async deliver() { return { status: 'temporary_failure' }; } } });
  const result = await core.receiveInbound(tenantContext, {
    sender: 'external@example.net', recipients: ['alice@acme.example'], users, aliases, sizeBytes: 100,
  });
  assert.equal(result.status, 'deferred');
  const queueId = result.queue.queueId;
  let state = result.queue;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    queue.claim(queueId, masterContext);
    state = queue.defer(queueId, masterContext, { reason: 'lmtp_temporary_failure' });
  }
  assert.equal(state.state, 'bounced');
  assert.equal(state.reason, 'retry_exhausted');
});

test('quota rejection is explicit and does not acknowledge delivery', async () => {
  const policy = createMailPolicy({ tenantId: 'acme', domain: 'acme.example' });
  const core = createMailCore({
    policy,
    rspamd: { async scan() { return { action: 'accept' }; } },
    clamav: { async scan() { return { status: 'clean' }; } },
    quota: { async reserve() { return { accepted: false, reason: 'quota_exceeded' }; } },
    lmtp: { async deliver() { throw new Error('must not be called'); } },
  });
  await assert.rejects(
    core.receiveInbound(tenantContext, { sender: 'external@example.net', recipients: ['alice@acme.example'], users, aliases, sizeBytes: 100 }),
    (error) => error.code === 'QUOTA_EXCEEDED',
  );
});

test('IMAP IDLE sequence is deterministic and reconnect-safe', () => {
  const idle = createImapIdleBroker({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  const events = [];
  const subscription = idle.subscribe(tenantContext, { userId: 'alice', mailbox: 'INBOX', onEvent: (event) => events.push(event) });
  const first = idle.notify(masterContext, { userId: 'alice', mailbox: 'INBOX', uidNext: 10 });
  const second = idle.notify(masterContext, { userId: 'alice', mailbox: 'INBOX', uidNext: 11 });
  assert.equal(first.delivered, 1);
  assert.equal(second.delivered, 1);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(events.map((event) => event.eventId), ['idle-event-00000001', 'idle-event-00000002']);
  subscription.close();
  assert.equal(idle.count(), 0);
});
