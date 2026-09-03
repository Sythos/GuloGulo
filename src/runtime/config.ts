// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { createControlPanelConfig } from '../integrations/control-panel.ts';

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_CONFIG_FILE = '/etc/gulogulo/config.json';
export const CONFIG_FILE_ENVIRONMENT_VARIABLE = 'GULOGULO_CONFIG_FILE';

const PRODUCT_DISPLAY_NAME = 'Gulo Gulo';
const PRODUCT_MACHINE_NAME = 'gulogulo';
const DEFAULT_BUILD_VERSION = '0.1.4';
const DEFAULT_BUILD_DIGEST = 'development';
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8080;
const DEFAULT_SERVICE_NAME = 'gulogulo-runtime';
const DEFAULT_ENVIRONMENT = 'development';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_PATCH_STATUS_FILE = '/var/lib/gulogulo/patch/status.json';

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_BUILD_DIGEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/;
const PATCH_STATUS_PATH_PATTERN = /^\/[A-Za-z0-9._/-]{1,255}$/;
const MAILBOX_PATH_PATTERN = /^\/[A-Za-z0-9._/-]{1,255}$/;
const SECRET_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const CONTROL_PANEL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DISTINGUISHED_NAME_PATTERN = /^[\x20-\x7E]{1,512}$/;
const SECRET_KEY_PATTERN = /(password|passphrase|token(?!secretref)|private[_-]?key|credential(?!secretref)|authorization|cookie|api[_-]?key(?!secretref)|secret(?!ref)|(^|[_-])dsn($|[_-]))/i;
const CPANEL_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CONFIGURATION_FILE_BYTES = 1024 * 1024;

const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'schemaVersion',
  'buildVersion',
  'buildDigest',
  'project',
  'runtime',
  'ldap',
  'postgres',
  'controlPanel',
  'cpanel',
  'plesk',
  'mail',
  'webAuth',
  'retention',
  'api',
  'upgrade',
  'patching',
]);

const SECTION_KEYS = Object.freeze({
  project: new Set(['displayName', 'machineName']),
  runtime: new Set(['host', 'port', 'serviceName', 'environment', 'shutdownTimeoutMs']),
  ldap: new Set([
    'enabled',
    'url',
    'startTls',
    'bindDn',
    'bindSecretRef',
    'userBaseDn',
    'connectTimeoutMs',
    'operationTimeoutMs',
    'poolMax',
    'retryAttempts',
  ]),
  postgres: new Set([
    'enabled',
    'host',
    'port',
    'database',
    'user',
    'sslMode',
    'dsnSecretRef',
    'connectTimeoutMs',
    'idleTimeoutMs',
    'poolMax',
    'retryAttempts',
  ]),
  controlPanel: new Set([
    'enabled',
    'provider',
    'baseUrl',
    'accountRef',
    'credentialSecretRef',
    'webhookSecretRef',
    'syncMode',
    'allowDnsChanges',
  ]),
  cpanel: new Set([
    'enabled',
    'baseUrl',
    'username',
    'apiTokenSecretRef',
    'timeoutMs',
  ]),
  plesk: new Set([
    'enabled',
    'baseUrl',
    'apiKeySecretRef',
    'timeoutMs',
  ]),
  mail: new Set([
    'imapIdle',
    'pop3sEnabled',
    'catchAll',
    'userForwarding',
    'smtpInboundPort',
    'smtpSubmissionPort',
    'smtpImplicitTlsPort',
    'imapsPort',
    'lmtpSocket',
    'mailboxRoot',
    'rspamdEnabled',
    'clamavEnabled',
    'scanFailureMode',
    'maxMessageBytes',
    'maxRecipients',
    'maxConnectionsPerIp',
    'maxMessagesPerUserPerMinute',
    'queueMaxAttempts',
    'queueRetryBaseMs',
  ]),
  webAuth: new Set(['totp', 'webauthn', 'recoveryCodes']),
  retention: new Set(['trashDays']),
  api: new Set(['readOnly']),
  upgrade: new Set(['strategy']),
  patching: new Set(['mode', 'statusFile']),
});

