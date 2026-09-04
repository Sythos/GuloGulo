// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createImapClient } from '../../core/mail/imap-client.ts';
import type { ImapClient, ImapClientLogger } from '../../core/mail/imap-client.ts';
import { createSmtpClient } from '../../core/mail/smtp-client.ts';
import type { SmtpClient, SmtpClientLogger, SmtpTlsMode } from '../../core/mail/smtp-client.ts';
import type { IntegrationConfig, LdapIdentityClient, PostgresStore, SecretResolver } from '../../integrations/types.ts';
import type { PostgresCalDavStore } from '../../core/dav/caldav/postgres-caldav-store.ts';
import type { PostgresCardDavStore } from '../../core/dav/carddav/postgres-carddav-store.ts';
import { createFilesystemBackupAdapter } from '../../core/backup/filesystem-backup-adapter.ts';
import type { BackupAdapterLogger, BackupStorageAdapter } from '../../core/backup/filesystem-backup-adapter.ts';
import { createDisabledAlertDelivery, createWebhookAlertAdapter } from '../../core/observability/webhook-alert-adapter.ts';
import type {
  AlertAdapterLogger,
  AlertDeliveryAdapter,
  AlertRecord,
  AlertDeliveryResult,
  WebhookPayloadFormat,
} from '../../core/observability/webhook-alert-adapter.ts';
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
  readonly createImapClient: (overrides?: { readonly tls?: boolean; readonly connectTimeoutMs?: number; readonly commandTimeoutMs?: number }) => ImapClient;
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
/** Matches `src/runtime/config.ts`'s own `mail.mailboxRoot` default, so the same-device check has a sensible fallback even when the loaded config never set it explicitly. */
const DEFAULT_MAILBOX_ROOT = '/var/lib/gulogulo/mail';
/** `%{_localstatedir}`-style default shared by every current target (see `packaging/cpanel/gulogulo.spec`'s `/var/lib/gulogulo`); always overridable via `contract.backup.path`. */
const DEFAULT_BACKUP_PATH = '/var/lib/gulogulo/backups';

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
    createImapClient: (overrides: { readonly tls?: boolean; readonly connectTimeoutMs?: number; readonly commandTimeoutMs?: number } = {}) => createImapClient({
      host,
      port: imapsPort,
      tls: overrides.tls ?? true,
      connectTimeoutMs: overrides.connectTimeoutMs,
      commandTimeoutMs: overrides.commandTimeoutMs,
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
 * Real cPanel/Plesk mailbox password verification: neither panel's API
 * exposes a generic "verify this password" endpoint (see
 * `cpanel-identity-client.ts`/`plesk-identity-client.ts`), so the only
 * mechanism actually available is attempting an IMAP LOGIN against the same
 * local mail server `createLocalMailClients()` already points at. Success or
 * a rejected password both come back as a plain `boolean` (fail closed on
 * every error, including a network failure) — callers never learn more than
 * "the credential worked" or "it didn't". Only `AUTHENTICATION_FAILED`
 * (imap-client.ts's own code for a rejected LOGIN) is the expected, silent
 * case; anything else (timeout, refused connection, protocol error) is
 * logged via `logEvent` since on a real host that usually means the local
 * mail server isn't reachable the way `INSTALL.md` assumes.
 */
export async function authenticateWithImapLogin({
  createImapClient: createClient,
  mailAddress,
  password,
  logger,
  logEvent,
}: {
  readonly createImapClient: MailClientFactories['createImapClient'];
  readonly mailAddress: string;
  readonly password: string;
  readonly logger?: ImapClientLogger;
  readonly logEvent: string;
}): Promise<boolean> {
  const client = createClient();
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.login(mailAddress, password);
    return true;
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code !== 'AUTHENTICATION_FAILED') {
      logger?.warn?.(logEvent, { error: { name: error instanceof Error ? error.name : 'Error', code: typeof code === 'string' ? code : 'unknown' } });
    }
    return false;
  } finally {
    if (connected) {
      try { await client.logout(); } catch { client.close(); }
    } else {
      client.close();
    }
  }
}

function readBackupPath(config: IntegrationConfig, fallback: string): string {
  const root = asMailConfigRecord(config);
  const contract = asMailConfigRecord(root.contract);
  const backup = asMailConfigRecord(contract.backup ?? root.backup);
  const value = backup.path;
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * The application's own live mailbox root (`mail.mailboxRoot`, already
 * configurable per `src/runtime/config.ts`) doubles as the default
 * comparison path for the local backup adapter's same-filesystem-device
 * warning — it is the one "live data directory" every target already has a
 * real, configured answer for. `contract.backup.liveDataPath` overrides it
 * for anyone whose live data is not the mailbox root.
 */
function readBackupLiveDataPath(config: IntegrationConfig): string {
  const root = asMailConfigRecord(config);
  const contract = asMailConfigRecord(root.contract);
  const backup = asMailConfigRecord(contract.backup ?? root.backup);
  if (typeof backup.liveDataPath === 'string' && backup.liveDataPath.length > 0) return backup.liveDataPath;
  const mail = asMailConfigRecord(contract.mail ?? root.mail);
  return typeof mail.mailboxRoot === 'string' && mail.mailboxRoot.length > 0 ? mail.mailboxRoot : DEFAULT_MAILBOX_ROOT;
}

/**
 * Builds the local filesystem `BackupStorageAdapter` shared by every current
 * target's `createBackupStorage()`. `defaultPath` is the per-target
 * fallback (see each adapter's own comment); `contract.backup.path` in the
 * loaded config always overrides it, which is what makes the standalone
 * target's path "configurable" as called for by its own target description
 * — the very same override mechanism cPanel/Plesk operators can also use if
 * `/var/lib/gulogulo/backups` is not appropriate for their host.
 *
 * IMPORTANT: this is a local-path adapter, not disaster recovery — see the
 * same-filesystem-device warning documented in
 * `src/core/backup/filesystem-backup-adapter.ts` and
 * `doc/lifecycle-backup-dr.md`.
 */
export function createLocalBackupStorage(
  config: IntegrationConfig,
  options: { readonly defaultPath: string; readonly logger?: BackupAdapterLogger } = { defaultPath: DEFAULT_BACKUP_PATH },
): BackupStorageAdapter {
  return createFilesystemBackupAdapter({
    basePath: readBackupPath(config, options.defaultPath),
    liveDataPath: readBackupLiveDataPath(config),
    logger: options.logger,
  });
}

const SEVERITY_RANK: Record<'warning' | 'critical', number> = Object.freeze({ critical: 0, warning: 1 });

interface AlertingSettingsShape {
  readonly enabled: boolean;
  readonly webhookUrlSecretRef: string | null;
  readonly format: WebhookPayloadFormat;
  readonly timeoutMs: number | undefined;
  readonly retryAttempts: number | undefined;
  readonly minSeverity: 'warning' | 'critical';
}

function readAlertingSettings(config: IntegrationConfig): AlertingSettingsShape {
  const root = asMailConfigRecord(config);
  const contract = asMailConfigRecord(root.contract);
  const raw = asMailConfigRecord(contract.alerting ?? root.alerting);
  const format = raw.format;
  const timeoutMs = raw.timeoutMs;
  const retryAttempts = raw.retryAttempts;
  return {
    enabled: raw.enabled === true,
    webhookUrlSecretRef: typeof raw.webhookUrlSecretRef === 'string' ? raw.webhookUrlSecretRef : null,
    format: format === 'slack' || format === 'discord' ? format : 'generic',
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
    retryAttempts: typeof retryAttempts === 'number' ? retryAttempts : undefined,
    minSeverity: raw.minSeverity === 'critical' ? 'critical' : 'warning',
  };
}

/**
 * Builds the alert-delivery adapter shared by every current target's
 * `createAlertDelivery()`: a generic HTTP webhook
 * (`src/core/observability/webhook-alert-adapter.ts`) that delivers what
 * `src/core/observability/alert-policy.ts` decided to alert on — gated by
 * `alerting.enabled` and otherwise configured entirely from `alerting.*` in
 * `src/runtime/config.ts`.
 *
 * The webhook URL is a secret reference, not a plain config value (a Slack/
 * Discord/PagerDuty webhook URL carries its own bearer token in its path),
 * so it is resolved once here via `resolveSecret` — the same pattern
 * `createLdapIdentityClient()`/`createCpanelIdentityClient()` already use
 * for `bindSecretRef`/`apiTokenSecretRef`. Disabled (the default) or
 * unconfigured returns the same safe no-op shape those adapters return for
 * `enabled: false`.
 *
 * `alerting.minSeverity` doubles as the paging knob: point this same
 * webhook at Slack with the default `'warning'` for a general channel that
 * sees both severities, or at a PagerDuty/Opsgenie-compatible webhook URL
 * with `'critical'` to use the identical mechanism purely for paging — no
 * second, paging-specific adapter exists or is needed (see
 * doc/observability.md).
 */
export async function createConfiguredAlertDelivery(
  config: IntegrationConfig,
  options: { readonly resolveSecret?: SecretResolver; readonly logger?: AlertAdapterLogger } = {},
): Promise<AlertDeliveryAdapter> {
  const settings = readAlertingSettings(config);
  if (!settings.enabled) {
    return createDisabledAlertDelivery();
  }
  if (typeof options.resolveSecret !== 'function' || settings.webhookUrlSecretRef === null) {
    throw new Error('alerting.webhookUrlSecretRef and a secret resolver are required when alerting.enabled is true');
  }
  const webhookUrl = await options.resolveSecret(settings.webhookUrlSecretRef);
  if (typeof webhookUrl !== 'string' || webhookUrl.length === 0) {
    throw new Error('alert webhook URL secret resolution failed');
  }
  const delivery = createWebhookAlertAdapter({
    webhookUrl,
    format: settings.format,
    timeoutMs: settings.timeoutMs,
    retryAttempts: settings.retryAttempts,
    logger: options.logger,
  });
  const minRank = SEVERITY_RANK[settings.minSeverity];
  return Object.freeze({
    enabled: true as const,
    deliver: (alerts: readonly AlertRecord[]): Promise<AlertDeliveryResult> =>
      delivery.deliver(alerts.filter((alert) => SEVERITY_RANK[alert.severity] <= minRank)),
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

  /**
   * Resolves where the manifests/archives `src/core/backup/backup-contract.ts`
   * builds in memory are actually written. Every current target returns a
   * local filesystem adapter (`createLocalBackupStorage()` below) — a fast,
   * same-host recovery convenience within the retention window, explicitly
   * NOT disaster recovery (see `doc/lifecycle-backup-dr.md`). The interface
   * itself is storage-agnostic, so a future remote adapter (rsync to
   * another host, an S3-compatible store) can be returned here without this
   * contract or any caller changing. Optional for the same reason
   * `createMailClients` is: an adapter that predates backup wiring, or a
   * test double, is not forced to implement it.
   */
  createBackupStorage?(config: IntegrationConfig): Promise<BackupStorageAdapter>;

  /**
   * Resolves where a threshold breach evaluated by
   * `src/core/observability/alert-policy.ts` is actually delivered: a
   * generic HTTP webhook (Slack/Discord/PagerDuty-relay/any JSON endpoint —
   * `src/core/observability/webhook-alert-adapter.ts`), gated and
   * configured by `alerting.*` (`src/runtime/config.ts`). Every current
   * target returns `createConfiguredAlertDelivery()` below.
   * `alert-policy.ts` itself stays pure — it only decides severity, never
   * opens a socket; this method, together with `deliverAlertEvaluation()` in
   * `webhook-alert-adapter.ts`, is the I/O layer that actually delivers what
   * it decided. Optional for the same reason `createMailClients`/
   * `createBackupStorage` are: an adapter that predates alert-delivery
   * wiring, or a test double, is not forced to implement it.
   */
  createAlertDelivery?(config: IntegrationConfig): Promise<AlertDeliveryAdapter>;

  /** Resolves where/how web sessions are persisted for this target. */
  createSessionStore(): Promise<SessionStore>;
}
