// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { assertTenantContext } from '../../integrations/tenant-context.ts';
import { createCpanelApiClient } from './cpanel-api-client.ts';
import type { CpanelApiClientLike, CpanelApiClientOptions } from './cpanel-api-client.ts';
import type {
  CpanelApiSettings,
  EnabledLdapIdentityClient,
  IntegrationLogger,
  LdapAuthenticateRequest,
  LdapIdentityClient,
  LdapLookupRequest,
  SecretResolver,
  TenantIdentity,
} from '../../integrations/types.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DEFAULT_TIMEOUT_MS = 5_000;

interface CodedError extends Error {
  readonly code: string;
}

interface CpanelIdentityClientOptions {
  readonly config?: unknown;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
  /** Injectable for tests: overrides how the underlying UAPI client is built. */
  readonly createApiClient?: (options: CpanelApiClientOptions) => CpanelApiClientLike;
}

interface UapiResult {
  readonly status?: number;
  readonly errors?: readonly unknown[] | null;
  readonly data?: unknown;
}

function cpanelIdentityError(message: string, code = 'CPANEL_IDENTITY_ERROR'): CodedError {
  const error = new Error(`cPanel identity client error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readSettings(config: unknown): CpanelApiSettings {
  const root = asRecord(config);
  const contract = asRecord(root.contract);
  const raw = asRecord(contract.cpanel ?? root.cpanel);
  return {
    enabled: raw.enabled === true,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    username: typeof raw.username === 'string' ? raw.username : '',
    apiTokenSecretRef: raw.apiTokenSecretRef === null || typeof raw.apiTokenSecretRef === 'string' ? (raw.apiTokenSecretRef as string | null ?? null) : null,
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

function asUapiResult(raw: unknown): UapiResult {
  return raw !== null && typeof raw === 'object' ? raw as UapiResult : {};
}

/**
 * Resolves user identity for the cPanel target via the local per-account
 * UAPI (`Email::list_pops`), instead of LDAP. Returns the same
 * `LdapIdentityClient` shape as `src/integrations/ldap-client.ts` so
 * `src/core/` stays panel-agnostic per ADR-002 — the name is historical.
 */
export function createCpanelIdentityClient({
  config,
  resolveSecret,
  logger = console,
  createApiClient = createCpanelApiClient,
}: CpanelIdentityClientOptions = {}): LdapIdentityClient {
  const settings = readSettings(config);
  if (!settings.enabled) {
    return Object.freeze({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      authenticate: async () => false,
      close: async () => {},
    });
  }

  if (typeof resolveSecret !== 'function' || settings.apiTokenSecretRef === null) {
    throw cpanelIdentityError('an apiTokenSecretRef and a secret resolver are required', 'CONFIGURATION');
  }
  if (settings.baseUrl.length === 0) {
    throw cpanelIdentityError('baseUrl is required', 'CONFIGURATION');
  }
  if (settings.username.length === 0) {
    throw cpanelIdentityError('username is required', 'CONFIGURATION');
  }
  const secretResolver = resolveSecret;
  const apiTokenSecretRef = settings.apiTokenSecretRef;

  async function withApiClient<Result>(callback: (client: CpanelApiClientLike) => Promise<Result>): Promise<Result> {
    const apiToken = await secretResolver(apiTokenSecretRef);
    if (typeof apiToken !== 'string' || apiToken.length === 0) {
      throw cpanelIdentityError('cPanel API token secret resolution failed', 'SECRET_UNAVAILABLE');
    }
    const client = createApiClient({
      baseUrl: settings.baseUrl,
      username: settings.username,
      apiToken,
      timeoutMs: settings.timeoutMs,
    });
    return callback(client);
  }

  async function lookupUser({ tenantContext, username }: LdapLookupRequest = {}): Promise<TenantIdentity | null> {
    const context = assertTenantContext(tenantContext);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw cpanelIdentityError('username is invalid', 'INVALID_INPUT');
    }
    const mailAddress = `${username}@${context.domain}`.toLowerCase();
    return withApiClient(async (client) => {
      let raw: unknown;
      try {
        // Email::list_pops enumerates the cPanel account's mail accounts;
        // it is the closest UAPI equivalent to an LDAP "does this identity
        // exist" lookup, since cPanel owns its own email accounts rather
        // than delegating to a directory service.
        raw = await client.callUapi('Email', 'list_pops');
      } catch (error) {
        logger.warn?.('cpanel_lookup_failed', { error: errorDetails(error) });
        throw error;
      }
      const result = asUapiResult(raw);
      const rows = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
      const entry = rows.find((row) => {
        const email = row.email;
        return typeof email === 'string' && email.toLowerCase() === mailAddress;
      });
      if (entry === undefined) return null;
      const suspended = entry.suspended_login === true || entry.suspended === true;
      const login = entry.login;
      return {
        externalId: typeof login === 'string' ? login : username,
        mailAddress,
        displayName: null,
        active: !suspended,
      };
    });
  }

  // cPanel's UAPI has no generic, safe "verify this mailbox's password"
  // endpoint: Email::list_pops and its neighbors manage mail accounts, they
  // do not authenticate them, and inventing an undocumented endpoint here
  // would mean shipping unverified behavior against a real cPanel host.
  // Real password verification for cPanel-hosted mail accounts will need a
  // different mechanism in a later milestone — most likely a direct
  // IMAP/POP3 LOGIN against the local mail server (the same approach this
  // project already relies on elsewhere for LDAP-backed auth paths), or a
  // dedicated cPanel plugin/hook shipped alongside Gulo Gulo. Until then this
  // fails closed: it always returns false instead of pretending to
  // authenticate.
  async function authenticate(_request: LdapAuthenticateRequest = {}): Promise<boolean> {
    logger.warn?.('cpanel_authenticate_not_implemented', {
      reason: 'UAPI exposes no safe generic password-verification endpoint for cPanel mail accounts; requires IMAP/POP3 or a cPanel plugin, tracked for a later milestone',
    });
    return false;
  }

  async function healthCheck(): Promise<{ status: 'ok' }> {
    await withApiClient(async (client) => {
      // DomainInfo::domains_data is a lightweight, read-only call that is
      // always available on an account with UAPI access, so it is a
      // reasonable reachability probe without side effects.
      await client.callUapi('DomainInfo', 'domains_data');
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
