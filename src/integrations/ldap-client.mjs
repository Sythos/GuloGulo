// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { Client as DefaultClient } from 'ldapts';
import { assertTenantContext } from './tenant-context.mjs';

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function ldapError(message, code = 'LDAP_ERROR') {
  const error = new Error(`LDAP client error: ${message}`);
  error.code = code;
  return error;
}

function escapeFilter(value) {
  return String(value).replace(/[\\*()\0]/g, (character) => ({ '\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00' })[character]);
}

function tlsOptions(settings) {
  return { rejectUnauthorized: true, servername: new URL(settings.url).hostname };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeClient(client) {
  if (typeof client?.unbind !== 'function') return;
  try { await client.unbind(); } catch { /* best-effort cleanup; never expose bind material */ }
}

export function createLdapIdentityClient({ config, resolveSecret, logger = console, ClientClass = DefaultClient, sleep: sleepFunction = sleep } = {}) {
  const contract = config?.contract ?? config ?? {};
  const settings = contract.ldap ?? {};
  if (!settings.enabled) return Object.freeze({ enabled: false, healthCheck: async () => ({ status: 'disabled' }), authenticate: async () => false, close: async () => {} });
  if (typeof resolveSecret !== 'function' || settings.bindSecretRef === null || settings.bindDn === null || settings.userBaseDn === null) throw ldapError('bind DN, bind secret reference, and user base DN are required', 'CONFIGURATION');
  const parsedUrl = new URL(settings.url);
  if (parsedUrl.protocol === 'ldap:' && !settings.startTls) throw ldapError('ldap:// requires StartTLS', 'CONFIGURATION');
  if (parsedUrl.protocol === 'ldaps:' && settings.startTls) throw ldapError('ldaps:// cannot use StartTLS', 'CONFIGURATION');

  async function retry(operation, label) {
    let lastError;
    for (let attempt = 0; attempt <= settings.retryAttempts; attempt += 1) {
      try { return await operation(); } catch (error) {
        lastError = error;
        if (attempt === settings.retryAttempts) break;
        logger.warn?.('ldap_retry', { operation: label, attempt: attempt + 1, error: { name: error?.name ?? 'Error', code: error?.code ?? 'unknown' } });
        await sleepFunction(Math.min(1000, 100 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async function openClient() {
    const client = new ClientClass({ url: settings.url, timeout: settings.operationTimeoutMs, connectTimeout: settings.connectTimeoutMs, tlsOptions: tlsOptions(settings) });
    if (parsedUrl.protocol === 'ldap:') await client.startTLS(tlsOptions(settings));
    return client;
  }

  async function serviceClient(callback) {
    const client = await openClient();
    try {
      const secret = await resolveSecret(settings.bindSecretRef);
      if (typeof secret !== 'string' || secret.length === 0) throw ldapError('LDAP bind secret resolution failed', 'SECRET_UNAVAILABLE');
      await client.bind(settings.bindDn, secret);
      return await callback(client);
    } finally {
      await closeClient(client);
    }
  }

  async function lookupUser({ tenantContext, username } = {}) {
    const context = assertTenantContext(tenantContext);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) throw ldapError('username is invalid', 'INVALID_INPUT');
    const filter = `(&(objectClass=person)(mail=${escapeFilter(username)}@${escapeFilter(context.domain)}))`;
    return retry(() => serviceClient(async (client) => {
      const result = await client.search(settings.userBaseDn, { scope: 'sub', filter, attributes: ['uid', 'mail', 'displayName', 'cn', 'active'] });
      const entries = result.searchEntries ?? [];
      if (entries.length > 1) throw ldapError('LDAP returned multiple identities', 'AMBIGUOUS_IDENTITY');
      if (entries.length === 0) return null;
      const entry = entries[0];
      const mailAddress = Array.isArray(entry.mail) ? entry.mail[0] : entry.mail;
      const externalId = Array.isArray(entry.uid) ? entry.uid[0] : entry.uid;
      return { externalId, mailAddress, displayName: entry.displayName ?? entry.cn ?? null, dn: entry.dn, active: entry.active !== false };
    }), 'lookup');
  }

  async function authenticate({ tenantContext, username, password } = {}) {
    if (typeof password !== 'string' || password.length === 0) return false;
    try {
      const identity = await lookupUser({ tenantContext, username });
      if (!identity?.dn || identity.active === false) return false;
      const client = await openClient();
      try { await client.bind(identity.dn, password); return true; } finally { await closeClient(client); }
    } catch (error) {
      logger.warn?.('ldap_authentication_failed', { error: { name: error?.name ?? 'Error', code: error?.code ?? 'unknown' } });
      return false;
    }
  }

  return Object.freeze({
    enabled: true,
    lookupUser,
    authenticate,
    healthCheck: async () => retry(() => serviceClient(async (client) => { await client.search(settings.userBaseDn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] }); return { status: 'ok' }; }), 'health'),
    close: async () => {},
  });
}

export { escapeFilter, tlsOptions };
