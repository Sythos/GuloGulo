// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG_FILE,
  loadConfig,
  loadConfiguration,
} from '../../runtime/config.js';

function withConfigFile(configuration, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'gulogulo-config-'));
  const filePath = join(directory, 'config.json');
  writeFileSync(filePath, JSON.stringify(configuration), 'utf8');

  try {
    return callback(filePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('configuration defaults are versioned, deterministic, and secret-free', () => {
  const first = loadConfiguration({}, { configFilePath: null });
  const second = loadConfiguration({}, { configFilePath: null });

  assert.equal(first.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(first.buildVersion, '0.1.8');
  assert.equal(first.buildDigest, 'development');
  assert.equal(first.project.displayName, 'Gulo Gulo');
  assert.equal(first.project.machineName, 'gulogulo');
  assert.equal(first.runtime.host, '0.0.0.0');
  assert.equal(first.runtime.port, 8080);
  assert.equal(first.mail.imapIdle, true);
  assert.equal(first.mail.catchAll, false);
  assert.equal(first.mail.userForwarding, false);
  assert.equal(first.mail.smtpInboundPort, 25);
  assert.equal(first.mail.smtpSubmissionPort, 587);
  assert.equal(first.mail.imapsPort, 993);
  assert.equal(first.mail.mailboxRoot, '/var/lib/gulogulo/mail');
  assert.equal(first.mail.scanFailureMode, 'fail_closed');
  assert.equal(first.mail.maxMessageBytes, 52_428_800);
  assert.equal(first.mail.queueMaxAttempts, 5);
  assert.equal(first.retention.trashDays, 28);
  assert.equal(first.api.readOnly, true);
  assert.equal(first.upgrade.strategy, 'in_place');
  assert.equal(first.patching.mode, 'build_and_operator');
  assert.equal(first.patching.statusFile, '/var/lib/gulogulo/patch/status.json');
  assert.deepEqual(first.controlPanel, {
    enabled: false,
    provider: 'none',
    baseUrl: null,
    accountRef: null,
    credentialSecretRef: null,
    webhookSecretRef: null,
    syncMode: 'pull',
    allowDnsChanges: false,
  });
  assert.deepEqual(first.alerting, {
    enabled: false,
    webhookUrlSecretRef: null,
    format: 'generic',
    timeoutMs: 5_000,
    retryAttempts: 2,
    minSeverity: 'warning',
  });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first).includes('password'), false);
  assert.equal(JSON.stringify(first).includes('token'), false);
  assert.equal(JSON.stringify(first).includes('secret'), false);
});

test('the production process environment is accepted by the loader', () => {
  const configuration = loadConfiguration(process.env, { configFilePath: null });

  assert.equal(configuration.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(configuration.project.machineName, 'gulogulo');
});

test('empty Compose secret-reference placeholders remain unset', () => {
  const configuration = loadConfiguration(
    {
      LDAP_BIND_SECRET_REF: '',
      POSTGRES_DSN_SECRET_REF: '',
    },
    { configFilePath: null },
  );

  assert.equal(configuration.ldap.bindSecretRef, null);
  assert.equal(configuration.postgres.dsnSecretRef, null);
});

test('optional upstream Plesk or cPanel configuration is loaded and remains read-only', () => {
  const configuration = loadConfiguration(
    {
      GULOGULO_CONTROL_PANEL_ENABLED: 'true',
      GULOGULO_CONTROL_PANEL_PROVIDER: 'plesk',
      GULOGULO_CONTROL_PANEL_BASE_URL: 'https://panel.example.test/api/',
      GULOGULO_CONTROL_PANEL_ACCOUNT_REF: 'tenant/acme',
      GULOGULO_CONTROL_PANEL_CREDENTIAL_SECRET_REF: 'secret/panel-token',
      GULOGULO_CONTROL_PANEL_WEBHOOK_SECRET_REF: 'secret/panel-webhook',
      GULOGULO_CONTROL_PANEL_SYNC_MODE: 'hybrid',
    },
    { configFilePath: null },
  );

  assert.deepEqual(configuration.controlPanel, {
    enabled: true,
    provider: 'plesk',
    baseUrl: 'https://panel.example.test/api',
    accountRef: 'tenant/acme',
    credentialSecretRef: 'secret/panel-token',
    webhookSecretRef: 'secret/panel-webhook',
    syncMode: 'hybrid',
    allowDnsChanges: false,
  });

  withConfigFile({
    schemaVersion: 1,
    controlPanel: {
      enabled: true,
      provider: 'cpanel',
      baseUrl: 'https://cpanel.example.test',
      accountRef: 'tenant/acme',
      credentialSecretRef: 'secret/cpanel-token',
      syncMode: 'pull',
    },
  }, (filePath) => {
    const fromFile = loadConfiguration({}, { configFilePath: filePath });
    assert.equal(fromFile.controlPanel.provider, 'cpanel');
    assert.equal(fromFile.controlPanel.allowDnsChanges, false);
  });

  withConfigFile({ schemaVersion: 1, controlPanel: { allowDnsChanges: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /allowDnsChanges is permanently false/);
  });
});

test('cPanel and Plesk API settings default to disabled and are read from the environment', () => {
  const defaults = loadConfiguration({}, { configFilePath: null });

  assert.deepEqual(defaults.cpanel, {
    enabled: false,
    baseUrl: 'https://cpanel.example.invalid:2083',
    username: '',
    apiTokenSecretRef: null,
    timeoutMs: 5_000,
  });
  assert.deepEqual(defaults.plesk, {
    enabled: false,
    baseUrl: 'https://plesk.example.invalid:8443',
    apiKeySecretRef: null,
    timeoutMs: 5_000,
  });

  const configuration = loadConfiguration(
    {
      CPANEL_API_ENABLED: 'true',
      CPANEL_API_BASE_URL: 'https://cpanel.example.test:2083',
      CPANEL_API_USERNAME: 'gulogulo',
      CPANEL_API_TOKEN_SECRET_REF: 'cpanel-token',
      CPANEL_API_TIMEOUT_MS: '4000',
      PLESK_API_ENABLED: 'true',
      PLESK_API_BASE_URL: 'https://plesk.example.test:8443',
      PLESK_API_KEY_SECRET_REF: 'plesk-key',
      PLESK_API_TIMEOUT_MS: '4500',
    },
    { configFilePath: null },
  );

  assert.deepEqual(configuration.cpanel, {
    enabled: true,
    baseUrl: 'https://cpanel.example.test:2083',
    username: 'gulogulo',
    apiTokenSecretRef: 'cpanel-token',
    timeoutMs: 4_000,
  });
  assert.deepEqual(configuration.plesk, {
    enabled: true,
    baseUrl: 'https://plesk.example.test:8443',
    apiKeySecretRef: 'plesk-key',
    timeoutMs: 4_500,
  });
});

test('cPanel and Plesk API settings can be loaded from a configuration file', () => {
  withConfigFile(
    {
      schemaVersion: 1,
      cpanel: {
        enabled: true,
        baseUrl: 'https://cpanel.example.test:2083',
        username: 'gulogulo',
        apiTokenSecretRef: 'cpanel-token',
        timeoutMs: 6_000,
      },
      plesk: {
        enabled: true,
        baseUrl: 'https://plesk.example.test:8443',
        apiKeySecretRef: 'plesk-key',
        timeoutMs: 6_500,
      },
    },
    (filePath) => {
      const configuration = loadConfiguration({}, { configFilePath: filePath });

      assert.equal(configuration.cpanel.enabled, true);
      assert.equal(configuration.cpanel.username, 'gulogulo');
      assert.equal(configuration.cpanel.apiTokenSecretRef, 'cpanel-token');
      assert.equal(configuration.cpanel.timeoutMs, 6_000);
      assert.equal(configuration.plesk.enabled, true);
      assert.equal(configuration.plesk.apiKeySecretRef, 'plesk-key');
      assert.equal(configuration.plesk.timeoutMs, 6_500);
    },
  );
});

test('invalid cPanel and Plesk configuration fails closed with clear errors', () => {
  withConfigFile({ schemaVersion: 1, cpanel: { enabled: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /cpanel\.username is required/);
  });

  withConfigFile({ schemaVersion: 1, cpanel: { enabled: true, username: 'gulogulo' } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /cpanel\.apiTokenSecretRef is required/);
  });

  withConfigFile({ schemaVersion: 1, plesk: { enabled: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /plesk\.apiKeySecretRef is required/);
  });

  withConfigFile({ schemaVersion: 1, cpanel: { baseUrl: 'http://cpanel.example.test' } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /cpanel\.baseUrl must use https/);
  });

  withConfigFile({ schemaVersion: 1, alerting: { enabled: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /alerting\.webhookUrlSecretRef is required/);
  });

  withConfigFile({ schemaVersion: 1, alerting: { enabled: true, webhookUrlSecretRef: 'secret/alert-webhook', format: 'slack', minSeverity: 'critical' } }, (filePath) => {
    const configuration = loadConfiguration({}, { configFilePath: filePath });
    assert.equal(configuration.alerting.enabled, true);
    assert.equal(configuration.alerting.webhookUrlSecretRef, 'secret/alert-webhook');
    assert.equal(configuration.alerting.format, 'slack');
    assert.equal(configuration.alerting.minSeverity, 'critical');
  });

  withConfigFile({ schemaVersion: 1, plesk: { baseUrl: 'not a url' } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /plesk\.baseUrl must be a valid HTTPS URL/);
  });

  withConfigFile({ schemaVersion: 1, cpanel: { unknownSetting: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /cpanel\.unknownSetting is unknown/);
  });

  withConfigFile({ schemaVersion: 1, cpanel: { apiToken: 'plaintext-not-allowed' } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /cpanel\.apiToken is not allowed/);
  });
});

