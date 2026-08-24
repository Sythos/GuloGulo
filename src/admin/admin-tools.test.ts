// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailQueue } from '../mail/mail-queue.mjs';
import { createAdminTools, createAuditStore } from './admin-tools.ts';

const alice = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', userId: 'alice', role: 'user' });
const bob = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'bob', userId: 'bob', role: 'user' });
const master = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });
const provider = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'provider', role: 'provider' });
const monitor = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'monitor', role: 'monitor' });

test('audit store accepts bounded metadata and rejects bodies, secrets, and arbitrary payloads', () => {
  const audit = createAuditStore({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  const event = audit.record(master, {
    eventType: 'user.updated',
    subjectId: 'alice',
    action: 'update',
    result: 'success',
    reason: 'profile_change',
    requestId: 'req-001',
    metadata: { changedFields: ['displayName'], statusCode: 200 },
  });
  assert.equal(event.tenantId, 'acme');
  assert.equal(event.actorRole, 'tenant_master');
  assert.deepEqual(event.metadata, { changedFields: ['displayName'], statusCode: 200 });
  assert.equal(Object.hasOwn(event, 'password'), false);
  assert.throws(() => audit.record(master, { eventType: 'user.updated', metadata: { password: 'never' } }), (error) => error.code === 'SENSITIVE_AUDIT_DATA');
  assert.throws(() => audit.record(master, { eventType: 'user.updated', metadata: { body: 'mail content' } }), (error) => error.code === 'SENSITIVE_AUDIT_DATA');
  assert.throws(() => audit.record(master, { eventType: 'user.updated', metadata: { nested: { value: 'no' } } }), (error) => error.code === 'SENSITIVE_AUDIT_DATA');
});

test('master audit visibility is off by default and policy-controlled without content access', () => {
  const audit = createAuditStore({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  audit.record(master, { eventType: 'delegation.created', subjectId: 'alice', metadata: { targetUserId: 'bob' } });
  const hidden = createAdminTools({ audit, masterLogAccess: false });
  assert.throws(() => hidden.viewAudit(master), (error) => error.code === 'MASTER_LOG_ACCESS_DISABLED');
  const visible = createAdminTools({ audit, masterLogAccess: true });
  const events = visible.viewAudit(master);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'delegation.created');
  assert.equal(Object.hasOwn(events[0], 'body'), false);
  assert.equal(visible.viewAudit(provider).length, 1);
  assert.equal(visible.viewAudit(monitor).length, 1);
});

test('user audit view is self-scoped and cannot enumerate a colleague', () => {
  const audit = createAuditStore({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  audit.record(alice, { eventType: 'auth.login.success', subjectId: 'alice' });
  audit.record(bob, { eventType: 'auth.login.success', subjectId: 'bob' });
  assert.equal(audit.view(alice).length, 1);
  assert.equal(audit.view(alice)[0].subjectId, 'alice');
  assert.throws(() => audit.view(alice, { subjectUserId: 'bob' }), (error) => error.code === 'USER_SCOPE_DENIED' || error.code === 'PERMISSION_DENIED');
});

test('queue tools expose metadata only and keep actions outside master/read-only surfaces', () => {
  const queue = createMailQueue({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  queue.enqueue(alice, {
    sender: 'alice@acme.example',
    recipients: ['bob@acme.example'],
    sizeBytes: 12,
    messageRef: 'private-mail-reference',
  });
  const tools = createAdminTools({ queue, masterLogAccess: true });
  const visible = tools.viewQueue(master);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].queueId, 'q-00000001');
  assert.equal(Object.hasOwn(visible[0], 'messageRef'), false);
  assert.equal(Object.hasOwn(visible[0], 'body'), false);
  assert.throws(() => tools.viewQueue(alice), (error) => error.code === 'PERMISSION_DENIED');
  assert.equal(tools.viewQueue(monitor).length, 1);
  assert.equal(tools.authorizeQueueAction(provider, { action: 'retry', queueId: 'q-00000001' }).allowed, true);
  assert.throws(() => tools.authorizeQueueAction(master, { action: 'retry', queueId: 'q-00000001' }), (error) => error.code === 'PERMISSION_DENIED');
});

test('queue action and audit input validation fail closed', () => {
  const tools = createAdminTools({ queue: createMailQueue() });
  assert.throws(() => tools.authorizeQueueAction(provider, { action: 'run arbitrary shell' }), (error) => error.code === 'INVALID_ACTION');
  assert.throws(() => tools.authorizeQueueAction(provider, { action: 'retry', queueId: '../queue' }), (error) => error.code === 'INVALID_QUEUE_ID');
  assert.throws(() => tools.recordAudit(master, { eventType: 'admin.action', metadata: { content: 'forbidden' } }), (error) => error.code === 'SENSITIVE_AUDIT_DATA');
});
