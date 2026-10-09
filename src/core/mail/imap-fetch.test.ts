// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createImapClient } from './imap-client.ts';

// A tiny scripted IMAP server: the client under test talks to a real socket,
// the server answers LOGIN/SELECT/FETCH/LOGOUT from fixed synthetic data.
async function withImapServer(fetchResponse: readonly string[], run: (port: number, commands: string[]) => Promise<void>): Promise<void> {
  const commands: string[] = [];
  const server = createServer((socket) => {
    socket.write('* OK ready\r\n');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index = buffered.indexOf('\r\n');
      while (index !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        index = buffered.indexOf('\r\n');
        const [tag, verb = ''] = line.split(' ');
        commands.push(line);
        if (verb === 'LOGIN') socket.write(`${tag} OK logged in\r\n`);
        else if (verb === 'SELECT') socket.write(`* 2 EXISTS\r\n* OK [UIDNEXT 9] next\r\n${tag} OK selected\r\n`);
        else if (verb === 'FETCH') socket.write(`${fetchResponse.join('\r\n')}\r\n${tag} OK done\r\n`);
        else if (verb === 'LOGOUT') { socket.write(`* BYE\r\n${tag} OK bye\r\n`); socket.end(); }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port, commands);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('fetchSummaries parses envelopes, flags, literals and encoded words, newest first', async () => {
  const literalSubject = 'Plan: {draft}';
  await withImapServer([
    '* 1 FETCH (UID 4 FLAGS (\\Seen) INTERNALDATE "01-Sep-2026 10:00:00 +0000" ENVELOPE ("Tue, 1 Sep 2026 10:00:00 +0000" "=?utf-8?B?Q2Fmw6k=?=" (("Alice" NIL "alice" "acme.example")) NIL NIL (("Bob \\"B\\"" NIL "bob" "acme.example")(NIL NIL "carol" "acme.example")) NIL NIL NIL "<m1@acme.example>"))',
    `* 2 FETCH (UID 8 FLAGS () INTERNALDATE "02-Sep-2026 11:00:00 +0000" ENVELOPE (NIL {${literalSubject.length}}`,
    `${literalSubject} ((NIL NIL "dave" "acme.example")) NIL NIL NIL NIL NIL NIL NIL))`,
  ], async (port, commands) => {
    const client = createImapClient({ host: '127.0.0.1', port, tls: false });
    await client.connect();
    await client.login('alice@acme.example', 'synthetic-password');
    const status = await client.select('INBOX');
    const summaries = await client.fetchSummaries(1, status.exists);
    await client.logout();

    assert.ok(commands.some((line) => /FETCH 1:2 \(UID FLAGS INTERNALDATE ENVELOPE\)$/u.test(line)));
    assert.equal(summaries.length, 2);
    assert.deepEqual(summaries.map((summary) => summary.uid), [8, 4]);
    assert.equal(summaries[0].subject, literalSubject);
    assert.equal(summaries[0].from, 'dave@acme.example');
    assert.equal(summaries[0].date, null);
    assert.equal(summaries[0].internalDate, '2026-09-02T11:00:00.000Z');
    assert.deepEqual(summaries[0].flags, []);
    assert.equal(summaries[1].subject, 'Café');
    assert.equal(summaries[1].from, 'Alice <alice@acme.example>');
    assert.equal(summaries[1].to, 'Bob "B" <bob@acme.example>, carol@acme.example');
    assert.equal(summaries[1].date, '2026-09-01T10:00:00.000Z');
    assert.deepEqual(summaries[1].flags, ['\\Seen']);
    assert.equal(summaries[1].messageId, '<m1@acme.example>');
  });
});

test('fetchSummaries rejects an invalid range and surfaces a rejected FETCH', async () => {
  await withImapServer([], async (port) => {
    const client = createImapClient({ host: '127.0.0.1', port, tls: false });
    await client.connect();
    await assert.rejects(() => client.fetchSummaries(0, 5), { code: 'INVALID_INPUT' });
    await assert.rejects(() => client.fetchSummaries(5, 1), { code: 'INVALID_INPUT' });
    client.close();
  });
});
