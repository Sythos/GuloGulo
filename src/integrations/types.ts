/*
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
*/

/** The roles understood by the tenant isolation boundary. */
export type TenantRole = 'provider' | 'tenant_master' | 'user' | 'monitor';

/** The canonical tenant context passed between adapters and application services. */
export interface TenantContext {
  readonly tenantId: string;
  readonly domain: string;
  readonly actorId: string | null;
  readonly role: TenantRole;
}

/** Untrusted input accepted by the context constructor. */
export interface TenantContextInput {
  tenantId?: unknown;
  domain?: unknown;
  actorId?: unknown;
  role?: unknown;
}

/**
 * The subset of the loaded configuration that selects which identity source
 * `src/platform/standalone/standalone-adapter.ts` uses: `'ldap'` (the
 * existing default) or `'database'` (`src/platform/standalone/db-identity-client.ts`,
 * a PostgreSQL-backed `local_users` table for lighter single/few-tenant
 * installs). Additive to the existing `IntegrationConfig` contract, mirroring
 * the `upgrade.strategy` enum already in `src/runtime/config.ts`.
 */
export interface IdentitySettings {
  source: 'ldap' | 'database';
}

/** The subset of the loaded configuration consumed by the LDAP adapter. */
export interface LdapSettings {
  enabled: boolean;
  url: string;
  startTls: boolean;
  bindDn: string | null;
  bindSecretRef: string | null;
  userBaseDn: string | null;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  retryAttempts: number;
}

/** The subset of the loaded configuration consumed by the PostgreSQL adapter. */
export interface PostgresSettings {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  dsnSecretRef: string | null;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  poolMax: number;
  retryAttempts: number;
}

/**
 * The subset of the loaded configuration consumed by the cPanel identity
 * adapter (`src/platform/cpanel/`): where to reach the local cPanel UAPI
 * endpoint and which account/token identify Gulo Gulo to it. Additive to the
 * existing `IntegrationConfig` contract — no existing field changes shape.
 */
export interface CpanelApiSettings {
  enabled: boolean;
  baseUrl: string;
  username: string;
  apiTokenSecretRef: string | null;
  timeoutMs: number;
}

/**
 * The subset of the loaded configuration consumed by the Plesk identity
 * adapter (`src/platform/plesk/`): where to reach the local Plesk REST API
 * (`/api/v2/*`) and which API key identifies Gulo Gulo to it. Additive to the
 * existing `IntegrationConfig` contract — no existing field changes shape.
 */
export interface PleskApiSettings {
  enabled: boolean;
  baseUrl: string;
  apiKeySecretRef: string | null;
  timeoutMs: number;
}

/** A deliberately narrow configuration envelope so adapters do not depend on runtime internals. */
export interface IntegrationConfig {
  readonly contract?: {
    readonly identity?: Partial<IdentitySettings>;
    readonly ldap?: Partial<LdapSettings>;
    readonly postgres?: Partial<PostgresSettings>;
    readonly cpanel?: Partial<CpanelApiSettings>;
    readonly plesk?: Partial<PleskApiSettings>;
  };
  readonly identity?: Partial<IdentitySettings>;
  readonly ldap?: Partial<LdapSettings>;
  readonly postgres?: Partial<PostgresSettings>;
  readonly cpanel?: Partial<CpanelApiSettings>;
  readonly plesk?: Partial<PleskApiSettings>;
}

/** A secret resolver never receives or exposes a plaintext secret reference in logs. */
export type SecretResolver = (reference: string) => Promise<string | undefined>;

/** Logger surface required by the adapters. */
export interface IntegrationLogger {
  warn?: (event: string, details?: Record<string, unknown>) => void;
  info?: (event: string, details?: Record<string, unknown>) => void;
}

/** Minimal LDAP result shape used by the adapter and deterministic unit fakes. */
export interface LdapSearchEntry {
  readonly dn?: string;
  readonly uid?: string | string[];
  readonly mail?: string | string[];
  readonly displayName?: string | string[];
  readonly cn?: string | string[];
  readonly active?: boolean | string | string[];
  readonly [key: string]: unknown;
}

export interface LdapSearchResult {
  readonly searchEntries?: readonly LdapSearchEntry[];
}

export interface LdapSearchOptions {
  readonly scope?: 'base' | 'children' | 'one' | 'sub' | 'subordinates';
  readonly filter?: string;
  readonly attributes?: readonly string[];
}

export interface LdapClientLike {
  bind: (dn: string, password?: string) => Promise<void>;
  search: (baseDn: string, options: LdapSearchOptions) => Promise<LdapSearchResult>;
  startTLS?: (options: Record<string, unknown>) => Promise<void>;
  unbind?: () => Promise<void>;
}

export interface LdapClientOptions {
  readonly url: string;
  readonly timeout?: number;
  readonly connectTimeout?: number;
  readonly tlsOptions?: Record<string, unknown>;
}

export type LdapClientConstructor = new (options: LdapClientOptions) => LdapClientLike;

export interface TenantIdentity {
  readonly externalId?: string;
  readonly mailAddress?: string;
  readonly displayName: string | null;
  readonly dn?: string;
  readonly active: boolean;
}

