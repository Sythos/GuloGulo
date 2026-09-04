// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { assertTenantContext } from '../../integrations/tenant-context.ts';
import { createPleskApiClient } from './plesk-api-client.ts';
import type { PleskApiClientLike, PleskApiClientOptions } from './plesk-api-client.ts';
import { authenticateWithImapLogin } from '../contract/platform-adapter.ts';
import type { MailClientFactories } from '../contract/platform-adapter.ts';
import type {
  EnabledLdapIdentityClient,
  IntegrationLogger,
  LdapAuthenticateRequest,
  LdapIdentityClient,
  LdapLookupRequest,
  PleskApiSettings,
  SecretResolver,
  TenantIdentity,
} from '../../integrations/types.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DEFAULT_TIMEOUT_MS = 5_000;

interface CodedError extends Error {
  readonly code: string;
}

interface PleskIdentityClientOptions {
  readonly config?: unknown;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
  /** Injectable for tests: overrides how the underlying REST client is built. */
  readonly createApiClient?: (options: PleskApiClientOptions) => PleskApiClientLike;
  /** Required when `enabled`: how `authenticate()` opens an IMAP LOGIN against this target's local mail server. Callers pass `createLocalMailClients(config).createImapClient` (see `plesk-adapter.ts`); tests inject a fake. */
  readonly createImapClient?: MailClientFactories['createImapClient'];
}

