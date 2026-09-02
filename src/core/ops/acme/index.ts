// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { domainToASCII } from 'node:url';

const DAY_MS = 86_400_000;
const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;
const SECRET_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EMAIL_PATTERN = /^[\x21-\x7E]{1,254}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]+-----/u;
const SECRET_KEY_PATTERN = /(account.?key|private.?key|certificate.?pem|secret|password|passphrase|token|credential|authorization|cookie|hmac|bearer)/iu;

export const ACME_PROVIDERS = Object.freeze({
  LETSENCRYPT: 'letsencrypt',
  GENERIC: 'acme',
});

export const ACME_ENVIRONMENTS = Object.freeze({
  PRODUCTION: 'production',
  STAGING: 'staging',
});

export const CHALLENGE_TYPES = Object.freeze({
  HTTP_01: 'http-01',
  DNS_01: 'dns-01',
});

export const DEFAULT_LETSENCRYPT_DIRECTORY_URL = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETSENCRYPT_STAGING_DIRECTORY_URL = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export const RENEWAL_STATES = Object.freeze([
  'idle',
  'scheduled',
  'authorizing',
  'ordering',
  'finalizing',
  'reload_pending',
  'active',
  'retry_wait',
  'degraded',
  'failed',
  'cancelled',
]);

export const TLS_PROTOCOLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function acmeError(message, code = 'ACME_CONTRACT_ERROR', details = undefined) {
  const error = new Error(`ACME contract error: ${message}`);
  error.code = code;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    error.details = redactSecrets(details);
  }
  return error;
}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw acmeError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw acmeError(`${field}.${key} is not supported`, 'UNKNOWN_CONFIGURATION');
  }
}

function assertBoolean(value, field) {
  if (typeof value !== 'boolean') throw acmeError(`${field} must be a boolean`, 'INVALID_CONFIGURATION');
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw acmeError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function positiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  return integer(value, field, 1, maximum);
}

function safeIdentifier(value, field, { max = 128 } = {}) {
  if (typeof value !== 'string' || value.length > max || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw acmeError(`${field} is invalid`, 'INVALID_IDENTIFIER');
  }
  return value;
}

function secretReference(value, field) {
  if (typeof value !== 'string' || !SECRET_REFERENCE_PATTERN.test(value)) {
    throw acmeError(`${field} must be a secret reference`, 'INVALID_SECRET_REFERENCE');
  }
  return value;
}

function isoDate(value, field, fallback = undefined) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (candidate === undefined || candidate === null) return null;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(date.getTime()) || Math.abs(date.getTime()) > MAX_SAFE_DATE_MS) {
    throw acmeError(`${field} is not a valid timestamp`, 'INVALID_TIMESTAMP');
  }
  return date.toISOString();
}

function nowIso(clock = () => new Date()) {
  return isoDate(clock(), 'clock');
}

function parseDate(value, field) {
  const result = isoDate(value, field);
  if (result === null) throw acmeError(`${field} is required`, 'INVALID_TIMESTAMP');
  return new Date(result);
}

function normalizeEmail(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 254 || !EMAIL_PATTERN.test(value)) {
    throw acmeError(`${field} is invalid`, 'INVALID_CONTACT');
  }
  return value;
}

function hasWildcard(domain) {
  return domain.startsWith('*.');
}

function normalizeDomain(value, field = 'domains') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw acmeError(`${field} contains an invalid domain`, 'INVALID_DOMAIN');
  }
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw acmeError(`${field} contains an invalid domain`, 'INVALID_DOMAIN');
  }
  const wildcard = hasWildcard(trimmed);
  const source = wildcard ? trimmed.slice(2) : trimmed;
  const ascii = domainToASCII(source).toLowerCase();
  if (!HOSTNAME_PATTERN.test(ascii) || (wildcard && ascii.split('.').length < 2)) {
    throw acmeError(`${field} contains an invalid domain`, 'INVALID_DOMAIN');
  }
  return wildcard ? `*.${ascii}` : ascii;
}

function normalizeDomains(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw acmeError('domains must be a non-empty list of at most 100 names', 'INVALID_DOMAIN');
  }
  const domains = [...new Set(value.map((entry, index) => normalizeDomain(entry, `domains[${index}]`)))];
  if (domains.length === 0) throw acmeError('domains must not be empty', 'INVALID_DOMAIN');
  return domains;
}

