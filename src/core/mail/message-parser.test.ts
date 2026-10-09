// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { composeMessage, MailInputError, validateOutgoing } from './message-composer.ts';
import { parseMessage } from './message-parser.ts';

test('parseMessage decodes headers, quoted-printable text and multipart alternatives with attachments', () => {
  const raw = [
    'From: =?UTF-8?Q?Andr=C3=A9?= <andre@example.test>',
    'To: alice@example.test',
    'Subject: Plan',
    'Date: Tue, 01 Sep 2026 10:00:00 +0200',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'caf=C3=A9 soft=',
    'wrap',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>café</p>',
    '--inner--',
    '--outer',
    'Content-Type: application/pdf; name="r.pdf"',
    'Content-Disposition: attachment; filename="r.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'QUJD',
    '--outer--',
    '',
  ].join('\r\n');
  const parsed = parseMessage(raw);
  assert.equal(parsed.from, 'André <andre@example.test>');
  assert.equal(parsed.date, '2026-09-01T08:00:00.000Z');
  assert.equal(parsed.text, 'café softwrap');
  assert.equal(parsed.html, '<p>café</p>');
  assert.deepEqual(parsed.attachments, [{ name: 'r.pdf', contentType: 'application/pdf', size: 3 }]);
});

test('parseMessage tolerates malformed input', () => {
  const parsed = parseMessage('not a message');
  assert.equal(parsed.subject, '');
  assert.equal(parsed.text, '');
  assert.equal(parseMessage('Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\n').attachments.length, 0);
});

test('validateOutgoing accepts lists and display names and rejects unsafe input', () => {
  const input = validateOutgoing({ to: ['A <a@x.example>', 'b@x.example', 'a@x.example'], subject: 'S', text: 't' });
  assert.deepEqual(input.recipients, ['a@x.example', 'b@x.example']);
  for (const bad of [
    { to: 'a@x.example\r\nBcc: b@x.example', subject: 's', text: 't' },
    { to: 'a@x.example', subject: 's\n', text: 't' },
    { to: 'a@x.example', subject: 's', text: 7 },
    { to: 'a@localhost', subject: 's', text: 't' },
    { to: 'a@x.example', text: 't', attachments: ['x'] },
  ]) {
    assert.throws(() => validateOutgoing(bad), MailInputError);
  }
});

test('composeMessage uses the authenticated sender and round-trips through the parser', () => {
  const input = validateOutgoing({ to: 'bob@y.example', subject: 'Grüße', text: 'line one\n.dot line' });
  const raw = composeMessage({ from: 'alice@x.example', input, now: new Date('2026-09-01T10:00:00Z') });
  assert.match(raw, /^From: <alice@x\.example>\r\n/u);
  assert.match(raw, /\r\nDate: Tue, 01 Sep 2026 10:00:00 \+0000\r\n/u);
  const parsed = parseMessage(raw);
  assert.equal(parsed.subject, 'Grüße');
  assert.equal(parsed.text, 'line one\r\n.dot line');
});
