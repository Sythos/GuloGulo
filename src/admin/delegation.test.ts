// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDelegationStore } from './delegation.ts';
import { authorize } from './rbac.ts';

const owner = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', userId: 'alice', role: 'user' });
const bob = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'bob', userId: 'bob', role: 'user' });
const carol = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'carol', userId: 'carol', role: 'user' });
const master = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });
const otherTenantMaster = Object.freeze({ tenantId: 'other', domain: 'other.example', actorId: 'master', role: 'tenant_master' });

test('a user can delegate read or write access to one colleague with canonical permissions', () => {
  const store = createDelegationStore({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  const record = store.create(owner, {
    ownerUserId: 'alice',
    delegateUserId: 'bob',
    permissions: ['write'],
    expiresAt: '2026-08-23T10:00:00.000Z',
  });
  assert.deepEqual(record.permissions, ['read', 'write']);
  assert.equal(record.forced, false);
  assert.equal(record.policySource, 'user_delegated');
  assert.equal(store.canAccess(bob, 'alice', 'read'), true);
  assert.equal(store.canAccess(bob, 'alice', 'write'), true);
  assert.equal(store.canAccess(carol, 'alice', 'read'), false);
  assert.equal(store.canAccess(master, 'alice', 'read'), false);
  assert.equal(authorize(bob, { permission: 'content.read', resource: 'calendar', targetUserId: 'alice', delegationStore: store }).allowed, true);
  assert.equal(authorize(bob, { permission: 'content.write', resource: 'mailbox', targetUserId: 'alice', delegationStore: store }).allowed, true);
});

test('only one active delegate is allowed and expired delegation can be replaced', () => {
  let current = new Date('2026-08-22T10:00:00.000Z');
  const store = createDelegationStore({ clock: () => current });
  store.create(owner, { ownerUserId: 'alice', delegateUserId: 'bob', expiresAt: '2026-08-23T10:00:00.000Z' });
  assert.throws(
    () => store.create(owner, { ownerUserId: 'alice', delegateUserId: 'carol' }),
    (error) => error.code === 'ACTIVE_DELEGATE_EXISTS' && error.status === 409,
  );
  current = new Date('2026-08-24T10:00:00.000Z');
  assert.equal(store.canAccess(bob, 'alice', 'read'), false);
  const replacement = store.create(owner, { ownerUserId: 'alice', delegateUserId: 'carol' });
  assert.equal(replacement.delegateUserId, 'carol');
  assert.equal(store.canAccess(carol, 'alice', 'read'), true);
});

test('master-forced delegation is explicit, visible, audited, and not user-revocable', () => {
  const store = createDelegationStore({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  assert.throws(
    () => store.create(master, { ownerUserId: 'alice', delegateUserId: 'bob' }),
    (error) => error.code === 'FORCED_FLAG_REQUIRED',
  );
  const record = store.create(master, {
    ownerUserId: 'alice',
    delegateUserId: 'bob',
    permissions: ['read'],
    forced: true,
    reason: 'support coverage',
  });
  assert.equal(record.forced, true);
  assert.equal(record.policySource, 'master_forced');
  assert.throws(() => store.revoke(owner, 'alice', { reason: 'owner_attempt' }), (error) => error.code === 'FORCED_DELEGATION_LOCKED');
  assert.throws(() => store.update(owner, 'alice', { delegateUserId: 'carol' }), (error) => error.code === 'FORCED_DELEGATION_LOCKED');
  assert.throws(() => store.events(master), (error) => error.code === 'MASTER_LOG_ACCESS_DISABLED');
  assert.equal(store.events(master, { masterLogAccess: true }).length, 1);
  assert.equal(store.events(master, { masterLogAccess: true })[0].eventType, 'delegation.created');
  assert.equal(store.get(master, 'alice').forced, true);
});

test('owner may update and revoke a normal delegation, while another tenant cannot inspect it', () => {
  const store = createDelegationStore({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  store.create(owner, { ownerUserId: 'alice', delegateUserId: 'bob' });
  const updated = store.update(owner, 'alice', { delegateUserId: 'carol', permissions: ['read'], reason: 'temporary cover' });
  assert.equal(updated.delegateUserId, 'carol');
  assert.equal(store.canAccess(bob, 'alice', 'read'), false);
  assert.equal(store.canAccess(carol, 'alice', 'read'), true);
  const revoked = store.revoke(owner, 'alice', { reason: 'no longer needed' });
  assert.equal(revoked.status, 'expired');
  assert.equal(store.canAccess(carol, 'alice', 'read'), false);
  assert.throws(() => store.get(otherTenantMaster, 'alice'), (error) => error.code === 'NOT_FOUND');
});

test('invalid, self, cross-role, and cross-tenant delegation attempts fail closed', () => {
  const store = createDelegationStore({ clock: () => new Date('2026-08-22T10:00:00.000Z') });
  assert.throws(() => store.create(owner, { ownerUserId: 'alice', delegateUserId: 'alice' }), (error) => error.code === 'SELF_DELEGATION');
  assert.throws(() => store.create(bob, { ownerUserId: 'alice', delegateUserId: 'carol' }), (error) => error.code === 'OWNER_SCOPE_DENIED');
  store.create(master, { ownerUserId: 'alice', delegateUserId: 'carol', forced: true, reason: 'tenant policy' });
  assert.throws(() => store.get(otherTenantMaster, 'alice'), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => store.create(master, { ownerUserId: 'alice', delegateUserId: 'bob', forced: true }), (error) => error.code === 'REASON_REQUIRED');
});