function normalizeDirectoryUrl(value, field = 'directoryUrl') {
  if (typeof value !== 'string' || value.length > 2048) throw acmeError(`${field} is invalid`, 'INVALID_DIRECTORY_URL');
  let parsed;
  try { parsed = new URL(value); } catch { throw acmeError(`${field} is not a URL`, 'INVALID_DIRECTORY_URL'); }
  if (parsed.protocol !== 'https:') throw acmeError(`${field} must use HTTPS`, 'INSECURE_DIRECTORY_URL');
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw acmeError(`${field} must not contain credentials, query parameters, or fragments`, 'INVALID_DIRECTORY_URL');
  }
  if (!parsed.hostname || parsed.hostname.includes('..')) throw acmeError(`${field} host is invalid`, 'INVALID_DIRECTORY_URL');
  return parsed.toString().replace(/\/$/u, '');
}

function normalizeAccount(input = {}) {
  const account = assertPlainObject(input, 'account');
  assertAllowedKeys(account, new Set(['id', 'contactEmail', 'keySecretRef', 'accountUrl', 'externalAccountBinding']), 'account');
  const output = {
    id: account.id === undefined ? null : safeIdentifier(account.id, 'account.id'),
    contactEmail: normalizeEmail(account.contactEmail, 'account.contactEmail'),
    keySecretRef: secretReference(account.keySecretRef ?? 'acme/account-key', 'account.keySecretRef'),
    accountUrl: account.accountUrl === undefined || account.accountUrl === null ? null : normalizeDirectoryUrl(account.accountUrl, 'account.accountUrl'),
    externalAccountBinding: null,
  };
  if (account.externalAccountBinding !== undefined && account.externalAccountBinding !== null) {
    const eab = assertPlainObject(account.externalAccountBinding, 'account.externalAccountBinding');
    assertAllowedKeys(eab, new Set(['kid', 'hmacSecretRef']), 'account.externalAccountBinding');
    if (typeof eab.kid !== 'string' || eab.kid.length === 0 || eab.kid.length > 256 || PEM_PATTERN.test(eab.kid)) {
      throw acmeError('account.externalAccountBinding.kid is invalid', 'INVALID_ACCOUNT_BINDING');
    }
    output.externalAccountBinding = {
      kid: eab.kid,
      hmacSecretRef: secretReference(eab.hmacSecretRef, 'account.externalAccountBinding.hmacSecretRef'),
    };
  }
  return output;
}

function normalizeChallenge(input = {}, domains) {
  const challenge = assertPlainObject(input, 'challenge');
  const type = challenge.type ?? CHALLENGE_TYPES.HTTP_01;
  if (!Object.values(CHALLENGE_TYPES).includes(type)) throw acmeError('challenge.type is unsupported', 'INVALID_CHALLENGE');
  if (type === CHALLENGE_TYPES.HTTP_01) {
    assertAllowedKeys(challenge, new Set(['type', 'listenPort', 'publicPort', 'tokenPathPrefix']), 'challenge');
    const listenPort = challenge.listenPort ?? 80;
    const publicPort = challenge.publicPort ?? 80;
    if (hasWildcard(domains[0])) throw acmeError('HTTP-01 cannot validate wildcard domains', 'INVALID_CHALLENGE');
    const tokenPathPrefix = challenge.tokenPathPrefix ?? '/.well-known/acme-challenge/';
    if (typeof tokenPathPrefix !== 'string' || !/^\/[A-Za-z0-9._/-]{1,127}\/$/u.test(tokenPathPrefix) || tokenPathPrefix.includes('..')) {
      throw acmeError('challenge.tokenPathPrefix is invalid', 'INVALID_CHALLENGE');
    }
    return {
      type,
      listenPort: integer(listenPort, 'challenge.listenPort', 1, 65_535),
      publicPort: integer(publicPort, 'challenge.publicPort', 1, 65_535),
      tokenPathPrefix,
    };
  }
  assertAllowedKeys(challenge, new Set(['type', 'dnsProvider', 'credentialsSecretRef', 'propagationTimeoutSeconds', 'pollIntervalSeconds']), 'challenge');
  if (typeof challenge.dnsProvider !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(challenge.dnsProvider)) {
    throw acmeError('challenge.dnsProvider is required and invalid', 'INVALID_CHALLENGE');
  }
  return {
    type,
    dnsProvider: challenge.dnsProvider,
    credentialsSecretRef: secretReference(challenge.credentialsSecretRef, 'challenge.credentialsSecretRef'),
    propagationTimeoutSeconds: integer(challenge.propagationTimeoutSeconds ?? 120, 'challenge.propagationTimeoutSeconds', 10, 3_600),
    pollIntervalSeconds: integer(challenge.pollIntervalSeconds ?? 5, 'challenge.pollIntervalSeconds', 1, 300),
  };
}

