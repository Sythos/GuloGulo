// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTenantAccess, createTenantContext, tenantScope } from './tenant-context.ts';

test('tenant context is canonical and immutable', () => {
  const context = createTenantContext({ tenantId: 'acme', domain: 'Example.COM', actorId: 'user-1', role: 'user' });
  assert.equal(context.domain, 'example.com');
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(tenantScope(context), { tenantId: 'acme' });
});

test('cross-tenant access is denied before a datastore query', () => {
  const context = createTenantContext({ tenantId: 'acme', domain: 'acme.example', role: 'tenant_master' });
  assert.throws(() => assertTenantAccess(context, 'other'), /cross-tenant access denied/);
});

test('invalid context values fail closed', () => {
  assert.throws(() => createTenantContext({ tenantId: 'ACME', domain: 'acme.example' }), /tenantId is invalid/);
  assert.throws(() => createTenantContext({ tenantId: 'acme', domain: 'not a domain' }), /domain is invalid/);
  assert.throws(() => createTenantContext({ tenantId: 'acme', domain: 'acme.example', role: 'admin' }), /role is invalid/);
});
