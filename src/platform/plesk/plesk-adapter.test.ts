// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPleskAdapter } from './plesk-adapter.ts';
import type { PlatformAdapter } from '../contract/platform-adapter.ts';

/** An environment with no GULOGULO_CONFIG_FILE set: config.ts falls back to
 * its optional default mount, which does not exist on a test machine, so
 * loadConfig() resolves to schema defaults — ldap, postgres, and (being
 * absent from the schema entirely) plesk all resolve as disabled. */
function emptyEnvironment(): NodeJS.ProcessEnv {
  return {};
}

test('createPleskAdapter satisfies the PlatformAdapter contract and identifies as plesk', () => {
  const adapter: PlatformAdapter = createPleskAdapter({ environment: emptyEnvironment() });
  assert.equal(adapter.platformKind, 'plesk');
});

test('loadConfig() delegates to src/runtime/config.ts and resolves disabled integrations by default', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig() as Record<string, any>;
  assert.equal(config.contract.ldap.enabled, false);
  assert.equal(config.contract.postgres.enabled, false);
});

test('createIdentityClient() builds a disabled PleskIdentityClient with a minimal/disabled config', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const client = await adapter.createIdentityClient(config);
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.healthCheck(), { status: 'disabled' });
  assert.equal(await client.authenticate(), false);
});

test('createIdentityClient() builds a working enabled client when plesk settings are present', async () => {
  const adapter = createPleskAdapter({
    environment: emptyEnvironment(),
    resolveSecret: async () => 'resolved-key',
  });
  const config = {
    contract: {
      plesk: {
        enabled: true,
        baseUrl: 'https://127.0.0.1:8443',
        apiKeySecretRef: 'plesk/api-key',
        timeoutMs: 100,
      },
    },
  } as any;
  const client = await adapter.createIdentityClient(config);
  assert.equal(client.enabled, true);
  assert.equal(await client.authenticate(), false);
});

test('createDataStore() builds a real PostgresStore from src/integrations/postgres-store.ts', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const store = await adapter.createDataStore(config);
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.healthCheck(), { status: 'disabled' });
  await store.close();
});

test('createSessionStore() returns a working in-memory SessionStore', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const store = await adapter.createSessionStore();
  assert.equal(store.size, 0);
  assert.equal(store.get('missing-session'), undefined);
  const session = { sessionId: 'fake' } as any;
  store.set('fake', session);
  assert.equal(store.get('fake'), session);
  assert.equal(store.delete('fake'), true);
  assert.equal([...store.entries()].length, 0);
});
