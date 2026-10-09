// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { imapClientError } from '../core/mail/imap-client.ts';
import type { ImapClient, ImapFetchedMessage } from '../core/mail/imap-client.ts';
import { SmtpCommandError } from '../core/mail/smtp-client.ts';
import type { SmtpClient, SmtpResponse } from '../core/mail/smtp-client.ts';
import { createLogger } from './logger.js';
import { createRuntimeServer, startServer, stopServer } from './server.js';

type TestRuntime = ReturnType<typeof createRuntimeServer>;
interface JsonResponse { statusCode: number | undefined; headers: IncomingHttpHeaders; body: any }

const PASSWORD = 'test-only-password';
const RAW_MESSAGE = [
  'From: Bob <bob@other.example>',
  'To: alice@acme.example',
  'Subject: =?UTF-8?B?Q2Fmw6k=?=',
  'Date: Tue, 01 Sep 2026 10:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'secret body text',
].join('\r\n');

const ok = (message = 'OK'): SmtpResponse => ({ code: 250, lines: [`250 ${message}`], message });

class FakeImap implements ImapClient {
  static instances: FakeImap[] = [];
  static failConnect = false;
  static message: ImapFetchedMessage | null = { uid: 7, flags: [], raw: RAW_MESSAGE, truncated: false };
  readonly calls: string[] = [];
  constructor() { FakeImap.instances.push(this); }
  async connect(): Promise<void> {
    this.calls.push('connect');
    if (FakeImap.failConnect) throw new Error('connect ECONNREFUSED secret-host');
  }
  async login(username: string, password: string): Promise<void> {
    this.calls.push(`login:${username}`);
    if (password !== PASSWORD) throw imapClientError('authentication failed', 'AUTHENTICATION_FAILED');
  }
  async select(mailbox: string) { this.calls.push(`select:${mailbox}`); return { exists: 1, uidNext: 8 }; }
  async fetchMessage(uid: number): Promise<ImapFetchedMessage | null> { this.calls.push(`fetch:${uid}`); return FakeImap.message; }
  async moveMessage(uid: number, destination: string): Promise<void> { this.calls.push(`move:${uid}:${destination}`); }
  async idle(): Promise<{ stop: () => Promise<void> }> { return { stop: async () => {} }; }
  async logout(): Promise<void> { this.calls.push('logout'); }
  close(): void { this.calls.push('close'); }
}

class FakeSmtp implements SmtpClient {
  static instances: FakeSmtp[] = [];
  static rejectRecipient: string | null = null;
  static failConnect = false;
  readonly calls: string[] = [];
  payload = '';
  constructor() { FakeSmtp.instances.push(this); }
  async connect(): Promise<SmtpResponse> {
    this.calls.push('connect');
    if (FakeSmtp.failConnect) throw new Error('connect ECONNREFUSED');
    return ok();
  }
  async ehlo() { this.calls.push('ehlo'); return { response: ok(), capabilities: ['STARTTLS'] }; }
  async startTls() { this.calls.push('starttls'); return ok(); }
  async authLogin(username: string) { this.calls.push(`auth:${username}`); return ok(); }
  async mailFrom(address: string) { this.calls.push(`from:${address}`); return ok(); }
  async rcptTo(address: string) {
    this.calls.push(`rcpt:${address}`);
    if (address === FakeSmtp.rejectRecipient) throw new SmtpCommandError({ code: 550, lines: ['550 no such user'], message: 'no such user' });
    return ok();
  }
  async data(content: string | Buffer) { this.calls.push('data'); this.payload = String(content); return ok(); }
  async quit() { this.calls.push('quit'); return ok(); }
  close(): void { this.calls.push('close'); }
}

function reset(): void {
  FakeImap.instances = [];
  FakeImap.failConnect = false;
  FakeImap.message = { uid: 7, flags: [], raw: RAW_MESSAGE, truncated: false };
  FakeSmtp.instances = [];
  FakeSmtp.rejectRecipient = null;
  FakeSmtp.failConnect = false;
}

function makeRuntime() {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let logged = '';
  output.on('data', (chunk) => { logged += String(chunk); });
  errorOutput.on('data', (chunk) => { logged += String(chunk); });
  const runtime = createRuntimeServer({
    config: { host: '127.0.0.1', port: 0, serviceName: 'gulogulo-test', environment: 'test', shutdownTimeoutMs: 1_000 },
    logger: createLogger({ output: output as unknown as typeof process.stdout, errorOutput: errorOutput as unknown as typeof process.stderr }),
    authenticateLogin: async ({ email, password }) => {
      if (password !== PASSWORD) return null;
      const [userId, domain] = email.split('@');
      return { tenantId: domain, domain, userId, actorId: userId, role: 'user' };
    },
    mailClients: { createImapClient: () => new FakeImap(), createSmtpClient: () => new FakeSmtp() },
  });
  return { runtime, logs: () => logged };
}