function normalizeRetry(input = {}) {
  const retry = assertPlainObject(input, 'renewal.retry');
  assertAllowedKeys(retry, new Set(['maxAttempts', 'initialDelaySeconds', 'maxDelaySeconds', 'multiplier']), 'renewal.retry');
  const maxAttempts = integer(retry.maxAttempts ?? 5, 'renewal.retry.maxAttempts', 0, 20);
  const initialDelaySeconds = integer(retry.initialDelaySeconds ?? 300, 'renewal.retry.initialDelaySeconds', 1, 86_400);
  const maxDelaySeconds = integer(retry.maxDelaySeconds ?? 86_400, 'renewal.retry.maxDelaySeconds', initialDelaySeconds, 604_800);
  const multiplier = retry.multiplier ?? 2;
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
    throw acmeError('renewal.retry.multiplier is invalid', 'INVALID_RETRY_POLICY');
  }
  return { maxAttempts, initialDelaySeconds, maxDelaySeconds, multiplier };
}

function normalizeRenewal(input = {}) {
  const renewal = assertPlainObject(input, 'renewal');
  assertAllowedKeys(renewal, new Set(['enabled', 'renewBeforeDays', 'expiryWarningDays', 'expiryCriticalDays', 'retry', 'fallback']), 'renewal');
  const enabled = renewal.enabled ?? true;
  if (typeof enabled !== 'boolean') throw acmeError('renewal.enabled must be a boolean', 'INVALID_RENEWAL_POLICY');
  const renewBeforeDays = integer(renewal.renewBeforeDays ?? 30, 'renewal.renewBeforeDays', 1, 90);
  const expiryWarningDays = integer(renewal.expiryWarningDays ?? 30, 'renewal.expiryWarningDays', 1, 90);
  const expiryCriticalDays = integer(renewal.expiryCriticalDays ?? 7, 'renewal.expiryCriticalDays', 0, expiryWarningDays);
  const fallbackInput = renewal.fallback ?? {};
  const fallback = assertPlainObject(fallbackInput, 'renewal.fallback');
  assertAllowedKeys(fallback, new Set(['preserveCurrentCertificate', 'alertOnFailure', 'allowServingUntilExpiry']), 'renewal.fallback');
  return {
    enabled,
    renewBeforeDays,
    expiryWarningDays,
    expiryCriticalDays,
    retry: normalizeRetry(renewal.retry ?? {}),
    fallback: {
      preserveCurrentCertificate: fallback.preserveCurrentCertificate ?? true,
      alertOnFailure: fallback.alertOnFailure ?? true,
      allowServingUntilExpiry: fallback.allowServingUntilExpiry ?? true,
    },
  };
}

function normalizeReload(input = {}) {
  const reload = assertPlainObject(input, 'reload');
  assertAllowedKeys(reload, new Set(['strategy', 'consumers', 'timeoutSeconds', 'healthGate', 'rollbackOnFailure']), 'reload');
  const consumers = reload.consumers ?? ['web', 'postfix', 'dovecot'];
  const allowedConsumers = new Set(['web', 'postfix', 'dovecot', 'caldav', 'carddav']);
  if (!Array.isArray(consumers) || consumers.length === 0 || consumers.some((value) => typeof value !== 'string' || !allowedConsumers.has(value))) {
    throw acmeError('reload.consumers is invalid', 'INVALID_RELOAD_POLICY');
  }
  const strategy = reload.strategy ?? 'graceful';
  if (strategy !== 'graceful') throw acmeError('reload.strategy must be graceful', 'INVALID_RELOAD_POLICY');
  return {
    strategy,
    consumers: [...new Set(consumers)],
    timeoutSeconds: integer(reload.timeoutSeconds ?? 30, 'reload.timeoutSeconds', 1, 600),
    healthGate: reload.healthGate ?? true,
    rollbackOnFailure: reload.rollbackOnFailure ?? true,
  };
}

function normalizeTls(input = {}) {
  const tls = assertPlainObject(input, 'tls');
  assertAllowedKeys(tls, new Set(['minimumVersion', 'allowedVersions', 'healthCheckHostnames']), 'tls');
  const minimumVersion = tls.minimumVersion ?? 'TLSv1.2';
  if (!TLS_PROTOCOLS.includes(minimumVersion)) throw acmeError('tls.minimumVersion is invalid', 'INVALID_TLS_POLICY');
  const allowedVersions = tls.allowedVersions ?? TLS_PROTOCOLS;
  if (!Array.isArray(allowedVersions) || allowedVersions.length === 0 || allowedVersions.some((value) => !TLS_PROTOCOLS.includes(value))) {
    throw acmeError('tls.allowedVersions is invalid', 'INVALID_TLS_POLICY');
  }
  if (!allowedVersions.includes(minimumVersion)) throw acmeError('tls.allowedVersions must include minimumVersion', 'INVALID_TLS_POLICY');
  const healthCheckHostnames = tls.healthCheckHostnames ?? [];
  if (!Array.isArray(healthCheckHostnames) || healthCheckHostnames.some((value) => hasWildcard(normalizeDomain(value, 'tls.healthCheckHostnames')))) {
    throw acmeError('tls.healthCheckHostnames is invalid', 'INVALID_TLS_POLICY');
  }
  return { minimumVersion, allowedVersions: [...new Set(allowedVersions)], healthCheckHostnames: [...new Set(healthCheckHostnames.map((value) => normalizeDomain(value, 'tls.healthCheckHostnames')))] };
}

