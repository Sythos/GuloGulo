// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { loadConfig as loadRuntimeConfig } from '../../runtime/config.ts';
import { createPleskIdentityClient } from './plesk-identity-client.ts';
import { createPostgresStore } from '../../integrations/postgres-store.ts';
import { createPostgresCalDavStore } from '../../core/dav/caldav/postgres-caldav-store.ts';
import { createPostgresCardDavStore } from '../../core/dav/carddav/postgres-carddav-store.ts';
import type { IntegrationConfig, IntegrationLogger, LdapIdentityClient, PostgresStore, SecretResolver } from '../../integrations/types.ts';
import { createConfiguredAlertDelivery, createLocalBackupStorage, createLocalMailClients } from '../contract/platform-adapter.ts';
import type { DavStore, MailClientFactories, PlatformAdapter } from '../contract/platform-adapter.ts';
import type { BackupStorageAdapter } from '../../core/backup/filesystem-backup-adapter.ts';
import type { AlertDeliveryAdapter } from '../../core/observability/webhook-alert-adapter.ts';
import type { SessionStore, WebSession } from '../../web/security/session-manager.ts';

/**
 * Options accepted by {@link createPleskAdapter}. Every field mirrors an
 * existing knob already understood by the delegate it is forwarded to:
 * `environment`/`configFilePath` go to `loadConfig()` in
 * `src/runtime/config.ts`, `resolveSecret`/`logger` go to
 * `createPleskIdentityClient()` (`./plesk-identity-client.ts`) and
 * `createPostgresStore()` in `src/integrations/`. Nothing here introduces
 * new configuration surface beyond the additive `PleskApiSettings` already
 * added to `src/integrations/types.ts`.
 */
export interface PleskAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly configFilePath?: string;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
}

/**
 * The ADR-002 `plesk` target adapter: identity is resolved against the
 * local Plesk REST API instead of LDAP (Plesk manages its own email
 * accounts), everything else is unchanged from the `standalone` target.
 *
 * This is intentionally a thin wiring layer, matching
 * `src/platform/cpanel/cpanel-adapter.ts` and
 * `src/platform/standalone/standalone-adapter.ts`:
 * - `loadConfig()` calls `loadConfig()` from `src/runtime/config.ts`, the
 *   same file/env-driven configuration loader the runtime already uses.
 * - `createIdentityClient()` calls `createPleskIdentityClient()` from
 *   `./plesk-identity-client.ts`, which itself builds the injectable
 *   `PleskApiClientLike` HTTP client from `./plesk-api-client.ts`.
 * - `createDataStore()` calls `createPostgresStore()` from
 *   `src/integrations/postgres-store.ts` — the same pragmatic choice already
 *   made for the standalone and cPanel targets: MySQL/MariaDB (Plesk's usual
 *   default engine) stays backlog, a Plesk host with PostgreSQL enabled
 *   works today.
 * - `createMailClients()` calls `createLocalMailClients()` from
 *   `../contract/platform-adapter.ts` — see `standalone-adapter.ts` for the
 *   shared 127.0.0.1/configured-port wiring.
 * - `createAlertDelivery()` calls `createConfiguredAlertDelivery()` from
 *   `../contract/platform-adapter.ts` — see `standalone-adapter.ts` for the
 *   shared generic-webhook wiring.
 * - `createSessionStore()` uses the same in-memory `Map` default that
 *   `createSessionManager()` in `src/web/security/session-manager.ts` uses.
 */
export function createPleskAdapter(options: PleskAdapterOptions = {}): PlatformAdapter {
  const { environment, configFilePath, resolveSecret, logger } = options;

  async function loadConfig(): Promise<IntegrationConfig> {
    const configOptions = configFilePath === undefined ? {} : { configFilePath };
    const config = environment === undefined
      ? loadRuntimeConfig(undefined, configOptions)
      : loadRuntimeConfig(environment, configOptions);
    return config as unknown as IntegrationConfig;
  }

  async function createIdentityClient(config: IntegrationConfig): Promise<LdapIdentityClient> {
    return createPleskIdentityClient({ config, resolveSecret, logger });
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

  /** `/var/lib/gulogulo/backups`, matching the shared `%{_localstatedir}`-style data directory convention (`packaging/cpanel/gulogulo.spec`); overridable via `contract.backup.path`. */
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
    platformKind: 'plesk' as const,
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