function send(runtime: TestRuntime, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<JsonResponse> {
  const address = runtime.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const handle = request({
      host: address.address, port: address.port, path, method,
      headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: text.length > 0 ? JSON.parse(text) : null }));
    });
    handle.on('error', reject);
    handle.end(payload);
  });
}

async function signIn(runtime: TestRuntime, email: string) {
  const login = await send(runtime, '/api/session/login', { method: 'POST', body: { email, password: PASSWORD, rememberMe: false } });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  assert.ok(Array.isArray(setCookie));
  return { cookie: setCookie[0].split(';', 1)[0], csrf: login.body.csrfToken as string };
}

test('message detail opens a real message as the session mailbox and keeps content out of logs', async () => {
  reset();
  const { runtime, logs } = makeRuntime();
  await startServer(runtime);
  try {
    assert.equal((await send(runtime, '/api/mail/messages/inbox:7')).statusCode, 401);

    const { cookie } = await signIn(runtime, 'alice@acme.example');
    const detail = await send(runtime, '/api/mail/messages/inbox:7', { headers: { cookie } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.message.subject, 'Café');
    assert.equal(detail.body.message.text, 'secret body text');
    assert.equal(detail.body.message.id, 'inbox:7');
    assert.equal(detail.body.message.unread, true);
    assert.deepEqual(FakeImap.instances[0].calls, ['connect', 'login:alice@acme.example', 'select:INBOX', 'fetch:7', 'logout']);

    assert.equal((await send(runtime, '/api/mail/messages/7', { headers: { cookie } })).statusCode, 200);
    assert.equal((await send(runtime, '/api/mail/messages/..%2Fetc', { headers: { cookie } })).statusCode, 400);
    assert.equal((await send(runtime, '/api/mail/messages/spam:7', { headers: { cookie } })).statusCode, 400);
    assert.equal((await send(runtime, '/api/mail/messages/%E0%A4%A', { headers: { cookie } })).statusCode, 400);
    assert.equal((await send(runtime, '/api/mail/messages/inbox:7', { method: 'DELETE', headers: { cookie } })).statusCode, 405);

    FakeImap.message = null;
    assert.equal((await send(runtime, '/api/mail/messages/inbox:99', { headers: { cookie } })).statusCode, 404);

    FakeImap.failConnect = true;
    const backend = await send(runtime, '/api/mail/messages/inbox:7', { headers: { cookie } });
    assert.equal(backend.statusCode, 502);
    assert.equal(backend.body.error.code, 'MAIL_BACKEND_UNAVAILABLE');
    assert.ok(!JSON.stringify(backend.body).includes('secret-host'));
    assert.ok(!logs().includes(PASSWORD));
    assert.ok(!logs().includes('secret body text'));
  } finally {
    await stopServer(runtime);
  }
});

test('each user only reaches their own mailbox', async () => {
  reset();
  const { runtime } = makeRuntime();
  await startServer(runtime);
  try {
    const alice = await signIn(runtime, 'alice@acme.example');
    const bob = await signIn(runtime, 'bob@acme.example');
    await send(runtime, '/api/mail/messages/inbox:7', { headers: { cookie: alice.cookie } });
    await send(runtime, '/api/mail/messages/inbox:7', { headers: { cookie: bob.cookie } });
    assert.deepEqual(FakeImap.instances.map((client) => client.calls[1]), ['login:alice@acme.example', 'login:bob@acme.example']);

    // A mailbox outside the session's tenant is refused before any connection is opened.
    runtime.sessionMailAddress.set(runtime.webSecurity.authenticate(alice.cookie)!.sessionId, 'alice@other.example');
    FakeImap.instances = [];
    const crossTenant = await send(runtime, '/api/mail/messages/inbox:7', { headers: { cookie: alice.cookie } });
    assert.equal(crossTenant.statusCode, 403);
    assert.equal(FakeImap.instances.length, 0);

    // The session's mailbox password is gone after logout, so a replayed cookie cannot read mail.
    await send(runtime, '/api/session/logout', { method: 'POST', headers: { cookie: bob.cookie, 'x-csrf-token': bob.csrf } });
    assert.equal((await send(runtime, '/api/mail/messages/inbox:7', { headers: { cookie: bob.cookie } })).statusCode, 401);
  } finally {
    await stopServer(runtime);
  }
});

test('send submits as the session mailbox, requires CSRF and validates input', async () => {
  reset();
  const { runtime, logs } = makeRuntime();
  await startServer(runtime);
  try {
    const { cookie, csrf } = await signIn(runtime, 'alice@acme.example');
    const body = { to: 'Bob <bob@other.example>, carol@acme.example', subject: 'Hi', text: 'private text' };

    assert.equal((await send(runtime, '/api/mail/send', { method: 'POST', body })).statusCode, 401);
    assert.equal((await send(runtime, '/api/mail/send', { method: 'GET', headers: { cookie } })).statusCode, 405);
    const noCsrf = await send(runtime, '/api/mail/send', { method: 'POST', headers: { cookie }, body });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(FakeSmtp.instances.length, 0);

    const sent = await send(runtime, '/api/mail/send', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: { ...body, from: 'ceo@acme.example' } });
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.body.recipients, 2);
    assert.match(sent.body.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
    const smtp = FakeSmtp.instances[0];
    assert.deepEqual(smtp.calls, ['connect', 'ehlo', 'starttls', 'ehlo', 'auth:alice@acme.example', 'from:alice@acme.example', 'rcpt:bob@other.example', 'rcpt:carol@acme.example', 'data', 'quit']);
    assert.match(smtp.payload, /^From: <alice@acme\.example>/u);
    assert.ok(!smtp.payload.includes('ceo@acme.example'));

    // The used token is spent; the one from the answer is the next valid one, and failed changes leave it usable.
    const replay = await send(runtime, '/api/mail/send', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body });
    assert.equal(replay.statusCode, 403);
    const token = sent.body.csrfToken as string;

    for (const [invalid, status, code] of [
      [{ ...body, to: 'not-an-address' }, 400, 'INVALID_INPUT'],
      [{ ...body, to: '' }, 400, 'INVALID_INPUT'],
      [{ ...body, subject: 'a\r\nBcc: x@y.example' }, 400, 'INVALID_INPUT'],
      [{ ...body, attachments: [{ name: 'a.txt' }] }, 400, 'ATTACHMENTS_NOT_SUPPORTED'],
      [{ ...body, to: Array.from({ length: 51 }, (_unused, index) => `u${index}@x.example`) }, 400, 'TOO_MANY_RECIPIENTS'],
      [{ ...body, text: 'x'.repeat(256 * 1024 + 1) }, 413, 'MESSAGE_TOO_LARGE'],
    ] as const) {
      const response = await send(runtime, '/api/mail/send', { method: 'POST', headers: { cookie, 'x-csrf-token': token }, body: invalid });
      assert.equal(response.statusCode, status);
      assert.equal(response.body.error.code, code);
      assert.equal(response.body.csrfToken, undefined);
    }
    assert.equal(FakeSmtp.instances.length, 1);

    FakeSmtp.rejectRecipient = 'bob@other.example';
    const rejected = await send(runtime, '/api/mail/send', { method: 'POST', headers: { cookie, 'x-csrf-token': token }, body });
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.body.error.code, 'MESSAGE_REJECTED');

    FakeSmtp.failConnect = true;
    const backend = await send(runtime, '/api/mail/send', { method: 'POST', headers: { cookie, 'x-csrf-token': token }, body });
    assert.equal(backend.statusCode, 502);
    assert.equal(backend.body.error.code, 'MAIL_BACKEND_UNAVAILABLE');
    assert.ok(!logs().includes(PASSWORD));
    assert.ok(!logs().includes('private text'));
  } finally {
    await stopServer(runtime);
  }
});

