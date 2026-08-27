// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import net from 'node:net';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const manifest = JSON.parse(await readFile(resolve(root, 'release/lp3-local-mail.json'), 'utf8'));
const postfixHost = process.env.LP3_POSTFIX_HOST || 'lp3-postfix';
const dovecotHost = process.env.LP3_DOVECOT_HOST || 'lp3-dovecot';
const rspamdHost = process.env.LP3_RSPAMD_HOST || 'lp3-rspamd';
const clamavHost = process.env.LP3_CLAMAV_HOST || 'lp3-clamav';
const inboundPort = Number(process.env.LP3_SMTP_INBOUND_PORT || manifest.protocols.smtpInbound.port);
const submissionPort = Number(process.env.LP3_SMTP_SUBMISSION_PORT || manifest.protocols.smtpSubmission.port);
const imapsPort = Number(process.env.LP3_IMAPS_PORT || manifest.protocols.imap.implicitTlsPort);
const lmtpPort = Number(process.env.LP3_LMTP_PORT || 24);
const rspamdPort = Number(process.env.LP3_RSPAMD_PORT || 11333);
const clamavPort = Number(process.env.LP3_CLAMAV_PORT || 3310);
const timeoutMs = Number(process.env.LP3_PROBE_TIMEOUT_MS || 15_000);
const imapUser = process.env.LP3_IMAP_USER || 'alice@gulogulo.test';
const imapPassword = process.env.LP3_IMAP_PASSWORD || 'lp3-synthetic-password';

