// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLogRotationPolicy,
  createAlertPolicy,
  createAuditEvent,
  createLogRotationPolicy,
  createStructuredEvent,
  isAuditEvent,
  parseByteSize,
  serializeStructuredEvent,
} from './index.mjs';

test('log rotation defaults are bounded and Docker-compatible', () => {
  const policy = createLogRotationPolicy();

  assert.equal(policy.mode, 'docker-json-file');
  assert.equal(policy.bounded, true);
  assert.equal(policy.max_size_bytes, 10_000_000);
  assert.equal(policy.max_files, 5);
  assert.equal(policy.docker.driver, 'json-file');
  assert.equal(policy.docker.options['max-size'], '10m');
  assert.equal(policy.docker.options['max-file'], '5');
  assert.equal(policy.audit.preserve, true);
  assert.equal(policy.audit.content_excluded, true);
  assert.equal(assertLogRotationPolicy(policy), true);
  assert.equal(Object.isFrozen(policy), true);
});

test('log rotation supports journald and sidecar bounds without unbounded fallback', () => {
  const journald = createLogRotationPolicy({
    mode: 'journald',
    maxSize: '20m',
    maxFiles: 3,
    retentionDays: 14,
    auditRetentionDays: 730,
    journald: { maxUse: '2g', maxFile: '100m' },
    auditSink: 'journald',
  });
  assert.equal(journald.journald.max_use_bytes, 2_000_000_000);
  assert.equal(journald.journald.max_file_bytes, 100_000_000);
  assert.equal(journald.docker, null);

  const sidecar = createLogRotationPolicy({
    mode: 'sidecar',
    maxSize: '8m',
    maxFiles: 4,
    sidecar: { name: 'vector-collector' },
  });
  assert.equal(sidecar.sidecar.name, 'vector-collector');
  assert.equal(sidecar.sidecar.max_size_bytes, 8_000_000);
  assert.equal(sidecar.sidecar.max_files, 4);
  assert.equal(sidecar.sidecar.forward_to_audit, true);
});

test('log policy rejects zero, oversized records, and shorter audit retention', () => {
  assert.equal(parseByteSize('1MiB'), 1_048_576);
  assert.throws(() => parseByteSize('0m'), /positive/);
  assert.throws(() => createLogRotationPolicy({ maxSize: '1m', maxRecordBytes: '2m' }), /cannot exceed/);
  assert.throws(() => createLogRotationPolicy({ retentionDays: 30, auditRetentionDays: 29 }), /at least/);
  assert.throws(() => createLogRotationPolicy({ mode: 'unbounded' }), /one of/);
});

test('structured events redact credentials and content while preserving audit metadata', () => {
  const event = createAuditEvent({
    service: 'gulogulo-web',
    event: 'mfa.factor.enrolled',
    timestamp: '2026-08-22T00:00:00.000Z',
    tenant: 'example.test',
    actor: 'user@example.test',
    subject: 'user@example.test',
    result: 'success',
    details: {
      factor: 'totp',
      token: 'secret-token',
      message_body: 'private message',
      inline: 'password=private-password',
    },
  });

  assert.equal(event.audit, true);
  assert.equal(event.actor, 'user@example.test');
  assert.equal(event.details.token, '[REDACTED]');
  assert.equal(event.details.message_body, '[REDACTED]');
  assert.equal(event.details.inline.includes('private-password'), false);
  assert.equal(isAuditEvent(event), true);
  assert.equal(serializeStructuredEvent(event).endsWith('\n'), true);
  assert.equal(serializeStructuredEvent(event).includes('private-password'), false);
  assert.equal(serializeStructuredEvent({ event: 'unsafe.event', token: 'secret-token' }).includes('secret-token'), false);
});

test('non-audit events do not allow details to overwrite stable metadata', () => {
  const event = createStructuredEvent({
    event: 'queue.depth.sampled',
    details: {
      level: 'error',
      audit: true,
      result: 'failure',
      depth: 12,
    },
  });

  assert.equal(event.level, 'info');
  assert.equal(event.audit, false);
  assert.equal(event.result, null);
  assert.equal(event.details.depth, 12);
  assert.equal('audit' in event.details, false);
});

test('structured event size limit fails closed', () => {
  assert.throws(
    () => createStructuredEvent({ event: 'test.event', maxBytes: 512, details: { text: 'x'.repeat(2_000) } }),
    /byte limit/,
  );
  assert.throws(() => createAuditEvent({ event: 'audit.event' }), /actor is required/);
});

test('alert policy covers dependencies, queue, certificates, capacity, and auth abuse', () => {
  const policy = createAlertPolicy({ clock: () => new Date('2026-08-22T00:00:00.000Z') });
  const result = policy.evaluate({
    dependencies: {
      ldap: { status: 'failed', endpoint: 'ldap.internal', password: 'secret' },
      postgres: { status: 'degraded' },
    },
    queue: { depth: 1_200, oldestAgeSeconds: 2_000 },
    certificates: [{ name: 'web', daysRemaining: 4 }, { name: 'mail', daysRemaining: 20 }],
    storage: { usedBytes: 95, capacityBytes: 100 },
    quota: { usedPercent: 85, subject: 'tenant@example.test' },
    authAbuse: { failedAttempts: 25, subject: 'user@example.test', windowSeconds: 300 },
  });

  assert.equal(result.status, 'critical');
  assert.equal(result.critical >= 5, true);
  assert.equal(result.warning >= 3, true);
  assert.equal(result.generated_at, '2026-08-22T00:00:00.000Z');
  assert.equal(result.alerts.some((alert) => alert.code === 'dependency_failed'), true);
  assert.equal(result.alerts.some((alert) => alert.code === 'queue_depth_critical'), true);
  assert.equal(result.alerts.some((alert) => alert.code === 'certificate_expiry_critical'), true);
  assert.equal(result.alerts.some((alert) => alert.code === 'storage_pressure_critical'), true);
  assert.equal(result.alerts.some((alert) => alert.code === 'quota_pressure_high'), true);
  assert.equal(result.alerts.some((alert) => alert.code === 'auth_abuse_critical'), true);
  assert.equal(JSON.stringify(result).includes('ldap.internal'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);

  const overfull = policy.evaluate({ storage: { usedPercent: 110 } });
  assert.equal(overfull.status, 'critical');
  assert.equal(overfull.alerts[0].observed, 110);
});

test('alert policy returns a clean status and accepts disabled dependencies', () => {
  const policy = createAlertPolicy();
  const result = policy.evaluate({ dependencies: { clamd: { status: 'disabled' } } });
  assert.equal(result.status, 'ok');
  assert.equal(result.alerts.length, 0);
});

test('alert thresholds reject unsafe ordering', () => {
  assert.throws(
    () => createAlertPolicy({ thresholds: { queue: { warningDepth: 100, criticalDepth: 99 } } }),
    /Critical queue thresholds/,
  );
  assert.throws(
    () => createAlertPolicy({ thresholds: { storage: { warningPercent: 80, criticalPercent: 101 } } }),
    /between 0 and 100/,
  );
});