function assertNoPrivateKeyInput(value, path = 'value', seen = new Set()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (PRIVATE_KEY_PATTERN.test(value)) throw acmeError(`${path} must use a secret reference, not private-key material`, 'SECRET_MATERIAL_FORBIDDEN');
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoPrivateKeyInput(entry, `${path}[${index}]`, seen));
  else if (typeof value === 'object') Object.entries(value).forEach(([key, entry]) => {
    if (SECRET_KEY_PATTERN.test(key) && key !== 'keySecretRef' && key !== 'hmacSecretRef' && key !== 'credentialsSecretRef' && key !== 'privateKeySecretRef') {
      if (entry !== null && entry !== undefined && typeof entry !== 'string' && typeof entry !== 'boolean') throw acmeError(`${path}.${key} must not contain secret material`, 'SECRET_MATERIAL_FORBIDDEN');
      if (typeof entry === 'string' && (PEM_PATTERN.test(entry) || entry.length > 256)) throw acmeError(`${path}.${key} must use a secret reference`, 'SECRET_MATERIAL_FORBIDDEN');
    }
    assertNoPrivateKeyInput(entry, `${path}.${key}`, seen);
  });
}

/** Recursively remove private-key, token, credential, and PEM material from logs. */
export function redactSecrets(value, seen = new Set()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return PEM_PATTERN.test(value) ? '[REDACTED_PEM]' : value.length > 1024 ? `${value.slice(0, 1024)}...[REDACTED]` : value;
  if (seen.has(value)) return '[REDACTED_CYCLE]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, seen));
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && !/secretref$/iu.test(key)) output[key] = '[REDACTED]';
    else output[key] = redactSecrets(entry, seen);
  }
  return output;
}

/** Normalize and validate the certificate-provider contract without handling keys or certificates. */
export function createAcmeConfig(input = {}) {
  assertPlainObject(input, 'config');
  assertNoPrivateKeyInput(input);
  assertAllowedKeys(input, new Set(['provider', 'environment', 'directoryUrl', 'domains', 'account', 'certificateKeySecretRef', 'challenge', 'renewal', 'reload', 'tls']), 'config');
  const provider = input.provider ?? ACME_PROVIDERS.LETSENCRYPT;
  if (!Object.values(ACME_PROVIDERS).includes(provider)) throw acmeError('provider is unsupported', 'INVALID_PROVIDER');
  const environment = input.environment ?? ACME_ENVIRONMENTS.PRODUCTION;
  if (!Object.values(ACME_ENVIRONMENTS).includes(environment)) throw acmeError('environment is unsupported', 'INVALID_ENVIRONMENT');
  const directoryDefault = provider === ACME_PROVIDERS.LETSENCRYPT
    ? (environment === ACME_ENVIRONMENTS.STAGING ? LETSENCRYPT_STAGING_DIRECTORY_URL : DEFAULT_LETSENCRYPT_DIRECTORY_URL)
    : null;
  if (provider === ACME_PROVIDERS.GENERIC && !input.directoryUrl) throw acmeError('generic ACME requires directoryUrl', 'INVALID_DIRECTORY_URL');
  if (input.directoryUrl && environment === ACME_ENVIRONMENTS.STAGING && provider === ACME_PROVIDERS.LETSENCRYPT && normalizeDirectoryUrl(input.directoryUrl) !== LETSENCRYPT_STAGING_DIRECTORY_URL) {
    throw acmeError("a staging Let's Encrypt configuration must use the staging directory", 'INVALID_DIRECTORY_URL');
  }
  const domains = normalizeDomains(input.domains);
  const challenge = normalizeChallenge(input.challenge ?? {}, domains);
  if (domains.some(hasWildcard) && challenge.type !== CHALLENGE_TYPES.DNS_01) throw acmeError('wildcard domains require DNS-01', 'INVALID_CHALLENGE');
  const account = normalizeAccount(input.account ?? {});
  const reload = normalizeReload(input.reload ?? {});
  const renewal = normalizeRenewal(input.renewal ?? {});
  const tls = normalizeTls(input.tls ?? {});
  const config = {
    schemaVersion: 1,
    provider,
    environment,
    directoryUrl: normalizeDirectoryUrl(input.directoryUrl ?? directoryDefault),
    domains,
    account,
    certificateKeySecretRef: secretReference(input.certificateKeySecretRef ?? 'acme/certificate-key', 'certificateKeySecretRef'),
    challenge,
    renewal,
    reload,
    tls,
  };
  return deepFreeze(config);
}