test('archive moves the message, requires CSRF and reports backend failure safely', async () => {
  reset();
  const { runtime, logs } = makeRuntime();
  await startServer(runtime);
  try {
    const { cookie, csrf } = await signIn(runtime, 'alice@acme.example');

    assert.equal((await send(runtime, '/api/mail/messages/inbox:7/archive', { method: 'POST', body: {} })).statusCode, 401);
    assert.equal((await send(runtime, '/api/mail/messages/inbox:7/archive', { method: 'GET', headers: { cookie } })).statusCode, 405);
    const noCsrf = await send(runtime, '/api/mail/messages/inbox:7/archive', { method: 'POST', headers: { cookie }, body: {} });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(FakeImap.instances.length, 0);

    const archived = await send(runtime, '/api/mail/messages/inbox:7/archive', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: {} });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.body.archived, true);
    assert.deepEqual(FakeImap.instances[0].calls, ['connect', 'login:alice@acme.example', 'select:INBOX', 'move:7:Archive', 'logout']);
    const token = archived.body.csrfToken as string;

    const invalid = await send(runtime, '/api/mail/messages/nope/archive', { method: 'POST', headers: { cookie, 'x-csrf-token': token }, body: {} });
    assert.equal(invalid.statusCode, 400);

    const again = await send(runtime, '/api/mail/messages/archive:7/archive', { method: 'POST', headers: { cookie, 'x-csrf-token': token }, body: {} });
    assert.equal(again.statusCode, 409);

    FakeImap.failConnect = true;
    const backend = await send(runtime, '/api/mail/messages/inbox:7/archive', { method: 'POST', headers: { cookie, 'x-csrf-token': token }, body: {} });
    assert.equal(backend.statusCode, 502);
    assert.equal(backend.body.error.code, 'MAIL_BACKEND_UNAVAILABLE');
    assert.ok(!logs().includes(PASSWORD));
  } finally {
    await stopServer(runtime);
  }
});