const ENVIRONMENT_VARIABLES = Object.freeze({
  schemaVersion: ['GULOGULO_SCHEMA_VERSION'],
  buildVersion: ['GULOGULO_VERSION', 'GULOGULO_BUILD_VERSION'],
  buildDigest: ['GULOGULO_BUILD_DIGEST'],
  runtime: {
    host: ['GULOGULO_HOST', 'HOST'],
    port: ['GULOGULO_PORT', 'PORT'],
    serviceName: ['GULOGULO_SERVICE_NAME'],
    environment: ['GULOGULO_ENV', 'APP_ENV'],
    shutdownTimeoutMs: ['GULOGULO_SHUTDOWN_TIMEOUT_MS'],
  },
  ldap: {
    enabled: ['GULOGULO_LDAP_ENABLED', 'LDAP_ENABLED'],
    url: ['GULOGULO_LDAP_URL', 'LDAP_URL'],
    startTls: ['GULOGULO_LDAP_STARTTLS', 'LDAP_STARTTLS'],
    bindDn: ['GULOGULO_LDAP_BIND_DN', 'LDAP_BIND_DN'],
    bindSecretRef: ['GULOGULO_LDAP_BIND_SECRET_REF', 'LDAP_BIND_SECRET_REF'],
    userBaseDn: ['GULOGULO_LDAP_USER_BASE_DN', 'LDAP_USER_BASE_DN'],
    connectTimeoutMs: ['GULOGULO_LDAP_CONNECT_TIMEOUT_MS', 'LDAP_CONNECT_TIMEOUT_MS'],
    operationTimeoutMs: ['GULOGULO_LDAP_OPERATION_TIMEOUT_MS', 'LDAP_OPERATION_TIMEOUT_MS'],
    poolMax: ['GULOGULO_LDAP_POOL_MAX', 'LDAP_POOL_MAX'],
    retryAttempts: ['GULOGULO_LDAP_RETRY_ATTEMPTS', 'LDAP_RETRY_ATTEMPTS'],
  },
  postgres: {
    enabled: ['GULOGULO_POSTGRES_ENABLED', 'POSTGRES_ENABLED'],
    host: ['GULOGULO_POSTGRES_HOST', 'POSTGRES_HOST'],
    port: ['GULOGULO_POSTGRES_PORT', 'POSTGRES_PORT'],
    database: ['GULOGULO_POSTGRES_DB', 'POSTGRES_DB'],
    user: ['GULOGULO_POSTGRES_USER', 'POSTGRES_USER'],
    sslMode: ['GULOGULO_POSTGRES_SSLMODE', 'POSTGRES_SSLMODE'],
    dsnSecretRef: ['GULOGULO_POSTGRES_DSN_SECRET_REF', 'POSTGRES_DSN_SECRET_REF'],
    connectTimeoutMs: ['GULOGULO_POSTGRES_CONNECT_TIMEOUT_MS', 'POSTGRES_CONNECT_TIMEOUT_MS'],
    idleTimeoutMs: ['GULOGULO_POSTGRES_IDLE_TIMEOUT_MS', 'POSTGRES_IDLE_TIMEOUT_MS'],
    poolMax: ['GULOGULO_POSTGRES_POOL_MAX', 'POSTGRES_POOL_MAX'],
    retryAttempts: ['GULOGULO_POSTGRES_RETRY_ATTEMPTS', 'POSTGRES_RETRY_ATTEMPTS'],
  },
  controlPanel: {
    enabled: ['GULOGULO_CONTROL_PANEL_ENABLED', 'CONTROL_PANEL_ENABLED'],
    provider: ['GULOGULO_CONTROL_PANEL_PROVIDER', 'CONTROL_PANEL_PROVIDER'],
    baseUrl: ['GULOGULO_CONTROL_PANEL_BASE_URL', 'CONTROL_PANEL_BASE_URL'],
    accountRef: ['GULOGULO_CONTROL_PANEL_ACCOUNT_REF', 'CONTROL_PANEL_ACCOUNT_REF'],
    credentialSecretRef: ['GULOGULO_CONTROL_PANEL_CREDENTIAL_SECRET_REF', 'CONTROL_PANEL_CREDENTIAL_SECRET_REF'],
    webhookSecretRef: ['GULOGULO_CONTROL_PANEL_WEBHOOK_SECRET_REF', 'CONTROL_PANEL_WEBHOOK_SECRET_REF'],
    syncMode: ['GULOGULO_CONTROL_PANEL_SYNC_MODE', 'CONTROL_PANEL_SYNC_MODE'],
  },
  cpanel: {
    enabled: ['GULOGULO_CPANEL_API_ENABLED', 'CPANEL_API_ENABLED'],
    baseUrl: ['GULOGULO_CPANEL_API_BASE_URL', 'CPANEL_API_BASE_URL'],
    username: ['GULOGULO_CPANEL_API_USERNAME', 'CPANEL_API_USERNAME'],
    apiTokenSecretRef: ['GULOGULO_CPANEL_API_TOKEN_SECRET_REF', 'CPANEL_API_TOKEN_SECRET_REF'],
    timeoutMs: ['GULOGULO_CPANEL_API_TIMEOUT_MS', 'CPANEL_API_TIMEOUT_MS'],
  },
  plesk: {
    enabled: ['GULOGULO_PLESK_API_ENABLED', 'PLESK_API_ENABLED'],
    baseUrl: ['GULOGULO_PLESK_API_BASE_URL', 'PLESK_API_BASE_URL'],
    apiKeySecretRef: ['GULOGULO_PLESK_API_KEY_SECRET_REF', 'PLESK_API_KEY_SECRET_REF'],
    timeoutMs: ['GULOGULO_PLESK_API_TIMEOUT_MS', 'PLESK_API_TIMEOUT_MS'],
  },
  mail: {
    imapIdle: ['GULOGULO_MAIL_IMAP_IDLE', 'MAIL_IMAP_IDLE'],
    pop3sEnabled: ['GULOGULO_MAIL_POP3S_ENABLED', 'MAIL_POP3S_ENABLED'],
    catchAll: ['GULOGULO_MAIL_CATCH_ALL', 'MAIL_CATCH_ALL'],
    userForwarding: ['GULOGULO_MAIL_USER_FORWARDING', 'MAIL_USER_FORWARDING'],
    smtpInboundPort: ['GULOGULO_MAIL_SMTP_INBOUND_PORT', 'MAIL_SMTP_INBOUND_PORT'],
    smtpSubmissionPort: ['GULOGULO_MAIL_SMTP_SUBMISSION_PORT', 'MAIL_SMTP_SUBMISSION_PORT'],
    smtpImplicitTlsPort: ['GULOGULO_MAIL_SMTP_IMPLICIT_TLS_PORT', 'MAIL_SMTP_IMPLICIT_TLS_PORT'],
    imapsPort: ['GULOGULO_MAIL_IMAPS_PORT', 'MAIL_IMAPS_PORT'],
    lmtpSocket: ['GULOGULO_MAIL_LMTP_SOCKET', 'MAIL_LMTP_SOCKET'],
    mailboxRoot: ['GULOGULO_MAILBOX_ROOT', 'MAILBOX_ROOT'],
    rspamdEnabled: ['GULOGULO_MAIL_RSPAMD_ENABLED', 'MAIL_RSPAMD_ENABLED'],
    clamavEnabled: ['GULOGULO_MAIL_CLAMAV_ENABLED', 'MAIL_CLAMAV_ENABLED'],
    scanFailureMode: ['GULOGULO_MAIL_SCAN_FAILURE_MODE', 'MAIL_SCAN_FAILURE_MODE'],
    maxMessageBytes: ['GULOGULO_MAIL_MAX_MESSAGE_BYTES', 'MAIL_MAX_MESSAGE_BYTES'],
    maxRecipients: ['GULOGULO_MAIL_MAX_RECIPIENTS', 'MAIL_MAX_RECIPIENTS'],
    maxConnectionsPerIp: ['GULOGULO_MAIL_MAX_CONNECTIONS_PER_IP', 'MAIL_MAX_CONNECTIONS_PER_IP'],
    maxMessagesPerUserPerMinute: ['GULOGULO_MAIL_MAX_MESSAGES_PER_USER_PER_MINUTE', 'MAIL_MAX_MESSAGES_PER_USER_PER_MINUTE'],
    queueMaxAttempts: ['GULOGULO_MAIL_QUEUE_MAX_ATTEMPTS', 'MAIL_QUEUE_MAX_ATTEMPTS'],
    queueRetryBaseMs: ['GULOGULO_MAIL_QUEUE_RETRY_BASE_MS', 'MAIL_QUEUE_RETRY_BASE_MS'],
  },
  webAuth: {
    totp: ['GULOGULO_WEB_AUTH_TOTP', 'WEB_AUTH_TOTP'],
    webauthn: ['GULOGULO_WEB_AUTH_WEBAUTHN', 'WEB_AUTH_WEBAUTHN'],
    recoveryCodes: ['GULOGULO_WEB_AUTH_RECOVERY_CODES', 'WEB_AUTH_RECOVERY_CODES'],
  },
  retention: {
    trashDays: ['GULOGULO_RETENTION_TRASH_DAYS', 'RETENTION_TRASH_DAYS'],
  },
  api: {
    readOnly: ['GULOGULO_API_READ_ONLY', 'API_READ_ONLY'],
  },
  upgrade: {
    strategy: ['GULOGULO_UPGRADE_STRATEGY', 'UPGRADE_STRATEGY'],
  },
  patching: {
    mode: ['GULOGULO_PATCH_MODE'],
    statusFile: ['GULOGULO_PATCH_STATUS_FILE'],
  },
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function configurationError(message) {
  return new Error(`Configuration error: ${message}`);
}

function assertObject(value, name) {
  if (!isPlainObject(value)) {
    throw configurationError(`${name} must be an object`);
  }
}

function assertKnownKeys(value, allowedKeys, path) {
  for (const key of Object.keys(value)) {
    const keyPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      throw configurationError(`${keyPath} is not allowed; use an external secret reference`);
    }

    if (!allowedKeys.has(key)) {
      throw configurationError(`${keyPath} is unknown`);
    }
  }
}

function readString(value, name, pattern = null) {
  if (typeof value !== 'string' || value.length === 0 || (pattern !== null && !pattern.test(value))) {
    throw configurationError(`${name} must be a non-empty value using the supported characters`);
  }

  return value;
}

function readBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw configurationError(`${name} must be a boolean`);
  }

  return value;
}

