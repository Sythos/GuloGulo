// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import pg from 'pg';
import { createMigrationRunner } from './migration-runner.mjs';
import { assertTenantAccess, assertTenantContext } from './tenant-context.mjs';

const { Pool: DefaultPool } = pg;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function storeError(message, code = 'STORE_ERROR') {
  const error = new Error(`PostgreSQL store error: ${message}`);
  error.code = code;
  return error;
}

function safeIdentifier(value, name) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw storeError(`${name} is invalid`, 'INVALID_INPUT');
  }
  return value;
}

function quotaBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storeError('allocatedQuotaBytes must be a non-negative safe integer', 'INVALID_INPUT');
  }
  return value;
}

function sslOptions(mode) {
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

function logError(logger, event, error, details = {}) {
  logger.warn?.(event, { ...details, error: { name: error?.name ?? 'Error', code: error?.code ?? 'unknown' } });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPostgresStore({
  config,
  resolveSecret,
  logger = console,
  PoolClass = DefaultPool,
  migrationDirectory,
  sleep: sleepFunction = sleep,
} = {}) {
  const contract = config?.contract ?? config ?? {};
  const settings = contract.postgres ?? {};
  if (!settings.enabled) {
    return Object.freeze({
      enabled: false,
      healthCheck: async () => ({ status: 'disabled' }),
      close: async () => {},
    });
  }
  if (typeof resolveSecret !== 'function' || settings.dsnSecretRef === null) {
    throw storeError('a DSN secret resolver and reference are required when postgres is enabled', 'CONFIGURATION');
  }

  let pool;
  let closed = false;

  async function getPool() {
    if (closed) throw storeError('store is closed', 'CLOSED');
    if (pool) return pool;
    const dsn = await resolveSecret(settings.dsnSecretRef);
    if (typeof dsn !== 'string' || dsn.length === 0) {
      throw storeError('DSN secret resolution failed', 'SECRET_UNAVAILABLE');
    }
    pool = new PoolClass({
      connectionString: dsn,
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      ssl: sslOptions(settings.sslMode),
      connectionTimeoutMillis: settings.connectTimeoutMs,
      idleTimeoutMillis: settings.idleTimeoutMs,
      max: settings.poolMax,
    });
    return pool;
  }

  async function retry(operation, label) {
    let lastError;
    for (let attempt = 0; attempt <= settings.retryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === settings.retryAttempts) break;
        logError(logger, 'postgres_retry', error, { operation: label, attempt: attempt + 1 });
        await sleepFunction(Math.min(1000, 100 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async function withTenantTransaction(context, callback) {
    const canonical = assertTenantContext(context);
    return retry(async () => {
      const client = await (await getPool()).connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('gulogulo.tenant_id', $1, true)", [canonical.tenantId]);
        const result = await callback(client, canonical);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release?.();
      }
    }, 'transaction');
  }

  async function bootstrapTenant(context, { tenantId, domain, grossQuotaBytes, masterLogAccess = false, maxUsers = 1000, maxAliases = 5000, maxMessageBytes = 52_428_800 } = {}) {
    const canonical = assertTenantAccess(context, tenantId);
    safeIdentifier(domain.toLowerCase(), 'domain');
    if (!Number.isSafeInteger(grossQuotaBytes) || grossQuotaBytes <= 0) throw storeError('grossQuotaBytes must be positive', 'INVALID_INPUT');
    return withTenantTransaction(canonical, async (client) => {
      const existing = await client.query('SELECT tenant_id, domain, gross_quota_bytes FROM tenants WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
      if (existing.rowCount === 0) {
        await client.query('INSERT INTO tenants (tenant_id, domain, gross_quota_bytes, master_log_access) VALUES ($1, $2, $3, $4)', [tenantId, domain.toLowerCase(), grossQuotaBytes, Boolean(masterLogAccess)]);
        await client.query('INSERT INTO tenant_policies (tenant_id, max_users, max_aliases, max_message_bytes) VALUES ($1, $2, $3, $4)', [tenantId, maxUsers, maxAliases, maxMessageBytes]);
      } else if (existing.rows[0].domain !== domain.toLowerCase() || Number(existing.rows[0].gross_quota_bytes) !== grossQuotaBytes) {
        throw storeError('tenant bootstrap conflicts with the existing immutable domain or gross quota', 'CONFLICT');
      }
      return { tenantId, domain: domain.toLowerCase(), grossQuotaBytes };
    });
  }

  async function createUserReference(context, { userId, externalId, mailAddress, displayName = null, allocatedQuotaBytes = 0, status = 'active' } = {}) {
    const canonical = assertTenantContext(context);
    safeIdentifier(userId, 'userId'); safeIdentifier(externalId, 'externalId'); safeIdentifier(mailAddress, 'mailAddress');
    quotaBytes(allocatedQuotaBytes);
    return withTenantTransaction(canonical, async (client) => {
      const tenant = await client.query('SELECT gross_quota_bytes FROM tenants WHERE tenant_id = $1 FOR UPDATE', [canonical.tenantId]);
      if (tenant.rowCount !== 1) throw storeError('tenant does not exist', 'NOT_FOUND');
      const used = await client.query('SELECT COALESCE(SUM(allocated_quota_bytes), 0) AS used FROM quota_allocations WHERE tenant_id = $1', [canonical.tenantId]);
      if (BigInt(used.rows[0].used ?? 0) + BigInt(allocatedQuotaBytes) > BigInt(tenant.rows[0].gross_quota_bytes)) throw storeError('tenant gross quota would be exceeded', 'QUOTA_EXCEEDED');
      await client.query('INSERT INTO user_references (tenant_id, user_id, external_id, mail_address, display_name, status) VALUES ($1, $2, $3, $4, $5, $6)', [canonical.tenantId, userId, externalId, mailAddress.toLowerCase(), displayName, status]);
      await client.query('INSERT INTO quota_allocations (tenant_id, user_id, allocated_quota_bytes) VALUES ($1, $2, $3)', [canonical.tenantId, userId, allocatedQuotaBytes]);
      return { tenantId: canonical.tenantId, userId, allocatedQuotaBytes };
    });
  }

  async function allocateQuota(context, { userId, allocatedQuotaBytes } = {}) {
    const canonical = assertTenantContext(context);
    safeIdentifier(userId, 'userId'); quotaBytes(allocatedQuotaBytes);
    return withTenantTransaction(canonical, async (client) => {
      const tenant = await client.query('SELECT gross_quota_bytes FROM tenants WHERE tenant_id = $1 FOR UPDATE', [canonical.tenantId]);
      const user = await client.query('SELECT user_id FROM user_references WHERE tenant_id = $1 AND user_id = $2', [canonical.tenantId, userId]);
      if (tenant.rowCount !== 1 || user.rowCount !== 1) throw storeError('tenant or user does not exist', 'NOT_FOUND');
      const used = await client.query('SELECT COALESCE(SUM(allocated_quota_bytes), 0) AS used FROM quota_allocations WHERE tenant_id = $1 AND user_id <> $2', [canonical.tenantId, userId]);
      if (BigInt(used.rows[0].used ?? 0) + BigInt(allocatedQuotaBytes) > BigInt(tenant.rows[0].gross_quota_bytes)) throw storeError('tenant gross quota would be exceeded', 'QUOTA_EXCEEDED');
      await client.query('INSERT INTO quota_allocations (tenant_id, user_id, allocated_quota_bytes) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET allocated_quota_bytes = EXCLUDED.allocated_quota_bytes, updated_at = now()', [canonical.tenantId, userId, allocatedQuotaBytes]);
      return { tenantId: canonical.tenantId, userId, allocatedQuotaBytes };
    });
  }

  async function createAlias(context, { aliasAddress, targetUserId } = {}) {
    const canonical = assertTenantContext(context);
    safeIdentifier(aliasAddress, 'aliasAddress'); safeIdentifier(targetUserId, 'targetUserId');
    return withTenantTransaction(canonical, async (client) => {
      await client.query('INSERT INTO aliases (tenant_id, alias_address, target_user_id) VALUES ($1, $2, $3)', [canonical.tenantId, aliasAddress.toLowerCase(), targetUserId]);
      return { tenantId: canonical.tenantId, aliasAddress: aliasAddress.toLowerCase(), targetUserId };
    });
  }

  async function getTenantSnapshot(context) {
    const canonical = assertTenantContext(context);
    return withTenantTransaction(canonical, async (client) => {
      const tenant = await client.query('SELECT tenant_id, domain, gross_quota_bytes, master_log_access, status FROM tenants WHERE tenant_id = $1', [canonical.tenantId]);
      if (tenant.rowCount !== 1) throw storeError('tenant does not exist', 'NOT_FOUND');
      const allocation = await client.query('SELECT COALESCE(SUM(allocated_quota_bytes), 0) AS allocated FROM quota_allocations WHERE tenant_id = $1', [canonical.tenantId]);
      return { ...tenant.rows[0], gross_quota_bytes: Number(tenant.rows[0].gross_quota_bytes), allocated_quota_bytes: Number(allocation.rows[0].allocated ?? 0) };
    });
  }

  async function insertAuditReference(context, { eventId, eventType, actorId = null, subjectId = null, correlationId = null } = {}) {
    const canonical = assertTenantContext(context);
    safeIdentifier(eventId, 'eventId'); safeIdentifier(eventType, 'eventType');
    return withTenantTransaction(canonical, async (client) => {
      await client.query('INSERT INTO audit_event_references (tenant_id, event_id, event_type, actor_id, subject_id, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)', [canonical.tenantId, eventId, eventType, actorId, subjectId, correlationId]);
      return { tenantId: canonical.tenantId, eventId };
    });
  }

  return Object.freeze({
    enabled: true,
    healthCheck: async () => retry(async () => { const client = await (await getPool()).connect(); try { await client.query('SELECT 1'); return { status: 'ok' }; } finally { client.release?.(); } }, 'health'),
    runMigrations: async () => { const client = await (await getPool()).connect(); try { return await createMigrationRunner({ client, migrationDirectory, logger }).run(); } finally { client.release?.(); } },
    migrationStatus: async () => { const client = await (await getPool()).connect(); try { return await createMigrationRunner({ client, migrationDirectory, logger }).status(); } finally { client.release?.(); } },
    bootstrapTenant,
    createUserReference,
    allocateQuota,
    createAlias,
    getTenantSnapshot,
    insertAuditReference,
    withTenantTransaction,
    close: async () => { closed = true; await pool?.end?.(); pool = null; },
  });
}

export { sslOptions };