test('environment variables override mounted file values with canonical names first', () => {
  withConfigFile(
    {
      schemaVersion: 1,
      buildVersion: 'file-build',
      buildDigest: 'sha256:file-digest',
      runtime: {
        host: '127.0.0.1',
        port: 9000,
        environment: 'file',
        serviceName: 'file-runtime',
        shutdownTimeoutMs: 2_000,
      },
      mail: { imapIdle: false },
    },
    (filePath) => {
      const configuration = loadConfiguration(
        {
          GULOGULO_CONFIG_FILE: filePath,
          GULOGULO_HOST: '127.0.0.2',
          HOST: '127.0.0.3',
          PORT: '9001',
          GULOGULO_PORT: '9002',
          APP_ENV: 'legacy',
          GULOGULO_ENV: 'test',
          GULOGULO_VERSION: 'environment-version',
          GULOGULO_BUILD_DIGEST: 'sha256:environment-digest',
          GULOGULO_BUILD_VERSION: 'environment-build',
          GULOGULO_PATCH_STATUS_FILE: '/tmp/gulogulo-patch-status.json',
        },
        { configFilePath: filePath },
      );

      assert.equal(configuration.runtime.host, '127.0.0.2');
      assert.equal(configuration.runtime.port, 9002);
      assert.equal(configuration.runtime.environment, 'test');
      assert.equal(configuration.runtime.serviceName, 'file-runtime');
      assert.equal(configuration.runtime.shutdownTimeoutMs, 2_000);
      assert.equal(configuration.buildVersion, 'environment-version');
      assert.equal(configuration.buildDigest, 'sha256:environment-digest');
      assert.equal(configuration.patching.statusFile, '/tmp/gulogulo-patch-status.json');
      assert.equal(configuration.mail.imapIdle, false);
      assert.equal(configuration.mail.smtpSubmissionPort, 587);
    },
  );
});

