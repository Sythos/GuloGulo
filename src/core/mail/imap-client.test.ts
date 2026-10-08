// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import test from 'node:test';

import { createImapClient } from './imap-client.ts';

const MESSAGE = 'Subject: Hi\r\n\r\nline one\r\n\r\nüber\r\n';

async function withServer(handler: (line: string, write: (text: string) => void) => void, run: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer((socket) => {
    socket.write('* OK ready\r\n');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let index = pending.indexOf('\r\n');
      while (index !== -1) {
        handler(pending.slice(0, index), (text) => socket.write(text));
        pending = pending.slice(index + 2);
        index = pending.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

test('fetchMessage reads a literal that contains blank lines and multibyte text, plus flags', async () => {
  const seen: string[] = [];
  await withServer((line, write) => {
    seen.push(line);
    const [tag, ...rest] = line.split(' ');
    if (rest[1] === 'FETCH' && rest[2] === '7') {
      write(`* 1 FETCH (UID 7 FLAGS (\\Seen \\Answered) BODY[]<0> {${Buffer.byteLength(MESSAGE)}}\r\n${MESSAGE})\r\n${tag} OK done\r\n`);
    } else if (rest[0] === 'SELECT') {
      write(`* 1 EXISTS\r\n${tag} OK done\r\n`);
    } else {
      write(`${tag} OK done\r\n`);
    }
  }, async (port) => {
    const client = createImapClient({ host: '127.0.0.1', port, tls: false });
    await client.connect();
    await client.login('a@x.example', 'pw');
    await client.select('INBOX');
    const fetched = await client.fetchMessage(7, 1024);
    assert.equal(fetched?.raw, MESSAGE);
    assert.deepEqual(fetched?.flags, ['\\Seen', '\\Answered']);
    assert.equal(fetched?.truncated, false);
    assert.equal(await client.fetchMessage(8, 1024), null);
    client.close();
  });
  assert.ok(seen.some((line) => line.includes('UID FETCH 7 (UID FLAGS BODY.PEEK[]<0.1025>)')));
});

test('fetchMessage flags a message longer than the cap as truncated', async () => {
  const long = 'x'.repeat(11);
  await withServer((line, write) => {
    const tag = line.split(' ')[0];
    write(line.includes('FETCH') ? `* 1 FETCH (UID 1 BODY[]<0> {${long.length}}\r\n${long}\r\n)\r\n${tag} OK done\r\n` : `${tag} OK done\r\n`);
  }, async (port) => {
    const client = createImapClient({ host: '127.0.0.1', port, tls: false });
    await client.connect();
    const fetched = await client.fetchMessage(1, 10);
    assert.equal(fetched?.truncated, true);
    assert.equal(fetched?.raw.length, 10);
    client.close();
  });
});

test('moveMessage creates the destination if needed and issues UID MOVE', async () => {
  const seen: string[] = [];
  await withServer((line, write) => {
    seen.push(line.slice(line.indexOf(' ') + 1));
    const tag = line.split(' ')[0];
    write(line.includes('CREATE') ? `${tag} NO [ALREADYEXISTS] exists\r\n` : `${tag} OK done\r\n`);
  }, async (port) => {
    const client = createImapClient({ host: '127.0.0.1', port, tls: false });
    await client.connect();
    await client.moveMessage(7, 'Archive');
    await assert.rejects(client.moveMessage(0, 'Archive'), { code: 'INVALID_INPUT' });
    client.close();
  });
  assert.deepEqual(seen, ['CREATE "Archive"', 'UID MOVE 7 "Archive"']);
});
