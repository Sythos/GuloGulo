// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ABUSE_CHANNELS,
  createAbuseAuditEvent,
  createAbuseGuard,
  createRateLimiter,
  validateComposeProductionReadiness,
} from './index.mjs';

function createClock(start = Date.parse('2026-08-22T10:00:00Z')) {
  let current = start;
  return {
    clock: () => new Date(current),
    advance(milliseconds) {
      current += milliseconds;
    },
  };
}

function createProductionCompose(overrides = {}) {
  const environment = {
    APP_ENV: 'production',
    LDAP_ENABLED: 'true',
    LDAP_URL: 'ldaps://ldap.example.net:636',
    LDAP_BIND_SECRET_REF: 'deploy/ldap-bind',
    POSTGRES_ENABLED: 'true',
    POSTGRES_HOST: 'postgres.example.net',
    POSTGRES_DSN_SECRET_REF: 'deploy/postgres-dsn',
    ...overrides.environment,
  };
  return {
    services: {
      gulogulo: {
        user: '10001:10001',
        environment,
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        deploy: { resources: { limits: { cpus: '1.0', memory: '512M', pids: 512 } } },
        secrets: ['deploy/ldap-bind', 'deploy/postgres-dsn'],
        ...overrides.service,
      },
    },
    secrets: {
      'deploy/ldap-bind': { external: true },
      'deploy/postgres-dsn': { external: true },
    },
    volumes: {
      'runtime-state': { external: true },
      'mail-data': { external: true },
      'dav-data': { external: true },
      'backup-data': { external: true },
    },
    ...overrides,
  };
}

test('rate limiter covers every required channel and hashes IP/session dimensions', () => {
  const clock = createClock();
  const limits = Object.fromEntries(ABUSE_CHANNELS.map((channel) => [channel, {
    tenant: { max: 2, windowMs: 60_000 },
    ip: { max: 1, windowMs: 60_000 },
    session: { max: 2, windowMs: 60_000 },
  }]));
  const limiter = createRateLimiter({ limits, clock: clock.clock });
  assert.equal(limiter.consume({ channel: 'smtp', tenantId: 'acme', ipAddress: '203.0.113.5', sessionId: 'opaque-session' }).allowed, true);
  const blocked = limiter.consume({ channel: 'smtp', tenantId: 'acme', ipAddress: '203.0.113.5', sessionId: 'opaque-session' });
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.limitedBy, ['ip']);
  assert.equal(JSON.stringify(blocked).includes('203.0.113.5'), false);
  assert.equal(JSON.stringify(blocked).includes('opaque-session'), false);
  clock.advance(60_000);
  assert.equal(limiter.consume({ channel: 'imap', tenantId: 'acme', ipAddress: '203.0.113.5', sessionId: 'opaque-session' }).allowed, true);
});

test('abuse guard emits metadata-only audit hooks and locks out failures', () => {
  const clock = createClock();
  const audit = [];
  const guard = createAbuseGuard({
    clock: clock.clock,
    onAudit: (event) => audit.push(event),
    lockoutPolicy: { failureThreshold: 2, failureWindowMs: 60_000, lockoutMs: 120_000, quarantineThreshold: 3, quarantineMs: 300_000 },
  });
  guard.recordFailure({ tenantId: 'acme', subjectType: 'ip', subject: '203.0.113.5', channel: 'login', reason: 'invalid-credentials' });
  const second = guard.recordFailure({ tenantId: 'acme', subjectType: 'ip', subject: '203.0.113.5', channel: 'login', reason: 'invalid-credentials' });
  assert.equal(second.locked, true);
  assert.equal(guard.check({ channel: 'login', tenantId: 'acme', ipAddress: '203.0.113.5' }).allowed, false);
  assert.equal(guard.status({ tenantId: 'acme', subjectType: 'ip', subject: '203.0.113.5' }).locked, true);
  assert.equal(audit.length, 2);
  assert.equal(JSON.stringify(audit).includes('203.0.113.5'), false);
  assert.equal(audit[1].subjectType, 'ip');
  clock.advance(120_000);
  assert.equal(guard.status({ tenantId: 'acme', subjectType: 'ip', subject: '203.0.113.5' }).locked, false);
});

