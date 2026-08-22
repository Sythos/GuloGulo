// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLdapIdentityClient, escapeFilter } from './ldap-client.mjs';
import { createTenantContext } from './tenant-context.mjs';

function settings(overrides = {}) {
  return { contract: { ldap: { enabled: true, url: 'ldaps://ldap.example.test:636', startTls: false, bindDn: 'cn=service,dc=example,dc=test', bindSecretRef: 'ldap/bind', userBaseDn: 'ou=users,dc=example,dc=test', connectTimeoutMs: 100, operationTimeoutMs: 100, poolMax: 2, retryAttempts: 0, ...overrides } } };
}

class FakeClient {
  static instances = [];
  constructor(options) { this.options = options; this.bound = []; this.searches = []; FakeClient.instances.push(this); }
  async bind(dn, password) { this.bound.push({ dn, password }); if (password === 'bad') throw new Error('invalid'); }
  async search(base, options) { this.searches.push({ base, options }); return { searchEntries: [{ dn: 'uid=alice,ou=users,dc=example,dc=test', uid: 'alice', mail: 'alice@example.test', displayName: 'Alice', active: true }] }; }
  async unbind() {}
}

test('LDAP filter is escaped and tenant domain is part of lookup', async () => {
  assert.equal(escapeFilter('a*(b)'), 'a\\2a\\28b\\29');
  FakeClient.instances.length = 0;
  const client = createLdapIdentityClient({ config: settings(), resolveSecret: async () => 'not-logged', ClientClass: FakeClient });
  const identity = await client.lookupUser({ tenantContext: createTenantContext({ tenantId: 'acme', domain: 'example.test' }), username: 'alice' });
  assert.equal(identity.mailAddress, 'alice@example.test');
  assert.match(FakeClient.instances[0].searches[0].options.filter, /alice@example\.test/);
});

test('LDAP authentication never treats a bind failure as success', async () => {
  const client = createLdapIdentityClient({ config: settings(), resolveSecret: async () => 'service-secret', ClientClass: FakeClient });
  const context = createTenantContext({ tenantId: 'acme', domain: 'example.test' });
  assert.equal(await client.authenticate({ tenantContext: context, username: 'alice', password: 'good' }), true);
  assert.equal(await client.authenticate({ tenantContext: context, username: 'alice', password: 'bad' }), false);
});

test('plain LDAP without StartTLS is rejected', () => {
  assert.throws(() => createLdapIdentityClient({ config: settings({ url: 'ldap://ldap.example.test:389' }), resolveSecret: async () => 'secret', ClientClass: FakeClient }), /requires StartTLS/);
});
