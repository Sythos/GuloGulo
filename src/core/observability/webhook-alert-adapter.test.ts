// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// A real `node:http` fake server test, the same principle already used for
// the IMAP/SMTP protocol fakes (`src/core/mail/imap-idle-adapter.test.ts`,
// `src/core/mail/smtp-queue-adapter.test.ts`): a real HTTP server on
// 127.0.0.1 drives `createWebhookAlertAdapter()` over a real socket, with no
// Docker and no real Slack/Discord/PagerDuty endpoint. This proves the wire
// behavior end to end; it does not prove interoperability with a live
// Slack/Discord/PagerDuty webhook (see doc/observability.md).

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createAlertPolicy } from './alert-policy.ts';
import {
  createDisabledAlertDelivery,
  createWebhookAlertAdapter,
  deliverAlertEvaluation,
} from './webhook-alert-adapter.ts';
import type { AlertDeliveryAdapter, AlertRecord } from './webhook-alert-adapter.ts';

interface CapturedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface FakeWebhookServer {
  readonly port: number;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

type RequestHandler = (request: CapturedRequest, response: ServerResponse) => void;

function startFakeWebhookServer(handler: RequestHandler): Promise<FakeWebhookServer> {
  return new Promise((resolve, reject) => {
    const requests: CapturedRequest[] = [];
    const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const captured: CapturedRequest = {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(captured);
        handler(captured, response);
      });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(Object.freeze({
        port: address.port,
        requests,
        close: () => new Promise<void>((resolveClose) => {
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
      }));
    });
  });
}

function testAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    code: 'queue_depth_critical',
    severity: 'critical',
    source: 'queue',
    subject: 'global',
    observed: 1_200,
    threshold: 1_000,
    message: 'Mail queue depth is critical',
    generated_at: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function respondOk(_request: CapturedRequest, response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"ok":true}');
}

test('delivers a generic-format alert as a single JSON POST with the expected structured fields', async () => {
  const fake = await startFakeWebhookServer(respondOk);
  try {
    const adapter = createWebhookAlertAdapter({ webhookUrl: `http://127.0.0.1:${fake.port}/hooks/secret-token` });
    const result = await adapter.deliver([testAlert()]);

    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 0);
    assert.equal(fake.requests.length, 1);

    const request = fake.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/hooks/secret-token');
    assert.equal(request.headers['content-type'], 'application/json');

    const payload = JSON.parse(request.body);
    assert.equal(payload.event, 'gulogulo.alert');
    assert.equal(payload.code, 'queue_depth_critical');
    assert.equal(payload.severity, 'critical');
    assert.equal(payload.subject, 'global');
    assert.equal(payload.observed, 1_200);
    assert.equal(payload.threshold, 1_000);
    assert.equal(payload.message, 'Mail queue depth is critical');
    assert.equal(payload.generated_at, '2026-08-22T00:00:00.000Z');
    assert.equal(payload.text, undefined);
  } finally {
    await fake.close();
  }
});

test('slack format sends only a text field, discord format sends only a content field', async () => {
  const fake = await startFakeWebhookServer(respondOk);
  try {
    const slackAdapter = createWebhookAlertAdapter({ webhookUrl: `http://127.0.0.1:${fake.port}/slack`, format: 'slack' });
    await slackAdapter.deliver([testAlert({ severity: 'warning', message: 'A dependency is not ready' })]);
    const slackPayload = JSON.parse(fake.requests[0].body);
    assert.deepEqual(Object.keys(slackPayload), ['text']);
    assert.match(slackPayload.text, /WARNING/);
    assert.match(slackPayload.text, /A dependency is not ready/);

    const discordAdapter = createWebhookAlertAdapter({ webhookUrl: `http://127.0.0.1:${fake.port}/discord`, format: 'discord' });
    await discordAdapter.deliver([testAlert()]);
    const discordPayload = JSON.parse(fake.requests[1].body);
    assert.deepEqual(Object.keys(discordPayload), ['content']);
    assert.match(discordPayload.content, /CRITICAL/);
  } finally {
    await fake.close();
  }
});

test('a request that never responds times out, retries the configured number of times, and is reported failed', async () => {
  const fake = await startFakeWebhookServer(() => {
    // Deliberately never respond.
  });
  try {
    const sleeps: number[] = [];
    const adapter = createWebhookAlertAdapter({
      webhookUrl: `http://127.0.0.1:${fake.port}/hook`,
      timeoutMs: 20,
      retryAttempts: 2,
      sleep: async (milliseconds: number) => { sleeps.push(milliseconds); },
    });

    const result = await adapter.deliver([testAlert()]);

    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.errors[0].code, 'TIMEOUT');
    assert.equal(fake.requests.length, 3);
    assert.deepEqual(sleeps, [100, 200]);
  } finally {
    await fake.close();
  }
});

test('a connection failure is classified as a network error, retried, and never leaks the webhook path or token', async () => {
  const fake = await startFakeWebhookServer(respondOk);
  const closedPort = fake.port;
  await fake.close();

  const sleeps: number[] = [];
  const adapter = createWebhookAlertAdapter({
    webhookUrl: `http://127.0.0.1:${closedPort}/hooks/super-secret-token`,
    retryAttempts: 1,
    sleep: async (milliseconds: number) => { sleeps.push(milliseconds); },
  });

  const result = await adapter.deliver([testAlert()]);

  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].code, 'NETWORK_ERROR');
  assert.equal(sleeps.length, 1);
  assert.equal(JSON.stringify(result).includes('super-secret-token'), false);
});

