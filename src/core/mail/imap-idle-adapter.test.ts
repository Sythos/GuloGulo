// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// End-to-end protocol test: a real `node:net` TCP server speaking just enough
// IMAP4rev1 + IDLE (RFC 3501 / RFC 2177) to drive `imap-client.ts` and
// `imap-idle-adapter.ts` over a real socket on 127.0.0.1, with no Docker and
// no real Dovecot. This proves the wire protocol end to end; it does not
// prove interoperability with a real Dovecot server (see doc/mail-core.md).

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import test from 'node:test';

import { createTenantContext } from '../../integrations/tenant-context.ts';
import { createImapIdleAdapter } from './imap-idle-adapter.ts';
import { createImapIdleBroker } from './imap-idle.ts';

const masterContext = createTenantContext({ tenantId: 'acme', domain: 'acme.example', actorId: 'master', role: 'tenant_master' });

interface FakeImapServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * A tiny scripted IMAP server: greets, accepts LOGIN only for the given
 * credentials, accepts SELECT INBOX, then on IDLE pushes one `EXISTS` event
 * (split across two TCP writes to prove line-framing survives a mid-line
 * chunk boundary) and completes on DONE.
 */
function startFakeImapServer({ username, password }: { readonly username: string; readonly password: string }): Promise<FakeImapServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket: Socket) => {
      let buffer = '';
      let idleTag: string | null = null;

      socket.write('* OK fake IMAP ready\r\n');

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\r\n');
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handleLine(line);
          index = buffer.indexOf('\r\n');
        }
      });

      function handleLine(line: string): void {
        if (idleTag !== null) {
          if (line === 'DONE') {
            const tag = idleTag;
            idleTag = null;
            socket.write(`${tag} OK IDLE terminated\r\n`);
          }
          return;
        }

        const spaceIndex = line.indexOf(' ');
        const tag = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
        const rest = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);
        const command = rest.split(' ')[0]?.toUpperCase() ?? '';

        if (command === 'LOGIN') {
          const ok = rest === `LOGIN "${username}" "${password}"`;
          socket.write(ok ? `${tag} OK LOGIN completed\r\n` : `${tag} NO LOGIN failed\r\n`);
          return;
        }
        if (command === 'SELECT') {
          socket.write('* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDNEXT 12] Predicted\r\n');
          socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
          return;
        }
        if (command === 'IDLE') {
          idleTag = tag;
          socket.write('+ idling\r\n');
          // Split one response across two writes to prove the client
          // reassembles a line that arrives in separate TCP chunks.
          setTimeout(() => {
            socket.write('* 4 EX');
            setTimeout(() => socket.write('ISTS\r\n'), 5);
          }, 10);
          return;
        }
        if (command === 'LOGOUT') {
          socket.write('* BYE logging out\r\n');
          socket.write(`${tag} OK LOGOUT completed\r\n`);
          return;
        }
        socket.write(`${tag} BAD unknown command\r\n`);
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(Object.freeze({
        port: address.port,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      }));
    });
  });
}

test('IMAP IDLE adapter connects, logs in, selects INBOX, and forwards a real EXISTS event into the broker', async () => {
  const fake = await startFakeImapServer({ username: 'alice', password: 'correct-horse' });
  try {
    const broker = createImapIdleBroker();
    const received: unknown[] = [];
    broker.subscribe(masterContext, { userId: 'alice', onEvent: (event) => received.push(event) });

    const adapter = createImapIdleAdapter({ broker, host: '127.0.0.1', port: fake.port, tls: false });
    const watch = await adapter.watch(masterContext, {
      userId: 'alice',
      mailbox: 'INBOX',
      credentials: { username: 'alice', password: 'correct-horse' },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received.length, 1);
    assert.equal((received[0] as { kind: string }).kind, 'exists');

    await watch.stop();
  } finally {
    await fake.close();
  }
});

test('IMAP IDLE adapter surfaces an authentication failure instead of silently connecting', async () => {
  const fake = await startFakeImapServer({ username: 'alice', password: 'correct-horse' });
  try {
    const broker = createImapIdleBroker();
    const adapter = createImapIdleAdapter({ broker, host: '127.0.0.1', port: fake.port, tls: false });

    await assert.rejects(
      adapter.watch(masterContext, { userId: 'alice', mailbox: 'INBOX', credentials: { username: 'alice', password: 'wrong-password' } }),
      (error: unknown) => (error as { code?: string }).code === 'AUTHENTICATION_FAILED',
    );
  } finally {
    await fake.close();
  }
});
