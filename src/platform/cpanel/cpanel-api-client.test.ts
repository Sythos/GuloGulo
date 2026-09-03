// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCpanelApiClient } from './cpanel-api-client.ts';

interface FakeCall {
  readonly url: URL;
  readonly init: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal };
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

test('callUapi builds the expected URL, auth header, and query params, then parses JSON', async () => {
  let seen: FakeCall | undefined;
  const client = createCpanelApiClient({
    baseUrl: 'https://127.0.0.1:2083',
    username: 'jdoe',
    apiToken: 'super-secret-token',
    fetchImpl: fakeFetch((call) => {
      seen = call;
      return { status: 200, body: JSON.stringify({ status: 1, data: [{ email: 'alice@example.test' }] }) };
    }),
  });

  const result = await client.callUapi('Email', 'list_pops', { domain: 'example.test' });

  assert.deepEqual(result, { status: 1, data: [{ email: 'alice@example.test' }] });
  assert.ok(seen);
  assert.equal(seen?.url.pathname, '/execute/Email/list_pops');
  assert.equal(seen?.url.searchParams.get('domain'), 'example.test');
  assert.equal(seen?.init.headers?.Authorization, 'cpanel jdoe:super-secret-token');
});

test('a non-2xx response is rejected and never echoes the API token', async () => {
  const client = createCpanelApiClient({
    baseUrl: 'https://127.0.0.1:2083',
    username: 'jdoe',
    apiToken: 'super-secret-token',
    fetchImpl: fakeFetch(() => ({ status: 401, body: 'unauthorized' })),
  });

  await assert.rejects(client.callUapi('Email', 'list_pops'), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /super-secret-token/);
    return true;
  });
});

test('a malformed JSON body is rejected', async () => {
  const client = createCpanelApiClient({
    baseUrl: 'https://127.0.0.1:2083',
    username: 'jdoe',
    apiToken: 'super-secret-token',
    fetchImpl: fakeFetch(() => ({ status: 200, body: 'not json' })),
  });

  await assert.rejects(client.callUapi('Email', 'list_pops'), /not valid JSON/);
});

test('an aborted request is surfaced as a timeout, not a generic failure', async () => {
  const client = createCpanelApiClient({
    baseUrl: 'https://127.0.0.1:2083',
    username: 'jdoe',
    apiToken: 'super-secret-token',
    timeoutMs: 10,
    fetchImpl: fakeFetch(() => 'abort'),
  });

  await assert.rejects(client.callUapi('Email', 'list_pops'), /timed out/);
});

test('a network failure is rejected without leaking the API token', async () => {
  const client = createCpanelApiClient({
    baseUrl: 'https://127.0.0.1:2083',
    username: 'jdoe',
    apiToken: 'super-secret-token',
    fetchImpl: fakeFetch(() => 'network-error'),
  });

  await assert.rejects(client.callUapi('Email', 'list_pops'), (error: Error) => {
    assert.doesNotMatch(error.message, /super-secret-token/);
    return true;
  });
});

test('an insecure or malformed baseUrl is rejected at construction', () => {
  assert.throws(() => createCpanelApiClient({ baseUrl: 'http://127.0.0.1:2083', username: 'jdoe', apiToken: 'token' }), /HTTPS/);
  assert.throws(() => createCpanelApiClient({ baseUrl: 'not-a-url', username: 'jdoe', apiToken: 'token' }), /valid URL/);
});

test('a missing username or apiToken is rejected at construction', () => {
  assert.throws(() => createCpanelApiClient({ baseUrl: 'https://127.0.0.1:2083', username: '', apiToken: 'token' }), /username/);
  assert.throws(() => createCpanelApiClient({ baseUrl: 'https://127.0.0.1:2083', username: 'jdoe', apiToken: '' }), /apiToken/);
});

test('an invalid module or function name is rejected before any network call', async () => {
  const client = createCpanelApiClient({
    baseUrl: 'https://127.0.0.1:2083',
    username: 'jdoe',
    apiToken: 'super-secret-token',
    fetchImpl: fakeFetch(() => { throw new Error('should not be called'); }),
  });

  await assert.rejects(client.callUapi('bad module', 'list_pops'), /module is invalid/);
  await assert.rejects(client.callUapi('Email', 'bad function!'), /function is invalid/);
});
