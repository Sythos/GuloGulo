// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import test from 'node:test';
import { createPostgresStore } from './postgres-store.ts';
import { createTenantContext } from './tenant-context.ts';
import type { PostgresStoreEnabled } from './types.ts';

const dsn = process.env.GULOGULO_M2_POSTGRES_DSN;

test('M2 PostgreSQL integration provisions tenant state and enforces gross quota', { skip: !dsn ? 'GULOGULO_M2_POSTGRES_DSN is not configured' : false }, async () => {
  const store = createPostgresStore({
    config: { contract: { postgres: { enabled: true, host: '127.0.0.1', port: 5432, database: 'gulogulo', user: 'gulogulo', sslMode: 'disable', dsnSecretRef: 'integration/dsn', connectTimeoutMs: 3000, idleTimeoutMs: 1000, poolMax: 2, retryAttempts: 1 } } },
    resolveSecret: async () => dsn,
  });
  if (!store.enabled) throw new Error('PostgreSQL store unexpectedly disabled');
  const context = createTenantContext({ tenantId: 'integration', domain: 'integration.example' });
  await store.runMigrations();
  await store.bootstrapTenant(context, { tenantId: 'integration', domain: 'integration.example', grossQuotaBytes: 1000 });
  await store.createUserReference(context, { userId: 'alice', externalId: 'ldap-alice', mailAddress: 'alice@integration.example', allocatedQuotaBytes: 600 });
  await store.createUserReference(context, { userId: 'bob', externalId: 'ldap-bob', mailAddress: 'bob@integration.example', allocatedQuotaBytes: 400 });
  const snapshot = await store.getTenantSnapshot(context);
  if (snapshot.allocated_quota_bytes !== 1000) throw new Error('gross quota accounting mismatch');
  await assertQuota(store, context);
  await store.close();
});

async function assertQuota(store: PostgresStoreEnabled, context: ReturnType<typeof createTenantContext>): Promise<void> {
  await import('node:assert/strict').then(({ default: assert }) => assert.rejects(
    () => store.allocateQuota(context, { userId: 'alice', allocatedQuotaBytes: 601 }),
    (error: unknown) => error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'QUOTA_EXCEEDED',
  ));
}
