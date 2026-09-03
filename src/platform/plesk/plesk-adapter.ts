// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { loadConfig as loadRuntimeConfig } from '../../runtime/config.ts';
import { createPleskIdentityClient } from './plesk-identity-client.ts';
import { createPostgresStore } from '../../integrations/postgres-store.ts';
import type { IntegrationConfig, IntegrationLogger, LdapIdentityClient, PostgresStore, SecretResolver } from '../../integrations/types.ts';
import type { PlatformAdapter } from '../contract/platform-adapter.ts';
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

  async function createSessionStore(): Promise<SessionStore> {
    return new Map<string, WebSession>();
  }

  return Object.freeze({
    platformKind: 'plesk' as const,
    loadConfig,
    createIdentityClient,
    createDataStore,
    createSessionStore,
  });
}