test('quarantine and release are explicit auditable controls', () => {
  const audit = [];
  const guard = createAbuseGuard({ onAudit: (event) => audit.push(event) });
  const quarantine = guard.quarantineSubject({ tenantId: 'acme', subjectType: 'user', subject: 'alice', channel: 'recovery', durationMs: 60_000, reason: 'repeated-recovery-abuse' });
  assert.equal(quarantine.quarantined, true);
  assert.equal(guard.check({ channel: 'recovery', tenantId: 'acme', sessionId: 'session-a' }).allowed, true);
  assert.equal(guard.status({ tenantId: 'acme', subjectType: 'user', subject: 'alice' }).quarantined, true);
  const released = guard.releaseSubject({ tenantId: 'acme', subjectType: 'user', subject: 'alice', channel: 'recovery' });
  assert.equal(released.released, true);
  assert.equal(guard.status({ tenantId: 'acme', subjectType: 'user', subject: 'alice' }).quarantined, false);
  assert.equal(audit.every((event) => !Object.hasOwn(event, 'payload') && !Object.hasOwn(event, 'sessionId')), true);
});

test('audit event rejects content and credential fields', () => {
  assert.throws(
    () => createAbuseAuditEvent({ action: 'abuse.failure', channel: 'api', outcome: 'rejected', tenantId: 'acme', reason: 'bad-input', details: { payload: 'mail body' } }),
    (error) => error.code === 'SENSITIVE_DATA_FORBIDDEN',
  );
});

test('production Compose readiness passes only with secrets, external hosts, least privilege, bounds, and volumes', () => {
  const result = validateComposeProductionReadiness({ compose: createProductionCompose() });
  assert.equal(result.ready, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.controls.nonRoot, true);
  assert.equal(result.controls.externalDependencies, true);
  assert.equal(JSON.stringify(result).includes('deploy/ldap-bind'), false);
  assert.equal(JSON.stringify(result).includes('ldap.example.net'), false);
});

test('production Compose readiness fails closed for root, missing references, unsafe hosts, mutable filesystems, and weak bounds', () => {
  const result = validateComposeProductionReadiness({
    compose: createProductionCompose({
      service: {
        user: 'root',
        read_only: false,
        cap_drop: [],
        security_opt: [],
        deploy: { resources: { limits: { cpus: '0.1', memory: '64M', pids: 32 } } },
      },
      environment: {
        LDAP_URL: 'ldaps://127.0.0.1:636',
        LDAP_BIND_SECRET_REF: 'plaintext secret',
        POSTGRES_HOST: 'postgres.internal',
        POSTGRES_DSN_SECRET_REF: '',
      },
    }),
  });
  assert.equal(result.ready, false);
  const codes = new Set(result.errors.map((error) => error.code));
  for (const code of ['NON_ROOT_USER_REQUIRED', 'READ_ONLY_REQUIRED', 'CAP_DROP_ALL_REQUIRED', 'NO_NEW_PRIVILEGES_REQUIRED', 'CPU_LIMIT_REQUIRED', 'MEMORY_LIMIT_REQUIRED', 'PIDS_LIMIT_INVALID', 'HOST_INVALID', 'SECRET_VALUE_FORBIDDEN', 'REQUIRED_SECRET_REFERENCE_MISSING']) assert.equal(codes.has(code), true, code);
});

test('disabled external dependencies produce warnings instead of false readiness failures', () => {
  const result = validateComposeProductionReadiness({
    compose: createProductionCompose({
      environment: {
        LDAP_ENABLED: 'false',
        POSTGRES_ENABLED: 'false',
      },
    }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.warnings.filter((warning) => warning.code === 'DEPENDENCY_DISABLED').length, 4);
});

test('Compose readiness does not accept a Docker socket or host namespace', () => {
  const result = validateComposeProductionReadiness({
    compose: createProductionCompose({ service: { network_mode: 'host', volumes: ['/var/run/docker.sock:/var/run/docker.sock'] } }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((error) => error.code === 'HOST_NAMESPACE_FORBIDDEN'), true);
});
