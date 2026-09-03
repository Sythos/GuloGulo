// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlatformAdapter } from './platform-adapter.ts';
import type { WebSession } from '../../web/security/session-manager.ts';

/**
 * A no-op, in-memory adapter used only to prove at compile time that
 * `PlatformAdapter` is concretely implementable. It carries no behavior
 * worth testing on its own — every future adapter (cPanel, Plesk,
 * standalone) implements the same interface with real bodies instead.
 */
function createNoopPlatformAdapter(): PlatformAdapter {
  return {
    platformKind: 'standalone',
    loadConfig: async () => ({}),
    createIdentityClient: async () => ({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      authenticate: async () => false,
      close: async () => {},
    }),
    createDataStore: async () => ({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      close: async () => {},
    }),
    createDavStore: async () => ({
      caldav: { enabled: false as const, healthCheck: async () => ({ status: 'disabled' as const }), close: async () => {} },
      carddav: { enabled: false as const, healthCheck: async () => ({ status: 'disabled' as const }), close: async () => {} },
    }),
    createSessionStore: async () => new Map<string, WebSession>(),
  };
}

test('a no-op adapter satisfies the PlatformAdapter contract', () => {
  const adapter = createNoopPlatformAdapter();
  assert.equal(adapter.platformKind, 'standalone');
});

test('every contract method resolves for the no-op adapter', async () => {
  const adapter = createNoopPlatformAdapter();
  assert.deepEqual(await adapter.loadConfig(), {});
  assert.equal((await adapter.createIdentityClient({})).enabled, false);
  assert.equal((await adapter.createDataStore({})).enabled, false);
  const davStore = await adapter.createDavStore({});
  assert.equal(davStore.caldav.enabled, false);
  assert.equal(davStore.carddav.enabled, false);
  assert.equal((await adapter.createSessionStore()).size, 0);
});
