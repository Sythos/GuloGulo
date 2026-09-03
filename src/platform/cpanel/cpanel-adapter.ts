// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { loadConfig as loadRuntimeConfig } from '../../runtime/config.ts';
import { createCpanelIdentityClient } from './cpanel-identity-client.ts';
import { createPostgresStore } from '../../integrations/postgres-store.ts';
import { createPostgresCalDavStore } from '../../core/dav/caldav/postgres-caldav-store.ts';
import { createPostgresCardDavStore } from '../../core/dav/carddav/postgres-carddav-store.ts';
import type { IntegrationConfig, IntegrationLogger, LdapIdentityClient, PostgresStore, SecretResolver } from '../../integrations/types.ts';
import { createLocalBackupStorage, createLocalMailClients } from '../contract/platform-adapter.ts';
import type { DavStore, MailClientFactories, PlatformAdapter } from '../contract/platform-adapter.ts';
import type { BackupStorageAdapter } from '../../core/backup/filesystem-backup-adapter.ts';
import type { SessionStore, WebSession } from '../../web/security/session-manager.ts';

/**
 * Options accepted by {@link createCpanelAdapter}. Every field mirrors an
 * existing knob already understood by the delegate it is forwarded to:
 * `environment`/`configFilePath` go to `loadConfig()` in
 * `src/runtime/config.ts`, `resolveSecret`/`logger` go to
 * `createCpanelIdentityClient()` (`./cpanel-identity-client.ts`) and
 * `createPostgresStore()` in `src/integrations/`. Nothing here introduces
 * new configuration surface beyond the additive `CpanelApiSettings` already
 * added to `src/integrations/types.ts`.
 */
export interface CpanelAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly configFilePath?: string;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
}

/**
 * The ADR-002 `cpanel` target adapter: identity is resolved against the
 * local cPanel UAPI instead of LDAP (cPanel manages its own email accounts),
 * everything else is unchanged from the `standalone` target.
 *
 * This is intentionally a thin wiring layer, matching
 * `src/platform/standalone/standalone-adapter.ts`:
 * - `loadConfig()` calls `loadConfig()` from `src/runtime/config.ts`, the
 *   same file/env-driven configuration loader the runtime already uses.
 * - `createIdentityClient()` calls `createCpanelIdentityClient()` from
 *   `./cpanel-identity-client.ts`, which itself builds the injectable
 *   `CpanelApiClientLike` HTTP client from `./cpanel-api-client.ts`.
 * - `createDataStore()` calls `createPostgresStore()` from
 *   `src/integrations/postgres-store.ts` — the same pragmatic choice already
 *   made for the standalone target in PK2: MySQL/MariaDB (cPanel's usual
 *   default engine) stays backlog, a cPanel host with PostgreSQL enabled
 *   works today.
 * - `createMailClients()` calls `createLocalMailClients()` from
 *   `../contract/platform-adapter.ts` — see `standalone-adapter.ts` for the
 *   shared 127.0.0.1/configured-port wiring.
 * - `createSessionStore()` uses the same in-memory `Map` default that
 *   `createSessionManager()` in `src/web/security/session-manager.ts` uses.
 */
export function createCpanelAdapter(options: CpanelAdapterOptions = {}): PlatformAdapter {
  const { environment, configFilePath, resolveSecret, logger } = options;

  async function loadConfig(): Promise<IntegrationConfig> {
    const configOptions = configFilePath === undefined ? {} : { configFilePath };
    const config = environment === undefined
      ? loadRuntimeConfig(undefined, configOptions)
      : loadRuntimeConfig(environment, configOptions);
    return config as unknown as IntegrationConfig;
  }

  async function createIdentityClient(config: IntegrationConfig): Promise<LdapIdentityClient> {
    return createCpanelIdentityClient({ config, resolveSecret, logger });
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

  /** `/var/lib/gulogulo/backups`, matching the RPM target's fixed `%{_localstatedir}`-derived install layout (`packaging/cpanel/gulogulo.spec`); overridable via `contract.backup.path`. */
  async function createBackupStorage(config: IntegrationConfig): Promise<BackupStorageAdapter> {
    return createLocalBackupStorage(config, { defaultPath: '/var/lib/gulogulo/backups', logger });
  }

  async function createSessionStore(): Promise<SessionStore> {
    return new Map<string, WebSession>();
  }

  return Object.freeze({
    platformKind: 'cpanel' as const,
    loadConfig,
    createIdentityClient,
    createDataStore,
    createDavStore,
    createMailClients,
    createBackupStorage,
    createSessionStore,
  });
}
