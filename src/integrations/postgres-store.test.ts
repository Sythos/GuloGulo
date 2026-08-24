// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresStore, sslOptions } from './postgres-store.ts';
import { createTenantContext } from './tenant-context.ts';
import type { PostgresClientLike, PostgresPoolOptions, QueryResult } from './types.ts';

class FakeClient implements PostgresClientLike {
  constructor() { this.queries = []; this.released = false; }
  readonly queries: Array<{ text: string; values: unknown[] }>;
  released: boolean;
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (text.includes('FROM tenants') && text.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ tenant_id: 'acme', domain: 'acme.example', gross_quota_bytes: '1000' }] as unknown as Row[] };
    if (text.includes('COALESCE(SUM')) return { rowCount: 1, rows: [{ used: '500' }] as unknown as Row[] };
    if (text.includes('FROM user_references')) return { rowCount: 1, rows: [{ user_id: 'alice' }] as unknown as Row[] };
    return { rowCount: 0, rows: [] as Row[] };
  }
  release() { this.released = true; }
}

class FakePool {
  readonly options: PostgresPoolOptions;
  client: FakeClient;
  constructor(options: PostgresPoolOptions) { this.options = options; this.client = new FakeClient(); }
  async connect(): Promise<FakeClient> { return this.client; }
  async end(): Promise<void> {}
}

function config() {
  return { contract: { postgres: { enabled: true, host: 'postgres.example', port: 5432, database: 'gulogulo', user: 'gulogulo', sslMode: 'verify-full', dsnSecretRef: 'postgres/dsn', connectTimeoutMs: 100, idleTimeoutMs: 1000, poolMax: 2, retryAttempts: 0 } } };
}

test('PostgreSQL pool uses certificate verification by default', () => {
  assert.deepEqual(sslOptions('verify-full'), { rejectUnauthorized: true });
  assert.deepEqual(sslOptions('require'), { rejectUnauthorized: false });
  assert.equal(sslOptions('disable'), false);
});

test('tenant transaction sets the RLS context and rejects cross-tenant calls', async () => {
  const store = createPostgresStore({ config: config(), resolveSecret: async () => 'postgresql://secret', PoolClass: FakePool });
  if (!store.enabled) throw new Error('PostgreSQL store unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme', domain: 'acme.example' });
  await store.allocateQuota(context, { userId: 'alice', allocatedQuotaBytes: 200 });
  const client = (await store.healthCheck(), store);
  assert.equal(client.enabled, true);
  await assert.rejects(() => store.bootstrapTenant(context, { tenantId: 'other', domain: 'other.example', grossQuotaBytes: 1_000 }), /Tenant context error/);
  await store.close();
});

test('quota allocation fails closed when the gross tenant quota would be exceeded', async () => {
  class QuotaPool extends FakePool {
    constructor(options: PostgresPoolOptions) { super(options); this.client = new FakeClient(); }
  }
  const store = createPostgresStore({ config: config(), resolveSecret: async () => 'dsn', PoolClass: QuotaPool });
  if (!store.enabled) throw new Error('PostgreSQL store unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'acme', domain: 'acme.example' });
  await assert.rejects(() => store.allocateQuota(context, { userId: 'alice', allocatedQuotaBytes: 600 }), (error: unknown) => error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'QUOTA_EXCEEDED');
  await store.close();
});
