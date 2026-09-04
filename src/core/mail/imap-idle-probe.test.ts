// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { imapClientError } from './imap-client.ts';
import { probeImapIdleAvailability } from './imap-idle-probe.ts';
import type { ImapClient, ImapIdleSession, ImapMailboxStatus } from './imap-client.ts';

class FakeImapClient implements ImapClient {
  readonly calls: string[] = [];
  readonly behavior: { connectError?: Error; loginError?: Error; selectError?: Error; idleError?: Error };
  idleStopped = false;

  constructor(behavior: { connectError?: Error; loginError?: Error; selectError?: Error; idleError?: Error } = {}) {
    this.behavior = behavior;
  }

  async connect(): Promise<void> { this.calls.push('connect'); if (this.behavior.connectError) throw this.behavior.connectError; }
  async login(username: string): Promise<void> { this.calls.push(`login:${username}`); if (this.behavior.loginError) throw this.behavior.loginError; }
  async select(mailbox: string): Promise<ImapMailboxStatus> { this.calls.push(`select:${mailbox}`); if (this.behavior.selectError) throw this.behavior.selectError; return { exists: 0, uidNext: null }; }
  async idle(): Promise<ImapIdleSession> {
    this.calls.push('idle');
    if (this.behavior.idleError) throw this.behavior.idleError;
    return { stop: async () => { this.idleStopped = true; this.calls.push('idle-stop'); } };
  }
  async logout(): Promise<void> { this.calls.push('logout'); }
  close(): void { this.calls.push('close'); }
}

test('the probe reports availability when IDLE is accepted, and stops/logs out afterwards', async () => {
  let client: FakeImapClient | undefined;
  const available = await probeImapIdleAvailability({
    createImapClient: () => (client = new FakeImapClient()),
    mailAddress: 'alice@example.test',
    password: 'correct-password',
  });
  assert.equal(available, true);
  assert.deepEqual(client?.calls, ['connect', 'login:alice@example.test', 'select:INBOX', 'idle', 'idle-stop', 'logout']);
  assert.equal(client?.idleStopped, true);
});

test('the probe fails closed when the server rejects IDLE', async () => {
  const available = await probeImapIdleAvailability({
    createImapClient: () => new FakeImapClient({ idleError: imapClientError('IDLE was not accepted', 'COMMAND_REJECTED') }),
    mailAddress: 'alice@example.test',
    password: 'correct-password',
  });
  assert.equal(available, false);
});

test('the probe fails closed when LOGIN is rejected', async () => {
  let client: FakeImapClient | undefined;
  const available = await probeImapIdleAvailability({
    createImapClient: () => (client = new FakeImapClient({ loginError: imapClientError('authentication failed', 'AUTHENTICATION_FAILED') })),
    mailAddress: 'alice@example.test',
    password: 'wrong-password',
  });
  assert.equal(available, false);
  assert.deepEqual(client?.calls, ['connect', 'login:alice@example.test', 'logout']);
});

test('the probe fails closed and never calls logout when the connection itself fails', async () => {
  let client: FakeImapClient | undefined;
  const available = await probeImapIdleAvailability({
    createImapClient: () => (client = new FakeImapClient({ connectError: new Error('connection refused') })),
    mailAddress: 'alice@example.test',
    password: 'anything',
  });
  assert.equal(available, false);
  assert.deepEqual(client?.calls, ['connect', 'close']);
});
