// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPanelConfig, createControlPanelIntegration } from './control-panel.ts';

test('keeps the optional control panel disabled by default', () => {
  const integration = createControlPanelIntegration();
  assert.deepEqual(integration.status(), { provider: 'none', enabled: false, state: 'disabled', syncMode: 'pull', reason: 'disabled' });
  assert.equal(integration.readOnly, true);
  assert.equal(integration.capabilities.executeCommands, false);
});

test('validates an enabled Plesk integration without storing credentials', () => {
  const config = createControlPanelConfig({
    enabled: true,
    provider: 'plesk',
    baseUrl: 'https://panel.example.test:8443/',
    accountRef: 'tenant/acme',
    credentialSecretRef: 'secret/plesk/acme',
    syncMode: 'pull',
  });
  assert.equal(config.baseUrl, 'https://panel.example.test:8443');
  assert.equal(config.credentialSecretRef, 'secret/plesk/acme');
  assert.equal(Object.hasOwn(config, 'password'), false);
  const integration = createControlPanelIntegration(config);
  assert.deepEqual(integration.status(), { provider: 'plesk', enabled: true, state: 'configured', syncMode: 'pull', baseHost: 'panel.example.test', accountRef: 'tenant/acme' });
});

test('supports cPanel webhook or hybrid configuration only with a secret reference', () => {
  assert.throws(() => createControlPanelConfig({ enabled: true, provider: 'cpanel', baseUrl: 'https://cpanel.example.test', accountRef: 'acme', credentialSecretRef: 'secret/cpanel', syncMode: 'webhook' }), (error: { code?: string }) => error.code === 'INCOMPLETE_CONFIGURATION');
  const config = createControlPanelConfig({ enabled: true, provider: 'cpanel', baseUrl: 'https://cpanel.example.test', accountRef: 'acme', credentialSecretRef: 'secret/cpanel', webhookSecretRef: 'secret/cpanel-webhook', syncMode: 'hybrid' });
  assert.equal(config.provider, 'cpanel');
  assert.equal(config.syncMode, 'hybrid');
});

test('rejects insecure URLs, embedded credentials, and write attempts', () => {
  assert.throws(() => createControlPanelConfig({ enabled: true, provider: 'plesk', baseUrl: 'http://panel.example.test', accountRef: 'acme', credentialSecretRef: 'secret/panel' }), (error: { code?: string }) => error.code === 'INSECURE_URL');
  assert.throws(() => createControlPanelConfig({ enabled: true, provider: 'plesk', baseUrl: 'https://user:password@panel.example.test', accountRef: 'acme', credentialSecretRef: 'secret/panel' }), (error: { code?: string }) => error.code === 'INSECURE_URL');
  assert.throws(() => createControlPanelConfig({ provider: 'plesk', allowDnsChanges: true }), (error: { code?: string }) => error.code === 'WRITE_OPERATION_FORBIDDEN');
});

test('binds a panel domain to one tenant and never grants content access', () => {
  const integration = createControlPanelIntegration({ enabled: true, provider: 'plesk', baseUrl: 'https://panel.example.test', accountRef: 'acme', credentialSecretRef: 'secret/panel' });
  const binding = integration.createTenantBinding({ tenantId: 'acme', domain: 'Example.COM', externalDomainId: 'domain-42' });
  assert.deepEqual(binding, { provider: 'plesk', tenantId: 'acme', domain: 'example.com', accountRef: 'acme', externalDomainId: 'domain-42' });
  assert.equal(integration.capabilities.writeDomainState, false);
  assert.throws(() => integration.createTenantBinding({ tenantId: 'acme', domain: 'bad domain' }), (error: { code?: string }) => error.code === 'INVALID_DOMAIN');
});

test('disabled panel integrations cannot create an external binding', () => {
  const config = createControlPanelConfig({ provider: 'cpanel' });
  assert.equal(config.enabled, false);
  assert.throws(() => createControlPanelIntegration({ provider: 'cpanel' }).createTenantBinding({ tenantId: 'acme', domain: 'example.com' }), (error: { code?: string }) => error.code === 'INTEGRATION_DISABLED');
});
