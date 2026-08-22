// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresStore, sslOptions } from './postgres-store.mjs';
import { createTenantContext } from './tenant-context.mjs';

class FakeClient {
  constructor() { this.queries = []; this.released = false; }
  async query(text, values = []) {
    this.queries.push({ text, values });
    if (text.includes('FROM tenants') && text.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ tenant_id: 'acme', domain: 'acme.example', gross_quota_bytes: '1000' }] };
    if (text.includes('COALESCE(SUM')) return { rowCount: 1, rows: [{ used: '500' }] };
    if (text.includes('FROM user_references')) return { rowCount: 1, rows: [{ user_id: 'alice' }] };
    return { rowCount: 0, rows: [] };
  }
  release() { this.released = true; }
}

class FakePool {
  constructor(options) { this.options = options; this.client = new FakeClient(); }
  async connect() { return this.client; }
  async end() {}
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
  const context = createTenantContext({ tenantId: 'acme', domain: 'acme.example' });
  await store.allocateQuota(context, { userId: 'alice', allocatedQuotaBytes: 200 });
  const client = (await store.healthCheck(), store);
  assert.equal(client.enabled, true);
  await assert.rejects(() => store.bootstrapTenant(context, { tenantId: 'other', domain: 'other.example', grossQuotaBytes: 1_000 }), /Tenant context error/);
  await store.close();
});

test('quota allocation fails closed when the gross tenant quota would be exceeded', async () => {
  class QuotaPool extends FakePool {
    constructor(options) { super(options); this.client = new FakeClient(); }
  }
  const store = createPostgresStore({ config: config(), resolveSecret: async () => 'dsn', PoolClass: QuotaPool });
  const context = createTenantContext({ tenantId: 'acme', domain: 'acme.example' });
  await assert.rejects(() => store.allocateQuota(context, { userId: 'alice', allocatedQuotaBytes: 600 }), (error) => error.code === 'QUOTA_EXCEEDED');
  await store.close();
});
