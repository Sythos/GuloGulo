// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACME_PROVIDERS,
  CHALLENGE_TYPES,
  DEFAULT_LETSENCRYPT_DIRECTORY_URL,
  LETSENCRYPT_STAGING_DIRECTORY_URL,
  advanceRenewal,
  createAcmeConfig,
  createExpiryAlert,
  createRenewalState,
  createSafeReloadPlan,
  createTlsHealthContract,
  completeSafeReloadPlan,
  evaluateCertificateHealth,
  redactSecrets,
  retryDelaySeconds,
} from './index.mjs';

const NOW = '2026-08-22T12:00:00.000Z';
const CERTIFICATE = Object.freeze({
  id: 'cert-001',
  notBefore: '2026-08-01T00:00:00.000Z',
  notAfter: '2026-10-15T00:00:00.000Z',
  issuer: "Let's Encrypt",
  subject: 'CN=mail.example.test',
  serialNumber: 'ABC123',
  dnsNames: ['mail.example.test', '*.example.test'],
  chainValid: true,
  privateKeyMatches: true,
});

function config(overrides = {}) {
  return createAcmeConfig({
    domains: ['mail.example.test'],
    account: { keySecretRef: 'acme/account-key' },
    ...overrides,
  });
}

test('defaults to production Let\'s Encrypt and automatic renewal', () => {
  const result = config();
  assert.equal(result.provider, ACME_PROVIDERS.LETSENCRYPT);
  assert.equal(result.directoryUrl, DEFAULT_LETSENCRYPT_DIRECTORY_URL);
  assert.equal(result.environment, 'production');
  assert.equal(result.renewal.enabled, true);
  assert.equal(result.challenge.type, CHALLENGE_TYPES.HTTP_01);
  assert.equal(result.account.keySecretRef, 'acme/account-key');
  assert.equal(result.certificateKeySecretRef, 'acme/certificate-key');
  assert.equal(Object.hasOwn(result, 'privateKey'), false);
});

test('supports staging and generic private ACME directories over HTTPS', () => {
  const staging = config({ environment: 'staging' });
  assert.equal(staging.directoryUrl, LETSENCRYPT_STAGING_DIRECTORY_URL);
  const generic = config({
    provider: ACME_PROVIDERS.GENERIC,
    directoryUrl: 'https://ca.internal.example/acme/directory',
    account: {
      contactEmail: 'ops@example.test',
      keySecretRef: 'vault/acme/account',
      externalAccountBinding: { kid: 'tenant-kid', hmacSecretRef: 'vault/acme/eab' },
    },
  });
  assert.equal(generic.provider, ACME_PROVIDERS.GENERIC);
  assert.equal(generic.account.externalAccountBinding.hmacSecretRef, 'vault/acme/eab');
  assert.throws(() => config({ provider: ACME_PROVIDERS.GENERIC }), (error) => error.code === 'INVALID_DIRECTORY_URL');
  assert.throws(() => config({ directoryUrl: 'http://ca.example.test/directory' }), (error) => error.code === 'INSECURE_DIRECTORY_URL');
});

test('validates HTTP-01 and DNS-01 challenge requirements', () => {
  const dns = config({
    domains: ['*.example.test'],
    challenge: {
      type: 'dns-01',
      dnsProvider: 'cloud-dns',
      credentialsSecretRef: 'vault/dns/cloud',
    },
  });
  assert.equal(dns.challenge.type, CHALLENGE_TYPES.DNS_01);
  assert.throws(() => config({ domains: ['*.example.test'] }), (error) => error.code === 'INVALID_CHALLENGE');
  assert.throws(() => config({ challenge: { type: 'dns-01', dnsProvider: 'cloud-dns' } }), (error) => error.code === 'INVALID_SECRET_REFERENCE');
  assert.throws(() => config({ challenge: { type: 'http-01', listenPort: 80, tokenPathPrefix: '/bad/../' } }), (error) => error.code === 'INVALID_CHALLENGE');
});

test('rejects private key material and preserves secret references only', () => {
  assert.throws(() => config({ account: { keySecretRef: 'acme/key', privateKey: '-----BEGIN PRIVATE KEY-----abc' } }), (error) => error.code === 'SECRET_MATERIAL_FORBIDDEN');
  const redacted = redactSecrets({
    accountKey: '-----BEGIN PRIVATE KEY-----abc',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----abc',
    dnsProviderSecretRef: 'vault/dns',
    authorizationToken: 'token-value',
    nested: [{ certificatePem: '-----BEGIN CERTIFICATE-----abc' }],
  });
  assert.equal(redacted.accountKey, '[REDACTED]');
  assert.equal(redacted.privateKeyPem, '[REDACTED]');
  assert.equal(redacted.dnsProviderSecretRef, 'vault/dns');
  assert.equal(redacted.nested[0].certificatePem, '[REDACTED]');
  assert.equal(JSON.stringify(redacted).includes('BEGIN PRIVATE KEY'), false);
});

test('calculates deterministic exponential retry delays', () => {
  const policy = { maxAttempts: 3, initialDelaySeconds: 60, maxDelaySeconds: 300, multiplier: 2 };
  assert.equal(retryDelaySeconds(0, policy), 60);
  assert.equal(retryDelaySeconds(1, policy), 120);
  assert.equal(retryDelaySeconds(2, policy), 240);
  assert.equal(retryDelaySeconds(3, policy), 300);
});

