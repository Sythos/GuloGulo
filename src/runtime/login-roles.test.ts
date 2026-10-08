// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { authorize } from '../core/admin/rbac.ts';
import type { EnabledLdapIdentityClient, LdapLookupRequest, TenantIdentity } from '../integrations/types.ts';
import type { PlatformAdapter } from '../platform/contract/platform-adapter.ts';
import { createProvisionedLoginAuthenticator, resolveLoginRole } from './login.js';

type Directory = Record<string, TenantIdentity | null | 'throw'>;

function adapterFor(directory: Directory): PlatformAdapter {
  const client: EnabledLdapIdentityClient = {
    enabled: true,
    lookupUser: async ({ tenantContext, username }: LdapLookupRequest = {}) => {
      const domain = (tenantContext as { domain: string }).domain;
      const entry = directory[`${username as string}@${domain}`];
      if (entry === 'throw') throw new Error('directory unavailable');
      return entry ?? null;
    },
    authenticate: async () => true,
    healthCheck: async () => ({ status: 'ok' }),
    close: async () => {},
  };
  return {
    platformKind: 'standalone',
    loadConfig: async () => ({}),
    createIdentityClient: async () => client,
    createDataStore: async () => { throw new Error('not exercised by this test'); },
    createDavStore: async () => { throw new Error('not exercised by this test'); },
    createSessionStore: async () => new Map(),
  };
}

const quiet = { warn: () => {} };

function identity(externalId: string, role?: string): TenantIdentity {
  return { externalId, displayName: null, active: true, ...(role === undefined ? {} : { role }) };
}

test('login resolves user, tenant_master and monitor roles from the identity source', async () => {
  const login = createProvisionedLoginAuthenticator({
    logger: quiet,
    adapter: adapterFor({
      'alice@acme.test': identity('alice', 'user'),
      'bob@acme.test': identity('bob'),
      'master@acme.test': identity('master', 'tenant_master'),
      'watch@acme.test': identity('watch', 'monitor'),
    }),
  });
  assert.equal((await login({ email: 'alice@acme.test', password: 'x' }))?.role, 'user');
  assert.equal((await login({ email: 'bob@acme.test', password: 'x' }))?.role, 'user');
  assert.equal((await login({ email: 'master@acme.test', password: 'x' }))?.role, 'tenant_master');
  assert.equal((await login({ email: 'watch@acme.test', password: 'x' }))?.role, 'monitor');
});

test('login fails closed on unknown, ambiguous or non-tenant roles', async () => {
  const login = createProvisionedLoginAuthenticator({
    logger: quiet,
    adapter: adapterFor({
      'a@acme.test': identity('a', 'admin'),
      'b@acme.test': identity('b', 'provider'),
      'c@acme.test': identity('c', 'ambiguous'),
      'd@acme.test': identity('d', ''),
      'e@acme.test': identity('e', 'TENANT_MASTER'),
    }),
  });
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    assert.equal(await login({ email: `${name}@acme.test`, password: 'x' }), null, name);
  }
});

test('a failed directory lookup never elevates beyond the least-privilege user role', async () => {
  const login = createProvisionedLoginAuthenticator({ logger: quiet, adapter: adapterFor({ 'a@acme.test': 'throw' }) });
  assert.equal((await login({ email: 'a@acme.test', password: 'x' }))?.role, 'user');
  assert.equal(resolveLoginRole(null), 'user');
});

test('roles are tenant-bound: a master of one tenant is only a plain user in another', async () => {
  const login = createProvisionedLoginAuthenticator({
    logger: quiet,
    adapter: adapterFor({
      'master@acme.test': identity('master', 'tenant_master'),
      'master@other.test': identity('master'),
    }),
  });
  const acme = await login({ email: 'master@acme.test', password: 'x' });
  const other = await login({ email: 'master@other.test', password: 'x' });
  assert.equal(acme?.tenantId, 'acme.test');
  assert.equal(acme?.role, 'tenant_master');
  assert.equal(other?.tenantId, 'other.test');
  assert.equal(other?.role, 'user');
});

test('a role field smuggled in the credentials is ignored', async () => {
  const login = createProvisionedLoginAuthenticator({ logger: quiet, adapter: adapterFor({ 'alice@acme.test': identity('alice') }) });
  const session = await login({ email: 'alice@acme.test', password: 'x', role: 'tenant_master' } as never);
  assert.equal(session?.role, 'user');
});

test('a logged-in master cannot read another user private content', async () => {
  const login = createProvisionedLoginAuthenticator({
    logger: quiet,
    adapter: adapterFor({ 'master@acme.test': identity('master', 'tenant_master'), 'alice@acme.test': identity('alice') }),
  });
  const master = await login({ email: 'master@acme.test', password: 'x' });
  assert.ok(master);
  // rbac.ts is untyped (`@ts-nocheck`), so its defaulted option fields infer as `null`.
  const decide = (request: Record<string, string>) => authorize(master, request as never);
  assert.throws(
    () => decide({ permission: 'content.read', resource: 'mailbox', targetUserId: 'alice' }),
    (error: unknown) => (error as { code?: string }).code === 'CONTENT_ACCESS_DENIED',
  );
  assert.equal(decide({ permission: 'user.read', targetUserId: 'alice' }).allowed, true);
});