function readInteger(value, name, minimum, maximum) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !/^\d+$/.test(value)) ||
    (typeof value === 'number' && !Number.isInteger(value))
  ) {
    throw configurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < minimum || integer > maximum) {
    throw configurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return integer;
}

function readPort(value, name = 'runtime.port') {
  return readInteger(value, name, 1, 65_535);
}

function readShutdownTimeout(value, name = 'runtime.shutdownTimeoutMs') {
  return readInteger(value, name, 1_000, 60_000);
}

function readHost(value, name = 'runtime.host') {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`${name} must be a valid IP address or hostname`);
  }

  if (isIP(value) !== 0 || HOSTNAME_PATTERN.test(value)) {
    return value;
  }

  throw configurationError(`${name} must be a valid IP address or hostname`);
}

function readEnum(value, name, values) {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw configurationError(`${name} must be one of: ${values.join(', ')}`);
  }

  return value;
}

function readUrl(value, name) {
  const url = readString(value, name);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw configurationError(`${name} must be a valid LDAP URL`);
  }

  if (!['ldap:', 'ldaps:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw configurationError(`${name} must use ldap:// or ldaps:// without embedded credentials`);
  }

  return url;
}

function readSecretReference(value, name) {
  return readString(value, name, SECRET_REFERENCE_PATTERN);
}

function readHttpsUrl(value, name) {
  const url = readString(value, name);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw configurationError(`${name} must be a valid HTTPS URL`);
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configurationError(`${name} must use https:// without embedded credentials, query, or fragment`);
  }

  return url;
}

function readUsername(value, name) {
  return readString(value, name, CPANEL_USERNAME_PATTERN);
}

function readEnvironmentOptionalUsername(value, name) {
  if (value === '') {
    return '';
  }

  return readUsername(value, name);
}

function readEnvironmentOptionalSecretReference(value, name) {
  if (value === '') {
    return null;
  }

  return readSecretReference(value, name);
}

function readEnvironmentOptionalControlPanelReference(value, name) {
  if (value === '') {
    return null;
  }

  return readEnvironmentString(value, name, CONTROL_PANEL_REFERENCE_PATTERN);
}

function readDistinguishedName(value, name) {
  return readString(value, name, DISTINGUISHED_NAME_PATTERN);
}

function readEnvironmentOptionalDistinguishedName(value, name) {
  if (value === '') {
    return null;
  }

  return readDistinguishedName(value, name);
}

function readPatchStatusFile(value, name) {
  return readString(value, name, PATCH_STATUS_PATH_PATTERN);
}

function readPath(value, name) {
  return readString(value, name, MAILBOX_PATH_PATTERN);
}

