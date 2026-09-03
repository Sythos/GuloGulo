/*
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
*/

import { createRequire } from 'node:module';

import { createMigrationRunner } from './migration-runner.ts';
import { assertTenantAccess, assertTenantContext } from './tenant-context.ts';
import type {
  AliasOptions,
  AuditReferenceOptions,
  IntegrationLogger,
  MigrationRunResult,
  MigrationStatus,
  PostgresClientLike,
  PostgresPoolConstructor,
  PostgresPoolLike,
  PostgresPoolOptions,
  PostgresSettings,
  PostgresStore,
  PostgresStoreOptions,
  QuotaAllocationOptions,
  TenantBootstrapOptions,
  TenantContext,
  TenantSnapshot,
  UserReferenceOptions,
} from './types.ts';

const { Pool: DefaultPool } = createRequire(import.meta.url)('pg') as { Pool: PostgresPoolConstructor };
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_MAX = 8;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_SSL_MODE: PostgresSettings['sslMode'] = 'verify-full';

interface CodedStoreError extends Error {
  readonly code: string;
}

interface TenantRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly domain: string;
  readonly gross_quota_bytes: string | number | bigint;
  readonly master_log_access?: boolean;
  readonly status?: string;
}

interface UserRow extends Record<string, unknown> {
  readonly user_id: string;
}

interface QuotaRow extends Record<string, unknown> {
  readonly used?: string | number | bigint;
  readonly allocated?: string | number | bigint;
}

function storeError(message: string, code = 'STORE_ERROR'): CodedStoreError {
  const error = new Error(`PostgreSQL store error: ${message}`) as CodedStoreError;
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readSettings(config: unknown): PostgresSettings {
  const root = asRecord(config);
  const contract = asRecord(root.contract);
  const raw = asRecord(contract.postgres ?? root.postgres);
  const sslMode = raw.sslMode;
  const allowedSslModes: readonly PostgresSettings['sslMode'][] = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];
  return {
    enabled: raw.enabled === true,
    host: typeof raw.host === 'string' ? raw.host : '',
    port: Number.isSafeInteger(raw.port) ? raw.port as number : 5432,
    database: typeof raw.database === 'string' ? raw.database : '',
    user: typeof raw.user === 'string' ? raw.user : '',
    sslMode: typeof sslMode === 'string' && allowedSslModes.includes(sslMode as PostgresSettings['sslMode'])
      ? sslMode as PostgresSettings['sslMode']
      : DEFAULT_SSL_MODE,
    dsnSecretRef: raw.dsnSecretRef === null || typeof raw.dsnSecretRef === 'string' ? raw.dsnSecretRef : null,
    connectTimeoutMs: Number.isSafeInteger(raw.connectTimeoutMs) ? raw.connectTimeoutMs as number : DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: Number.isSafeInteger(raw.idleTimeoutMs) ? raw.idleTimeoutMs as number : DEFAULT_IDLE_TIMEOUT_MS,
    poolMax: Number.isSafeInteger(raw.poolMax) && (raw.poolMax as number) > 0 ? raw.poolMax as number : DEFAULT_POOL_MAX,
    retryAttempts: Number.isSafeInteger(raw.retryAttempts) && (raw.retryAttempts as number) >= 0
      ? raw.retryAttempts as number
      : DEFAULT_RETRY_ATTEMPTS,
  };
}

function safeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw storeError(`${name} is invalid`, 'INVALID_INPUT');
  }
  return value;
}

function quotaBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw storeError('allocatedQuotaBytes must be a non-negative safe integer', 'INVALID_INPUT');
  }
  return value as number;
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw storeError(`${field} returned an invalid numeric value`, 'DATA_INTEGRITY');
}

