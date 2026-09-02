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