function readConfigurationFile(filePath, { optional, readFile = readFileSync } = {}) {
  if (filePath === null || filePath === false) {
    return {};
  }

  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw configurationError(`${CONFIG_FILE_ENVIRONMENT_VARIABLE} must be a non-empty path`);
  }

  let contents;
  try {
    contents = readFile(filePath, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') {
      return {};
    }

    throw configurationError(`cannot read ${filePath}: ${error?.message ?? 'unknown file error'}`);
  }

  if (typeof contents !== 'string') {
    throw configurationError(`${filePath} must be read as UTF-8 text`);
  }

  if (Buffer.byteLength(contents, 'utf8') > MAX_CONFIGURATION_FILE_BYTES) {
    throw configurationError(`${filePath} exceeds the ${MAX_CONFIGURATION_FILE_BYTES}-byte limit`);
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw configurationError(`cannot parse ${filePath} as JSON: ${error.message}`);
  }

  assertObject(parsed, filePath);
  return parsed;
}

function getEnvironmentValue(environment, names) {
  for (const name of names) {
    if (environment[name] !== undefined) {
      return { name, value: environment[name] };
    }
  }

  return undefined;
}

function applyEnvironmentValue(target, key, environment, names, parser) {
  const found = getEnvironmentValue(environment, names);
  if (found === undefined) {
    return;
  }

  target[key] = parser(found.value, found.name);
}

function readEnvironmentString(value, name, pattern = null) {
  return readString(value, name, pattern);
}

