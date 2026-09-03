// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPleskApiClient } from './plesk-api-client.ts';

interface FakeCall {
  readonly url: URL;
  readonly init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string; readonly signal?: AbortSignal };
}

function fakeFetch(handler: (call: FakeCall) => { status: number; body: string } | 'abort' | 'network-error'): typeof fetch {
  return async (input: unknown, init?: unknown) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const outcome = handler({ url, init: (init ?? {}) });
    if (outcome === 'network-error') {
      throw new Error('connection refused');
    }
    if (outcome === 'abort') {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      text: async () => outcome.body,
    } as unknown as Response;
  };
}

test('request builds the expected URL, auth header, and body, then parses JSON', async () => {
  let seen: FakeCall | undefined;
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    fetchImpl: fakeFetch((call) => {
      seen = call;
      return { status: 200, body: JSON.stringify([{ id: 1, name: 'example.test' }]) };
    }),
  });

  const result = await client.request('GET', '/api/v2/domains');

  assert.deepEqual(result, [{ id: 1, name: 'example.test' }]);
  assert.ok(seen);
  assert.equal(seen?.url.pathname, '/api/v2/domains');
  assert.equal(seen?.init.method, 'GET');
  assert.equal(seen?.init.headers?.['X-API-Key'], 'super-secret-key');
});

test('a POST request serializes the body as JSON with a Content-Type header', async () => {
  let seen: FakeCall | undefined;
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    fetchImpl: fakeFetch((call) => {
      seen = call;
      return { status: 201, body: JSON.stringify({ id: 42 }) };
    }),
  });

  const result = await client.request('POST', '/api/v2/domains', { name: 'example.test' });

  assert.deepEqual(result, { id: 42 });
  assert.equal(seen?.init.method, 'POST');
  assert.equal(seen?.init.headers?.['Content-Type'], 'application/json');
  assert.equal(seen?.init.body, JSON.stringify({ name: 'example.test' }));
});

test('an empty response body resolves to null instead of throwing', async () => {
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    fetchImpl: fakeFetch(() => ({ status: 204, body: '' })),
  });

  const result = await client.request('DELETE', '/api/v2/domains/1');
  assert.equal(result, null);
});

test('a non-2xx response is rejected and never echoes the API key', async () => {
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    fetchImpl: fakeFetch(() => ({ status: 401, body: 'unauthorized' })),
  });

  await assert.rejects(client.request('GET', '/api/v2/domains'), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /super-secret-key/);
    return true;
  });
});

test('a malformed JSON body is rejected', async () => {
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    fetchImpl: fakeFetch(() => ({ status: 200, body: 'not json' })),
  });

  await assert.rejects(client.request('GET', '/api/v2/domains'), /not valid JSON/);
});

test('an aborted request is surfaced as a timeout, not a generic failure', async () => {
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    timeoutMs: 10,
    fetchImpl: fakeFetch(() => 'abort'),
  });

  await assert.rejects(client.request('GET', '/api/v2/domains'), /timed out/);
});

test('a network failure is rejected without leaking the API key', async () => {
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    fetchImpl: fakeFetch(() => 'network-error'),
  });

  await assert.rejects(client.request('GET', '/api/v2/domains'), (error: Error) => {
    assert.doesNotMatch(error.message, /super-secret-key/);
    return true;
  });
});

test('an insecure or malformed baseUrl is rejected at construction', () => {
  assert.throws(() => createPleskApiClient({ baseUrl: 'http://127.0.0.1:8443', apiKey: 'key' }), /HTTPS/);
  assert.throws(() => createPleskApiClient({ baseUrl: 'not-a-url', apiKey: 'key' }), /valid URL/);
});

test('a missing apiKey is rejected at construction', () => {
  assert.throws(() => createPleskApiClient({ baseUrl: 'https://127.0.0.1:8443', apiKey: '' }), /apiKey/);
});

test('an invalid method or path is rejected before any network call', async () => {
  const client = createPleskApiClient({
    baseUrl: 'https://127.0.0.1:8443',
    apiKey: 'super-secret-key',
    fetchImpl: fakeFetch(() => { throw new Error('should not be called'); }),
  });

  await assert.rejects(client.request('TRACE', '/api/v2/domains'), /method is invalid/);
  await assert.rejects(client.request('GET', '/not-the-api'), /path is invalid/);
});
