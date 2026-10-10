// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createConfiguredAlertDelivery, createLocalMailClients } from './platform-adapter.ts';
import type { IntegrationConfig } from '../../integrations/types.ts';
import type { PlatformAdapter } from './platform-adapter.ts';
import type { AlertRecord } from '../../core/observability/webhook-alert-adapter.ts';
import type { WebSession } from '../../web/security/session-manager.ts';

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

interface FakeWebhookServer {
  readonly url: string;
  readonly bodies: string[];
  close(): Promise<void>;
}

/** A real local HTTP server, same principle as the IMAP/SMTP protocol fakes. */
function startFakeWebhookServer(): Promise<FakeWebhookServer> {
  return new Promise((resolve, reject) => {
    const bodies: string[] = [];
    const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(Object.freeze({
        url: `http://127.0.0.1:${address.port}/hooks/secret-token`,
        bodies,
        close: () => new Promise<void>((resolveClose) => {
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
      }));
    });
  });
}

/**
 * A no-op, in-memory adapter used only to prove at compile time that
 * `PlatformAdapter` is concretely implementable. It carries no behavior
 * worth testing on its own — every future adapter (cPanel, Plesk,
 * standalone) implements the same interface with real bodies instead.
 */
function createNoopPlatformAdapter(): PlatformAdapter {
  return {
    platformKind: 'standalone',
    loadConfig: async () => ({}),
    createIdentityClient: async () => ({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      authenticate: async () => false,
      close: async () => {},
    }),
    createDataStore: async () => ({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      close: async () => {},
    }),
    createDavStore: async () => ({
      caldav: { enabled: false as const, healthCheck: async () => ({ status: 'disabled' as const }), close: async () => {} },
      carddav: { enabled: false as const, healthCheck: async () => ({ status: 'disabled' as const }), close: async () => {} },
    }),
    createSessionStore: async () => new Map<string, WebSession>(),
  };
}

test('a no-op adapter satisfies the PlatformAdapter contract', () => {
  const adapter = createNoopPlatformAdapter();
  assert.equal(adapter.platformKind, 'standalone');
});

test('every contract method resolves for the no-op adapter', async () => {
  const adapter = createNoopPlatformAdapter();
  assert.deepEqual(await adapter.loadConfig(), {});
  assert.equal((await adapter.createIdentityClient({})).enabled, false);
  assert.equal((await adapter.createDataStore({})).enabled, false);
  const davStore = await adapter.createDavStore({});
  assert.equal(davStore.caldav.enabled, false);
  assert.equal(davStore.carddav.enabled, false);
  assert.equal((await adapter.createSessionStore()).size, 0);
});

test('createConfiguredAlertDelivery is disabled by default', async () => {
  const delivery = await createConfiguredAlertDelivery({});
  assert.equal(delivery.enabled, false);
  assert.deepEqual(await delivery.deliver([testAlert()]), { delivered: 0, failed: 0, errors: [] });
});

test('createConfiguredAlertDelivery requires a resolveSecret and a webhookUrlSecretRef when enabled', async () => {
  const config = { alerting: { enabled: true } };
  await assert.rejects(createConfiguredAlertDelivery(config), /webhookUrlSecretRef and a secret resolver are required/);
  await assert.rejects(
    createConfiguredAlertDelivery(config, { resolveSecret: async () => undefined }),
    /webhookUrlSecretRef and a secret resolver are required/,
  );
});

test('createConfiguredAlertDelivery resolves the webhook URL from a secret reference and never exposes it', async () => {
  const config = { alerting: { enabled: true, webhookUrlSecretRef: 'secret/alert-webhook' } };
  let requestedRef: string | undefined;
  const delivery = await createConfiguredAlertDelivery(config, {
    resolveSecret: async (ref) => {
      requestedRef = ref;
      return 'https://127.0.0.1:1/hooks/should-never-connect';
    },
  });
  assert.equal(requestedRef, 'secret/alert-webhook');
  assert.equal(delivery.enabled, true);
});

test('createConfiguredAlertDelivery.minSeverity filters which alerts reach the webhook (paging use case)', async () => {
  const fake = await startFakeWebhookServer();
  try {
    const config = {
      alerting: { enabled: true, webhookUrlSecretRef: 'secret/alert-webhook', minSeverity: 'critical' as const },
    };
    const delivery = await createConfiguredAlertDelivery(config, { resolveSecret: async () => fake.url });

    const result = await delivery.deliver([
      testAlert({ code: 'certificate_expiry_warning', severity: 'warning' }),
      testAlert({ code: 'queue_depth_critical', severity: 'critical' }),
    ]);

    // Only the critical alert reached the webhook — the same generic
    // adapter used purely as a paging channel, per doc/observability.md.
    assert.equal(result.delivered, 1);
    assert.equal(fake.bodies.length, 1);
    assert.equal(JSON.parse(fake.bodies[0]).code, 'queue_depth_critical');
  } finally {
    await fake.close();
  }
});

test('createConfiguredAlertDelivery with the default minSeverity delivers both warning and critical alerts', async () => {
  const fake = await startFakeWebhookServer();
  try {
    const config = { alerting: { enabled: true, webhookUrlSecretRef: 'secret/alert-webhook' } };
    const delivery = await createConfiguredAlertDelivery(config, { resolveSecret: async () => fake.url });

    const result = await delivery.deliver([
      testAlert({ code: 'certificate_expiry_warning', severity: 'warning' }),
      testAlert({ code: 'queue_depth_critical', severity: 'critical' }),
    ]);

    assert.equal(result.delivered, 2);
    assert.equal(fake.bodies.length, 2);
  } finally {
    await fake.close();
  }
});

test('createLocalMailClients uses STARTTLS on the submission port by default', () => {
  const clients = createLocalMailClients({ mail: { smtpSubmissionPort: 2587, smtpImplicitTlsPort: 2465 } } as unknown as IntegrationConfig);
  assert.equal(clients.createSmtpClient().tls, 'starttls');
});

test('createLocalMailClients connects to the implicit-TLS port when mail.smtpSubmissionTls is implicit', async () => {
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const config = { mail: { smtpSubmissionPort: 1, smtpImplicitTlsPort: port, smtpSubmissionTls: 'implicit' } } as unknown as IntegrationConfig;
    const client = createLocalMailClients(config).createSmtpClient();
    assert.equal(client.tls, 'implicit');
    await assert.rejects(client.connect());
    client.close();
    assert.equal(connections, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
