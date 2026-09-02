// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { loadConfig as loadRuntimeConfig } from '../../runtime/config.ts';
import { createLdapIdentityClient } from '../../integrations/ldap-client.ts';
import { createPostgresStore } from '../../integrations/postgres-store.ts';
import type { IntegrationConfig, IntegrationLogger, LdapIdentityClient, PostgresStore, SecretResolver } from '../../integrations/types.ts';
import type { PlatformAdapter } from '../contract/platform-adapter.ts';
import type { SessionStore, WebSession } from '../../web/security/session-manager.ts';

/**
 * Options accepted by {@link createStandaloneAdapter}. Every field mirrors an
 * existing knob already understood by the delegate it is forwarded to:
 * `environment`/`configFilePath` go to `loadConfig()` in
 * `src/runtime/config.ts`, `resolveSecret`/`logger` go to
 * `createLdapIdentityClient()` and `createPostgresStore()` in
 * `src/integrations/`. Nothing here introduces new configuration surface.
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
 *   `src/integrations/ldap-client.ts`.
 * - `createDataStore()` calls `createPostgresStore()` from
 *   `src/integrations/postgres-store.ts`.
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
    return createLdapIdentityClient({ config, resolveSecret, logger });
  }

  async function createDataStore(config: IntegrationConfig): Promise<PostgresStore> {
    return createPostgresStore({ config, resolveSecret, logger });
  }

  async function createSessionStore(): Promise<SessionStore> {
    return new Map<string, WebSession>();
  }

  return Object.freeze({
    platformKind: 'standalone' as const,
    loadConfig,
    createIdentityClient,
    createDataStore,
    createSessionStore,
  });
}