function sslOptions(mode: string): false | { rejectUnauthorized: boolean } {
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

function logError(logger: IntegrationLogger, event: string, error: unknown, details: Record<string, unknown> = {}): void {
  const record = asRecord(error);
  logger.warn?.(event, {
    ...details,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      code: typeof record.code === 'string' ? record.code : 'unknown',
    },
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPostgresStore({
  config,
  resolveSecret,
  logger = console,
  PoolClass = DefaultPool,
  migrationDirectory,
  sleep: sleepFunction = sleep,
}: PostgresStoreOptions = {}): PostgresStore {
  const settings = readSettings(config);
  if (!settings.enabled) {
    return Object.freeze({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      close: async () => {},
    });
  }
  if (typeof resolveSecret !== 'function' || settings.dsnSecretRef === null) {
    throw storeError('a DSN secret resolver and reference are required when postgres is enabled', 'CONFIGURATION');
  }
  const secretResolver = resolveSecret;
  const dsnSecretRef = settings.dsnSecretRef;

  let pool: PostgresPoolLike | undefined;
  let closed = false;

  async function getPool(): Promise<PostgresPoolLike> {
    if (closed) throw storeError('store is closed', 'CLOSED');
    if (pool) return pool;
    const dsn = await secretResolver(dsnSecretRef);
    if (typeof dsn !== 'string' || dsn.length === 0) {
      throw storeError('DSN secret resolution failed', 'SECRET_UNAVAILABLE');
    }
    const options: PostgresPoolOptions = {
      connectionString: dsn,
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      ssl: sslOptions(settings.sslMode),
      connectionTimeoutMillis: settings.connectTimeoutMs,
      idleTimeoutMillis: settings.idleTimeoutMs,
      max: settings.poolMax,
    };
    pool = new PoolClass(options);
    return pool;
  }

  async function retry<Result>(operation: () => Promise<Result>, label: string): Promise<Result> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= settings.retryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === settings.retryAttempts) break;
        logError(logger, 'postgres_retry', error, { operation: label, attempt: attempt + 1 });
        await sleepFunction(Math.min(1_000, 100 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async function withTenantTransaction<Result>(context: unknown, callback: (client: PostgresClientLike, canonical: TenantContext) => Promise<Result>): Promise<Result> {
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

  async function bootstrapTenant(context: unknown, {
    tenantId,
    domain,
    grossQuotaBytes,
    masterLogAccess = false,
    maxUsers = 1_000,
    maxAliases = 5_000,
    maxMessageBytes = 52_428_800,
  }: TenantBootstrapOptions = {}): Promise<Record<string, unknown>> {
    const canonical = assertTenantAccess(context, tenantId);
    const normalizedDomain = safeIdentifier(domain, 'domain').toLowerCase();
    if (!Number.isSafeInteger(grossQuotaBytes) || (grossQuotaBytes as number) <= 0) {
      throw storeError('grossQuotaBytes must be positive', 'INVALID_INPUT');
    }
    const grossQuota = grossQuotaBytes as number;
    return withTenantTransaction(canonical, async (client) => {
      const existing = await client.query<TenantRow>('SELECT tenant_id, domain, gross_quota_bytes FROM tenants WHERE tenant_id = $1 FOR UPDATE', [canonical.tenantId]);
      const existingTenant = existing.rows[0];
      if ((existing.rowCount ?? 0) === 0 || !existingTenant) {
        await client.query('INSERT INTO tenants (tenant_id, domain, gross_quota_bytes, master_log_access) VALUES ($1, $2, $3, $4)', [canonical.tenantId, normalizedDomain, grossQuota, Boolean(masterLogAccess)]);
        await client.query('INSERT INTO tenant_policies (tenant_id, max_users, max_aliases, max_message_bytes) VALUES ($1, $2, $3, $4)', [canonical.tenantId, maxUsers, maxAliases, maxMessageBytes]);
      } else if (existingTenant.domain !== normalizedDomain || asBigInt(existingTenant.gross_quota_bytes, 'gross_quota_bytes') !== BigInt(grossQuota)) {
        throw storeError('tenant bootstrap conflicts with the existing immutable domain or gross quota', 'CONFLICT');
      }
      return { tenantId: canonical.tenantId, domain: normalizedDomain, grossQuotaBytes: grossQuota };
    });
  }

  async function createUserReference(context: unknown, {
    userId,
    externalId,
    mailAddress,
    displayName = null,
    allocatedQuotaBytes = 0,
    status = 'active',
  }: UserReferenceOptions = {}): Promise<Record<string, unknown>> {
    const canonical = assertTenantContext(context);
    const normalizedUserId = safeIdentifier(userId, 'userId');
    const normalizedExternalId = safeIdentifier(externalId, 'externalId');
    const normalizedMailAddress = safeIdentifier(mailAddress, 'mailAddress').toLowerCase();
    const allocated = quotaBytes(allocatedQuotaBytes);
    const normalizedStatus = typeof status === 'string' ? status : 'active';
    return withTenantTransaction(canonical, async (client) => {
      const tenant = await client.query<TenantRow>('SELECT gross_quota_bytes FROM tenants WHERE tenant_id = $1 FOR UPDATE', [canonical.tenantId]);
      const tenantRow = tenant.rows[0];
      if ((tenant.rowCount ?? 0) !== 1 || !tenantRow) throw storeError('tenant does not exist', 'NOT_FOUND');
      const used = await client.query<QuotaRow>('SELECT COALESCE(SUM(allocated_quota_bytes), 0) AS used FROM quota_allocations WHERE tenant_id = $1', [canonical.tenantId]);
      if (asBigInt(used.rows[0]?.used ?? 0, 'allocated_quota_bytes') + BigInt(allocated) > asBigInt(tenantRow.gross_quota_bytes, 'gross_quota_bytes')) {
        throw storeError('tenant gross quota would be exceeded', 'QUOTA_EXCEEDED');
      }
      await client.query('INSERT INTO user_references (tenant_id, user_id, external_id, mail_address, display_name, status) VALUES ($1, $2, $3, $4, $5, $6)', [canonical.tenantId, normalizedUserId, normalizedExternalId, normalizedMailAddress, displayName, normalizedStatus]);
      await client.query('INSERT INTO quota_allocations (tenant_id, user_id, allocated_quota_bytes) VALUES ($1, $2, $3)', [canonical.tenantId, normalizedUserId, allocated]);
      return { tenantId: canonical.tenantId, userId: normalizedUserId, allocatedQuotaBytes: allocated };
    });
  }

  async function allocateQuota(context: unknown, { userId, allocatedQuotaBytes }: QuotaAllocationOptions = {}): Promise<Record<string, unknown>> {
    const canonical = assertTenantContext(context);
    const normalizedUserId = safeIdentifier(userId, 'userId');
    const allocated = quotaBytes(allocatedQuotaBytes);
    return withTenantTransaction(canonical, async (client) => {
      const tenant = await client.query<TenantRow>('SELECT gross_quota_bytes FROM tenants WHERE tenant_id = $1 FOR UPDATE', [canonical.tenantId]);
      const user = await client.query<UserRow>('SELECT user_id FROM user_references WHERE tenant_id = $1 AND user_id = $2', [canonical.tenantId, normalizedUserId]);
      const tenantRow = tenant.rows[0];
      if ((tenant.rowCount ?? 0) !== 1 || (user.rowCount ?? 0) !== 1 || !tenantRow || !user.rows[0]) {
        throw storeError('tenant or user does not exist', 'NOT_FOUND');
      }
      const used = await client.query<QuotaRow>('SELECT COALESCE(SUM(allocated_quota_bytes), 0) AS used FROM quota_allocations WHERE tenant_id = $1 AND user_id <> $2', [canonical.tenantId, normalizedUserId]);
      if (asBigInt(used.rows[0]?.used ?? 0, 'allocated_quota_bytes') + BigInt(allocated) > asBigInt(tenantRow.gross_quota_bytes, 'gross_quota_bytes')) {
        throw storeError('tenant gross quota would be exceeded', 'QUOTA_EXCEEDED');
      }
      await client.query('INSERT INTO quota_allocations (tenant_id, user_id, allocated_quota_bytes) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET allocated_quota_bytes = EXCLUDED.allocated_quota_bytes, updated_at = now()', [canonical.tenantId, normalizedUserId, allocated]);
      return { tenantId: canonical.tenantId, userId: normalizedUserId, allocatedQuotaBytes: allocated };
    });
  }

  async function createAlias(context: unknown, { aliasAddress, targetUserId }: AliasOptions = {}): Promise<Record<string, unknown>> {
    const canonical = assertTenantContext(context);
    const normalizedAliasAddress = safeIdentifier(aliasAddress, 'aliasAddress').toLowerCase();
    const normalizedTargetUserId = safeIdentifier(targetUserId, 'targetUserId');
    return withTenantTransaction(canonical, async (client) => {
      await client.query('INSERT INTO aliases (tenant_id, alias_address, target_user_id) VALUES ($1, $2, $3)', [canonical.tenantId, normalizedAliasAddress, normalizedTargetUserId]);
      return { tenantId: canonical.tenantId, aliasAddress: normalizedAliasAddress, targetUserId: normalizedTargetUserId };
    });
  }

  async function getTenantSnapshot(context: unknown): Promise<TenantSnapshot> {
    const canonical = assertTenantContext(context);
    return withTenantTransaction(canonical, async (client) => {
      const tenant = await client.query<TenantRow>('SELECT tenant_id, domain, gross_quota_bytes, master_log_access, status FROM tenants WHERE tenant_id = $1', [canonical.tenantId]);
      const tenantRow = tenant.rows[0];
      if ((tenant.rowCount ?? 0) !== 1 || !tenantRow) throw storeError('tenant does not exist', 'NOT_FOUND');
      const allocation = await client.query<QuotaRow>('SELECT COALESCE(SUM(allocated_quota_bytes), 0) AS allocated FROM quota_allocations WHERE tenant_id = $1', [canonical.tenantId]);
      return {
        ...tenantRow,
        gross_quota_bytes: Number(asBigInt(tenantRow.gross_quota_bytes, 'gross_quota_bytes')),
        allocated_quota_bytes: Number(asBigInt(allocation.rows[0]?.allocated ?? 0, 'allocated_quota_bytes')),
      };
    });
  }

  async function insertAuditReference(context: unknown, { eventId, eventType, actorId = null, subjectId = null, correlationId = null }: AuditReferenceOptions = {}): Promise<Record<string, unknown>> {
    const canonical = assertTenantContext(context);
    const normalizedEventId = safeIdentifier(eventId, 'eventId');
    const normalizedEventType = safeIdentifier(eventType, 'eventType');
    return withTenantTransaction(canonical, async (client) => {
      await client.query('INSERT INTO audit_event_references (tenant_id, event_id, event_type, actor_id, subject_id, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)', [canonical.tenantId, normalizedEventId, normalizedEventType, actorId, subjectId, correlationId]);
      return { tenantId: canonical.tenantId, eventId: normalizedEventId };
    });
  }

  return Object.freeze({
    enabled: true as const,
    healthCheck: async () => retry(async () => {
      const client = await (await getPool()).connect();
      try {
        await client.query('SELECT 1');
        return { status: 'ok' as const };
      } finally {
        client.release?.();
      }
    }, 'health'),
    runMigrations: async (): Promise<MigrationRunResult> => {
      const client = await (await getPool()).connect();
      try {
        return await createMigrationRunner({ client, migrationDirectory, logger }).run();
      } finally {
        client.release?.();
      }
    },
    migrationStatus: async (): Promise<MigrationStatus[]> => {
      const client = await (await getPool()).connect();
      try {
        return await createMigrationRunner({ client, migrationDirectory, logger }).status();
      } finally {
        client.release?.();
      }
    },
    bootstrapTenant,
    createUserReference,
    allocateQuota,
    createAlias,
    getTenantSnapshot,
    insertAuditReference,
    withTenantTransaction,
    close: async () => {
      closed = true;
      await pool?.end?.();
      pool = undefined;
    },
  });
}

export { sslOptions };
