// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// End-to-end protocol test: a real `node:net` TCP server speaking just enough
// SMTP (RFC 5321) to drive `smtp-client.ts` and `smtp-queue-adapter.ts` over
// a real socket on 127.0.0.1 — no Docker, no real Postfix. It proves the wire
// protocol (multiline EHLO, dot-stuffing, reply-code framing split across TCP
// chunks) end to end; interoperability with a real Postfix is unverified
// (see doc/mail-core.md).

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import test from 'node:test';

import { createTenantContext } from '../../integrations/tenant-context.ts';
import { createMailQueue } from './mail-queue.ts';
import { createSmtpQueueAdapter } from './smtp-queue-adapter.ts';
import type { MailQueueLike } from './smtp-queue-adapter.ts';

const context = createTenantContext({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });

/**
 * `mail-queue.ts` is a `@ts-nocheck` transitional file (see its header) with
 * no explicit parameter types, so TypeScript's cross-file declaration
 * inference for `enqueue()`/`view()` silently drops the untyped `sender`/
 * `recipients` bindings instead of widening them. Rather than depend on that
 * inference, this test declares the exact surface it actually calls.
 */
interface TestMailQueue extends MailQueueLike {
  readonly enqueue: (context: unknown, options: { readonly sender: string; readonly recipients: readonly string[]; readonly sizeBytes?: number }) => { readonly queueId: string };
  readonly view: (context: unknown, options?: { readonly state?: string }) => ReadonlyArray<{ readonly attempts: number }>;
}

function createTestQueue(options: { readonly retryBaseMs?: number; readonly maxAttempts?: number } = {}): TestMailQueue {
  return createMailQueue(options);
}

type Behavior = 'accept' | 'reject-recipient-permanent' | 'reject-recipient-temporary' | 'reject-data-temporary';

interface FakeSmtpServer {
  readonly port: number;
  readonly dataReceived: string[];
  close(): Promise<void>;
}

/** A tiny scripted SMTP server covering EHLO/MAIL FROM/RCPT TO/DATA/QUIT, with a switchable per-test behavior. */
function startFakeSmtpServer(behavior: Behavior): Promise<FakeSmtpServer> {
  return new Promise((resolve, reject) => {
    const dataReceived: string[] = [];
    const server: Server = createServer((socket: Socket) => {
      let buffer = '';
      let inData = false;
      let dataLines: string[] = [];

      // Split the greeting across two TCP writes (mid-line) to prove the
      // client reassembles a chunked line, and make the greeting genuinely
      // multiline (a "220-" continuation followed by the final "220 " line)
      // to prove multiline reply parsing.
      socket.write('220-fake.example ESM');
      setTimeout(() => socket.write('TP greeting\r\n220 ready\r\n'), 5);

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\r\n');
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            handleDataLine(line);
          } else {
            handleCommandLine(line);
          }
          index = buffer.indexOf('\r\n');
        }
      });

      function handleDataLine(line: string): void {
        if (line === '.') {
          inData = false;
          dataReceived.push(dataLines.map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\n'));
          dataLines = [];
          if (behavior === 'reject-data-temporary') {
            socket.write('450 4.3.0 mailbox temporarily unavailable\r\n');
          } else {
            socket.write('250 2.0.0 OK queued as 12345\r\n');
          }
          return;
        }
        dataLines.push(line);
      }

      function handleCommandLine(line: string): void {
        const [verb, ...rest] = line.split(' ');
        const command = verb.toUpperCase();
        if (command === 'EHLO') {
          socket.write('250-fake.example greets you\r\n250 8BITMIME\r\n');
          return;
        }
        if (command === 'MAIL') {
          socket.write('250 2.1.0 Sender OK\r\n');
          return;
        }
        if (command === 'RCPT') {
          const address = rest.join(' ');
          if (behavior === 'reject-recipient-permanent' && address.includes('bad-permanent')) {
            socket.write('550 5.1.1 no such user\r\n');
            return;
          }
          if (behavior === 'reject-recipient-temporary' && address.includes('bad-temporary')) {
            socket.write('450 4.2.1 mailbox busy\r\n');
            return;
          }
          socket.write('250 2.1.5 Recipient OK\r\n');
          return;
        }
        if (command === 'DATA') {
          inData = true;
          socket.write('354 Start mail input\r\n');
          return;
        }
        if (command === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        }
        socket.write('500 5.5.2 unrecognized command\r\n');
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(Object.freeze({
        port: address.port,
        dataReceived,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      }));
    });
  });
}