export const normalizeAcmeConfig = createAcmeConfig;
export const validateAcmeConfig = createAcmeConfig;
export const assertAcmeConfig = createAcmeConfig;

export function retryDelaySeconds(attempt, retryPolicy = {}) {
  const retry = normalizeRetry(retryPolicy);
  integer(attempt, 'attempt', 0, 1000);
  return Math.min(retry.maxDelaySeconds, Math.round(retry.initialDelaySeconds * (retry.multiplier ** attempt)));
}

export function createRetrySchedule({ attempt = 0, policy = {}, now = new Date() } = {}) {
  integer(attempt, 'attempt', 0, 1000);
  const timestamp = parseDate(now, 'now');
  const delaySeconds = retryDelaySeconds(attempt, policy);
  return deepFreeze({
    attempt,
    delaySeconds,
    retryAt: new Date(timestamp.getTime() + delaySeconds * 1000).toISOString(),
  });
}

function normalizeCertificateMetadata(certificate = {}, field = 'certificate') {
  assertPlainObject(certificate, field);
  assertNoPrivateKeyInput(certificate, field);
  assertAllowedKeys(certificate, new Set(['id', 'notBefore', 'notAfter', 'issuer', 'subject', 'serialNumber', 'dnsNames', 'chainValid', 'privateKeyMatches', 'chainError', 'keyAlgorithm']), field);
  const notAfter = isoDate(certificate.notAfter, `${field}.notAfter`);
  if (notAfter === null) throw acmeError(`${field}.notAfter is required`, 'INVALID_CERTIFICATE_METADATA');
  const notBefore = isoDate(certificate.notBefore, `${field}.notBefore`);
  if (notBefore && new Date(notBefore).getTime() >= new Date(notAfter).getTime()) throw acmeError(`${field}.notBefore must be before notAfter`, 'INVALID_CERTIFICATE_METADATA');
  const dnsNames = certificate.dnsNames ?? [];
  if (!Array.isArray(dnsNames) || dnsNames.length > 100) throw acmeError(`${field}.dnsNames is invalid`, 'INVALID_CERTIFICATE_METADATA');
  const normalizedDnsNames = [...new Set(dnsNames.map((value, index) => normalizeDomain(value, `${field}.dnsNames[${index}]`)))];
  for (const key of ['chainValid', 'privateKeyMatches']) {
    if (certificate[key] !== undefined && certificate[key] !== null && typeof certificate[key] !== 'boolean') {
      throw acmeError(`${field}.${key} must be a boolean or null`, 'INVALID_CERTIFICATE_METADATA');
    }
  }
  return {
    id: certificate.id === undefined ? null : safeIdentifier(certificate.id, `${field}.id`),
    notBefore,
    notAfter,
    issuer: certificate.issuer === undefined ? null : String(certificate.issuer).slice(0, 512),
    subject: certificate.subject === undefined ? null : String(certificate.subject).slice(0, 512),
    serialNumber: certificate.serialNumber === undefined ? null : safeIdentifier(certificate.serialNumber, `${field}.serialNumber`, { max: 256 }),
    dnsNames: normalizedDnsNames,
    chainValid: certificate.chainValid ?? null,
    privateKeyMatches: certificate.privateKeyMatches ?? null,
    chainError: certificate.chainError === undefined ? null : String(certificate.chainError).slice(0, 256),
    keyAlgorithm: certificate.keyAlgorithm === undefined ? null : String(certificate.keyAlgorithm).slice(0, 64),
  };
}

function hostnameMatches(hostname, names) {
  const normalized = normalizeDomain(hostname, 'hostname');
  return names.some((name) => name === normalized || (hasWildcard(name) && normalized.endsWith(name.slice(1)) && normalized.split('.').length === name.split('.').length));
}

