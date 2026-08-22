// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createRuntimeServer, startServer, stopServer } from './server.mjs';

function createTestLogger() {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  return {
    logger: createLogger({ output, errorOutput }),
    output,
    errorOutput,
  };
}

function makeTestRuntime() {
  const streams = createTestLogger();
  const runtime = createRuntimeServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      serviceName: 'gulogulo-test',
      environment: 'test',
      shutdownTimeoutMs: 1_000,
    },
    logger: streams.logger,
  });
  return { runtime, ...streams };
}

function getJson(runtime, path, method = 'GET') {
  const address = runtime.server.address();
  return new Promise((resolve, reject) => {
    const requestHandle = request(
      {
        host: address.address,
        port: address.port,
        path,
        method,
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
            body: body.length > 0 ? JSON.parse(body) : null,
          });
        });
      },
    );
    requestHandle.on('error', reject);
    requestHandle.end();
  });
}

function getResponse(runtime, path, method = 'GET') {
  const address = runtime.server.address();
  return new Promise((resolveResponse, reject) => {
    const requestHandle = request(
      {
        host: address.address,
        port: address.port,
        path,
        method,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolveResponse({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    requestHandle.on('error', reject);
    requestHandle.end();
  });
}

test('runtime exposes liveness and readiness endpoints without secrets', async () => {
  const { runtime } = makeTestRuntime();
  await startServer(runtime);

  try {
    const health = await getJson(runtime, '/health/live');
    assert.equal(health.statusCode, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.checks.process, 'ok');
    assert.equal(health.body.service, 'gulogulo-test');

    const readiness = await getJson(runtime, '/health/ready');
    assert.equal(readiness.statusCode, 200);
    assert.equal(readiness.body.status, 'ready');
    assert.equal(readiness.body.checks.configuration, 'ok');
    assert.equal(Object.hasOwn(readiness.body, 'password'), false);
    assert.equal(Object.hasOwn(readiness.body, 'token'), false);
  } finally {
    await stopServer(runtime);
  }
});

test('runtime returns safe protocol responses for unsupported routes and methods', async () => {
  const { runtime } = makeTestRuntime();
  await startServer(runtime);

  try {
    const notFound = await getJson(runtime, '/not-a-runtime-endpoint');
    assert.equal(notFound.statusCode, 404);
    assert.equal(notFound.body.status, 'not_found');

    const methodNotAllowed = await getJson(runtime, '/health/live', 'POST');
    assert.equal(methodNotAllowed.statusCode, 405);
    assert.equal(methodNotAllowed.headers.allow, 'GET, HEAD');
    assert.equal(methodNotAllowed.body.status, 'method_not_allowed');

    const head = await getJson(runtime, '/health/live', 'HEAD');
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, null);
  } finally {
    await stopServer(runtime);
  }
});

test('runtime serves the HTML5 shell with defensive static headers and rejects traversal', async () => {
  const { runtime } = makeTestRuntime();
  await startServer(runtime);

  try {
    const shell = await getResponse(runtime, '/');
    assert.equal(shell.statusCode, 200);
    assert.match(shell.headers['content-type'], /^text\/html/);
    assert.equal(shell.headers['x-content-type-options'], 'nosniff');
    assert.equal(shell.headers['x-frame-options'], 'DENY');
    assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(shell.body.toString('utf8'), /Gulo Gulo/);

    const styles = await getResponse(runtime, '/web/styles.css');
    assert.equal(styles.statusCode, 200);
    assert.match(styles.headers['content-type'], /^text\/css/);

    const traversal = await getJson(runtime, '/web/%2e%2e/src/runtime/server.mjs');
    assert.equal(traversal.statusCode, 404);
  } finally {
    await stopServer(runtime);
  }
});

test('runtime configuration validates network settings and excludes credentials', () => {
  assert.throws(
    () => loadConfig({ GULOGULO_PORT: '70000' }),
    /GULOGULO_PORT must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => loadConfig({ GULOGULO_HOST: 'not a host' }),
    /GULOGULO_HOST must be a valid IP address or hostname/,
  );

  const config = loadConfig({
    GULOGULO_HOST: '127.0.0.1',
    GULOGULO_PORT: '8081',
    GULOGULO_SERVICE_NAME: 'gulogulo-api',
    GULOGULO_ENV: 'test',
    GULOGULO_SHUTDOWN_TIMEOUT_MS: '1000',
    GULOGULO_DATABASE_PASSWORD: 'must-not-be-read',
  });

  assert.deepEqual(config, {
    host: '127.0.0.1',
    port: 8081,
    serviceName: 'gulogulo-api',
    environment: 'test',
    shutdownTimeoutMs: 1000,
  });
  assert.equal(Object.hasOwn(config, 'GULOGULO_DATABASE_PASSWORD'), false);
});

test('runtime shutdown makes readiness fail before closing', async () => {
  const { runtime } = makeTestRuntime();
  await startServer(runtime);
  const address = runtime.server.address();
  const closePromise = stopServer(runtime);

  assert.equal(runtime.state.ready, false);
  assert.equal(runtime.state.shuttingDown, true);

  await closePromise;
  assert.equal(runtime.server.listening, false);
  assert.equal(address.port > 0, true);
});
