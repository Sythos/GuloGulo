// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createPasswordHasher } from '../../core/auth/password-hashing.ts';
import { createPostgresStore } from '../../integrations/postgres-store.ts';
import { assertTenantContext } from '../../integrations/tenant-context.ts';
import type {
  EnabledLdapIdentityClient,
  IntegrationLogger,
  LdapAuthenticateRequest,
  LdapIdentityClient,
  LdapLookupRequest,
  PostgresPoolConstructor,
  PostgresStore,
  PostgresStoreEnabled,
  PostgresStoreOptions,
  SecretResolver,
  TenantIdentity,
} from '../../integrations/types.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

interface PasswordHasherLike {
  verify: (password: string, encoded: string) => { valid: boolean; needsRehash: boolean; code?: string };
}

interface CodedError extends Error {
  readonly code: string;
}

interface DbIdentityClientOptions {
  readonly config?: unknown;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
  /** Injectable for tests: overrides the `pg` Pool constructor used by the underlying PostgreSQL store. */
  readonly PoolClass?: PostgresPoolConstructor;
  /** Injectable for tests: overrides the password verifier (defaults to `createPasswordHasher()` from `src/core/auth/password-hashing.ts`). */
  readonly hasher?: PasswordHasherLike;
  /** Injectable for tests: overrides how the underlying PostgreSQL store is built. */
  readonly createStore?: (options: PostgresStoreOptions) => PostgresStore;
}

interface LocalUserRow extends Record<string, unknown> {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  readonly display_name: string | null;
  readonly active: boolean;
}

function dbIdentityError(message: string, code = 'DB_IDENTITY_ERROR'): CodedError {
  const error = new Error(`Database identity client error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function errorDetails(error: unknown): { name: string; code: string } {
  const record = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof record.code === 'string' ? record.code : 'unknown',
  };
}

/**
 * Resolves user identity for the standalone target from a PostgreSQL-backed
 * `local_users` table (`src/core/db/migrations/0002_standalone_local_identity.sql`)
 * instead of LDAP — for lighter single/few-tenant installs that would rather
 * store users directly in the database they already run. Returns the same
 * `LdapIdentityClient` shape as `src/integrations/ldap-client.ts` so
 * `src/core/` and `src/runtime/` stay identity-source-agnostic — the name is
 * historical.
 *
 * Deliberately reuses `createPostgresStore()` (`src/integrations/postgres-store.ts`)
 * for the connection pool, retry, SSL, and RLS transaction plumbing instead of
 * duplicating it: `withTenantTransaction()` already sets the
 * `gulogulo.tenant_id` RLS context per request, which is exactly what a
 * tenant-scoped `local_users` lookup needs. Password verification reuses
 * `createPasswordHasher()` (`src/core/auth/password-hashing.ts`) — the same
 * versioned scrypt hasher already used elsewhere in the project — instead of
 * inventing a second hashing scheme.
 */
export function createDatabaseIdentityClient({
  config,
  resolveSecret,
  logger = console,
  PoolClass,
  hasher = createPasswordHasher(),
  createStore = createPostgresStore,
}: DbIdentityClientOptions = {}): LdapIdentityClient {
  const store = createStore({
    config,
    resolveSecret,
    logger,
    ...(PoolClass === undefined ? {} : { PoolClass }),
  });

  if (!store.enabled) {
    return Object.freeze({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      authenticate: async () => false,
      close: async () => {},
    });
  }
  const enabledStore: PostgresStoreEnabled = store;

  async function lookupUser({ tenantContext, username }: LdapLookupRequest = {}): Promise<TenantIdentity | null> {
    const context = assertTenantContext(tenantContext);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw dbIdentityError('username is invalid', 'INVALID_INPUT');
    }
    const normalizedUsername = username.toLowerCase();
    return enabledStore.withTenantTransaction(context, async (client) => {
      const result = await client.query<LocalUserRow>(
        'SELECT id, username, password_hash, display_name, active FROM local_users WHERE tenant_id = $1 AND username = $2',
        [context.tenantId, normalizedUsername],
      );
      const row = result.rows[0];
      if ((result.rowCount ?? 0) !== 1 || !row) return null;
      return {
        externalId: row.id,
        mailAddress: `${row.username}@${context.domain}`,
        displayName: row.display_name,
        active: row.active !== false,
      };
    });
  }

  async function authenticate({ tenantContext, username, password }: LdapAuthenticateRequest = {}): Promise<boolean> {
    if (typeof password !== 'string' || password.length === 0) return false;
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) return false;
    try {
      const context = assertTenantContext(tenantContext);
      const normalizedUsername = username.toLowerCase();
      return await enabledStore.withTenantTransaction(context, async (client) => {
        const result = await client.query<LocalUserRow>(
          'SELECT password_hash, active FROM local_users WHERE tenant_id = $1 AND username = $2',
          [context.tenantId, normalizedUsername],
        );
        const row = result.rows[0];
        if ((result.rowCount ?? 0) !== 1 || !row || row.active === false) return false;
        return hasher.verify(password, row.password_hash).valid;
      });
    } catch (error) {
      logger.warn?.('database_identity_authenticate_failed', { error: errorDetails(error) });
      return false;
    }
  }

  const enabledClient: EnabledLdapIdentityClient = {
    enabled: true,
    lookupUser,
    authenticate,
    healthCheck: async () => {
      const status = await enabledStore.healthCheck();
      return status as { status: 'ok' };
    },
    close: () => enabledStore.close(),
  };
  return Object.freeze(enabledClient);
}
