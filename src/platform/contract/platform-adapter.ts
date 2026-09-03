// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createImapClient } from '../../core/mail/imap-client.ts';
import type { ImapClient, ImapClientLogger } from '../../core/mail/imap-client.ts';
import { createSmtpClient } from '../../core/mail/smtp-client.ts';
import type { SmtpClient, SmtpClientLogger, SmtpTlsMode } from '../../core/mail/smtp-client.ts';
import type { IntegrationConfig, LdapIdentityClient, PostgresStore } from '../../integrations/types.ts';
import type { PostgresCalDavStore } from '../../core/dav/caldav/postgres-caldav-store.ts';
import type { PostgresCardDavStore } from '../../core/dav/carddav/postgres-carddav-store.ts';
import type { SessionStore } from '../../web/security/session-manager.ts';

/** The three packaging/distribution targets defined by ADR-002. */
export type PlatformKind = 'cpanel' | 'plesk' | 'standalone';

/**
 * IMAP/SMTP client factories bound to one target's local mail server.
 * Factories, not ready-made clients: `imap-idle-adapter.ts` opens one IMAP
 * connection per (tenant, user, mailbox) watch, and `smtp-queue-adapter.ts`
 * opens one SMTP connection per delivery attempt, each with its own
 * credentials resolved at call time — there is no single long-lived client to
 * hand back here, unlike `createDataStore()`'s pooled store.
 */
export interface MailClientFactories {
  readonly createImapClient: (overrides?: { readonly tls?: boolean }) => ImapClient;
  readonly createSmtpClient: (overrides?: { readonly tls?: SmtpTlsMode }) => SmtpClient;
}

function asMailConfigRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readMailPort(config: IntegrationConfig, field: 'imapsPort' | 'smtpSubmissionPort', fallback: number): number {
  const root = asMailConfigRecord(config);
  const contract = asMailConfigRecord(root.contract);
  const mail = asMailConfigRecord(contract.mail ?? root.mail);
  const value = mail[field];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : fallback;
}

const LOCAL_MAIL_HOST = '127.0.0.1';
const DEFAULT_IMAPS_PORT = 993;
const DEFAULT_SMTP_SUBMISSION_PORT = 587;

/**
 * Build IMAP/SMTP client factories against the packaging target's local mail
 * server. Every target (standalone/cpanel/plesk) points at `127.0.0.1` — the
 * host's own Dovecot/Postfix, per `doc/mail-core.md` — with ports read from
 * the already-configurable `mail.imapsPort`/`mail.smtpSubmissionPort`
 * settings (`src/runtime/config.ts`). Shared by every concrete adapter's
 * `createMailClients()` so host/port resolution is not reimplemented three
 * times. Verified so far only against a local protocol fake (see
 * `src/core/mail/imap-idle-adapter.test.ts` and
 * `src/core/mail/smtp-queue-adapter.test.ts`) — real Dovecot/Postfix
 * interoperability is unverified operational work.
 */
export function createLocalMailClients(
  config: IntegrationConfig,
  options: { readonly logger?: ImapClientLogger & SmtpClientLogger; readonly host?: string } = {},
): MailClientFactories {
  const host = options.host ?? LOCAL_MAIL_HOST;
  const logger = options.logger;
  const imapsPort = readMailPort(config, 'imapsPort', DEFAULT_IMAPS_PORT);
  const smtpSubmissionPort = readMailPort(config, 'smtpSubmissionPort', DEFAULT_SMTP_SUBMISSION_PORT);
  return Object.freeze({
    createImapClient: (overrides: { readonly tls?: boolean } = {}) => createImapClient({
      host,
      port: imapsPort,
      tls: overrides.tls ?? true,
      logger,
    }),
    createSmtpClient: (overrides: { readonly tls?: SmtpTlsMode } = {}) => createSmtpClient({
      host,
      port: smtpSubmissionPort,
      tls: overrides.tls ?? 'starttls',
      logger,
    }),
  });
}

/**
 * The persistent CalDAV/CardDAV storage backends for this target — see
 * `src/core/dav/caldav/postgres-caldav-store.ts` and
 * `src/core/dav/carddav/postgres-carddav-store.ts`. Kept as a distinct pair
 * rather than folded into `createDataStore()`'s `PostgresStore` shape
 * because the DAV adapters expose an entirely different method surface
 * (calendar/contact objects, not tenant/user/quota rows) even though they
 * are backed by the same PostgreSQL engine and connection settings.
 */
export interface DavStore {
  readonly caldav: PostgresCalDavStore;
  readonly carddav: PostgresCardDavStore;
}

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

  /**
   * Resolves the persistent CalDAV/CardDAV storage backends for this target.
   * PostgreSQL is the only engine implemented today, via
   * `createPostgresCalDavStore()`/`createPostgresCardDavStore()` — the same
   * pragmatic per-target choice already made for `createDataStore()`.
   */
  createDavStore(config: IntegrationConfig): Promise<DavStore>;

  /**
   * Resolves IMAP/SMTP client factories for this target's local mail server
   * (`src/core/mail/imap-idle-adapter.ts`, `src/core/mail/smtp-queue-adapter.ts`).
   * Optional so an adapter that predates mail wiring, or a test double, is
   * not forced to implement it.
   */
  createMailClients?(config: IntegrationConfig): Promise<MailClientFactories>;

  /** Resolves where/how web sessions are persisted for this target. */
  createSessionStore(): Promise<SessionStore>;
}
