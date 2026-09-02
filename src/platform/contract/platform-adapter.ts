// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import type { IntegrationConfig, LdapIdentityClient, PostgresStore } from '../../integrations/types.ts';
import type { SessionStore } from '../../web/security/session-manager.ts';

/** The three packaging/distribution targets defined by ADR-002. */
export type PlatformKind = 'cpanel' | 'plesk' | 'standalone';

/**
 * Contract every target-specific adapter (`src/platform/cpanel/`,
 * `src/platform/plesk/`, `src/platform/standalone/`) implements so that
 * `src/core/` stays free of any packaging-target-specific code, per ADR-002.
 *
 * Each method is async because a panel-backed implementation (cPanel/Plesk)
 * may need to perform I/O — reading a panel-managed config location or
 * talking to the panel API — before it can hand back a usable client, even
 * where the standalone implementation can resolve synchronously.
 */
export interface PlatformAdapter {
  /** Identifies which of the three ADR-002 targets this adapter implements. */
  readonly platformKind: PlatformKind;

  /**
   * Resolves the application configuration for this target: file/env for
   * standalone, a panel-managed location for cPanel/Plesk.
   */
  loadConfig(): Promise<IntegrationConfig>;

  /**
   * Resolves user identity for this target: LDAP for standalone, the host
   * panel's own API (UAPI/whmapi1 for cPanel, REST/XML-RPC for Plesk) for
   * cPanel/Plesk. The shape is `LdapIdentityClient` for every target — the
   * name is historical, the interface (lookupUser/authenticate/healthCheck)
   * is already panel-agnostic.
   */
  createIdentityClient(config: IntegrationConfig): Promise<LdapIdentityClient>;

  /**
   * Resolves the data store for this target. PostgreSQL is the only engine
   * implemented today; a future MySQL/MariaDB engine (cPanel/Plesk's primary
   * engine per ADR-002) conforms to the same `PostgresStore` shape.
   */
  createDataStore(config: IntegrationConfig): Promise<PostgresStore>;

  /** Resolves where/how web sessions are persisted for this target. */
  createSessionStore(): Promise<SessionStore>;
}
