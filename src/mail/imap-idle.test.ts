// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTenantContext } from '../integrations/tenant-context.ts';
import { createImapIdleBroker } from './imap-idle.ts';

const userContext = createTenantContext({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', role: 'user' });
const masterContext = createTenantContext({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });
const otherTenantContext = createTenantContext({ tenantId: 'other', domain: 'other.example', actorId: 'master', role: 'tenant_master' });

test('IMAP IDLE events are monotonic, reconnect-safe, immutable, and metadata-only', () => {
  const events: unknown[] = [];
  const idle = createImapIdleBroker({ clock: () => new Date('2026-08-24T10:00:00.000Z') });
  const first = idle.subscribe(userContext, { userId: 'alice', onEvent: (event) => events.push(event) });
  const firstNotification = idle.notify(masterContext, { userId: 'alice', mailbox: 'INBOX', uidNext: 10 });
  first.close();

  const second = idle.subscribe(userContext, { userId: 'alice', onEvent: (event) => events.push(event) });
  const secondNotification = idle.notify(masterContext, { userId: 'alice', mailbox: 'INBOX', kind: 'flags', uidNext: 11 });

  assert.equal(firstNotification.delivered, 1);
  assert.equal(secondNotification.delivered, 1);
  assert.deepEqual((events as Array<{ sequence: number; eventId: string }>).map((event) => event.sequence), [1, 2]);
  assert.deepEqual((events as Array<{ sequence: number; eventId: string }>).map((event) => event.eventId), [
    'idle-event-00000001',
    'idle-event-00000002',
  ]);
  assert.equal(second.id, 'idle-00000002');
  assert.equal(Object.isFrozen(events[0]), true);
  assert.deepEqual(Object.keys(events[0] as object).sort(), [
    'eventId',
    'kind',
    'mailbox',
    'occurredAt',
    'sequence',
    'tenantId',
    'uidNext',
    'userId',
  ]);
  assert.equal(Object.hasOwn(events[0] as object, 'messageRef'), false);
  second.close();
  assert.equal(idle.count(), 0);
});

test('IDLE delivery is tenant-scoped and user subscriptions are self-only', () => {
  const events: unknown[] = [];
  const idle = createImapIdleBroker();
  idle.subscribe(userContext, { userId: 'alice', onEvent: (event) => events.push(event) });

  assert.equal(idle.notify(otherTenantContext, { userId: 'alice' }).delivered, 0);
  assert.equal(idle.notify(masterContext, { userId: 'bob' }).delivered, 0);
  assert.equal(events.length, 0);
  assert.throws(
    () => idle.subscribe(userContext, { userId: 'bob', onEvent: () => undefined }),
    (error: unknown) => (error as { code?: string }).code === 'FORBIDDEN',
  );
});

test('invalid IDLE inputs fail closed and unknown event kinds are safe defaults', () => {
  const idle = createImapIdleBroker();
  assert.throws(() => idle.subscribe(userContext, { userId: 'alice', mailbox: '../private', onEvent: () => undefined }), /mailbox is invalid/);
  assert.throws(() => idle.subscribe(userContext, { userId: '', onEvent: () => undefined }), /userId is required/);

  const notification = idle.notify(masterContext, { userId: 'alice', kind: 'message body', uidNext: 0 });
  assert.equal(notification.event.kind, 'exists');
  assert.equal(notification.event.uidNext, null);
  assert.equal(notification.delivered, 0);
});
