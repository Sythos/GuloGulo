// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCpanelAdapter } from './cpanel-adapter.ts';
import type { PlatformAdapter } from '../contract/platform-adapter.ts';

/** An environment with no GULOGULO_CONFIG_FILE set: config.ts falls back to
 * its optional default mount, which does not exist on a test machine, so
 * loadConfig() resolves to schema defaults — ldap, postgres, and (being
 * absent from the schema entirely) cpanel all resolve as disabled. */
function emptyEnvironment(): NodeJS.ProcessEnv {
  return {};
}

test('createCpanelAdapter satisfies the PlatformAdapter contract and identifies as cpanel', () => {
  const adapter: PlatformAdapter = createCpanelAdapter({ environment: emptyEnvironment() });
  assert.equal(adapter.platformKind, 'cpanel');
});

test('loadConfig() delegates to src/runtime/config.ts and resolves disabled integrations by default', async () => {
  const adapter = createCpanelAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig() as Record<string, any>;
  assert.equal(config.contract.ldap.enabled, false);
  assert.equal(config.contract.postgres.enabled, false);
});

test('createIdentityClient() builds a disabled CpanelIdentityClient with a minimal/disabled config', async () => {
  const adapter = createCpanelAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const client = await adapter.createIdentityClient(config);
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.healthCheck(), { status: 'disabled' });
  assert.equal(await client.authenticate(), false);
});

test('createIdentityClient() builds a working enabled client when cpanel settings are present', async () => {
  const adapter = createCpanelAdapter({
    environment: emptyEnvironment(),
    resolveSecret: async () => 'resolved-token',
  });
  const config = {
    contract: {
      cpanel: {
        enabled: true,
        baseUrl: 'https://127.0.0.1:2083',
        username: 'jdoe',
        apiTokenSecretRef: 'cpanel/api-token',
        timeoutMs: 100,
      },
    },
  } as any;
  const client = await adapter.createIdentityClient(config);
  assert.equal(client.enabled, true);
  assert.equal(await client.authenticate(), false);
});

test('createDataStore() builds a real PostgresStore from src/integrations/postgres-store.ts', async () => {
  const adapter = createCpanelAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const store = await adapter.createDataStore(config);
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.healthCheck(), { status: 'disabled' });
  await store.close();
});

test('createDavStore() builds real PostgreSQL-backed CalDAV/CardDAV stores from src/core/dav/', async () => {
  const adapter = createCpanelAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const davStore = await adapter.createDavStore(config);
  assert.equal(davStore.caldav.enabled, false);
  assert.deepEqual(await davStore.caldav.healthCheck(), { status: 'disabled' });
  assert.equal(davStore.carddav.enabled, false);
  assert.deepEqual(await davStore.carddav.healthCheck(), { status: 'disabled' });
  await davStore.caldav.close();
  await davStore.carddav.close();
});

test('createSessionStore() returns a working in-memory SessionStore', async () => {
  const adapter = createCpanelAdapter({ environment: emptyEnvironment() });
  const store = await adapter.createSessionStore();
  assert.equal(store.size, 0);
  assert.equal(store.get('missing-session'), undefined);
  const session = { sessionId: 'fake' } as any;
  store.set('fake', session);
  assert.equal(store.get('fake'), session);
  assert.equal(store.delete('fake'), true);
  assert.equal([...store.entries()].length, 0);
});
