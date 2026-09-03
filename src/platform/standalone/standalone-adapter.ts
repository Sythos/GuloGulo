// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { loadConfig as loadRuntimeConfig } from '../../runtime/config.ts';
import { createLdapIdentityClient } from '../../integrations/ldap-client.ts';
import { createPostgresStore } from '../../integrations/postgres-store.ts';
import { createPostgresCalDavStore } from '../../core/dav/caldav/postgres-caldav-store.ts';
import { createPostgresCardDavStore } from '../../core/dav/carddav/postgres-carddav-store.ts';
import { createDatabaseIdentityClient } from './db-identity-client.ts';
import type { IntegrationConfig, IntegrationLogger, LdapIdentityClient, PostgresStore, SecretResolver } from '../../integrations/types.ts';
import { createConfiguredAlertDelivery, createLocalBackupStorage, createLocalMailClients } from '../contract/platform-adapter.ts';
import type { DavStore, MailClientFactories, PlatformAdapter } from '../contract/platform-adapter.ts';
import type { BackupStorageAdapter } from '../../core/backup/filesystem-backup-adapter.ts';
import type { AlertDeliveryAdapter } from '../../core/observability/webhook-alert-adapter.ts';
import type { SessionStore, WebSession } from '../../web/security/session-manager.ts';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Reads `identity.source` from either the full contract (`config.contract.identity`)
 * or the legacy flat shape (`config.identity`), matching how every other
 * `readSettings()` in `src/integrations/` resolves its section. Defaults to
 * `'ldap'` so an operator who never sets this field keeps today's behavior.
 */
function identitySource(config: IntegrationConfig): 'ldap' | 'database' {
  const root = asRecord(config);
  const contract = asRecord(root.contract);
  const raw = asRecord(contract.identity ?? root.identity).source;
  return raw === 'database' ? 'database' : 'ldap';
}

/**
 * Options accepted by {@link createStandaloneAdapter}. Every field mirrors an
 * existing knob already understood by the delegate it is forwarded to:
 * `environment`/`configFilePath` go to `loadConfig()` in
 * `src/runtime/config.ts`, `resolveSecret`/`logger` go to
 * `createLdapIdentityClient()`, `createDatabaseIdentityClient()`, and
 * `createPostgresStore()` in `src/integrations/`/`./db-identity-client.ts`.
 * Which identity client is built is controlled entirely by the loaded
 * config's `identity.source` field (`'ldap'`, the default, or `'database'`),
 * not by anything here.
 */
export interface StandaloneAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly configFilePath?: string;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
}

/**
 * The ADR-002 `standalone` target adapter: the generic archive package for an
 * operator running Gulo Gulo on their own server/VPS without cPanel/Plesk.
 *
 * This is intentionally a thin wiring layer. Every method delegates to code
 * that already exists and is already tested elsewhere:
 * - `loadConfig()` calls `loadConfig()` from `src/runtime/config.ts`, the
 *   same file/env-driven configuration loader the runtime already uses.
 * - `createIdentityClient()` calls `createLdapIdentityClient()` from
 *   `src/integrations/ldap-client.ts` by default, or
 *   `createDatabaseIdentityClient()` from `./db-identity-client.ts` when the
 *   loaded config sets `identity.source` to `'database'` — a PostgreSQL-backed
 *   `local_users` table for lighter single/few-tenant installs that would
 *   rather not stand up an LDAP directory.
 * - `createDataStore()` calls `createPostgresStore()` from
 *   `src/integrations/postgres-store.ts`.
 * - `createDavStore()` calls `createPostgresCalDavStore()`/
 *   `createPostgresCardDavStore()` from `src/core/dav/caldav/` and
 *   `src/core/dav/carddav/` — the persistent backends for the in-memory
 *   `caldav-contract.ts`/`carddav-store.ts` object contracts.
 * - `createMailClients()` calls `createLocalMailClients()` from
 *   `../contract/platform-adapter.ts`, shared by all three targets: IMAP/SMTP
 *   client factories against `127.0.0.1` (the host's own Dovecot/Postfix)
 *   with ports from the existing `mail.imapsPort`/`mail.smtpSubmissionPort`
 *   config.
 * - `createAlertDelivery()` calls `createConfiguredAlertDelivery()` from
 *   `../contract/platform-adapter.ts`, shared by all three targets: a
 *   generic webhook delivering `alert-policy.ts`'s evaluated alerts, gated
 *   and configured by `alerting.*`.
 * - `createSessionStore()` returns the same in-memory `Map` that
 *   `createSessionManager()` in `src/web/security/session-manager.ts` already
 *   uses as its default `store`.
 */
export function createStandaloneAdapter(options: StandaloneAdapterOptions = {}): PlatformAdapter {
  const { environment, configFilePath, resolveSecret, logger } = options;

  async function loadConfig(): Promise<IntegrationConfig> {
    const configOptions = configFilePath === undefined ? {} : { configFilePath };
    const config = environment === undefined
      ? loadRuntimeConfig(undefined, configOptions)
      : loadRuntimeConfig(environment, configOptions);
    return config as unknown as IntegrationConfig;
  }

  async function createIdentityClient(config: IntegrationConfig): Promise<LdapIdentityClient> {
    return identitySource(config) === 'database'
      ? createDatabaseIdentityClient({ config, resolveSecret, logger })
      : createLdapIdentityClient({ config, resolveSecret, logger });
  }

  async function createDataStore(config: IntegrationConfig): Promise<PostgresStore> {
    return createPostgresStore({ config, resolveSecret, logger });
  }

  async function createDavStore(config: IntegrationConfig): Promise<DavStore> {
    return {
      caldav: createPostgresCalDavStore({ config, resolveSecret, logger }),
      carddav: createPostgresCardDavStore({ config, resolveSecret, logger }),
    };
  }

  async function createMailClients(config: IntegrationConfig): Promise<MailClientFactories> {
    return createLocalMailClients(config, { logger });
  }

  /**
   * A standalone install's location varies by operator (it is an archive
   * extracted wherever they chose), so `/var/lib/gulogulo/backups` here is
   * only the fallback default — the same FHS-style data directory
   * `mail.mailboxRoot` and the patch status file already default to for
   * this target. `contract.backup.path` in the loaded config overrides it.
   */
  async function createBackupStorage(config: IntegrationConfig): Promise<BackupStorageAdapter> {
    return createLocalBackupStorage(config, { defaultPath: '/var/lib/gulogulo/backups', logger });
  }

  /**
   * The generic webhook alert-delivery adapter shared by every target — see
   * `createConfiguredAlertDelivery()` in `../contract/platform-adapter.ts`.
   */
  async function createAlertDelivery(config: IntegrationConfig): Promise<AlertDeliveryAdapter> {
    return createConfiguredAlertDelivery(config, { resolveSecret, logger });
  }

  async function createSessionStore(): Promise<SessionStore> {
    return new Map<string, WebSession>();
  }

  return Object.freeze({
    platformKind: 'standalone' as const,
    loadConfig,
    createIdentityClient,
    createDataStore,
    createDavStore,
    createMailClients,
    createBackupStorage,
    createAlertDelivery,
    createSessionStore,
  });
}