/** Evaluate expiry, chain, key, and hostname state without touching certificate/key material. */
export function evaluateCertificateHealth({ certificate, hostname = undefined, now = new Date(), renewBeforeDays = 30, expiryWarningDays = 30, expiryCriticalDays = 7 } = {}) {
  const metadata = normalizeCertificateMetadata(certificate);
  const checkedAt = parseDate(now, 'now');
  const expiresAt = new Date(metadata.notAfter);
  const notBefore = metadata.notBefore ? new Date(metadata.notBefore) : null;
  const daysRemaining = Math.floor((expiresAt.getTime() - checkedAt.getTime()) / DAY_MS);
  const renewalDue = expiresAt.getTime() - checkedAt.getTime() <= integer(renewBeforeDays, 'renewBeforeDays', 1, 90) * DAY_MS;
  const alerts = [];
  if (expiresAt <= checkedAt) alerts.push({ type: 'certificate.expired', severity: 'critical', daysRemaining });
  else if (daysRemaining <= integer(expiryCriticalDays, 'expiryCriticalDays', 0, 90)) alerts.push({ type: 'certificate.expiry_critical', severity: 'critical', daysRemaining });
  else if (daysRemaining <= integer(expiryWarningDays, 'expiryWarningDays', 1, 90)) alerts.push({ type: 'certificate.expiry_warning', severity: 'warning', daysRemaining });
  if (metadata.chainValid === false) alerts.push({ type: 'certificate.chain_invalid', severity: 'critical', reason: metadata.chainError ?? 'chain validation failed' });
  if (metadata.privateKeyMatches === false) alerts.push({ type: 'certificate.key_mismatch', severity: 'critical' });
  if (notBefore && notBefore > checkedAt) alerts.push({ type: 'certificate.not_yet_valid', severity: 'critical' });
  if (hostname !== undefined && !hostnameMatches(hostname, metadata.dnsNames)) alerts.push({ type: 'certificate.hostname_mismatch', severity: 'critical' });
  const critical = alerts.some((alert) => alert.severity === 'critical');
  const status = critical ? 'unhealthy' : alerts.length > 0 ? 'degraded' : 'healthy';
  return deepFreeze({
    schemaVersion: 1,
    status,
    checkedAt: checkedAt.toISOString(),
    certificate: metadata,
    hostname: hostname === undefined ? null : normalizeDomain(hostname, 'hostname'),
    daysRemaining,
    renewalDue,
    alerts: alerts.map((alert) => Object.freeze({ ...alert })),
  });
}

export const createTlsHealthContract = evaluateCertificateHealth;
export const checkTlsHealth = evaluateCertificateHealth;

export function createExpiryAlert({ certificate, now = new Date(), renewBeforeDays = 30, expiryWarningDays = 30, expiryCriticalDays = 7, certificateId = undefined } = {}) {
  const health = evaluateCertificateHealth({ certificate, now, renewBeforeDays, expiryWarningDays, expiryCriticalDays });
  const expiryAlert = health.alerts.find((alert) => alert.type.startsWith('certificate.expiry') || alert.type === 'certificate.expired') ?? null;
  if (!expiryAlert) return null;
  return deepFreeze({
    schemaVersion: 1,
    type: expiryAlert.type,
    severity: expiryAlert.severity,
    certificateId: certificateId ?? health.certificate.id,
    checkedAt: health.checkedAt,
    expiresAt: health.certificate.notAfter,
    daysRemaining: health.daysRemaining,
    renewalDue: health.renewalDue,
  });
}

const TRANSITIONS = Object.freeze({
  idle: Object.freeze({ renew_due: 'scheduled', start: 'authorizing', cancel: 'cancelled' }),
  scheduled: Object.freeze({ start: 'authorizing', cancel: 'cancelled' }),
  authorizing: Object.freeze({ authorization_succeeded: 'ordering', failed: 'retry_wait', cancel: 'cancelled' }),
  ordering: Object.freeze({ order_ready: 'finalizing', failed: 'retry_wait', cancel: 'cancelled' }),
  finalizing: Object.freeze({ certificate_stored: 'reload_pending', failed: 'retry_wait', cancel: 'cancelled' }),
  reload_pending: Object.freeze({ reload_succeeded: 'active', reload_failed: 'retry_wait', failed: 'retry_wait', cancel: 'cancelled' }),
  active: Object.freeze({ renew_due: 'scheduled', reconcile: 'active', cancel: 'cancelled' }),
  retry_wait: Object.freeze({ retry_due: 'authorizing', cancel: 'cancelled', manual_retry: 'authorizing' }),
  degraded: Object.freeze({ retry_due: 'authorizing', manual_retry: 'authorizing', renew_due: 'scheduled', cancel: 'cancelled' }),
  failed: Object.freeze({ manual_retry: 'authorizing', retry_due: 'authorizing', cancel: 'cancelled' }),
  cancelled: Object.freeze({ manual_retry: 'authorizing' }),
});

function safeFailure(error) {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return { code: 'ACME_OPERATION_FAILED', message: redactSecrets(error).slice(0, 256) };
  if (typeof error === 'object') return {
    code: typeof error.code === 'string' && SAFE_ERROR_CODE_PATTERN.test(error.code) ? error.code : 'ACME_OPERATION_FAILED',
    message: redactSecrets(String(error.message ?? 'ACME operation failed')).slice(0, 256),
  };
  return { code: 'ACME_OPERATION_FAILED', message: 'ACME operation failed' };
}