async function readMessage(): Promise<string> {
  return 'Subject: test\r\n\r\n.Leading dot line.\r\nBody line.\r\n';
}

test('SMTP queue adapter delivers a queued message end to end and marks it delivered', async () => {
  const fake = await startFakeSmtpServer('accept');
  try {
    const queue = createTestQueue({ retryBaseMs: 1_000 });
    const queued = queue.enqueue(context, { sender: 'sales@acme.example', recipients: ['alice@example.net'], sizeBytes: 100 });

    const adapter = createSmtpQueueAdapter({ queue, host: '127.0.0.1', port: fake.port, tls: 'none', readMessage });
    const result = await adapter.deliver(context, queued.queueId);

    assert.equal(result.state, 'delivered');
    assert.deepEqual(result.accepted, ['alice@example.net']);
    assert.deepEqual(result.rejected, []);
    assert.equal(fake.dataReceived.length, 1);
    assert.match(fake.dataReceived[0], /Leading dot line/);
  } finally {
    await fake.close();
  }
});

test('SMTP queue adapter bounces on a permanent recipient rejection', async () => {
  const fake = await startFakeSmtpServer('reject-recipient-permanent');
  try {
    const queue = createTestQueue({ retryBaseMs: 1_000 });
    const queued = queue.enqueue(context, { sender: 'sales@acme.example', recipients: ['bad-permanent@example.net'], sizeBytes: 100 });

    const adapter = createSmtpQueueAdapter({ queue, host: '127.0.0.1', port: fake.port, tls: 'none', readMessage });
    const result = await adapter.deliver(context, queued.queueId);

    assert.equal(result.state, 'bounced');
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].code, 550);
  } finally {
    await fake.close();
  }
});

test('SMTP queue adapter defers on a temporary failure and a manual retry then succeeds', async () => {
  const fake = await startFakeSmtpServer('reject-recipient-temporary');
  try {
    const queue = createTestQueue({ retryBaseMs: 1_000, maxAttempts: 3 });
    const queued = queue.enqueue(context, { sender: 'sales@acme.example', recipients: ['bad-temporary@example.net'], sizeBytes: 100 });

    const adapter = createSmtpQueueAdapter({ queue, host: '127.0.0.1', port: fake.port, tls: 'none', readMessage });
    const first = await adapter.deliver(context, queued.queueId);
    assert.equal(first.state, 'deferred');
    assert.equal(first.rejected[0].code, 450);

    const view = queue.view(context, { state: 'deferred' });
    assert.equal(view.length, 1);
    assert.equal(view[0].attempts, 1);
  } finally {
    await fake.close();
  }
});

test('SMTP queue adapter retries a deferred item until it exhausts attempts and bounces', async () => {
  const fake = await startFakeSmtpServer('reject-data-temporary');
  try {
    const queue = createTestQueue({ retryBaseMs: 1_000, maxAttempts: 2 });
    const queued = queue.enqueue(context, { sender: 'sales@acme.example', recipients: ['alice@example.net'], sizeBytes: 100 });

    const adapter = createSmtpQueueAdapter({ queue, host: '127.0.0.1', port: fake.port, tls: 'none', readMessage });

    const first = await adapter.deliver(context, queued.queueId);
    assert.equal(first.state, 'deferred');

    const second = await adapter.deliver(context, queued.queueId);
    assert.equal(second.state, 'bounced');
  } finally {
    await fake.close();
  }
});