test('the M0 runtime shape remains compatible while exposing the M1 contract', () => {
  const configuration = loadConfig(
    {
      GULOGULO_HOST: '127.0.0.1',
      GULOGULO_PORT: '8081',
      GULOGULO_SERVICE_NAME: 'gulogulo-api',
      GULOGULO_ENV: 'test',
      GULOGULO_SHUTDOWN_TIMEOUT_MS: '1000',
      GULOGULO_DATABASE_PASSWORD: 'must-not-be-read',
    },
    { configFilePath: null },
  );

  assert.deepEqual(
    configuration,
    {
      host: '127.0.0.1',
      port: 8081,
      serviceName: 'gulogulo-api',
      environment: 'test',
      shutdownTimeoutMs: 1_000,
    },
  );
  assert.equal(configuration.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(configuration.contract.project.machineName, 'gulogulo');
  assert.equal(Object.hasOwn(configuration, 'GULOGULO_DATABASE_PASSWORD'), false);
  assert.equal(Object.hasOwn(configuration.contract, 'GULOGULO_DATABASE_PASSWORD'), false);
});

test('an explicitly configured file is mandatory and the default mount is optional', () => {
  assert.doesNotThrow(() => loadConfiguration({}, { configFilePath: DEFAULT_CONFIG_FILE }));
  assert.throws(
    () => loadConfiguration({ GULOGULO_CONFIG_FILE: join(tmpdir(), 'gulogulo-config-does-not-exist.json') }),
    /cannot read .*gulogulo-config-does-not-exist\.json/,
  );
  assert.throws(
    () => loadConfiguration({ GULOGULO_CONFIG_FILE: '' }),
    /GULOGULO_CONFIG_FILE must be a non-empty path/,
  );
});

test('unknown and plaintext secret settings are rejected in the mounted file', () => {
  withConfigFile({ schemaVersion: 1, runtime: { unknownSetting: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /runtime\.unknownSetting is unknown/);
  });

  withConfigFile({ schemaVersion: 1, databasePassword: 'plaintext' }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /databasePassword is not allowed/);
  });

  withConfigFile({ schemaVersion: 1, ldap: { bindPassword: 'plaintext' } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /ldap\.bindPassword is not allowed/);
  });

  withConfigFile({ schemaVersion: 1, postgres: { dsn: 'postgresql://user:password@example.invalid/db' } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /postgres\.dsn is not allowed/);
  });
});