function stateCertificate(value, field) {
  if (value === null || value === undefined) return null;
  return normalizeCertificateMetadata(value, field);
}

function normalizeConfigForUse(config) {
  if (config === null || config === undefined) return null;
  if (config.schemaVersion === 1 && typeof config.directoryUrl === 'string' && Array.isArray(config.domains) && config.renewal && config.account) return config;
  return createAcmeConfig(config);
}

/** Create a serializable renewal state. It contains references and metadata only, never keys or certificate PEM. */
export function createRenewalState({ certificateId = 'primary', domains, config = undefined, currentCertificate = null, now = new Date() } = {}) {
  const normalizedConfig = normalizeConfigForUse(config);
  const normalizedDomains = normalizeDomains(domains ?? normalizedConfig?.domains);
  const policy = normalizedConfig ? normalizedConfig.renewal : normalizeRenewal({});
  const checkedAt = parseDate(now, 'now');
  const current = stateCertificate(currentCertificate, 'currentCertificate');
  return deepFreeze({
    schemaVersion: 1,
    certificateId: safeIdentifier(certificateId, 'certificateId'),
    domains: normalizedDomains,
    provider: normalizedConfig ? normalizedConfig.provider : ACME_PROVIDERS.LETSENCRYPT,
    state: 'idle',
    attempt: 0,
    maxAttempts: policy.retry.maxAttempts,
    retryPolicy: policy.retry,
    renewalEnabled: policy.enabled,
    currentCertificate: current,
    pendingCertificate: null,
    fallbackActive: false,
    lastError: null,
    lastAlert: null,
    scheduledAt: null,
    nextAttemptAt: null,
    updatedAt: checkedAt.toISOString(),
  });
}

function eventObject(event, options) {
  if (typeof event === 'string') return { ...(options ?? {}), type: event };
  if (!event || typeof event !== 'object') throw acmeError('renewal event is required', 'INVALID_RENEWAL_EVENT');
  return event;
}

/** Advance the deterministic renewal state machine; operations are performed by a separate ACME worker. */
export function advanceRenewal(state, event, options = {}) {
  assertPlainObject(state, 'state');
  if (!RENEWAL_STATES.includes(state.state)) throw acmeError('state.state is invalid', 'INVALID_RENEWAL_STATE');
  const action = eventObject(event, options);
  const type = action.type;
  if (typeof type !== 'string' || !TRANSITIONS[state.state]?.[type]) throw acmeError(`${type ?? 'event'} is not valid from ${state.state}`, 'INVALID_RENEWAL_TRANSITION');
  const timestamp = parseDate(action.now ?? options.now ?? new Date(), 'event.now');
  const nextState = TRANSITIONS[state.state][type];
  const next = { ...state, state: nextState, updatedAt: timestamp.toISOString() };
  if (type === 'renew_due') {
    next.scheduledAt = timestamp.toISOString();
    next.nextAttemptAt = null;
    next.lastAlert = null;
  }
  if (type === 'start' || type === 'retry_due' || type === 'manual_retry') {
    next.lastError = null;
    next.lastAlert = null;
    next.nextAttemptAt = null;
  }
  if (type === 'authorization_succeeded' || type === 'order_ready') next.lastError = null;
  if (type === 'certificate_stored') {
    next.pendingCertificate = stateCertificate(action.certificate, 'event.certificate');
    next.lastError = null;
  }
  if (type === 'reload_succeeded') {
    next.currentCertificate = next.pendingCertificate ?? next.currentCertificate;
    next.pendingCertificate = null;
    next.attempt = 0;
    next.nextAttemptAt = null;
    next.fallbackActive = false;
    next.scheduledAt = null;
    next.lastError = null;
    next.lastAlert = null;
  }
  if (type === 'failed' || type === 'reload_failed') {
    const attempt = (Number.isSafeInteger(state.attempt) ? state.attempt : 0) + 1;
    const policy = normalizeRetry(action.retryPolicy ?? state.retryPolicy ?? { maxAttempts: state.maxAttempts ?? 5 });
    const failure = safeFailure(action.error ?? action.reason);
    next.attempt = attempt;
    next.lastError = failure;
    const currentHealth = next.currentCertificate ? evaluateCertificateHealth({ certificate: next.currentCertificate, now: timestamp }) : null;
    const canFallback = Boolean(next.currentCertificate && currentHealth && currentHealth.status !== 'unhealthy' && currentHealth.daysRemaining >= 0);
    next.fallbackActive = canFallback;
    if (attempt <= policy.maxAttempts) {
      next.state = 'retry_wait';
      next.nextAttemptAt = new Date(timestamp.getTime() + retryDelaySeconds(attempt - 1, policy) * 1000).toISOString();
    } else {
      next.state = canFallback ? 'degraded' : 'failed';
      next.nextAttemptAt = null;
      next.lastAlert = { type: 'certificate.renewal_failed', severity: canFallback ? 'warning' : 'critical', attempt, fallbackActive: canFallback };
    }
  }
  if (type === 'reconcile') next.lastAlert = null;
  return deepFreeze(next);
}