interface PleskDomainEntry {
  readonly id?: number | string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

interface PleskMailAccountEntry {
  readonly id?: number | string;
  readonly name?: string;
  readonly email?: string;
  readonly enabled?: boolean;
  readonly [key: string]: unknown;
}

function pleskIdentityError(message: string, code = 'PLESK_IDENTITY_ERROR'): CodedError {
  const error = new Error(`Plesk identity client error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readSettings(config: unknown): PleskApiSettings {
  const root = asRecord(config);
  const contract = asRecord(root.contract);
  const raw = asRecord(contract.plesk ?? root.plesk);
  return {
    enabled: raw.enabled === true,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKeySecretRef: raw.apiKeySecretRef === null || typeof raw.apiKeySecretRef === 'string' ? (raw.apiKeySecretRef ?? null) : null,
    timeoutMs: Number.isSafeInteger(raw.timeoutMs) ? raw.timeoutMs as number : DEFAULT_TIMEOUT_MS,
  };
}

function errorDetails(error: unknown): { name: string; code: string } {
  const record = asRecord(error);
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof record.code === 'string' ? record.code : 'unknown',
  };
}

function asDomainList(raw: unknown): PleskDomainEntry[] {
  return Array.isArray(raw) ? raw as PleskDomainEntry[] : [];
}

function asMailAccountList(raw: unknown): PleskMailAccountEntry[] {
  return Array.isArray(raw) ? raw as PleskMailAccountEntry[] : [];
}

/**
 * Resolves user identity for the Plesk target via the local REST API
 * (`/api/v2/*`) instead of LDAP. Returns the same `LdapIdentityClient` shape
 * as `src/integrations/ldap-client.ts` so `src/core/` stays panel-agnostic
 * per ADR-002 — the name is historical.
 */
export function createPleskIdentityClient({
  config,
  resolveSecret,
  logger = console,
  createApiClient = createPleskApiClient,
  createImapClient,
}: PleskIdentityClientOptions = {}): LdapIdentityClient {
  const settings = readSettings(config);
  if (!settings.enabled) {
    return Object.freeze({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      authenticate: async () => false,
      close: async () => {},
    });
  }

  if (typeof resolveSecret !== 'function' || settings.apiKeySecretRef === null) {
    throw pleskIdentityError('an apiKeySecretRef and a secret resolver are required', 'CONFIGURATION');
  }
  if (settings.baseUrl.length === 0) {
    throw pleskIdentityError('baseUrl is required', 'CONFIGURATION');
  }
  if (typeof createImapClient !== 'function') {
    throw pleskIdentityError('createImapClient is required to verify mail account passwords', 'CONFIGURATION');
  }
  const secretResolver = resolveSecret;
  const apiKeySecretRef = settings.apiKeySecretRef;
  const imapClientFactory = createImapClient;

  async function withApiClient<Result>(callback: (client: PleskApiClientLike) => Promise<Result>): Promise<Result> {
    const apiKey = await secretResolver(apiKeySecretRef);
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw pleskIdentityError('Plesk API key secret resolution failed', 'SECRET_UNAVAILABLE');
    }
    const client = createApiClient({
      baseUrl: settings.baseUrl,
      apiKey,
      timeoutMs: settings.timeoutMs,
    });
    return callback(client);
  }

  async function lookupUser({ tenantContext, username }: LdapLookupRequest = {}): Promise<TenantIdentity | null> {
    const context = assertTenantContext(tenantContext);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw pleskIdentityError('username is invalid', 'INVALID_INPUT');
    }
    const mailAddress = `${username}@${context.domain}`.toLowerCase();
    return withApiClient(async (client) => {
      // ASSUMED ENDPOINT (not verified against a live Plesk host, no access
      // to one was available while writing this): `GET /api/v2/domains`
      // lists every domain the API key can see; each entry is expected to
      // carry at least `id` and `name`. This matches the one endpoint whose
      // existence was actually confirmed by research
      // (`GET /api/v2/domains`) — everything past this point is this
      // module's best-effort extrapolation of the REST API's likely shape
      // and MUST be validated against a real Plesk Obsidian instance before
      // being trusted in production.
      let domainsRaw: unknown;
      try {
        domainsRaw = await client.request('GET', '/api/v2/domains');
      } catch (error) {
        logger.warn?.('plesk_lookup_domains_failed', { error: errorDetails(error) });
        throw error;
      }
      const domain = asDomainList(domainsRaw).find((entry) => {
        return typeof entry.name === 'string' && entry.name.toLowerCase() === context.domain;
      });
      if (domain === undefined || (typeof domain.id !== 'number' && typeof domain.id !== 'string')) {
        return null;
      }

      // ASSUMED ENDPOINT: a nested mail-accounts collection under the
      // domain resource, `GET /api/v2/domains/{id}/mail-accounts`. This is
      // this module's guess at how Plesk's REST API exposes per-domain mail
      // accounts, modeled after the nested-resource convention `/domains`
      // itself already follows; the exact path (it may instead be a
      // top-level `/api/v2/mail-accounts?domain=` collection, or something
      // else entirely) is UNVERIFIED and must be confirmed against a real
      // Plesk host before this code is relied on.
      let mailAccountsRaw: unknown;
      try {
        mailAccountsRaw = await client.request('GET', `/api/v2/domains/${domain.id}/mail-accounts`);
      } catch (error) {
        logger.warn?.('plesk_lookup_mail_accounts_failed', { error: errorDetails(error) });
        throw error;
      }
      const entry = asMailAccountList(mailAccountsRaw).find((row) => {
        if (typeof row.email === 'string' && row.email.toLowerCase() === mailAddress) return true;
        return typeof row.name === 'string' && row.name.toLowerCase() === username.toLowerCase();
      });
      if (entry === undefined) return null;

      return {
        externalId: typeof entry.name === 'string' ? entry.name : username,
        mailAddress,
        displayName: null,
        active: entry.enabled !== false,
      };
    });
  }

  // Plesk's REST API has no generic, safe "verify this mailbox's password"
  // endpoint: the domain/mail-account resources manage mail accounts, they
  // do not authenticate them. The only real verification mechanism is a
  // direct IMAP LOGIN against the local mail server, same as `lookupUser`'s
  // `mailAddress` convention — never the REST client.
  async function authenticate({ tenantContext, username, password }: LdapAuthenticateRequest = {}): Promise<boolean> {
    const context = assertTenantContext(tenantContext);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) return false;
    if (typeof password !== 'string' || password.length === 0) return false;
    const mailAddress = `${username}@${context.domain}`.toLowerCase();
    return authenticateWithImapLogin({
      createImapClient: imapClientFactory,
      mailAddress,
      password,
      logger,
      logEvent: 'plesk_authenticate_imap_failed',
    });
  }

  async function healthCheck(): Promise<{ status: 'ok' }> {
    await withApiClient(async (client) => {
      // ASSUMED ENDPOINT: `GET /api/v2/server` as a lightweight, read-only
      // reachability probe (analogous to Plesk's server-info panel).
      // Unverified against a live host; if it turns out not to exist, any
      // other stable read-only `/api/v2/*` endpoint reachable by the same
      // API key would do just as well as a probe.
      await client.request('GET', '/api/v2/server');
    });
    return { status: 'ok' as const };
  }

  const enabledClient: EnabledLdapIdentityClient = {
    enabled: true,
    lookupUser,
    authenticate,
    healthCheck,
    close: async () => {},
  };
  return Object.freeze(enabledClient);
}
