// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStandaloneAdapter } from './standalone-adapter.ts';
import type { PlatformAdapter } from '../contract/platform-adapter.ts';

/** An environment with no GULOGULO_CONFIG_FILE set: config.ts falls back to
 * its optional default mount, which does not exist on a test machine, so
 * loadConfig() resolves to schema defaults — ldap and postgres both disabled. */
function emptyEnvironment(): NodeJS.ProcessEnv {
  return {};
}

test('createStandaloneAdapter satisfies the PlatformAdapter contract and identifies as standalone', () => {
  const adapter: PlatformAdapter = createStandaloneAdapter({ environment: emptyEnvironment() });
  assert.equal(adapter.platformKind, 'standalone');
});

test('loadConfig() delegates to src/runtime/config.ts and resolves disabled integrations by default', async () => {
  const adapter = createStandaloneAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig() as Record<string, any>;
  assert.equal(config.contract.ldap.enabled, false);
  assert.equal(config.contract.postgres.enabled, false);
});

test('createIdentityClient() builds a real LdapIdentityClient from src/integrations/ldap-client.ts', async () => {
  const adapter = createStandaloneAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const client = await adapter.createIdentityClient(config);
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.healthCheck(), { status: 'disabled' });
  assert.equal(await client.authenticate(), false);
});

test('createDataStore() builds a real PostgresStore from src/integrations/postgres-store.ts', async () => {
  const adapter = createStandaloneAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const store = await adapter.createDataStore(config);
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.healthCheck(), { status: 'disabled' });
  await store.close();
});

function ldapEnabledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GULOGULO_LDAP_ENABLED: 'true',
    GULOGULO_LDAP_URL: 'ldaps://ldap.example.test:636',
    GULOGULO_LDAP_BIND_DN: 'cn=service,dc=example,dc=test',
    GULOGULO_LDAP_BIND_SECRET_REF: 'ldap/bind',
    GULOGULO_LDAP_USER_BASE_DN: 'ou=users,dc=example,dc=test',
    ...overrides,
  };
}

function postgresEnabledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GULOGULO_POSTGRES_ENABLED: 'true',
    GULOGULO_POSTGRES_DSN_SECRET_REF: 'postgres/dsn',
    ...overrides,
  };
}

test('createIdentityClient() defaults to LDAP when identity.source is unset', async () => {
  const adapter = createStandaloneAdapter({
    environment: ldapEnabledEnvironment(),
    resolveSecret: async () => 'secret-value',
  });
  const config = await adapter.loadConfig();
  const client = await adapter.createIdentityClient(config);
  // LDAP is enabled and postgres is not: only the LDAP path yields an
  // enabled client here, so this also proves the DB-backed path was not
  // picked by mistake.
  assert.equal(client.enabled, true);
});

test('createIdentityClient() switches to the DB-backed client when identity.source is "database"', async () => {
  const adapter = createStandaloneAdapter({
    environment: postgresEnabledEnvironment({ GULOGULO_IDENTITY_SOURCE: 'database' }),
    resolveSecret: async () => 'secret-value',
  });
  const config = await adapter.loadConfig();
  const client = await adapter.createIdentityClient(config);
  // LDAP is not enabled and postgres is: only the DB-backed path yields an
  // enabled client here, so this also proves the LDAP path was not picked
  // by mistake.
  assert.equal(client.enabled, true);
  await client.close();
});

test('loadConfig() defaults identity.source to "ldap"', async () => {
  const adapter = createStandaloneAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig() as Record<string, any>;
  assert.equal(config.contract.identity.source, 'ldap');
});

test('identity.source "database" is rejected by config validation when postgres is disabled', async () => {
  const adapter = createStandaloneAdapter({ environment: { GULOGULO_IDENTITY_SOURCE: 'database' } });
  await assert.rejects(() => adapter.loadConfig(), /identity\.source cannot be "database"/);
});

test('createSessionStore() returns a working in-memory SessionStore', async () => {
  const adapter = createStandaloneAdapter({ environment: emptyEnvironment() });
  const store = await adapter.createSessionStore();
  assert.equal(store.size, 0);
  assert.equal(store.get('missing-session'), undefined);
  const session = { sessionId: 'fake' } as any;
  store.set('fake', session);
  assert.equal(store.get('fake'), session);
  assert.equal(store.delete('fake'), true);
  assert.equal([...store.entries()].length, 0);
});