export const transitionRenewal = advanceRenewal;
export const advanceRenewalState = advanceRenewal;

/** Build a metadata-only graceful reload plan for protocol consumers. */
export function createSafeReloadPlan({ certificate, previousCertificate = null, consumers = ['web', 'postfix', 'dovecot'], generation = 1, now = new Date(), timeoutSeconds = 30 } = {}) {
  const nextCertificate = normalizeCertificateMetadata(certificate, 'certificate');
  const health = evaluateCertificateHealth({ certificate: nextCertificate, now });
  if (nextCertificate.chainValid !== true || nextCertificate.privateKeyMatches !== true || health.status === 'unhealthy') {
    throw acmeError('certificate fails the reload health gate', 'RELOAD_HEALTH_GATE_FAILED');
  }
  const previous = previousCertificate === null ? null : normalizeCertificateMetadata(previousCertificate, 'previousCertificate');
  if (!Array.isArray(consumers) || consumers.length === 0 || consumers.some((value) => !['web', 'postfix', 'dovecot', 'caldav', 'carddav'].includes(value))) throw acmeError('consumers is invalid', 'INVALID_RELOAD_PLAN');
  const uniqueConsumers = [...new Set(consumers)];
  return deepFreeze({
    schemaVersion: 1,
    operation: 'certificate_graceful_reload',
    generation: positiveInteger(generation, 'generation', 2 ** 31 - 1),
    strategy: 'graceful',
    healthGate: true,
    rollbackOnFailure: true,
    timeoutSeconds: integer(timeoutSeconds, 'timeoutSeconds', 1, 600),
    certificate: { id: nextCertificate.id, notAfter: nextCertificate.notAfter, serialNumber: nextCertificate.serialNumber, dnsNames: nextCertificate.dnsNames },
    previousCertificate: previous ? { id: previous.id, notAfter: previous.notAfter, serialNumber: previous.serialNumber } : null,
    consumers: uniqueConsumers.map((consumer) => ({ consumer, status: 'pending', reloadedAt: null, errorCode: null })),
    preflight: ['chain_valid', 'private_key_matches', 'consumer_configuration_valid'],
    createdAt: parseDate(now, 'now').toISOString(),
  });
}

export function completeSafeReloadPlan(plan, results, { now = new Date() } = {}) {
  assertPlainObject(plan, 'plan');
  if (!Array.isArray(results)) throw acmeError('results must be a list', 'INVALID_RELOAD_RESULT');
  const byConsumer = new Map(results.map((result) => [result.consumer, result]));
  const consumers = plan.consumers.map((entry) => {
    const result = byConsumer.get(entry.consumer);
    if (!result) return { ...entry, status: 'pending' };
    if (!['reloaded', 'failed', 'skipped'].includes(result.status)) throw acmeError(`reload result for ${entry.consumer} is invalid`, 'INVALID_RELOAD_RESULT');
    return {
      consumer: entry.consumer,
      status: result.status,
      reloadedAt: result.status === 'reloaded' ? parseDate(result.reloadedAt ?? now, `${entry.consumer}.reloadedAt`).toISOString() : null,
      errorCode: result.status === 'failed' ? (typeof result.errorCode === 'string' && SAFE_ERROR_CODE_PATTERN.test(result.errorCode) ? result.errorCode : 'RELOAD_FAILED') : null,
    };
  });
  const failed = consumers.filter((entry) => entry.status === 'failed');
  const pending = consumers.filter((entry) => entry.status === 'pending');
  return deepFreeze({
    ...plan,
    status: failed.length > 0 ? 'rollback_required' : pending.length > 0 ? 'pending' : 'completed',
    consumers,
    completedAt: failed.length === 0 && pending.length === 0 ? parseDate(now, 'now').toISOString() : null,
    rollbackRequired: failed.length > 0,
  });
}

export const applyReloadResults = completeSafeReloadPlan;

export function createTlsHealthContractFromConfig({ certificate, hostname, config, now = new Date() } = {}) {
  const normalizedConfig = createAcmeConfig(config);
  return evaluateCertificateHealth({
    certificate,
    hostname,
    now,
    renewBeforeDays: normalizedConfig.renewal.renewBeforeDays,
    expiryWarningDays: normalizedConfig.renewal.expiryWarningDays,
    expiryCriticalDays: normalizedConfig.renewal.expiryCriticalDays,
  });
}

export { DAY_MS, normalizeCertificateMetadata };
