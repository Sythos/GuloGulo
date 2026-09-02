// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createDiscoveryContract } from '../core/dav/discovery/index.ts';
import { createWebSecurity } from '../web/security/index.ts';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createFixtureLoginAuthenticator, createRuntimeServer, startServer, stopServer } from './server.js';

type TestRuntime = ReturnType<typeof createRuntimeServer>;
interface JsonResponse { statusCode: number | undefined; headers: IncomingHttpHeaders; body: any }
interface BinaryResponse { statusCode: number | undefined; headers: IncomingHttpHeaders; body: Buffer }

function createTestLogger() {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  return {
    logger: createLogger({ output: output as unknown as typeof process.stdout, errorOutput: errorOutput as unknown as typeof process.stderr }),
    output,
    errorOutput,
  };
}

function makeTestRuntime(options: Parameters<typeof createRuntimeServer>[0] = {}) {
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
    ...options,
  });
  return { runtime, ...streams };
}

function serverAddress(runtime: TestRuntime): AddressInfo {
  const address = runtime.server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address;
}

function headerString(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (typeof value !== 'string') throw new Error(`Expected string response header: ${name}`);
  return value;
}

function firstSetCookie(headers: IncomingHttpHeaders): string {
  const values = headers['set-cookie'];
  assert.ok(Array.isArray(values) && values.length > 0);
  return values[0]!;
}

function requestJson(runtime: TestRuntime, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: OutgoingHttpHeaders; body?: unknown } = {}): Promise<JsonResponse> {
  const address = serverAddress(runtime);
  return new Promise<JsonResponse>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHandle = request({
      host: address.address,
      port: address.port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: responseBody.length > 0 ? JSON.parse(responseBody) : null,
      }));
    });
    requestHandle.on('error', reject);
    requestHandle.end(payload);
  });
}