export interface TenantScopedRequest {
  readonly tenantContext?: unknown;
}

export interface LdapLookupRequest extends TenantScopedRequest {
  readonly username?: unknown;
}

export interface LdapAuthenticateRequest extends LdapLookupRequest {
  readonly password?: unknown;
}

export interface DisabledLdapIdentityClient {
  readonly enabled: false;
  readonly healthCheck: () => Promise<{ status: 'disabled' }>;
  readonly authenticate: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export interface EnabledLdapIdentityClient {
  readonly enabled: true;
  readonly lookupUser: (request?: LdapLookupRequest) => Promise<TenantIdentity | null>;
  readonly authenticate: (request?: LdapAuthenticateRequest) => Promise<boolean>;
  readonly healthCheck: () => Promise<{ status: 'ok' }>;
  readonly close: () => Promise<void>;
}

export type LdapIdentityClient = DisabledLdapIdentityClient | EnabledLdapIdentityClient;

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: Row[];
}

export interface PostgresClientLike {
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<QueryResult<Row>>;
  release?: () => void;
}

export interface PostgresPoolLike {
  connect: () => Promise<PostgresClientLike>;
  end?: () => Promise<void>;
}

export interface PostgresPoolOptions {
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly ssl: false | { readonly rejectUnauthorized: boolean };
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly max: number;
}

export type PostgresPoolConstructor = new (options: PostgresPoolOptions) => PostgresPoolLike;

export interface MigrationClient extends PostgresClientLike {}

export interface MigrationLogger extends IntegrationLogger {}

export interface MigrationRecord {
  readonly version: string;
  readonly checksum: string;
  readonly applied_at?: string | Date;
}

export interface MigrationStatus {
  readonly version: string;
  readonly checksum: string;
  readonly applied_at?: string | Date;
}

export interface MigrationRunnerOptions {
  readonly client: MigrationClient;
  readonly migrationDirectory?: string | URL;
  readonly logger?: MigrationLogger;
}

export interface MigrationRunResult {
  readonly current: string | null;
  readonly applied: string[];
}

export interface MigrationRunner {
  readonly run: () => Promise<MigrationRunResult>;
  readonly status: () => Promise<MigrationStatus[]>;
}

export interface PostgresStoreOptions {
  readonly config?: unknown;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
  readonly PoolClass?: PostgresPoolConstructor;
  readonly migrationDirectory?: string | URL;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface TenantBootstrapOptions {
  readonly tenantId?: unknown;
  readonly domain?: unknown;
  readonly grossQuotaBytes?: unknown;
  readonly masterLogAccess?: unknown;
  readonly maxUsers?: unknown;
  readonly maxAliases?: unknown;
  readonly maxMessageBytes?: unknown;
}

export interface UserReferenceOptions {
  readonly userId?: unknown;
  readonly externalId?: unknown;
  readonly mailAddress?: unknown;
  readonly displayName?: unknown;
  readonly allocatedQuotaBytes?: unknown;
  readonly status?: unknown;
}

export interface QuotaAllocationOptions {
  readonly userId?: unknown;
  readonly allocatedQuotaBytes?: unknown;
}

export interface AliasOptions {
  readonly aliasAddress?: unknown;
  readonly targetUserId?: unknown;
}

export interface AuditReferenceOptions {
  readonly eventId?: unknown;
  readonly eventType?: unknown;
  readonly actorId?: unknown;
  readonly subjectId?: unknown;
  readonly correlationId?: unknown;
}

export interface TenantSnapshot extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly domain: string;
  readonly gross_quota_bytes: number;
  readonly allocated_quota_bytes: number;
}

export interface PostgresStoreDisabled {
  readonly enabled: false;
  readonly healthCheck: () => Promise<{ status: 'disabled' }>;
  readonly close: () => Promise<void>;
}

export interface PostgresStoreEnabled {
  readonly enabled: true;
  readonly healthCheck: () => Promise<{ status: 'ok' }>;
  readonly runMigrations: () => Promise<MigrationRunResult>;
  readonly migrationStatus: () => Promise<MigrationStatus[]>;
  readonly bootstrapTenant: (context: unknown, options?: TenantBootstrapOptions) => Promise<Record<string, unknown>>;
  readonly createUserReference: (context: unknown, options?: UserReferenceOptions) => Promise<Record<string, unknown>>;
  readonly allocateQuota: (context: unknown, options?: QuotaAllocationOptions) => Promise<Record<string, unknown>>;
  readonly createAlias: (context: unknown, options?: AliasOptions) => Promise<Record<string, unknown>>;
  readonly getTenantSnapshot: (context: unknown) => Promise<TenantSnapshot>;
  readonly insertAuditReference: (context: unknown, options?: AuditReferenceOptions) => Promise<Record<string, unknown>>;
  readonly withTenantTransaction: <Result>(context: unknown, callback: (client: PostgresClientLike, context: TenantContext) => Promise<Result>) => Promise<Result>;
  readonly close: () => Promise<void>;
}

export type PostgresStore = PostgresStoreDisabled | PostgresStoreEnabled;
