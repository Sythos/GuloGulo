// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCpanelIdentityClient } from './cpanel-identity-client.ts';
import { createTenantContext } from '../../integrations/tenant-context.ts';
import type { CpanelApiClientLike } from './cpanel-api-client.ts';

/**
 * A fake `CpanelApiClientLike` — no `fetch`, no real HTTP, no dependency on
 * `cpanel-api-client.ts`'s real behavior at all. This is the injection seam
 * `cpanel-identity-client.ts` is built on top of.
 */
class FakeApiClient implements CpanelApiClientLike {
  readonly calls: Array<{ module: string; function_: string; params?: Record<string, string> }> = [];
  readonly responses: Record<string, unknown>;

  constructor(responses: Record<string, unknown>) {
    this.responses = responses;
  }

  async callUapi(module: string, function_: string, params?: Record<string, string>): Promise<unknown> {
    this.calls.push({ module, function_, params });
    const key = `${module}::${function_}`;
    const response = this.responses[key];
    if (response === undefined) throw new Error(`FakeApiClient has no response configured for ${key}`);
    if (typeof response === 'function') return (response as () => unknown)();
    return response;
  }
}

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: {
      cpanel: {
        enabled: true,
        baseUrl: 'https://127.0.0.1:2083',
        username: 'jdoe',
        apiTokenSecretRef: 'cpanel/api-token',
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
  const client = createCpanelIdentityClient({ config: {} });
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.healthCheck(), { status: 'disabled' });
  assert.equal(await client.authenticate(), false);
});

test('an enabled configuration without a secret resolver or token reference fails closed at construction', () => {
  assert.throws(() => createCpanelIdentityClient({ config: settings() }), /CONFIGURATION|secret resolver/);
  assert.throws(
    () => createCpanelIdentityClient({ config: settings({ apiTokenSecretRef: null }), resolveSecret: async () => 'token' }),
    /apiTokenSecretRef/,
  );
});

test('lookupUser maps a matching Email::list_pops entry to a TenantIdentity', async () => {
  const fake = new FakeApiClient({
    'Email::list_pops': { status: 1, data: [{ email: 'alice@example.test', login: 'alice' }] },
  });
  const client = createCpanelIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-token',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('cPanel identity client unexpectedly disabled');

  const identity = await client.lookupUser({ tenantContext: context(), username: 'alice' });
  if (!identity) throw new Error('cPanel identity unexpectedly missing');
  assert.equal(identity.mailAddress, 'alice@example.test');
  assert.equal(identity.externalId, 'alice');
  assert.equal(identity.active, true);
  assert.equal(fake.calls[0]?.module, 'Email');
  assert.equal(fake.calls[0]?.function_, 'list_pops');
});

test('lookupUser returns null when no matching mail account exists', async () => {
  const fake = new FakeApiClient({
    'Email::list_pops': { status: 1, data: [{ email: 'someone-else@example.test', login: 'someone-else' }] },
  });
  const client = createCpanelIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-token',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('cPanel identity client unexpectedly disabled');

  const identity = await client.lookupUser({ tenantContext: context(), username: 'alice' });
  assert.equal(identity, null);
});

test('lookupUser reports a suspended mailbox as inactive', async () => {
  const fake = new FakeApiClient({
    'Email::list_pops': { status: 1, data: [{ email: 'alice@example.test', login: 'alice', suspended_login: true }] },
  });
  const client = createCpanelIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-token',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('cPanel identity client unexpectedly disabled');

  const identity = await client.lookupUser({ tenantContext: context(), username: 'alice' });
  assert.equal(identity?.active, false);
});

test('authenticate always returns false and never calls the API client', async () => {
  const fake = new FakeApiClient({});
  const client = createCpanelIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-token',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('cPanel identity client unexpectedly disabled');

  const result = await client.authenticate({ tenantContext: context(), username: 'alice', password: 'anything' });
  assert.equal(result, false);
  assert.equal(fake.calls.length, 0);
});

test('healthCheck resolves ok when the reachability probe succeeds', async () => {
  const fake = new FakeApiClient({ 'DomainInfo::domains_data': { status: 1, data: [] } });
  const client = createCpanelIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-token',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('cPanel identity client unexpectedly disabled');

  assert.deepEqual(await client.healthCheck(), { status: 'ok' });
});

test('healthCheck propagates a network error instead of swallowing it', async () => {
  const fake = new FakeApiClient({
    'DomainInfo::domains_data': () => { throw new Error('connection refused'); },
  });
  const client = createCpanelIdentityClient({
    config: settings(),
    resolveSecret: async () => 'resolved-token',
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('cPanel identity client unexpectedly disabled');

  await assert.rejects(client.healthCheck(), /connection refused/);
});

test('a failed secret resolution fails closed instead of calling the API client', async () => {
  const fake = new FakeApiClient({});
  const client = createCpanelIdentityClient({
    config: settings(),
    resolveSecret: async () => undefined,
    createApiClient: () => fake,
  });
  if (!client.enabled) throw new Error('cPanel identity client unexpectedly disabled');

  await assert.rejects(client.healthCheck(), /token secret resolution failed/);
  assert.equal(fake.calls.length, 0);
});
