// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createLogger, sanitizeLogValue } from './logger.js';
import {
  createDependencyRegistry,
  createMetrics,
} from './metrics.js';
import { createRuntimeServer, startServer, stopServer } from './server.js';

function createStreamLogger() {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  return {
    logger: createLogger({
      serviceName: 'gulogulo-observability-test',
      environment: 'test',
      version: '0.0.0-test',
      build: 'test-build',
      output,
      errorOutput,
      clock: () => new Date('2026-08-22T00:00:00.000Z'),
    }),
    output,
    errorOutput,
  };
}

function readStream(stream) {
  let result = '';
  let chunk;
  while ((chunk = stream.read()) !== null) {
    result += chunk.toString('utf8');
  }
  return result;
}

function makeRuntime(options = {}) {
  const streams = createStreamLogger();
  const runtime = createRuntimeServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      serviceName: 'gulogulo-observability-test',
      environment: 'test',
      shutdownTimeoutMs: 1_000,
    },
    logger: streams.logger,
    clock: () => new Date('2026-08-22T00:00:00.000Z'),
    ...options,
  });
  return { runtime, ...streams };
}

function getResponse(runtime, path, method = 'GET', headers = {}) {
  const address = runtime.server.address();
  return new Promise((resolve, reject) => {
    const handle = request(
      {
        host: address.address,
        port: address.port,
        path,
        method,
        headers,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body,
            json: response.headers['content-type']?.startsWith('application/json')
              ? JSON.parse(body)
              : undefined,
          });
        });
      },
    );
    handle.on('error', reject);
    handle.end();
  });
}

test('structured logs use a stable schema and redact sensitive nested values', () => {
  const { logger, output } = createStreamLogger();
  const circular = { safe: 'value' };
  circular.self = circular;

  logger.info('redaction_test', {
    tenant: 'example.test',
    actor: 'operator',
    password: 'fixture-password',
    access_token: 'fixture-token',
    cookie: 'session=fixture-cookie',
    message_content: 'private message body',
    nested: {
      authorization: 'Bearer fixture-authorization',
      body: 'private nested body',
    },
    circular,
    inline: 'password=inline-password token=inline-token',
    error: new Error('token=error-token'),
  });

  const record = JSON.parse(readStream(output));
  assert.equal(record.timestamp, '2026-08-22T00:00:00.000Z');
  assert.equal(record.level, 'info');
  assert.equal(record.service, 'gulogulo-observability-test');
  assert.equal(record.version, '0.0.0-test');
  assert.equal(record.build, 'test-build');
  assert.equal(record.tenant, 'example.test');
  assert.equal(record.actor, 'operator');
  assert.equal(record.password, '[REDACTED]');
  assert.equal(record.access_token, '[REDACTED]');
  assert.equal(record.cookie, '[REDACTED]');
  assert.equal(record.message_content, '[REDACTED]');
  assert.equal(record.nested.authorization, '[REDACTED]');
  assert.equal(record.circular.self, '[Circular]');
  assert.equal(record.inline.includes('inline-password'), false);
  assert.equal(record.inline.includes('inline-token'), false);
  assert.equal(JSON.stringify(record).includes('fixture-'), false);
});

test('sanitizeLogValue handles arrays and repeated references safely', () => {
  const shared = { token: 'secret-token', label: 'safe' };
  const sanitized = sanitizeLogValue([shared, shared]);

  assert.deepEqual(sanitized, [
    { token: '[REDACTED]', label: 'safe' },
    '[Circular]',
  ]);
});