test('a 5xx response is retried and can succeed on a later attempt', async () => {
  let attempts = 0;
  const fake = await startFakeWebhookServer((_request, response) => {
    attempts += 1;
    if (attempts < 2) {
      response.writeHead(503);
      response.end();
      return;
    }
    respondOk(_request, response);
  });
  try {
    const adapter = createWebhookAlertAdapter({
      webhookUrl: `http://127.0.0.1:${fake.port}/hook`,
      retryAttempts: 2,
      sleep: async () => {},
    });

    const result = await adapter.deliver([testAlert()]);

    assert.equal(result.delivered, 1);
    assert.equal(attempts, 2);
  } finally {
    await fake.close();
  }
});

test('a 4xx response is not retried, since a retry cannot fix a client error', async () => {
  let attempts = 0;
  const fake = await startFakeWebhookServer((_request, response) => {
    attempts += 1;
    response.writeHead(400);
    response.end();
  });
  try {
    const adapter = createWebhookAlertAdapter({
      webhookUrl: `http://127.0.0.1:${fake.port}/hook`,
      retryAttempts: 3,
      sleep: async () => { throw new Error('should not sleep/retry on a 4xx'); },
    });

    const result = await adapter.deliver([testAlert()]);

    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.errors[0].code, 'HTTP_ERROR');
    assert.equal(attempts, 1);
  } finally {
    await fake.close();
  }
});

test('deliver() aggregates outcomes across multiple alerts independently', async () => {
  const fake = await startFakeWebhookServer((request, response) => {
    const payload = JSON.parse(request.body);
    if (payload.code === 'fails_always') {
      response.writeHead(400);
      response.end();
      return;
    }
    respondOk(request, response);
  });
  try {
    const adapter = createWebhookAlertAdapter({ webhookUrl: `http://127.0.0.1:${fake.port}/hook`, retryAttempts: 0 });

    const result = await adapter.deliver([
      testAlert({ code: 'queue_depth_critical' }),
      testAlert({ code: 'fails_always' }),
      testAlert({ code: 'certificate_expiry_warning', severity: 'warning' }),
    ]);

    assert.equal(result.delivered, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.errors[0].alertCode, 'fails_always');
  } finally {
    await fake.close();
  }
});

test('an invalid or credential-bearing webhookUrl is rejected at construction', () => {
  assert.throws(() => createWebhookAlertAdapter({ webhookUrl: '' }), /required/);
  assert.throws(() => createWebhookAlertAdapter({ webhookUrl: 'not a url' }), /valid URL/);
  assert.throws(() => createWebhookAlertAdapter({ webhookUrl: 'ftp://example.test/hook' }), /http:\/\/ or https:\/\//);
  assert.throws(() => createWebhookAlertAdapter({ webhookUrl: 'https://user:pass@example.test/hook' }), /credentials/);
});

test('invalid timeoutMs, retryAttempts, or format are rejected at construction', () => {
  const base = { webhookUrl: 'https://example.test/hook' };
  assert.throws(() => createWebhookAlertAdapter({ ...base, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => createWebhookAlertAdapter({ ...base, retryAttempts: -1 }), /retryAttempts/);
  assert.throws(() => createWebhookAlertAdapter({ ...base, format: 'teams' as never }), /format/);
});

test('the disabled adapter never performs I/O', async () => {
  const disabled = createDisabledAlertDelivery();
  assert.equal(disabled.enabled, false);
  const result = await disabled.deliver([testAlert()]);
  assert.deepEqual(result, { delivered: 0, failed: 0, errors: [] });
});

test('deliverAlertEvaluation wires a real alert-policy evaluation to an injected delivery adapter', async () => {
  const delivered: AlertRecord[][] = [];
  const fakeDelivery: AlertDeliveryAdapter = {
    enabled: true,
    deliver: async (alerts) => {
      delivered.push([...alerts]);
      return { delivered: alerts.length, failed: 0, errors: [] };
    },
  };

  const policy = createAlertPolicy({ clock: () => new Date('2026-08-22T00:00:00.000Z') });
  const evaluation = policy.evaluate({ queue: { depth: 2_000 } });

  const result = await deliverAlertEvaluation(evaluation, fakeDelivery);

  assert.equal(result.delivered, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][0].code, 'queue_depth_critical');
  assert.equal(delivered[0][0].severity, 'critical');
});

test('deliverAlertEvaluation is a safe no-op for a clean evaluation or a disabled adapter', async () => {
  const policy = createAlertPolicy();
  const cleanEvaluation = policy.evaluate({});
  const fakeDelivery: AlertDeliveryAdapter = {
    enabled: true,
    deliver: async () => { throw new Error('should not be called for a clean evaluation'); },
  };
  assert.deepEqual(await deliverAlertEvaluation(cleanEvaluation, fakeDelivery), { delivered: 0, failed: 0, errors: [] });

  const dirtyEvaluation = policy.evaluate({ queue: { depth: 2_000 } });
  const disabledResult = await deliverAlertEvaluation(dirtyEvaluation, createDisabledAlertDelivery());
  assert.deepEqual(disabledResult, { delivered: 0, failed: 0, errors: [] });
});
