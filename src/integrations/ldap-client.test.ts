// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLdapIdentityClient, escapeFilter } from './ldap-client.ts';
import { createTenantContext } from './tenant-context.ts';
import type { LdapClientOptions, LdapSearchOptions, LdapSearchResult } from './types.ts';

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { contract: { ldap: { enabled: true, url: 'ldaps://ldap.example.test:636', startTls: false, bindDn: 'cn=service,dc=example,dc=test', bindSecretRef: 'ldap/bind', userBaseDn: 'ou=users,dc=example,dc=test', connectTimeoutMs: 100, operationTimeoutMs: 100, poolMax: 2, retryAttempts: 0, ...overrides } } };
}

class FakeClient {
  static instances: FakeClient[] = [];
  readonly options: LdapClientOptions;
  readonly bound: Array<{ dn: string; password?: string }> = [];
  readonly searches: Array<{ base: string; options: LdapSearchOptions }> = [];
  constructor(options: LdapClientOptions) { this.options = options; FakeClient.instances.push(this); }
  async bind(dn: string, password?: string): Promise<void> { this.bound.push({ dn, password }); if (password === 'bad') throw new Error('invalid'); }
  async search(base: string, options: LdapSearchOptions): Promise<LdapSearchResult> { this.searches.push({ base, options }); return { searchEntries: [{ dn: 'uid=alice,ou=users,dc=example,dc=test', uid: 'alice', mail: 'alice@example.test', displayName: 'Alice', active: true }] }; }
  async unbind(): Promise<void> {}
}

test('LDAP filter is escaped and tenant domain is part of lookup', async () => {
  assert.equal(escapeFilter('a*(b)'), 'a\\2a\\28b\\29');
  FakeClient.instances.length = 0;
  const client = createLdapIdentityClient({ config: settings(), resolveSecret: async () => 'not-logged', ClientClass: FakeClient });
  if (!client.enabled) throw new Error('LDAP client unexpectedly disabled');
  const identity = await client.lookupUser({ tenantContext: createTenantContext({ tenantId: 'acme', domain: 'example.test' }), username: 'alice' });
  if (!identity) throw new Error('LDAP identity unexpectedly missing');
  assert.equal(identity.mailAddress, 'alice@example.test');
  const search = FakeClient.instances[0]?.searches[0];
  if (!search?.options.filter) throw new Error('LDAP search filter unexpectedly missing');
  assert.match(search.options.filter, /alice@example\.test/);
});

test('LDAP authentication never treats a bind failure as success', async () => {
  const client = createLdapIdentityClient({ config: settings(), resolveSecret: async () => 'service-secret', ClientClass: FakeClient });
  if (!client.enabled) throw new Error('LDAP client unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme', domain: 'example.test' });
  assert.equal(await client.authenticate({ tenantContext: context, username: 'alice', password: 'good' }), true);
  assert.equal(await client.authenticate({ tenantContext: context, username: 'alice', password: 'bad' }), false);
});

test('plain LDAP without StartTLS is rejected', () => {
  assert.throws(() => createLdapIdentityClient({ config: settings({ url: 'ldap://ldap.example.test:389' }), resolveSecret: async () => 'secret', ClientClass: FakeClient }), /requires StartTLS/);
});