test('health responses preserve aliases and request correlation identifiers', async () => {
  const { runtime, output } = makeRuntime();
  await startServer(runtime);

  try {
    const response = await getResponse(runtime, '/healthz', 'GET', {
      'x-request-id': 'request-123',
      'x-correlation-id': 'correlation-456',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-request-id'], 'request-123');
    assert.equal(response.headers['x-correlation-id'], 'correlation-456');
    assert.equal(response.json.status, 'ok');
    assert.equal(response.json.version, '0.1.2');
    assert.equal(response.json.build_digest, 'development');
    assert.equal(response.json.checks.process, 'ok');
    assert.equal(response.json.request_id, 'request-123');
    assert.equal(response.json.correlation_id, 'correlation-456');

    const logs = readStream(output);
    assert.equal(logs.includes('request-123'), true);
    assert.equal(logs.includes('correlation-456'), true);
    assert.equal(logs.includes('request_completed'), true);
  } finally {
    await stopServer(runtime);
  }
});

test('readiness fails closed for enabled dependencies and ignores disabled ones', async () => {
  const { runtime } = makeRuntime({
    dependencies: {
      ldap: { status: 'starting', endpoint: 'ldap.example.test' },
      postgres: { status: 'disabled', password: 'fixture-password' },
    },
  });
  await startServer(runtime);

  try {
    const starting = await getResponse(runtime, '/readyz');
    assert.equal(starting.statusCode, 503);
    assert.equal(starting.json.status, 'not_ready');
    assert.equal(starting.json.dependency_status, 'not_ready');
    assert.equal(starting.json.checks.dependencies.ldap.status, 'starting');
    assert.equal(starting.json.checks.dependencies.postgres.status, 'disabled');
    assert.equal(JSON.stringify(starting.json).includes('ldap.example.test'), false);
    assert.equal(JSON.stringify(starting.json).includes('fixture-password'), false);

    runtime.dependencies.setStatus('ldap', 'ok', { latencyMs: 3 });
    const ready = await getResponse(runtime, '/health/ready');
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json.status, 'ready');
    assert.equal(ready.json.checks.dependencies.ldap.status, 'ok');
    assert.equal(ready.json.checks.dependencies.ldap.latency_ms, 3);
  } finally {
    await stopServer(runtime);
  }
});

test('metrics registry exposes safe counters, gauges, histograms, and dependency status', () => {
  const metrics = createMetrics({
    clock: () => new Date('2026-08-22T00:00:00.000Z'),
  });
  metrics.increment('gulogulo_jobs_total', 2, { result: 'success' });
  metrics.set('gulogulo_workers', 1);
  metrics.observe('gulogulo_job_duration_ms', 4);
  metrics.recordRequest({
    method: 'get',
    route: '/health/live',
    statusCode: 200,
    durationMs: 1,
  });

  const dependencies = createDependencyRegistry({
    initial: { ldap: 'starting', postgres: 'disabled' },
    metrics,
    clock: () => new Date('2026-08-22T00:00:00.000Z'),
  });
  assert.equal(dependencies.isReady(), false);
  dependencies.setStatus('ldap', 'ok');
  assert.equal(dependencies.isReady(), true);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.generated_at, '2026-08-22T00:00:00.000Z');
  assert.equal(snapshot.counters.some((series) => series.name === 'gulogulo_jobs_total'), true);
  assert.equal(snapshot.gauges.some((series) => series.name === 'gulogulo_workers'), true);
  assert.equal(snapshot.histograms.some((series) => series.name === 'gulogulo_job_duration_ms'), true);
  const prometheus = metrics.toPrometheus();
  assert.equal(prometheus.includes('gulogulo_http_requests_total'), true);
  assert.equal(prometheus.includes('gulogulo_dependency_status'), true);
  assert.equal(prometheus.includes('fixture-password'), false);
});

test('runtime publishes metrics without request content or credentials', async () => {
  const { runtime } = makeRuntime();
  await startServer(runtime);

  try {
    await getResponse(runtime, '/health/live');
    const response = await getResponse(runtime, '/metrics');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'].startsWith('text/plain'), true);
    assert.equal(response.body.includes('gulogulo_http_requests_total'), true);
    assert.equal(response.body.includes('password'), false);
    assert.equal(response.body.includes('token'), false);
  } finally {
    await stopServer(runtime);
  }
});

test('patch status is exposed as a read-only, secret-free operational contract', async () => {
  const { runtime } = makeRuntime();
  await startServer(runtime);

  try {
    const response = await getResponse(runtime, '/ops/patch/status');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.status, 'ok');
    assert.equal(response.json.patching.state, 'unknown');
    assert.equal(response.json.patching.reason, 'status_unavailable');
    assert.equal(JSON.stringify(response.json).includes('password'), false);
    assert.equal(JSON.stringify(response.json).includes('token'), false);
  } finally {
    await stopServer(runtime);
  }
});
