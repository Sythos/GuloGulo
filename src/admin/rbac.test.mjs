// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_PERMISSIONS,
  PERMISSION_MATRIX,
  assertAdminActor,
  authorize,
  canAuthorize,
} from './rbac.mjs';

const user = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', userId: 'alice', role: 'user' });
const master = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });
const provider = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'provider', role: 'provider' });
const monitor = Object.freeze({ tenantId: 'acme', domain: 'acme.example', actorId: 'monitor', role: 'monitor' });

test('permission matrix is explicit and immutable for every supported role', () => {
  for (const role of ['provider', 'tenant_master', 'user', 'monitor']) {
    assert.ok(Array.isArray(PERMISSION_MATRIX[role]));
    assert.equal(Object.isFrozen(PERMISSION_MATRIX[role]), true);
  }
  assert.ok(PERMISSION_MATRIX.tenant_master.includes(ADMIN_PERMISSIONS.QUOTA_MANAGE));
  assert.ok(PERMISSION_MATRIX.user.includes(ADMIN_PERMISSIONS.CONTENT_WRITE));
  assert.equal(PERMISSION_MATRIX.tenant_master.includes(ADMIN_PERMISSIONS.CONTENT_READ), false);
  assert.equal(PERMISSION_MATRIX.provider.includes(ADMIN_PERMISSIONS.CONTENT_READ), false);
});

test('actors are canonicalized before permission evaluation', () => {
  const canonical = assertAdminActor(user);
  assert.deepEqual(canonical, {
    tenantId: 'acme',
    domain: 'acme.example',
    actorId: 'alice',
    userId: 'alice',
    role: 'user',
  });
  assert.equal(Object.isFrozen(canonical), true);
  assert.throws(() => assertAdminActor({ tenantId: 'acme', domain: 'acme.example', role: 'user' }), (error) => error.code === 'AUTHENTICATION_REQUIRED');
  assert.throws(() => assertAdminActor({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', role: 'admin' }), (error) => error.code === 'ROLE_DENIED');
  assert.throws(() => assertAdminActor({ tenantId: 'acme', domain: 'acme.example', actorId: 'alice', userId: 'bob', role: 'user' }), (error) => error.code === 'ACTOR_SCOPE_MISMATCH');
});

test('master may administer metadata but can never access mailbox or session content', () => {
  assert.equal(authorize(master, { permission: 'user.read', targetUserId: 'alice' }).allowed, true);
  assert.throws(
    () => authorize(master, { permission: 'content.read', resource: 'mailbox', targetUserId: 'alice' }),
    (error) => error.code === 'CONTENT_ACCESS_DENIED',
  );
  assert.throws(
    () => authorize(master, { permission: 'session.read', resource: 'user_session', targetUserId: 'alice' }),
    (error) => error.code === 'CONTENT_ACCESS_DENIED',
  );
  assert.throws(
    () => authorize(provider, { permission: 'user.read', resource: 'mailbox', targetUserId: 'alice' }),
    (error) => error.code === 'CONTENT_ACCESS_DENIED',
  );
});

test('tenant and user scopes fail closed before an adapter can be called', () => {
  assert.throws(
    () => authorize(master, { permission: 'quota.read', targetTenantId: 'other' }),
    (error) => error.code === 'CROSS_TENANT_DENIED',
  );
  assert.throws(
    () => authorize(user, { permission: 'content.read', targetUserId: 'bob', resource: 'mailbox' }),
    (error) => error.code === 'USER_SCOPE_DENIED',
  );
  assert.equal(canAuthorize(user, { permission: 'content.read', targetUserId: 'bob', resource: 'mailbox' }), false);
  assert.equal(canAuthorize(master, { permission: 'queue.read' }), true);
  assert.equal(canAuthorize(monitor, { permission: 'queue.action' }), false);
});

test('master log visibility is disabled by default and tenant-controlled when enabled', () => {
  assert.throws(
    () => authorize(master, { permission: 'audit.read', resource: 'audit' }),
    (error) => error.code === 'MASTER_LOG_ACCESS_DISABLED',
  );
  assert.equal(authorize(master, { permission: 'audit.read', resource: 'audit', policy: { masterLogAccess: true } }).allowed, true);
  assert.equal(authorize(provider, { permission: 'audit.read', resource: 'audit' }).allowed, true);
  assert.throws(
    () => authorize(master, { permission: 'policy.manage', resource: 'tenant_policy', policyField: 'masterLogAccess' }),
    (error) => error.code === 'POLICY_FIELD_DENIED',
  );
});

test('unknown permissions and malformed target identities are rejected', () => {
  assert.throws(() => authorize(master, { permission: 'tenant.admin' }), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(() => authorize(master, { permission: 'quota.read', targetUserId: '../alice' }), (error) => error.code === 'INVALID_USER');
});
