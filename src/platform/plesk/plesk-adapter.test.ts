// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPleskAdapter } from './plesk-adapter.ts';
import { createTenantContext } from '../../integrations/tenant-context.ts';
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
  // No real Plesk/IMAP host is reachable from a test machine, so this
  // exercises the real fail-closed path (see plesk-identity-client.test.ts
  // for the injected-fake IMAP client coverage of a genuine LOGIN success).
  assert.equal(await client.authenticate({ tenantContext: createTenantContext({ tenantId: 'acme', domain: 'acme.example' }), username: 'jdoe', password: 'anything' }), false);
});

test('createDataStore() builds a real PostgresStore from src/integrations/postgres-store.ts', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const store = await adapter.createDataStore(config);
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.healthCheck(), { status: 'disabled' });
  await store.close();
});

test('createDavStore() builds real PostgreSQL-backed CalDAV/CardDAV stores from src/core/dav/', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const davStore = await adapter.createDavStore(config);
  assert.equal(davStore.caldav.enabled, false);
  assert.deepEqual(await davStore.caldav.healthCheck(), { status: 'disabled' });
  assert.equal(davStore.carddav.enabled, false);
  assert.deepEqual(await davStore.carddav.healthCheck(), { status: 'disabled' });
  await davStore.caldav.close();
  await davStore.carddav.close();
});

test('createBackupStorage() builds a real filesystem adapter with the shared /var/lib/gulogulo/backups default', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const config = await adapter.loadConfig();
  const storage = await adapter.createBackupStorage!(config);
  assert.equal(storage.kind, 'filesystem-local');
  assert.equal(storage.basePath, '/var/lib/gulogulo/backups');
});

test('createBackupStorage() honors an overridden contract.backup.path', async () => {
  const adapter = createPleskAdapter({ environment: emptyEnvironment() });
  const storage = await adapter.createBackupStorage!({ contract: { backup: { path: '/srv/gulogulo-backups' } } } as any);
  assert.equal(storage.basePath, '/srv/gulogulo-backups');
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