function fail(message) {
  throw new Error(`LP3 mail proof failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function withTimeout(promise, label, milliseconds = timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function connectSocket(host, port, { secure = false } = {}) {
  return withTimeout(new Promise((resolveSocket, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.createConnection({ host, port });
    const onError = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
    const connected = () => {
        socket.removeListener('error', onError);
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`${host}:${port} timed out`)));
        resolveSocket(socket);
    };
    socket.once(secure ? 'secureConnect' : 'connect', connected);
  }), `connect ${host}:${port}`);
}

function lineReader(socket) {
  let buffer = '';
  const lines = [];
  let pending = null;
  let closed = false;

  function flush() {
    while (pending && lines.length > 0) {
      const { resolve: resolveLine } = pending;
      pending = null;
      resolveLine(lines.shift());
    }
  }

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      lines.push(buffer.slice(0, newline).replace(/\r$/u, ''));
      buffer = buffer.slice(newline + 1);
    }
    flush();
  });
  socket.once('close', () => {
    closed = true;
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(new Error('protocol socket closed before the expected response'));
    }
  });

  return {
    nextLine() {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      if (closed) return Promise.reject(new Error('protocol socket is closed'));
      return withTimeout(new Promise((resolveLine, reject) => {
        pending = { resolve: resolveLine, reject };
      }), 'protocol response');
    },
  };
}

async function readSmtpResponse(reader) {
  const lines = [await reader.nextLine()];
  const code = lines[0].slice(0, 3);
  if (/^\d{3}-/u.test(lines[0])) {
    while (true) {
      const line = await reader.nextLine();
      lines.push(line);
      if (line.startsWith(`${code} `)) break;
    }
  }
  return { code, text: lines.join('\n') };
}

async function smtpCommand(socket, reader, command) {
  socket.write(`${command}\r\n`);
  return readSmtpResponse(reader);
}

function closeSocket(socket) {
  if (!socket.destroyed) socket.end();
}

async function assertDualStack(host, label) {
  const addresses = await lookup(host, { all: true });
  assert(addresses.some(({ family }) => family === 4), `${label} has no IPv4 DNS address`);
  assert(addresses.some(({ family }) => family === 6), `${label} has no IPv6 DNS address`);
}

async function probeSmtpRelayPolicy(port, label) {
  const socket = await connectSocket(postfixHost, port);
  const reader = lineReader(socket);
  const greeting = await readSmtpResponse(reader);
  assert(greeting.code.startsWith('2'), `${label} did not return an SMTP greeting`);
  const ehlo = await smtpCommand(socket, reader, 'EHLO proof.gulogulo.test');
  assert(ehlo.code.startsWith('2'), `${label} did not accept EHLO`);
  const mailFrom = await smtpCommand(socket, reader, 'MAIL FROM:<external@example.net>');
  if (mailFrom.code.startsWith('2')) {
    const relay = await smtpCommand(socket, reader, 'RCPT TO:<outside@example.net>');
    assert(!relay.code.startsWith('2'), `${label} accepted unauthenticated external relay`);
  } else {
    assert(/^[45]/u.test(mailFrom.code), `${label} returned an unsafe MAIL FROM status`);
  }
  await smtpCommand(socket, reader, 'QUIT').catch(() => undefined);
  closeSocket(socket);
}

async function probeInboundRecipients() {
  const socket = await connectSocket(postfixHost, inboundPort);
  const reader = lineReader(socket);
  const greeting = await readSmtpResponse(reader);
  assert(greeting.code.startsWith('2'), 'Postfix inbound SMTP greeting is missing');
  assert((await smtpCommand(socket, reader, 'EHLO proof.gulogulo.test')).code.startsWith('2'), 'Postfix inbound EHLO failed');
  assert((await smtpCommand(socket, reader, 'MAIL FROM:<external@example.net>')).code.startsWith('2'), 'Postfix inbound MAIL FROM failed');
  const alias = await smtpCommand(socket, reader, 'RCPT TO:<sales@gulogulo.test>');
  assert(alias.code.startsWith('2'), 'explicit synthetic alias was not accepted');
  await smtpCommand(socket, reader, 'RSET');
  await smtpCommand(socket, reader, 'MAIL FROM:<external@example.net>');
  const unknown = await smtpCommand(socket, reader, 'RCPT TO:<missing@gulogulo.test>');
  assert(/^[45]/u.test(unknown.code), 'unknown internal recipient was accepted; catch-all may be active');
  await smtpCommand(socket, reader, 'QUIT').catch(() => undefined);
  closeSocket(socket);
}

async function imapCommand(socket, reader, tag, command) {
  socket.write(`${tag} ${command}\r\n`);
  const lines = [];
  while (true) {
    const line = await reader.nextLine();
    lines.push(line);
    if (line.startsWith(`${tag} `)) return lines;
  }
}

function imapCommandSucceeded(lines, tag) {
  return new RegExp(`^${tag} OK\\b`, 'iu').test(lines.at(-1) || '');
}

function imapQuotedString(value) {
  assert(!/[\r\n]/u.test(value), 'IMAP proof credentials contain a line break');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function probeImapIdleReconnect() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const socket = await connectSocket(dovecotHost, imapsPort, { secure: true });
    const reader = lineReader(socket);
    const greeting = await reader.nextLine();
    assert(/^\* OK\b/iu.test(greeting), `Dovecot IMAPS greeting is missing on reconnect ${attempt}`);
    const capabilityTag = `a00${attempt}`;
    const capability = (await imapCommand(socket, reader, capabilityTag, 'CAPABILITY')).join('\n');
    assert(/\bIDLE\b/iu.test(capability), `Dovecot did not advertise IMAP IDLE on reconnect ${attempt}`);
    const loginTag = `l00${attempt}`;
    const login = await imapCommand(socket, reader, loginTag, `LOGIN ${imapQuotedString(imapUser)} ${imapQuotedString(imapPassword)}`);
    assert(imapCommandSucceeded(login, loginTag), `Dovecot IMAP login failed on reconnect ${attempt}`);
    const selectTag = `s00${attempt}`;
    const selected = await imapCommand(socket, reader, selectTag, 'SELECT INBOX');
    assert(imapCommandSucceeded(selected, selectTag), `Dovecot IMAP INBOX select failed on reconnect ${attempt}`);
    socket.write(`b00${attempt} IDLE\r\n`);
    const idle = await reader.nextLine();
    assert(/^\+\s+idling/iu.test(idle), `Dovecot did not enter IMAP IDLE on reconnect ${attempt}`);
    socket.write('DONE\r\n');
    await reader.nextLine();
    socket.write(`c00${attempt} LOGOUT\r\n`);
    await reader.nextLine().catch(() => undefined);
    closeSocket(socket);
  }
}

async function probeLmtp() {
  const socket = await connectSocket(dovecotHost, lmtpPort);
  const reader = lineReader(socket);
  const greeting = await reader.nextLine();
  assert(/^220\b/u.test(greeting), 'Dovecot LMTP did not return a 220 greeting');
  socket.write('LHLO proof.gulogulo.test\r\n');
  const response = await readSmtpResponse(reader);
  assert(response.code.startsWith('2'), 'Dovecot LMTP LHLO failed');
  socket.write('QUIT\r\n');
  closeSocket(socket);
}

async function probeClamav() {
  const socket = await connectSocket(clamavHost, clamavPort);
  socket.write('zPING\0');
  const pong = await withTimeout(new Promise((resolveResponse, reject) => {
    socket.once('data', (chunk) => resolveResponse(chunk.toString('utf8')));
    socket.once('error', reject);
  }), 'ClamAV zPING');
  assert(/PONG/iu.test(pong), 'ClamAV did not return PONG');
  closeSocket(socket);
  const versionSocket = await connectSocket(clamavHost, clamavPort);
  versionSocket.write('VERSIONCOMMAND\0');
  const version = await withTimeout(new Promise((resolveVersion, reject) => {
    versionSocket.once('data', (chunk) => resolveVersion(chunk.toString('utf8')));
    versionSocket.once('error', reject);
  }), 'ClamAV VERSIONCOMMAND');
  assert(/signature=ready/iu.test(version), 'ClamAV did not expose a ready signature database');
  closeSocket(versionSocket);
}

async function probeRspamd() {
  const response = await fetch(`http://${rspamdHost}:${rspamdPort}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  assert(response.status === 200, `Rspamd health returned an unusable status: ${response.status}`);
  const health = await response.json();
  assert(health.signatureStatus === 'ready' && typeof health.signatureGeneration === 'string' && typeof health.signatureDigest === 'string', 'Rspamd did not expose ready signature metadata');
}

async function probeTypedMailContracts() {
  const module = async (name) => import(pathToFileURL(resolve(root, `dist/server/src/mail/${name}.js`)).href);
  const [{ createMailPolicy }, { createRspamdScanner, createClamAvScanner }, { createMailQueue }, { createImapIdleBroker }] = await Promise.all([
    module('mail-policy'),
    module('mail-scanners'),
    module('mail-queue'),
    module('imap-idle'),
  ]);
  const userContext = Object.freeze({ tenantId: 'gulogulo', domain: 'gulogulo.test', actorId: 'alice', role: 'user' });
  const masterContext = Object.freeze({ tenantId: 'gulogulo', domain: 'gulogulo.test', actorId: 'master', role: 'tenant_master' });
  const users = [
    { userId: 'alice', address: 'alice@gulogulo.test' },
    { userId: 'bob', address: 'bob@gulogulo.test' },
  ];
  const aliases = [{ address: 'sales@gulogulo.test', destinations: ['alice', 'bob'] }];
  const policy = createMailPolicy({ tenantId: 'gulogulo', domain: 'gulogulo.test' });
  const resolved = policy.resolveRecipients({ recipients: ['sales@gulogulo.test'], users, aliases });
  assert(resolved.accepted && resolved.resolved.length === 2, 'typed alias resolution contract failed');
  const unknown = policy.resolveRecipients({ recipients: ['missing@gulogulo.test'], users, aliases });
  assert(!unknown.accepted && unknown.rejected[0]?.reason === 'unknown_recipient', 'typed no-catch-all contract failed');
  try {
    policy.authorizeSubmission(userContext, { authenticated: false, authenticatedUserId: 'alice', sender: 'alice@gulogulo.test', recipients: ['outside@example.net'], users, aliases });
    fail('typed policy accepted unauthenticated submission');
  } catch (error) {
    assert(error.code === 'OPEN_RELAY_DISABLED', 'typed open-relay rejection used an unexpected code');
  }
  try {
    policy.validateSieve('redirect "outside@example.net";');
    fail('typed Sieve policy accepted redirect');
  } catch (error) {
    assert(error.code === 'FORWARDING_DISABLED', 'typed forwarding rejection used an unexpected code');
  }
  const rspamdUnavailable = await createRspamdScanner().scan({});
  const clamavUnavailable = await createClamAvScanner().scan({});
  assert(rspamdUnavailable.action === 'unavailable', 'Rspamd unavailable state was not explicit');
  assert(clamavUnavailable.status === 'unavailable', 'ClamAV unavailable state was not explicit');
  const queue = createMailQueue({ maxAttempts: manifest.policy.maxQueueAttempts, retryBaseMs: 1_000 });
  const queued = queue.enqueue(userContext, { sender: 'alice@gulogulo.test', recipients: ['bob@gulogulo.test'], sizeBytes: 42, messageRef: 'opaque' });
  for (let attempt = 0; attempt < manifest.policy.maxQueueAttempts; attempt += 1) {
    queue.claim(queued.queueId, masterContext);
    queue.defer(queued.queueId, masterContext, { reason: 'lmtp_temporary_failure' });
  }
  const queueView = queue.view(masterContext);
  assert(queueView[0]?.state === 'bounced' && !Object.hasOwn(queueView[0], 'messageRef'), 'typed retry/bounce or metadata-only queue contract failed');
  const idle = createImapIdleBroker({ clock: () => new Date('2026-08-24T00:00:00.000Z') });
  const events = [];
  const subscription = idle.subscribe(userContext, { userId: 'alice', mailbox: 'INBOX', onEvent: (event) => events.push(event) });
  idle.notify(masterContext, { userId: 'alice', mailbox: 'INBOX', uidNext: 2 });
  subscription.close();
  assert(events[0]?.eventId === 'idle-event-00000001' && events[0]?.sequence === 1, 'typed IMAP IDLE event contract failed');
}

for (const host of [
  [postfixHost, 'Postfix'],
  [dovecotHost, 'Dovecot'],
  [rspamdHost, 'Rspamd'],
  [clamavHost, 'ClamAV'],
]) await assertDualStack(host[0], host[1]);

await probeSmtpRelayPolicy(inboundPort, 'inbound SMTP');
await probeSmtpRelayPolicy(submissionPort, 'submission SMTP');
await probeInboundRecipients();
await probeImapIdleReconnect();
await probeLmtp();
await probeRspamd();
await probeClamav();
await probeTypedMailContracts();

console.log(JSON.stringify({
  milestone: manifest.milestone,
  proofType: manifest.proofType,
  services: {
    postfix: { host: postfixHost, inboundPort, submissionPort, relayDenied: true, aliasAccepted: true, unknownRecipientRejected: true },
    dovecot: { host: dovecotHost, imapsPort, imapIdle: true, reconnects: 2, lmtpPort },
    rspamd: { host: rspamdHost, port: rspamdPort, reachable: true, failureMode: manifest.policy.scanFailureMode },
    clamav: { host: clamavHost, port: clamavPort, ping: 'PONG', failureMode: manifest.policy.scanFailureMode },
  },
  queue: { retry: manifest.policy.queueRetry, maxAttempts: manifest.policy.maxQueueAttempts, terminalFailure: 'bounced', view: manifest.policy.queueView },
  policy: { catchAll: manifest.policy.catchAll, automaticForwarding: manifest.policy.automaticForwarding, trashRetentionDays: manifest.policy.trashRetentionDays },
  network: { internal: manifest.internalNetwork, ipFamilies: manifest.ipFamilies, externalDelivery: manifest.externalDeliveryEnabled },
  status: 'pass',
}, null, 2));