function getJson(runtime: TestRuntime, path: string, method = 'GET'): Promise<JsonResponse> {
  const address = serverAddress(runtime);
  return new Promise<JsonResponse>((resolve, reject) => {
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

function getResponse(runtime: TestRuntime, path: string, method = 'GET'): Promise<BinaryResponse> {
  const address = serverAddress(runtime);
  return new Promise<BinaryResponse>((resolveResponse, reject) => {
    const requestHandle = request(
      {
        host: address.address,
        port: address.port,
        path,
        method,
      },
      (response) => {
        const chunks: Buffer[] = [];
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
    assert.match(headerString(shell.headers, 'content-type'), /^text\/html/);
    assert.equal(shell.headers['x-content-type-options'], 'nosniff');
    assert.equal(shell.headers['x-frame-options'], 'DENY');
    assert.match(headerString(shell.headers, 'content-security-policy'), /frame-ancestors 'none'/);
    assert.match(shell.body.toString('utf8'), /Gulo Gulo/);

    const login = await getResponse(runtime, '/login');
    assert.equal(login.statusCode, 200);
    assert.deepEqual(login.body, shell.body);

    const styles = await getResponse(runtime, '/web/styles.css');
    assert.equal(styles.statusCode, 200);
    assert.match(headerString(styles.headers, 'content-type'), /^text\/css/);

    const artwork = await getResponse(runtime, '/assets/gulo-gulo-calendar-mail.png');
    assert.equal(artwork.statusCode, 200);
    assert.match(headerString(artwork.headers, 'content-type'), /^image\/png/);
    assert.ok(artwork.body.length > 1_024);

    const traversal = await getJson(runtime, '/web/%2e%2e/src/runtime/server.ts');
    assert.equal(traversal.statusCode, 404);
  } finally {
    await stopServer(runtime);
  }
});

test('session API fails closed, returns generic login errors, and rate limits failures', async () => {
  const { runtime } = makeTestRuntime();
  await startServer(runtime);
  try {
    const absent = await requestJson(runtime, '/api/session');
    assert.equal(absent.statusCode, 200);
    assert.equal(absent.body.authenticated, false);
    assert.equal(Object.hasOwn(absent.body, 'user'), false);

    const protectedResponse = await requestJson(runtime, '/api/mail/messages');
    assert.equal(protectedResponse.statusCode, 401);
    assert.equal(protectedResponse.body.error.code, 'AUTHENTICATION_REQUIRED');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await requestJson(runtime, '/api/session/login', {
        method: 'POST', body: { email: 'unknown@example.test', password: 'wrong', rememberMe: false },
      });
      assert.equal(failed.statusCode, attempt < 5 ? 401 : 429);
      assert.equal(failed.body.error.message, 'Unable to sign in.');
      assert.equal(JSON.stringify(failed.body).includes('unknown@example.test'), false);
      assert.equal(JSON.stringify(failed.body).includes('wrong'), false);
    }
  } finally {
    await stopServer(runtime);
  }
});

test('authenticated API is tenant/user scoped and logout requires a valid CSRF token', async () => {
  const requestedScopes: Array<{ tenantId: string; userId: string; role: string }> = [];
  const { runtime } = makeTestRuntime({
    authenticateLogin: async ({ email, password }) => email === 'alice@acme.example' && password === 'test-only-password'
      ? { tenantId: 'acme', domain: 'acme.example', userId: 'alice', actorId: 'alice', role: 'user' }
      : null,
    apiResources: {
      mail: async (scope) => { requestedScopes.push(scope); return { messages: [{ id: 'synthetic-1' }] }; },
    },
  });
  await startServer(runtime);
  try {
    const login = await requestJson(runtime, '/api/session/login', {
      method: 'POST', body: { email: 'alice@acme.example', password: 'test-only-password', rememberMe: false },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.body.user.tenantId, 'acme');
    assert.equal(login.body.user.userId, 'alice');
    assert.equal(Object.hasOwn(login.body.user, 'sessionId'), false);
    assert.equal(Object.hasOwn(login.body, 'password'), false);
    const cookie = firstSetCookie(login.headers).split(';', 1)[0]!;

    const mail = await requestJson(runtime, '/api/mail/messages', { headers: { cookie } });
    assert.equal(mail.statusCode, 200);
    assert.deepEqual(mail.body.scope, { tenantId: 'acme', userId: 'alice' });
    assert.deepEqual(mail.body.messages, [{ id: 'synthetic-1' }]);
    assert.deepEqual(requestedScopes, [{ tenantId: 'acme', userId: 'alice', role: 'user' }]);

    const missingCsrf = await requestJson(runtime, '/api/session/logout', { method: 'POST', headers: { cookie } });
    assert.equal(missingCsrf.statusCode, 403);
    const stillAuthenticated = await requestJson(runtime, '/api/session', { headers: { cookie } });
    assert.equal(stillAuthenticated.body.authenticated, true);

    const logout = await requestJson(runtime, '/api/session/logout', {
      method: 'POST', headers: { cookie, 'x-csrf-token': login.body.csrfToken },
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(logout.body.authenticated, false);
    assert.match(firstSetCookie(logout.headers), /Max-Age=0/u);
    const afterLogout = await requestJson(runtime, '/api/calendar/events', { headers: { cookie } });
    assert.equal(afterLogout.statusCode, 401);
  } finally {
    await stopServer(runtime);
  }
});

test('fixture login is explicit and production defaults remain fail-closed', async () => {
  const production = createFixtureLoginAuthenticator({});
  assert.equal(await production({ email: 'alice@acme.example', password: 'anything', rememberMe: false }), null);

  const fixture = createFixtureLoginAuthenticator({
    GULOGULO_FIXTURE_MODE: 'true',
    GULOGULO_FIXTURE_EMAIL: 'alice@acme.example',
    GULOGULO_FIXTURE_PASSWORD: 'local-proof-secret',
    GULOGULO_FIXTURE_TENANT: 'acme',
    GULOGULO_FIXTURE_DOMAIN: 'acme.example',
    GULOGULO_FIXTURE_USER_ID: 'alice',
  });
  assert.equal(await fixture({ email: 'alice@acme.example', password: 'wrong', rememberMe: false }), null);
  assert.deepEqual(await fixture({ email: 'alice@acme.example', password: 'local-proof-secret', rememberMe: false }), {
    tenantId: 'acme', domain: 'acme.example', userId: 'alice', actorId: 'alice', role: 'user',
  });
});

test('expired API sessions become unauthenticated and are cleared', async () => {
  let now = Date.parse('2026-08-25T10:00:00Z');
  const clock = () => new Date(now);
  const webSecurity = createWebSecurity({ clock, ttlMs: 1_000 });
  const { runtime } = makeTestRuntime({
    clock,
    webSecurity,
    authenticateLogin: async () => ({ tenantId: 'acme', domain: 'acme.example', userId: 'alice', actorId: 'alice', role: 'user' }),
  });
  await startServer(runtime);
  try {
    const login = await requestJson(runtime, '/api/session/login', { method: 'POST', body: { email: 'alice@acme.example', password: 'test-only-password' } });
    const cookie = firstSetCookie(login.headers).split(';', 1)[0]!;
    now += 1_000;
    const expired = await requestJson(runtime, '/api/session', { headers: { cookie } });
    assert.equal(expired.statusCode, 200);
    assert.equal(expired.body.authenticated, false);
    assert.match(firstSetCookie(expired.headers), /Max-Age=0/u);
  } finally {
    await stopServer(runtime);
  }
});

test('runtime serves only configured tenant-bound discovery resources', async () => {
  const streams = createTestLogger();
  const discoveryContract = createDiscoveryContract({
    tenantId: 'acme',
    domain: 'example.test',
    origin: 'https://example.test',
  });
  const runtime = createRuntimeServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      serviceName: 'gulogulo-test',
      environment: 'test',
      shutdownTimeoutMs: 1_000,
    },
    logger: streams.logger,
    discoveryContract,
    discoveryTenantId: 'acme',
  });
  await startServer(runtime);

  try {
    const caldav = await getResponse(runtime, '/.well-known/caldav');
    assert.equal(caldav.statusCode, 308);
    assert.equal(caldav.headers.location, 'https://example.test/dav/');
    assert.equal(caldav.headers['cache-control'], 'no-store');

    const document = await getResponse(runtime, '/.well-known/gulogulo/discovery.json');
    assert.equal(document.statusCode, 200);
    const parsed = JSON.parse(document.body.toString('utf8'));
    assert.equal(parsed.domain, 'example.test');
    assert.equal(Object.hasOwn(parsed, 'tenantId'), false);
    assert.match(headerString(document.headers, 'content-type'), /^application\/json/);
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
  const address = serverAddress(runtime);
  const closePromise = stopServer(runtime);

  assert.equal(runtime.state.ready, false);
  assert.equal(runtime.state.shuttingDown, true);

  await closePromise;
  assert.equal(runtime.server.listening, false);
  assert.equal(address.port > 0, true);
});
