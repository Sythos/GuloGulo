/*
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
*/

import { Client as DefaultClient } from 'ldapts';

import { assertTenantContext } from './tenant-context.ts';
import type {
  EnabledLdapIdentityClient,
  IntegrationLogger,
  LdapAuthenticateRequest,
  LdapClientConstructor,
  LdapClientLike,
  LdapIdentityClient,
  LdapLookupRequest,
  LdapSearchEntry,
  LdapSettings,
  SecretResolver,
  TenantIdentity,
} from './types.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_ATTEMPTS = 2;

interface CodedError extends Error {
  readonly code: string;
}

interface LdapClientOptions {
  readonly config?: unknown;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
  readonly ClientClass?: LdapClientConstructor;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function ldapError(message: string, code = 'LDAP_ERROR'): CodedError {
  const error = new Error(`LDAP client error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readSettings(config: unknown): LdapSettings {
  const root = asRecord(config);
  const contract = asRecord(root.contract);
  const raw = asRecord(contract.ldap ?? root.ldap);
  return {
    enabled: raw.enabled === true,
    url: typeof raw.url === 'string' ? raw.url : '',
    startTls: raw.startTls === true,
    bindDn: raw.bindDn === null || typeof raw.bindDn === 'string' ? raw.bindDn : null,
    bindSecretRef: raw.bindSecretRef === null || typeof raw.bindSecretRef === 'string' ? raw.bindSecretRef : null,
    userBaseDn: raw.userBaseDn === null || typeof raw.userBaseDn === 'string' ? raw.userBaseDn : null,
    connectTimeoutMs: Number.isSafeInteger(raw.connectTimeoutMs) ? raw.connectTimeoutMs as number : DEFAULT_CONNECT_TIMEOUT_MS,
    operationTimeoutMs: Number.isSafeInteger(raw.operationTimeoutMs) ? raw.operationTimeoutMs as number : DEFAULT_OPERATION_TIMEOUT_MS,
    retryAttempts: Number.isSafeInteger(raw.retryAttempts) && (raw.retryAttempts as number) >= 0
      ? raw.retryAttempts as number
      : DEFAULT_RETRY_ATTEMPTS,
  };
}

function errorDetails(error: unknown): { name: string; code: string } {
  const record = asRecord(error);
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof record.code === 'string' ? record.code : 'unknown',
  };
}

function escapeFilter(value: unknown): string {
  return String(value).replace(/[\\*()\0]/gu, (character) => ({
    '\\': '\\5c',
    '*': '\\2a',
    '(': '\\28',
    ')': '\\29',
    '\0': '\\00',
  }[character] ?? character));
}

function tlsOptions(settings: Pick<LdapSettings, 'url'>): Record<string, unknown> {
  return { rejectUnauthorized: true, servername: new URL(settings.url).hostname };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeClient(client: LdapClientLike): Promise<void> {
  if (typeof client.unbind !== 'function') return;
  try {
    await client.unbind();
  } catch {
    // Best-effort cleanup. Never expose bind material in an error path.
  }
}

function attributeString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return attributeString(value[0]);
  }
  return typeof value === 'string' ? value : undefined;
}

export function createLdapIdentityClient({
  config,
  resolveSecret,
  logger = console,
  ClientClass = DefaultClient as unknown as LdapClientConstructor,
  sleep: sleepFunction = sleep,
}: LdapClientOptions = {}): LdapIdentityClient {
  const settings = readSettings(config);
  if (!settings.enabled) {
    return Object.freeze({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      authenticate: async () => false,
      close: async () => {},
    });
  }

  if (typeof resolveSecret !== 'function' || settings.bindSecretRef === null || settings.bindDn === null || settings.userBaseDn === null) {
    throw ldapError('bind DN, bind secret reference, and user base DN are required', 'CONFIGURATION');
  }
  const secretResolver = resolveSecret;
  const bindSecretRef = settings.bindSecretRef;
  const bindDn = settings.bindDn;
  const userBaseDn = settings.userBaseDn;
  if (settings.url.length === 0) {
    throw ldapError('LDAP URL is required', 'CONFIGURATION');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(settings.url);
  } catch {
    throw ldapError('LDAP URL is invalid', 'CONFIGURATION');
  }
  if (parsedUrl.protocol !== 'ldap:' && parsedUrl.protocol !== 'ldaps:') {
    throw ldapError('LDAP URL must use ldap:// or ldaps://', 'CONFIGURATION');
  }
  if (parsedUrl.protocol === 'ldap:' && !settings.startTls) {
    throw ldapError('ldap:// requires StartTLS', 'CONFIGURATION');
  }
  if (parsedUrl.protocol === 'ldaps:' && settings.startTls) {
    throw ldapError('ldaps:// cannot use StartTLS', 'CONFIGURATION');
  }

  async function retry<Result>(operation: () => Promise<Result>, label: string): Promise<Result> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= settings.retryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === settings.retryAttempts) break;
        logger.warn?.('ldap_retry', { operation: label, attempt: attempt + 1, error: errorDetails(error) });
        await sleepFunction(Math.min(1_000, 100 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async function openClient(): Promise<LdapClientLike> {
    const client = new ClientClass({
      url: settings.url,
      timeout: settings.operationTimeoutMs,
      connectTimeout: settings.connectTimeoutMs,
      tlsOptions: tlsOptions(settings),
    });
    if (parsedUrl.protocol === 'ldap:') {
      if (typeof client.startTLS !== 'function') {
        await closeClient(client);
        throw ldapError('LDAP client does not support StartTLS', 'CONFIGURATION');
      }
      await client.startTLS(tlsOptions(settings));
    }
    return client;
  }

  async function serviceClient<Result>(callback: (client: LdapClientLike) => Promise<Result>): Promise<Result> {
    const client = await openClient();
    try {
      const secret = await secretResolver(bindSecretRef);
      if (typeof secret !== 'string' || secret.length === 0) {
        throw ldapError('LDAP bind secret resolution failed', 'SECRET_UNAVAILABLE');
      }
      await client.bind(bindDn, secret);
      return await callback(client);
    } finally {
      await closeClient(client);
    }
  }

  async function lookupUser({ tenantContext, username }: LdapLookupRequest = {}): Promise<TenantIdentity | null> {
    const context = assertTenantContext(tenantContext);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw ldapError('username is invalid', 'INVALID_INPUT');
    }
    const filter = `(&(objectClass=person)(mail=${escapeFilter(username)}@${escapeFilter(context.domain)}))`;
    return retry(() => serviceClient(async (client) => {
      const result = await client.search(userBaseDn, {
        scope: 'sub',
        filter,
        attributes: ['uid', 'mail', 'displayName', 'cn', 'active'],
      });
      const entries: readonly LdapSearchEntry[] = (result).searchEntries ?? [];
      if (entries.length > 1) throw ldapError('LDAP returned multiple identities', 'AMBIGUOUS_IDENTITY');
      if (entries.length === 0) return null;
      const entry = entries[0];
      const mailAddress = attributeString(entry.mail);
      const externalId = attributeString(entry.uid);
      return {
        externalId,
        mailAddress,
        displayName: attributeString(entry.displayName) ?? attributeString(entry.cn) ?? null,
        dn: attributeString(entry.dn),
        active: entry.active !== false,
      };
    }), 'lookup');
  }

  async function authenticate({ tenantContext, username, password }: LdapAuthenticateRequest = {}): Promise<boolean> {
    if (typeof password !== 'string' || password.length === 0) return false;
    try {
      const identity = await lookupUser({ tenantContext, username });
      if (!identity?.dn || identity.active === false) return false;
      const client = await openClient();
      try {
        await client.bind(identity.dn, password);
        return true;
      } finally {
        await closeClient(client);
      }
    } catch (error) {
      logger.warn?.('ldap_authentication_failed', { error: errorDetails(error) });
      return false;
    }
  }

  const enabledClient: EnabledLdapIdentityClient = {
    enabled: true,
    lookupUser,
    authenticate,
    healthCheck: async () => retry(() => serviceClient(async (client) => {
      await client.search(userBaseDn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] });
      return { status: 'ok' as const };
    }), 'health'),
    close: async () => {},
  };
  return Object.freeze(enabledClient);
}

export { escapeFilter, tlsOptions };