function readEnvironmentBoolean(value, name) {
  if (typeof value !== 'string') {
    throw configurationError(`${name} must be true or false`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw configurationError(`${name} must be true or false`);
}

function readEnvironmentInteger(value, name, minimum, maximum) {
  return readInteger(value, name, minimum, maximum);
}

function readEnvironmentEnum(value, name, values) {
  return readEnum(value, name, values);
}

function readSection(source, name) {
  const value = source[name];
  if (value === undefined) {
    return {};
  }

  assertObject(value, name);
  assertKnownKeys(value, SECTION_KEYS[name], name);
  return value;
}

function buildConfiguration(fileConfiguration, environment) {
  assertKnownKeys(fileConfiguration, TOP_LEVEL_KEYS, 'config');

  const runtimeFile = readSection(fileConfiguration, 'runtime');
  const ldapFile = readSection(fileConfiguration, 'ldap');
  const postgresFile = readSection(fileConfiguration, 'postgres');
  const controlPanelFile = readSection(fileConfiguration, 'controlPanel');
  const cpanelFile = readSection(fileConfiguration, 'cpanel');
  const pleskFile = readSection(fileConfiguration, 'plesk');
  const mailFile = readSection(fileConfiguration, 'mail');
  const webAuthFile = readSection(fileConfiguration, 'webAuth');
  const retentionFile = readSection(fileConfiguration, 'retention');
  const apiFile = readSection(fileConfiguration, 'api');
  const upgradeFile = readSection(fileConfiguration, 'upgrade');
  const patchingFile = readSection(fileConfiguration, 'patching');
  const projectFile = readSection(fileConfiguration, 'project');

  const schemaVersion = fileConfiguration.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  const buildVersion = fileConfiguration.buildVersion ?? DEFAULT_BUILD_VERSION;
  const buildDigest = fileConfiguration.buildDigest ?? DEFAULT_BUILD_DIGEST;

  const config = {
    schemaVersion: readInteger(schemaVersion, 'schemaVersion', CONFIG_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION),
    buildVersion: readString(buildVersion, 'buildVersion', SAFE_VERSION_PATTERN),
    buildDigest: readString(buildDigest, 'buildDigest', SAFE_BUILD_DIGEST_PATTERN),
    project: {
      displayName: readString(projectFile.displayName ?? PRODUCT_DISPLAY_NAME, 'project.displayName'),
      machineName: readString(projectFile.machineName ?? PRODUCT_MACHINE_NAME, 'project.machineName', SAFE_NAME_PATTERN),
    },
    runtime: {
      host: readHost(runtimeFile.host ?? DEFAULT_HOST),
      port: readPort(runtimeFile.port ?? DEFAULT_PORT),
      serviceName: readString(runtimeFile.serviceName ?? DEFAULT_SERVICE_NAME, 'runtime.serviceName', SAFE_NAME_PATTERN),
      environment: readString(runtimeFile.environment ?? DEFAULT_ENVIRONMENT, 'runtime.environment', SAFE_NAME_PATTERN),
      shutdownTimeoutMs: readShutdownTimeout(runtimeFile.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS),
    },
    ldap: {
      enabled: readBoolean(ldapFile.enabled ?? false, 'ldap.enabled'),
      url: readUrl(ldapFile.url ?? 'ldaps://ldap.example.invalid:636', 'ldap.url'),
      startTls: readBoolean(ldapFile.startTls ?? false, 'ldap.startTls'),
      bindDn: ldapFile.bindDn === undefined ? null : readDistinguishedName(ldapFile.bindDn, 'ldap.bindDn'),
      bindSecretRef: ldapFile.bindSecretRef === undefined ? null : readSecretReference(ldapFile.bindSecretRef, 'ldap.bindSecretRef'),
      userBaseDn: ldapFile.userBaseDn === undefined ? null : readDistinguishedName(ldapFile.userBaseDn, 'ldap.userBaseDn'),
      connectTimeoutMs: readInteger(ldapFile.connectTimeoutMs ?? 3_000, 'ldap.connectTimeoutMs', 100, 120_000),
      operationTimeoutMs: readInteger(ldapFile.operationTimeoutMs ?? 5_000, 'ldap.operationTimeoutMs', 100, 120_000),
      poolMax: readInteger(ldapFile.poolMax ?? 4, 'ldap.poolMax', 1, 32),
      retryAttempts: readInteger(ldapFile.retryAttempts ?? 2, 'ldap.retryAttempts', 0, 5),
    },
    postgres: {
      enabled: readBoolean(postgresFile.enabled ?? false, 'postgres.enabled'),
      host: readHost(postgresFile.host ?? 'postgres.example.invalid', 'postgres.host'),
      port: readPort(postgresFile.port ?? 5432, 'postgres.port'),
      database: readString(postgresFile.database ?? PRODUCT_MACHINE_NAME, 'postgres.database', SAFE_NAME_PATTERN),
      user: readString(postgresFile.user ?? PRODUCT_MACHINE_NAME, 'postgres.user', SAFE_NAME_PATTERN),
      sslMode: readEnum(
        postgresFile.sslMode ?? 'verify-full',
        'postgres.sslMode',
        ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'],
      ),
      dsnSecretRef: postgresFile.dsnSecretRef === undefined ? null : readSecretReference(postgresFile.dsnSecretRef, 'postgres.dsnSecretRef'),
      connectTimeoutMs: readInteger(postgresFile.connectTimeoutMs ?? 3_000, 'postgres.connectTimeoutMs', 100, 120_000),
      idleTimeoutMs: readInteger(postgresFile.idleTimeoutMs ?? 30_000, 'postgres.idleTimeoutMs', 1_000, 600_000),
      poolMax: readInteger(postgresFile.poolMax ?? 8, 'postgres.poolMax', 1, 32),
      retryAttempts: readInteger(postgresFile.retryAttempts ?? 2, 'postgres.retryAttempts', 0, 5),
    },
    controlPanel: {
      enabled: controlPanelFile.enabled ?? false,
      provider: controlPanelFile.provider ?? 'none',
      baseUrl: controlPanelFile.baseUrl ?? null,
      accountRef: controlPanelFile.accountRef ?? null,
      credentialSecretRef: controlPanelFile.credentialSecretRef ?? null,
      webhookSecretRef: controlPanelFile.webhookSecretRef ?? null,
      syncMode: controlPanelFile.syncMode ?? 'pull',
      allowDnsChanges: controlPanelFile.allowDnsChanges ?? false,
    },
    cpanel: {
      enabled: readBoolean(cpanelFile.enabled ?? false, 'cpanel.enabled'),
      baseUrl: readHttpsUrl(cpanelFile.baseUrl ?? 'https://cpanel.example.invalid:2083', 'cpanel.baseUrl'),
      username: cpanelFile.username === undefined ? '' : readUsername(cpanelFile.username, 'cpanel.username'),
      apiTokenSecretRef: cpanelFile.apiTokenSecretRef === undefined ? null : readSecretReference(cpanelFile.apiTokenSecretRef, 'cpanel.apiTokenSecretRef'),
      timeoutMs: readInteger(cpanelFile.timeoutMs ?? 5_000, 'cpanel.timeoutMs', 1, 120_000),
    },
    plesk: {
      enabled: readBoolean(pleskFile.enabled ?? false, 'plesk.enabled'),
      baseUrl: readHttpsUrl(pleskFile.baseUrl ?? 'https://plesk.example.invalid:8443', 'plesk.baseUrl'),
      apiKeySecretRef: pleskFile.apiKeySecretRef === undefined ? null : readSecretReference(pleskFile.apiKeySecretRef, 'plesk.apiKeySecretRef'),
      timeoutMs: readInteger(pleskFile.timeoutMs ?? 5_000, 'plesk.timeoutMs', 1, 120_000),
    },
    mail: {
      imapIdle: readBoolean(mailFile.imapIdle ?? true, 'mail.imapIdle'),
      pop3sEnabled: readBoolean(mailFile.pop3sEnabled ?? false, 'mail.pop3sEnabled'),
      catchAll: readBoolean(mailFile.catchAll ?? false, 'mail.catchAll'),
      userForwarding: readBoolean(mailFile.userForwarding ?? false, 'mail.userForwarding'),
      smtpInboundPort: readPort(mailFile.smtpInboundPort ?? 25, 'mail.smtpInboundPort'),
      smtpSubmissionPort: readPort(mailFile.smtpSubmissionPort ?? 587, 'mail.smtpSubmissionPort'),
      smtpImplicitTlsPort: readPort(mailFile.smtpImplicitTlsPort ?? 465, 'mail.smtpImplicitTlsPort'),
      imapsPort: readPort(mailFile.imapsPort ?? 993, 'mail.imapsPort'),
      lmtpSocket: readPath(mailFile.lmtpSocket ?? '/var/run/dovecot/lmtp', 'mail.lmtpSocket'),
      mailboxRoot: readPath(mailFile.mailboxRoot ?? '/var/lib/gulogulo/mail', 'mail.mailboxRoot'),
      rspamdEnabled: readBoolean(mailFile.rspamdEnabled ?? true, 'mail.rspamdEnabled'),
      clamavEnabled: readBoolean(mailFile.clamavEnabled ?? true, 'mail.clamavEnabled'),
      scanFailureMode: readEnum(mailFile.scanFailureMode ?? 'fail_closed', 'mail.scanFailureMode', ['fail_closed']),
      maxMessageBytes: readInteger(mailFile.maxMessageBytes ?? 52_428_800, 'mail.maxMessageBytes', 1, 1_073_741_824),
      maxRecipients: readInteger(mailFile.maxRecipients ?? 100, 'mail.maxRecipients', 1, 1000),
      maxConnectionsPerIp: readInteger(mailFile.maxConnectionsPerIp ?? 20, 'mail.maxConnectionsPerIp', 1, 10_000),
      maxMessagesPerUserPerMinute: readInteger(mailFile.maxMessagesPerUserPerMinute ?? 60, 'mail.maxMessagesPerUserPerMinute', 1, 100_000),
      queueMaxAttempts: readInteger(mailFile.queueMaxAttempts ?? 5, 'mail.queueMaxAttempts', 1, 100),
      queueRetryBaseMs: readInteger(mailFile.queueRetryBaseMs ?? 60_000, 'mail.queueRetryBaseMs', 1_000, 86_400_000),
    },
    webAuth: {
      totp: readEnum(webAuthFile.totp ?? 'optional', 'webAuth.totp', ['disabled', 'optional', 'required']),
      webauthn: readEnum(webAuthFile.webauthn ?? 'optional', 'webAuth.webauthn', ['disabled', 'optional', 'required']),
      recoveryCodes: readBoolean(webAuthFile.recoveryCodes ?? true, 'webAuth.recoveryCodes'),
    },
    retention: {
      trashDays: readInteger(retentionFile.trashDays ?? 28, 'retention.trashDays', 28, 28),
    },
    api: {
      readOnly: readBoolean(apiFile.readOnly ?? true, 'api.readOnly'),
    },
    upgrade: {
      strategy: readEnum(upgradeFile.strategy ?? 'in_place', 'upgrade.strategy', ['in_place']),
    },
    patching: {
      mode: readEnum(
        patchingFile.mode ?? 'build_and_operator',
        'patching.mode',
        ['build_and_operator'],
      ),
      statusFile: readPatchStatusFile(
        patchingFile.statusFile ?? DEFAULT_PATCH_STATUS_FILE,
        'patching.statusFile',
      ),
    },
  };

  applyEnvironmentValue(config, 'schemaVersion', environment, ENVIRONMENT_VARIABLES.schemaVersion, (value, name) =>
    readEnvironmentInteger(value, name, CONFIG_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION),
  );
  applyEnvironmentValue(config, 'buildVersion', environment, ENVIRONMENT_VARIABLES.buildVersion, (value, name) =>
    readEnvironmentString(value, name, SAFE_VERSION_PATTERN),
  );
  applyEnvironmentValue(config, 'buildDigest', environment, ENVIRONMENT_VARIABLES.buildDigest, (value, name) =>
    readEnvironmentString(value, name, SAFE_BUILD_DIGEST_PATTERN),
  );

  const environmentSections = [
    ['runtime', config.runtime, ENVIRONMENT_VARIABLES.runtime],
    ['ldap', config.ldap, ENVIRONMENT_VARIABLES.ldap],
    ['postgres', config.postgres, ENVIRONMENT_VARIABLES.postgres],
    ['controlPanel', config.controlPanel, ENVIRONMENT_VARIABLES.controlPanel],
    ['cpanel', config.cpanel, ENVIRONMENT_VARIABLES.cpanel],
    ['plesk', config.plesk, ENVIRONMENT_VARIABLES.plesk],
    ['mail', config.mail, ENVIRONMENT_VARIABLES.mail],
    ['webAuth', config.webAuth, ENVIRONMENT_VARIABLES.webAuth],
    ['retention', config.retention, ENVIRONMENT_VARIABLES.retention],
    ['api', config.api, ENVIRONMENT_VARIABLES.api],
    ['upgrade', config.upgrade, ENVIRONMENT_VARIABLES.upgrade],
    ['patching', config.patching, ENVIRONMENT_VARIABLES.patching],
  ];

  for (const [sectionName, target, variables] of environmentSections) {
    if (sectionName === 'runtime') {
      applyEnvironmentValue(target, 'host', environment, variables.host, readHost);
      applyEnvironmentValue(target, 'port', environment, variables.port, (value, name) => readEnvironmentInteger(value, name, 1, 65_535));
      applyEnvironmentValue(target, 'serviceName', environment, variables.serviceName, (value, name) => readEnvironmentString(value, name, SAFE_NAME_PATTERN));
      applyEnvironmentValue(target, 'environment', environment, variables.environment, (value, name) => readEnvironmentString(value, name, SAFE_NAME_PATTERN));
      applyEnvironmentValue(target, 'shutdownTimeoutMs', environment, variables.shutdownTimeoutMs, (value, name) => readEnvironmentInteger(value, name, 1_000, 60_000));
      continue;
    }

    if (sectionName === 'ldap') {
      applyEnvironmentValue(target, 'enabled', environment, variables.enabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'url', environment, variables.url, readUrl);
      applyEnvironmentValue(target, 'startTls', environment, variables.startTls, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'bindDn', environment, variables.bindDn, readEnvironmentOptionalDistinguishedName);
      applyEnvironmentValue(target, 'bindSecretRef', environment, variables.bindSecretRef, readEnvironmentOptionalSecretReference);
      applyEnvironmentValue(target, 'userBaseDn', environment, variables.userBaseDn, readDistinguishedName);
      applyEnvironmentValue(target, 'connectTimeoutMs', environment, variables.connectTimeoutMs, (value, name) => readEnvironmentInteger(value, name, 100, 120_000));
      applyEnvironmentValue(target, 'operationTimeoutMs', environment, variables.operationTimeoutMs, (value, name) => readEnvironmentInteger(value, name, 100, 120_000));
      applyEnvironmentValue(target, 'poolMax', environment, variables.poolMax, (value, name) => readEnvironmentInteger(value, name, 1, 32));
      applyEnvironmentValue(target, 'retryAttempts', environment, variables.retryAttempts, (value, name) => readEnvironmentInteger(value, name, 0, 5));
      continue;
    }

    if (sectionName === 'postgres') {
      applyEnvironmentValue(target, 'enabled', environment, variables.enabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'host', environment, variables.host, readHost);
      applyEnvironmentValue(target, 'port', environment, variables.port, (value, name) => readEnvironmentInteger(value, name, 1, 65_535));
      applyEnvironmentValue(target, 'database', environment, variables.database, (value, name) => readEnvironmentString(value, name, SAFE_NAME_PATTERN));
      applyEnvironmentValue(target, 'user', environment, variables.user, (value, name) => readEnvironmentString(value, name, SAFE_NAME_PATTERN));
      applyEnvironmentValue(target, 'sslMode', environment, variables.sslMode, (value, name) => readEnvironmentEnum(value, name, ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']));
      applyEnvironmentValue(target, 'dsnSecretRef', environment, variables.dsnSecretRef, readEnvironmentOptionalSecretReference);
      applyEnvironmentValue(target, 'connectTimeoutMs', environment, variables.connectTimeoutMs, (value, name) => readEnvironmentInteger(value, name, 100, 120_000));
      applyEnvironmentValue(target, 'idleTimeoutMs', environment, variables.idleTimeoutMs, (value, name) => readEnvironmentInteger(value, name, 1_000, 600_000));
      applyEnvironmentValue(target, 'poolMax', environment, variables.poolMax, (value, name) => readEnvironmentInteger(value, name, 1, 32));
      applyEnvironmentValue(target, 'retryAttempts', environment, variables.retryAttempts, (value, name) => readEnvironmentInteger(value, name, 0, 5));
      continue;
    }

    if (sectionName === 'controlPanel') {
      applyEnvironmentValue(target, 'enabled', environment, variables.enabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'provider', environment, variables.provider, (value, name) => readEnvironmentEnum(value, name, ['none', 'plesk', 'cpanel']));
      applyEnvironmentValue(target, 'baseUrl', environment, variables.baseUrl, (value, name) => value === '' ? null : readEnvironmentString(value, name));
      applyEnvironmentValue(target, 'accountRef', environment, variables.accountRef, readEnvironmentOptionalControlPanelReference);
      applyEnvironmentValue(target, 'credentialSecretRef', environment, variables.credentialSecretRef, readEnvironmentOptionalControlPanelReference);
      applyEnvironmentValue(target, 'webhookSecretRef', environment, variables.webhookSecretRef, readEnvironmentOptionalControlPanelReference);
      applyEnvironmentValue(target, 'syncMode', environment, variables.syncMode, (value, name) => readEnvironmentEnum(value, name, ['pull', 'webhook', 'hybrid']));
      config.controlPanel = createControlPanelConfig(target);
      continue;
    }

    if (sectionName === 'cpanel') {
      applyEnvironmentValue(target, 'enabled', environment, variables.enabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'baseUrl', environment, variables.baseUrl, readHttpsUrl);
      applyEnvironmentValue(target, 'username', environment, variables.username, readEnvironmentOptionalUsername);
      applyEnvironmentValue(target, 'apiTokenSecretRef', environment, variables.apiTokenSecretRef, readEnvironmentOptionalSecretReference);
      applyEnvironmentValue(target, 'timeoutMs', environment, variables.timeoutMs, (value, name) => readEnvironmentInteger(value, name, 1, 120_000));
      continue;
    }

    if (sectionName === 'plesk') {
      applyEnvironmentValue(target, 'enabled', environment, variables.enabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'baseUrl', environment, variables.baseUrl, readHttpsUrl);
      applyEnvironmentValue(target, 'apiKeySecretRef', environment, variables.apiKeySecretRef, readEnvironmentOptionalSecretReference);
      applyEnvironmentValue(target, 'timeoutMs', environment, variables.timeoutMs, (value, name) => readEnvironmentInteger(value, name, 1, 120_000));
      continue;
    }

    if (sectionName === 'mail') {
      applyEnvironmentValue(target, 'imapIdle', environment, variables.imapIdle, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'pop3sEnabled', environment, variables.pop3sEnabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'catchAll', environment, variables.catchAll, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'userForwarding', environment, variables.userForwarding, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'smtpInboundPort', environment, variables.smtpInboundPort, (value, name) => readEnvironmentInteger(value, name, 1, 65_535));
      applyEnvironmentValue(target, 'smtpSubmissionPort', environment, variables.smtpSubmissionPort, (value, name) => readEnvironmentInteger(value, name, 1, 65_535));
      applyEnvironmentValue(target, 'smtpImplicitTlsPort', environment, variables.smtpImplicitTlsPort, (value, name) => readEnvironmentInteger(value, name, 1, 65_535));
      applyEnvironmentValue(target, 'imapsPort', environment, variables.imapsPort, (value, name) => readEnvironmentInteger(value, name, 1, 65_535));
      applyEnvironmentValue(target, 'lmtpSocket', environment, variables.lmtpSocket, readPath);
      applyEnvironmentValue(target, 'mailboxRoot', environment, variables.mailboxRoot, readPath);
      applyEnvironmentValue(target, 'rspamdEnabled', environment, variables.rspamdEnabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'clamavEnabled', environment, variables.clamavEnabled, readEnvironmentBoolean);
      applyEnvironmentValue(target, 'scanFailureMode', environment, variables.scanFailureMode, (value, name) => readEnvironmentEnum(value, name, ['fail_closed']));
      applyEnvironmentValue(target, 'maxMessageBytes', environment, variables.maxMessageBytes, (value, name) => readEnvironmentInteger(value, name, 1, 1_073_741_824));
      applyEnvironmentValue(target, 'maxRecipients', environment, variables.maxRecipients, (value, name) => readEnvironmentInteger(value, name, 1, 1000));
      applyEnvironmentValue(target, 'maxConnectionsPerIp', environment, variables.maxConnectionsPerIp, (value, name) => readEnvironmentInteger(value, name, 1, 10_000));
      applyEnvironmentValue(target, 'maxMessagesPerUserPerMinute', environment, variables.maxMessagesPerUserPerMinute, (value, name) => readEnvironmentInteger(value, name, 1, 100_000));
      applyEnvironmentValue(target, 'queueMaxAttempts', environment, variables.queueMaxAttempts, (value, name) => readEnvironmentInteger(value, name, 1, 100));
      applyEnvironmentValue(target, 'queueRetryBaseMs', environment, variables.queueRetryBaseMs, (value, name) => readEnvironmentInteger(value, name, 1_000, 86_400_000));
      continue;
    }

    if (sectionName === 'webAuth') {
      applyEnvironmentValue(target, 'totp', environment, variables.totp, (value, name) => readEnvironmentEnum(value, name, ['disabled', 'optional', 'required']));
      applyEnvironmentValue(target, 'webauthn', environment, variables.webauthn, (value, name) => readEnvironmentEnum(value, name, ['disabled', 'optional', 'required']));
      applyEnvironmentValue(target, 'recoveryCodes', environment, variables.recoveryCodes, readEnvironmentBoolean);
      continue;
    }

    if (sectionName === 'retention') {
      applyEnvironmentValue(target, 'trashDays', environment, variables.trashDays, (value, name) => readEnvironmentInteger(value, name, 28, 28));
      continue;
    }

    if (sectionName === 'api') {
      applyEnvironmentValue(target, 'readOnly', environment, variables.readOnly, readEnvironmentBoolean);
      continue;
    }

    if (sectionName === 'upgrade') {
      applyEnvironmentValue(target, 'strategy', environment, variables.strategy, (value, name) => readEnvironmentEnum(value, name, ['in_place']));
      continue;
    }

    if (sectionName === 'patching') {
      applyEnvironmentValue(target, 'mode', environment, variables.mode, (value, name) => readEnvironmentEnum(value, name, ['build_and_operator']));
      applyEnvironmentValue(target, 'statusFile', environment, variables.statusFile, readPatchStatusFile);
    }
  }

  if (config.project.displayName !== PRODUCT_DISPLAY_NAME || config.project.machineName !== PRODUCT_MACHINE_NAME) {
    throw configurationError('project identity must remain Gulo Gulo / gulogulo');
  }

  if (config.ldap.enabled && config.ldap.bindSecretRef === null) {
    throw configurationError('ldap.bindSecretRef is required when ldap.enabled is true');
  }

  if (config.ldap.enabled && config.ldap.bindDn === null) {
    throw configurationError('ldap.bindDn is required when ldap.enabled is true');
  }

  if (config.ldap.enabled && config.ldap.userBaseDn === null) {
    throw configurationError('ldap.userBaseDn is required when ldap.enabled is true');
  }

  if (config.ldap.startTls && config.ldap.url.startsWith('ldaps:')) {
    throw configurationError('ldap.startTls cannot be enabled for an ldaps:// URL');
  }

  if (config.postgres.enabled && config.postgres.dsnSecretRef === null) {
    throw configurationError('postgres.dsnSecretRef is required when postgres.enabled is true');
  }

  if (config.cpanel.enabled && config.cpanel.username === '') {
    throw configurationError('cpanel.username is required when cpanel.enabled is true');
  }

  if (config.cpanel.enabled && config.cpanel.apiTokenSecretRef === null) {
    throw configurationError('cpanel.apiTokenSecretRef is required when cpanel.enabled is true');
  }

  if (config.plesk.enabled && config.plesk.apiKeySecretRef === null) {
    throw configurationError('plesk.apiKeySecretRef is required when plesk.enabled is true');
  }

  config.controlPanel = createControlPanelConfig(config.controlPanel);

  if (config.mail.catchAll) {
    throw configurationError('mail.catchAll is a V1 invariant and must remain false');
  }

  if (config.mail.userForwarding) {
    throw configurationError('mail.userForwarding is a V1 invariant and must remain false');
  }

  if (!config.api.readOnly) {
    throw configurationError('api.readOnly is a V1 invariant and must remain true');
  }

  return config;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }
    Object.freeze(value);
  }

  return value;
}

function resolveConfigurationFile(environment, options) {
  if (Object.hasOwn(options, 'configFilePath')) {
    return {
      path: options.configFilePath,
      optional: options.configFilePath === DEFAULT_CONFIG_FILE,
    };
  }

  if (environment[CONFIG_FILE_ENVIRONMENT_VARIABLE] !== undefined) {
    return {
      path: environment[CONFIG_FILE_ENVIRONMENT_VARIABLE],
      optional: false,
    };
  }

  return { path: DEFAULT_CONFIG_FILE, optional: true };
}

function attachContractMetadata(legacyConfig, fullConfig) {
  for (const [key, value] of Object.entries(fullConfig)) {
    if (key === 'runtime') {
      continue;
    }

    Object.defineProperty(legacyConfig, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }

  Object.defineProperty(legacyConfig, 'contract', {
    configurable: false,
    enumerable: false,
    value: fullConfig,
    writable: false,
  });

  return legacyConfig;
}

/**
 * Load the complete, versioned, secret-free Gulo Gulo configuration contract.
 * Environment variables override the mounted JSON file, which overrides safe
 * defaults. A missing default mount is allowed; an explicitly requested file
 * is mandatory and fails closed when it cannot be read or validated.
 */
export function loadConfiguration(environment = process.env, options = {}) {
  // Node exposes process.env as an environment-backed object rather than a
  // normal plain object. Copy the default process environment before schema
  // validation so the production entry point and direct test callers use the
  // same contract without weakening the configuration-file checks.
  const effectiveEnvironment = environment === process.env
    ? Object.fromEntries(Object.entries(environment))
    : environment;

  assertObject(effectiveEnvironment, 'environment');
  assertObject(options, 'options');

  const resolvedFile = resolveConfigurationFile(effectiveEnvironment, options);
  const fileConfiguration = readConfigurationFile(resolvedFile.path, {
    optional: resolvedFile.optional,
    readFile: options.readFile,
  });
  const configuration = buildConfiguration(fileConfiguration, effectiveEnvironment);
  return deepFreeze(configuration);
}

/**
 * Preserve the M0 runtime shape while exposing the complete M1 contract as
 * non-enumerable metadata. Existing runtime callers therefore keep receiving
 * host, port, serviceName, environment, and shutdownTimeoutMs, while new code
 * can use loadConfiguration() or config.contract without losing compatibility.
 */
export function loadConfig(environment = process.env, options = {}) {
  const fullConfig = loadConfiguration(environment, options);
  const legacyConfig = {
    ...fullConfig.runtime,
  };

  attachContractMetadata(legacyConfig, fullConfig);
  return Object.freeze(legacyConfig);
}
