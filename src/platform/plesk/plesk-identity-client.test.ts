// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPleskIdentityClient } from './plesk-identity-client.ts';
import { createTenantContext } from '../../integrations/tenant-context.ts';
import type { PleskApiClientLike } from './plesk-api-client.ts';

/**
 * A fake `PleskApiClientLike` — no `fetch`, no real HTTP, no dependency on
 * `plesk-api-client.ts`'s real behavior at all. This is the injection seam
 * `plesk-identity-client.ts` is built on top of.
 */
class FakeApiClient implements PleskApiClientLike {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly responses: Record<string, unknown>;

  constructor(responses: Record<string, unknown>) {
    this.responses = responses;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const response = this.responses[key];
    if (response === undefined) throw new Error(`FakeApiClient has no response configured for ${key}`);
    if (typeof response === 'function') return (response as () => unknown)();
    return response;
  }
}

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: {
      plesk: {
        enabled: true,
        baseUrl: 'https://127.0.0.1:8443',
        apiKeySecretRef: 'plesk/api-key',
        timeoutMs: 100,
        ...overrides,
      },
    },
  };
}

function context() {
  return createTenantContext({ tenantId: 'acme', domain: 'example.test' });
}

test('a disabled configuration returns a fail-closed disabled client', async () => {
  const client = createPleskIdentityClient({ config: {} });
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.healthCheck(), { status: 'disabled' });
  assert.equal(await client.authenticate(), false);
});

test('an enabled configuration without a secret resolver or key reference fails closed at construction', () => {
  assert.throws(() => createPleskIdentityClient({ config: settings() }), /CONFIGURATION|secret resolver/);
  assert.throws(
    () => createPleskIdentityClient({ config: settings({ apiKeySecretRef: null }), resolveSecret: async () => 'key' }),
    /apiKeySecretRef/,
  );
});

test('lookupUser maps a matching mail account entry to a TenantIdentity', async () => {
  const fake = new FakeApiClient({
    'GET /api/v2/domains': [{ id: 7, name: 'example.test' }],
    'GET /api/v2/domains/7/mail-accounts': [{ id: 1, name: 'alice', email: 'alice@example.test', enabled: true }],
  });
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-key',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  const identity = await client.lookupUser({ tenantContext: context(), username: 'alice' });
  if (!identity) throw new Error('Plesk identity unexpectedly missing');
  assert.equal(identity.mailAddress, 'alice@example.test');
  assert.equal(identity.externalId, 'alice');
  assert.equal(identity.active, true);
  assert.equal(fake.calls[0]?.method, 'GET');
  assert.equal(fake.calls[0]?.path, '/api/v2/domains');
  assert.equal(fake.calls[1]?.path, '/api/v2/domains/7/mail-accounts');
});

test('lookupUser returns null when the tenant domain does not exist on Plesk', async () => {
  const fake = new FakeApiClient({
    'GET /api/v2/domains': [{ id: 7, name: 'someone-else.test' }],
  });
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-key',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  const identity = await client.lookupUser({ tenantContext: context(), username: 'alice' });
  assert.equal(identity, null);
});

test('lookupUser returns null when no matching mail account exists', async () => {
  const fake = new FakeApiClient({
    'GET /api/v2/domains': [{ id: 7, name: 'example.test' }],
    'GET /api/v2/domains/7/mail-accounts': [{ id: 2, name: 'bob', email: 'bob@example.test', enabled: true }],
  });
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-key',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  const identity = await client.lookupUser({ tenantContext: context(), username: 'alice' });
  assert.equal(identity, null);
});

test('lookupUser reports a disabled mail account as inactive', async () => {
  const fake = new FakeApiClient({
    'GET /api/v2/domains': [{ id: 7, name: 'example.test' }],
    'GET /api/v2/domains/7/mail-accounts': [{ id: 1, name: 'alice', email: 'alice@example.test', enabled: false }],
  });
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-key',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  const identity = await client.lookupUser({ tenantContext: context(), username: 'alice' });
  assert.equal(identity?.active, false);
});

test('authenticate always returns false and never calls the API client', async () => {
  const fake = new FakeApiClient({});
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-key',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  const result = await client.authenticate({ tenantContext: context(), username: 'alice', password: 'anything' });
  assert.equal(result, false);
  assert.equal(fake.calls.length, 0);
});

test('healthCheck resolves ok when the reachability probe succeeds', async () => {
  const fake = new FakeApiClient({ 'GET /api/v2/server': { platform: 'plesk' } });
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-key',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  assert.deepEqual(await client.healthCheck(), { status: 'ok' });
});

test('healthCheck propagates a network error instead of swallowing it', async () => {
  const fake = new FakeApiClient({
    'GET /api/v2/server': () => { throw new Error('connection refused'); },
  });
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-key',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  await assert.rejects(client.healthCheck(), /connection refused/);
});

test('a failed secret resolution fails closed instead of calling the API client', async () => {
  const fake = new FakeApiClient({});
  const client = createPleskIdentityClient({
    config: settings(),
    resolveSecret: async () => undefined,
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('Plesk identity client unexpectedly disabled');

  await assert.rejects(client.healthCheck(), /key secret resolution failed/);
  assert.equal(fake.calls.length, 0);
});
