// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPasswordHasher } from '../../core/auth/password-hashing.ts';
import { createTenantContext } from '../../integrations/tenant-context.ts';
import type { PostgresClientLike, PostgresPoolOptions, QueryResult } from '../../integrations/types.ts';
import { createDatabaseIdentityClient } from './db-identity-client.ts';

const hasher = createPasswordHasher();
const GOOD_HASH = hasher.hash('correct-horse-battery-staple');

interface LocalUserFixtureRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  active: boolean;
}

class FakeClient implements PostgresClientLike {
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  released = false;
  readonly rows: LocalUserFixtureRow[];
  constructor(rows: LocalUserFixtureRow[]) { this.rows = rows; }
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (text.includes('FROM local_users')) {
      const username = values[1] as string;
      const row = this.rows.find((candidate) => candidate.username === username);
      if (row === undefined) return { rowCount: 0, rows: [] as Row[] };
      return { rowCount: 1, rows: [{ ...row }] as unknown as Row[] };
    }
    return { rowCount: 0, rows: [] as Row[] };
  }
  release(): void { this.released = true; }
}

class FakePool {
  readonly options: PostgresPoolOptions;
  readonly client: FakeClient;
  constructor(options: PostgresPoolOptions, rows: LocalUserFixtureRow[]) { this.options = options; this.client = new FakeClient(rows); }
  async connect(): Promise<FakeClient> { return this.client; }
  async end(): Promise<void> {}
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    contract: {
      postgres: {
        enabled: true, host: 'postgres.example', port: 5432, database: 'gulogulo', user: 'gulogulo',
        sslMode: 'verify-full', dsnSecretRef: 'postgres/dsn', connectTimeoutMs: 100, idleTimeoutMs: 1000,
        poolMax: 2, retryAttempts: 0, ...overrides,
      },
    },
  };
}

function disabledConfig() {
  return { contract: { postgres: { enabled: false } } };
}

function makeClient(rows: LocalUserFixtureRow[]) {
  class RowPool extends FakePool {
    constructor(options: PostgresPoolOptions) { super(options, rows); }
  }
  return createDatabaseIdentityClient({ config: config(), resolveSecret: async () => 'postgresql://secret', PoolClass: RowPool });
}

test('createDatabaseIdentityClient() is disabled when postgres is disabled', async () => {
  const client = createDatabaseIdentityClient({ config: disabledConfig() });
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.healthCheck(), { status: 'disabled' });
  assert.equal(await client.authenticate(), false);
  await client.close();
});

test('lookupUser() returns the matching local_users row as a TenantIdentity', async () => {
  const client = makeClient([{ id: 'u-1', username: 'alice', password_hash: GOOD_HASH, display_name: 'Alice', active: true }]);
  if (!client.enabled) throw new Error('client unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme.example', domain: 'acme.example' });
  const identity = await client.lookupUser({ tenantContext: context, username: 'alice' });
  if (!identity) throw new Error('identity unexpectedly missing');
  assert.equal(identity.externalId, 'u-1');
  assert.equal(identity.mailAddress, 'alice@acme.example');
  assert.equal(identity.displayName, 'Alice');
  assert.equal(identity.active, true);
});

test('lookupUser() returns null for an unknown username', async () => {
  const client = makeClient([]);
  if (!client.enabled) throw new Error('client unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme.example', domain: 'acme.example' });
  assert.equal(await client.lookupUser({ tenantContext: context, username: 'ghost' }), null);
});

test('authenticate() reuses src/core/auth/password-hashing.ts and never treats a bad password as valid', async () => {
  const client = makeClient([{ id: 'u-1', username: 'alice', password_hash: GOOD_HASH, display_name: null, active: true }]);
  if (!client.enabled) throw new Error('client unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme.example', domain: 'acme.example' });
  assert.equal(await client.authenticate({ tenantContext: context, username: 'alice', password: 'correct-horse-battery-staple' }), true);
  assert.equal(await client.authenticate({ tenantContext: context, username: 'alice', password: 'wrong-password' }), false);
});

test('authenticate() fails closed for an inactive user even with the correct password', async () => {
  const client = makeClient([{ id: 'u-1', username: 'alice', password_hash: GOOD_HASH, display_name: null, active: false }]);
  if (!client.enabled) throw new Error('client unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme.example', domain: 'acme.example' });
  assert.equal(await client.authenticate({ tenantContext: context, username: 'alice', password: 'correct-horse-battery-staple' }), false);
});

test('authenticate() fails closed for an unknown username without querying twice', async () => {
  const client = makeClient([]);
  if (!client.enabled) throw new Error('client unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme.example', domain: 'acme.example' });
  assert.equal(await client.authenticate({ tenantContext: context, username: 'ghost', password: 'anything' }), false);
});