test('secret references are allowed but secret values and unsafe cross-field settings are not', () => {
  const configuration = loadConfiguration(
    {
      GULOGULO_LDAP_ENABLED: 'true',
      GULOGULO_LDAP_BIND_DN: 'cn=service,dc=example,dc=test',
      GULOGULO_LDAP_BIND_SECRET_REF: 'ldap-bind',
      GULOGULO_LDAP_USER_BASE_DN: 'ou=users,dc=example,dc=test',
      GULOGULO_POSTGRES_ENABLED: 'true',
      GULOGULO_POSTGRES_DSN_SECRET_REF: 'postgres-dsn',
      GULOGULO_LDAP_BIND_PASSWORD: 'must-not-be-read',
      POSTGRES_PASSWORD: 'must-not-be-read',
    },
    { configFilePath: null },
  );

  assert.equal(configuration.ldap.enabled, true);
  assert.equal(configuration.ldap.bindSecretRef, 'ldap-bind');
  assert.equal(configuration.postgres.enabled, true);
  assert.equal(configuration.postgres.dsnSecretRef, 'postgres-dsn');
  assert.equal(JSON.stringify(configuration).includes('must-not-be-read'), false);
  assert.equal(JSON.stringify(configuration).includes('password'), false);

  withConfigFile({ schemaVersion: 1, mail: { catchAll: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /mail\.catchAll.*must remain false/);
  });
  withConfigFile({ schemaVersion: 1, mail: { scanFailureMode: 'permissive' } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /mail\.scanFailureMode must be one of: fail_closed/);
  });
  withConfigFile({ schemaVersion: 1, api: { readOnly: false } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /api\.readOnly.*must remain true/);
  });
  withConfigFile({ schemaVersion: 1, retention: { trashDays: 7 } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /retention\.trashDays must be an integer between 28 and 28/);
  });
  withConfigFile({ schemaVersion: 1, ldap: { enabled: true } }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /ldap\.bindSecretRef is required/);
  });
});

test('schema and build versions fail closed when unsupported', () => {
  withConfigFile({ schemaVersion: 2 }, (filePath) => {
    assert.throws(() => loadConfiguration({}, { configFilePath: filePath }), /schemaVersion must be an integer between 1 and 1/);
  });

  assert.throws(
    () => loadConfiguration({ GULOGULO_SCHEMA_VERSION: '2' }, { configFilePath: null }),
    /GULOGULO_SCHEMA_VERSION must be an integer between 1 and 1/,
  );
  assert.throws(
    () => loadConfiguration({ GULOGULO_BUILD_VERSION: 'not a safe version' }, { configFilePath: null }),
    /GULOGULO_BUILD_VERSION must be a non-empty value using the supported characters/,
  );
});