test('reports healthy, expiring, expired, and hostname-mismatch TLS states', () => {
  const healthy = evaluateCertificateHealth({ certificate: CERTIFICATE, hostname: 'mail.example.test', now: NOW });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.renewalDue, false);
  const expiring = evaluateCertificateHealth({ certificate: { ...CERTIFICATE, notAfter: '2026-09-05T00:00:00.000Z' }, hostname: 'mail.example.test', now: NOW });
  assert.equal(expiring.status, 'degraded');
  assert.equal(expiring.alerts[0].type, 'certificate.expiry_warning');
  const expired = evaluateCertificateHealth({ certificate: { ...CERTIFICATE, notAfter: '2026-08-21T00:00:00.000Z' }, hostname: 'mail.example.test', now: NOW });
  assert.equal(expired.status, 'unhealthy');
  assert.equal(expired.alerts[0].type, 'certificate.expired');
  const mismatch = createTlsHealthContract({ certificate: CERTIFICATE, hostname: 'other.example.net', now: NOW });
  assert.equal(mismatch.status, 'unhealthy');
  assert.ok(mismatch.alerts.some((alert) => alert.type === 'certificate.hostname_mismatch'));
});

test('creates expiry alerts without exposing certificate contents', () => {
  const alert = createExpiryAlert({
    certificate: { ...CERTIFICATE, notAfter: '2026-08-27T00:00:00.000Z' },
    certificateId: 'cert-001',
    now: NOW,
  });
  assert.equal(alert.type, 'certificate.expiry_critical');
  assert.equal(alert.certificateId, 'cert-001');
  assert.equal(Object.hasOwn(alert, 'certificatePem'), false);
});

test('renews through authorization, order, storage, and graceful reload', () => {
  let state = createRenewalState({
    config: config(),
    currentCertificate: CERTIFICATE,
    now: NOW,
  });
  assert.equal(state.state, 'idle');
  state = advanceRenewal(state, { type: 'renew_due', now: NOW });
  state = advanceRenewal(state, { type: 'start', now: NOW });
  state = advanceRenewal(state, { type: 'authorization_succeeded', now: NOW });
  state = advanceRenewal(state, { type: 'order_ready', now: NOW });
  state = advanceRenewal(state, { type: 'certificate_stored', certificate: { ...CERTIFICATE, id: 'cert-002' }, now: NOW });
  assert.equal(state.state, 'reload_pending');
  state = advanceRenewal(state, { type: 'reload_succeeded', now: NOW });
  assert.equal(state.state, 'active');
  assert.equal(state.currentCertificate.id, 'cert-002');
  assert.equal(state.attempt, 0);
  assert.equal(state.pendingCertificate, null);
});

test('keeps the current valid certificate while renewal retries and alerts after exhaustion', () => {
  let state = createRenewalState({
    config: config({ renewal: { retry: { maxAttempts: 1, initialDelaySeconds: 10, maxDelaySeconds: 10, multiplier: 1 } } }),
    currentCertificate: CERTIFICATE,
    now: NOW,
  });
  state = advanceRenewal(state, 'start', { now: NOW });
  state = advanceRenewal(state, { type: 'failed', now: NOW, error: { code: 'ACME_TIMEOUT', message: 'privateKeyPem=-----BEGIN PRIVATE KEY-----secret' } });
  assert.equal(state.state, 'retry_wait');
  assert.equal(state.fallbackActive, true);
  assert.equal(state.lastError.message.includes('BEGIN PRIVATE KEY'), false);
  state = advanceRenewal(state, { type: 'retry_due', now: '2026-08-22T12:01:00.000Z' });
  state = advanceRenewal(state, { type: 'failed', now: '2026-08-22T12:01:00.000Z', error: { code: 'ACME_TIMEOUT', message: 'directory unavailable' } });
  assert.equal(state.state, 'degraded');
  assert.equal(state.lastAlert.type, 'certificate.renewal_failed');
  assert.equal(state.fallbackActive, true);
});

test('creates and completes a metadata-only graceful reload plan', () => {
  const plan = createSafeReloadPlan({ certificate: CERTIFICATE, previousCertificate: { ...CERTIFICATE, id: 'cert-old' }, now: NOW });
  assert.equal(plan.strategy, 'graceful');
  assert.equal(plan.status, undefined);
  assert.deepEqual(plan.consumers.map((entry) => entry.status), ['pending', 'pending', 'pending']);
  assert.equal(Object.hasOwn(plan, 'privateKey'), false);
  const completed = completeSafeReloadPlan(plan, [
    { consumer: 'web', status: 'reloaded' },
    { consumer: 'postfix', status: 'reloaded' },
    { consumer: 'dovecot', status: 'reloaded' },
  ], { now: NOW });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.rollbackRequired, false);
  const failed = completeSafeReloadPlan(plan, [{ consumer: 'web', status: 'failed', errorCode: 'TLS_RELOAD_FAILED' }], { now: NOW });
  assert.equal(failed.status, 'rollback_required');
  assert.equal(failed.rollbackRequired, true);
});

test('fails the TLS health gate for invalid chains and key mismatch', () => {
  assert.throws(() => createSafeReloadPlan({ certificate: { ...CERTIFICATE, chainValid: false } }), (error) => error.code === 'RELOAD_HEALTH_GATE_FAILED');
  assert.throws(() => createSafeReloadPlan({ certificate: { ...CERTIFICATE, privateKeyMatches: false } }), (error) => error.code === 'RELOAD_HEALTH_GATE_FAILED');
  const result = evaluateCertificateHealth({ certificate: { ...CERTIFICATE, chainValid: false }, now: NOW });
  assert.equal(result.status, 'unhealthy');
  assert.ok(result.alerts.some((alert) => alert.type === 'certificate.chain_invalid'));
});
