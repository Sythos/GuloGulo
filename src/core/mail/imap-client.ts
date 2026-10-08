// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// A deliberately minimal IMAP4rev1 client (RFC 3501) plus the IDLE extension
// (RFC 2177). It implements only what the Dovecot IMAP IDLE adapter needs:
// connect, LOGIN, SELECT, IDLE/DONE, and line-level response parsing. This is
// the layer that opens the real socket; `imap-idle.ts` stays a pure,
// dependency-free event broker and never imports this file directly — only
// `imap-idle-adapter.ts` wires the two together.

import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { ConnectionOptions as TlsConnectionOptions, TLSSocket } from 'node:tls';

type ImapSocket = Socket | TLSSocket;

export interface ImapClientLogger {
  readonly warn?: (event: string, details?: Record<string, unknown>) => void;
}

export interface ImapClientOptions {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS (IMAPS), the only mode this app's `imapsPort` config supports. Defaults to true. */
  readonly tls?: boolean;
  readonly tlsOptions?: TlsConnectionOptions;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** RFC 2177 recommends renewing IDLE before a ~29 minute server timeout. Defaults to 25 minutes; pass 0 to disable. */
  readonly idleRefreshMs?: number;
  readonly logger?: ImapClientLogger;
}

export interface ImapMailboxStatus {
  readonly exists: number;
  readonly uidNext: number | null;
}

export interface ImapIdleEvent {
  readonly kind: 'exists' | 'expunge';
  readonly sequence: number;
}

export type ImapIdleEventHandler = (event: ImapIdleEvent) => void;

export interface ImapIdleSession {
  readonly stop: () => Promise<void>;
}

/** Header-level summary of one message, as returned by `fetchSummaries`. No body is ever fetched. */
export interface ImapMessageSummary {
  readonly uid: number;
  readonly sequence: number;
  readonly flags: readonly string[];
  readonly internalDate: string | null;
  readonly date: string | null;
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly messageId: string | null;
}

export interface ImapClient {
  connect(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  select(mailbox: string): Promise<ImapMailboxStatus>;
  /** FETCH UID/FLAGS/INTERNALDATE/ENVELOPE for the sequence-number range `first`..`last` of the selected mailbox, newest first. */
  fetchSummaries(first: number, last: number): Promise<readonly ImapMessageSummary[]>;
  idle(onEvent: ImapIdleEventHandler): Promise<ImapIdleSession>;
  logout(): Promise<void>;
  close(): void;
}

interface CodedError extends Error {
  readonly code: string;
}

function imapClientError(message: string, code = 'IMAP_CLIENT_ERROR'): CodedError {
  const error = new Error(`IMAP client error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { configurable: true, enumerable: true, value: code, writable: false });
  return error;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_REFRESH_MS = 25 * 60_000;
const CRLF = '\r\n';
const UNSAFE_CONTROL_CHARS = /[\r\n\0]/u;
const EXISTS_OR_EXPUNGE = /^\*\s+(\d+)\s+(EXISTS|EXPUNGE)\b/iu;
const UIDNEXT = /UIDNEXT\s+(\d+)/iu;

function assertSafeAtom(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || UNSAFE_CONTROL_CHARS.test(value)) {
    throw imapClientError(`${name} is invalid`, 'INVALID_INPUT');
  }
  return value;
}

/** IMAP quoted-string syntax (RFC 3501 4.3). Rejects CR/LF/NUL upstream via `assertSafeAtom`. */
function quotedString(value: string): string {
  return `"${value.replace(/[\\"]/gu, (char) => `\\${char}`)}"`;
}

type FetchValue = string | null | FetchValue[];

function charIndexForBytes(text: string, byteCount: number): number {
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    if (bytes >= byteCount) break;
    bytes += Buffer.byteLength(char);
    index += char.length;
  }
  return index;
}

/** Re-joins `{N}` literals (RFC 3501 4.3) that line splitting cut into several untagged lines. */
function mergeLiterals(lines: readonly string[]): string[] {
  const merged: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let current = lines[i];
    let tailStart = 0;
    for (;;) {
      const marker = /\{(\d+)\}$/u.exec(current.slice(tailStart));
      if (marker === null || i + 1 >= lines.length) break;
      const size = Number(marker[1]);
      current += CRLF;
      const literalStart = current.length;
      let first = true;
      while (i + 1 < lines.length) {
        i += 1;
        current += (first ? '' : CRLF) + lines[i];
        first = false;
        if (Buffer.byteLength(current.slice(literalStart)) >= size) break;
      }
      tailStart = literalStart + charIndexForBytes(current.slice(literalStart), size);
    }
    merged.push(current);
  }
  return merged;
}

/** Parses one merged FETCH response line into nested lists of atoms, strings and NIL (null). */
function parseFetchList(text: string): FetchValue {
  let pos = text.indexOf('(');
  if (pos === -1) throw imapClientError('malformed FETCH response', 'PROTOCOL_ERROR');

  function parseValue(): FetchValue {
    while (text[pos] === ' ') pos += 1;
    const char = text[pos];
    if (char === '(') {
      pos += 1;
      const list: FetchValue[] = [];
      for (;;) {
        while (text[pos] === ' ') pos += 1;
        if (pos >= text.length) throw imapClientError('malformed FETCH response', 'PROTOCOL_ERROR');
        if (text[pos] === ')') { pos += 1; return list; }
        list.push(parseValue());
      }
    }
    if (char === '"') {
      pos += 1;
      let value = '';
      while (pos < text.length && text[pos] !== '"') {
        if (text[pos] === '\\') pos += 1;
        value += text[pos] ?? '';
        pos += 1;
      }
      pos += 1;
      return value;
    }
    if (char === '{') {
      const end = text.indexOf('}', pos);
      const size = Number(text.slice(pos + 1, end));
      const start = end + 1 + CRLF.length;
      const length = charIndexForBytes(text.slice(start), size);
      pos = start + length;
      return text.slice(start, start + length);
    }
    const start = pos;
    while (pos < text.length && text[pos] !== ' ' && text[pos] !== ')' && text[pos] !== '(') pos += 1;
    const atom = text.slice(start, pos);
    if (atom.length === 0) throw imapClientError('malformed FETCH response', 'PROTOCOL_ERROR');
    return atom.toUpperCase() === 'NIL' ? null : atom;
  }

  return parseValue();
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/giu, (word, charset: string, encoding: string, payload: string) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(payload.replace(/_/gu, ' ').replace(/=([0-9a-f]{2})/giu, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return word;
    }
  }).replace(/\s+/gu, ' ').trim();
}

function formatAddresses(value: FetchValue | undefined): string {
  if (!Array.isArray(value)) return '';
  return value.map((entry) => {
    if (!Array.isArray(entry)) return '';
    const [name, , mailbox, host] = entry as Array<string | null>;
    const address = mailbox === null || mailbox === undefined ? '' : `${mailbox}@${host ?? ''}`;
    const display = typeof name === 'string' ? decodeMimeWords(name) : '';
    return display.length > 0 && address.length > 0 ? `${display} <${address}>` : display || address;
  }).filter((entry) => entry.length > 0).join(', ');
}

function isoDate(value: FetchValue | undefined): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseSummary(line: string): ImapMessageSummary | null {
  const sequenceMatch = /^\*\s+(\d+)\s+FETCH\b/iu.exec(line);
  if (sequenceMatch === null) return null;
  const list = parseFetchList(line.slice(sequenceMatch[0].length));
  if (!Array.isArray(list)) return null;
  const items = new Map<string, FetchValue>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = list[i];
    if (typeof key === 'string') items.set(key.toUpperCase(), list[i + 1]);
  }
  const uid = Number(items.get('UID'));
  if (!Number.isSafeInteger(uid)) return null;
  const flags = items.get('FLAGS');
  const envelope = items.get('ENVELOPE');
  const fields = Array.isArray(envelope) ? envelope : [];
  const internal = items.get('INTERNALDATE');
  const subject = fields[1];
  const messageId = fields[9];
  return Object.freeze({
    uid,
    sequence: Number(sequenceMatch[1]),
    flags: Object.freeze(Array.isArray(flags) ? flags.filter((flag): flag is string => typeof flag === 'string') : []),
    internalDate: isoDate(internal),
    date: isoDate(fields[0]),
    subject: typeof subject === 'string' ? decodeMimeWords(subject) : '',
    from: formatAddresses(fields[2]),
    to: formatAddresses(fields[5]),
    messageId: typeof messageId === 'string' ? messageId : null,
  });
}

export function createImapClient(options: ImapClientOptions): ImapClient {
  const host = assertSafeAtom(options.host, 'host');
  const port = options.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw imapClientError('port is invalid', 'INVALID_INPUT');
  }
  const useTls = options.tls ?? true;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const idleRefreshMs = options.idleRefreshMs ?? DEFAULT_IDLE_REFRESH_MS;
  const logger = options.logger ?? {};

  let socket: ImapSocket | null = null;
  let buffer = '';
  let tagSequence = 0;
  let unsolicitedHandler: ((line: string) => boolean) | null = null;
  const pendingLines: string[] = [];
  let lineWaiters: Array<(line: string) => void> = [];

  function nextTag(): string {
    tagSequence += 1;
    return `A${String(tagSequence).padStart(4, '0')}`;
  }

  function dispatchLine(line: string): void {
    if (unsolicitedHandler !== null && unsolicitedHandler(line)) return;
    const waiter = lineWaiters.shift();
    if (waiter !== undefined) {
      waiter(line);
      return;
    }
    pendingLines.push(line);
  }

  function onData(chunk: Buffer): void {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf(CRLF);
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      dispatchLine(line);
      index = buffer.indexOf(CRLF);
    }
  }

  function readLine(): Promise<string> {
    const queued = pendingLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lineWaiters = lineWaiters.filter((waiter) => waiter !== onLine);
        reject(imapClientError('timed out waiting for a server response', 'TIMEOUT'));
      }, commandTimeoutMs);
      function onLine(line: string): void {
        clearTimeout(timer);
        resolve(line);
      }
      lineWaiters.push(onLine);
    });
  }

  function writeLine(line: string): void {
    if (socket === null) throw imapClientError('not connected', 'NOT_CONNECTED');
    socket.write(`${line}${CRLF}`);
  }

  async function command(text: string): Promise<readonly string[]> {
    const tag = nextTag();
    writeLine(`${tag} ${text}`);
    const untagged: string[] = [];
    for (;;) {
      const line = await readLine();
      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1);
        const status = rest.split(' ', 1)[0];
        if (status === 'OK') return untagged;
        throw imapClientError(`command failed: ${rest}`, status === 'NO' ? 'COMMAND_REJECTED' : 'PROTOCOL_ERROR');
      }
      untagged.push(line);
    }
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        s.destroy();
        reject(imapClientError('connection timed out', 'TIMEOUT'));
      }, connectTimeoutMs);

      const s: ImapSocket = useTls
        ? tlsConnect({ host, port, ...options.tlsOptions })
        : netConnect({ host, port });

      s.once('error', (error: Error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      });

      s.once(useTls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        socket = s;
        s.on('data', onData);
        s.on('error', (error: Error) => {
          logger.warn?.('imap_socket_error', { error: { name: error.name } });
        });
        s.on('close', () => {
          socket = null;
        });
        readLine()
          .then((greeting) => {
            if (!/^\*\s+(OK|PREAUTH)\b/iu.test(greeting)) {
              throw imapClientError(`unexpected greeting: ${greeting}`, 'PROTOCOL_ERROR');
            }
            resolve();
          })
          .catch(reject);
      });
    });
  }

  async function login(username: string, password: string): Promise<void> {
    assertSafeAtom(username, 'username');
    if (typeof password !== 'string' || password.length === 0 || UNSAFE_CONTROL_CHARS.test(password)) {
      throw imapClientError('password is invalid', 'INVALID_INPUT');
    }
    try {
      await command(`LOGIN ${quotedString(username)} ${quotedString(password)}`);
    } catch (error) {
      if (error instanceof Error && (error as CodedError).code === 'COMMAND_REJECTED') {
        throw imapClientError('authentication failed', 'AUTHENTICATION_FAILED');
      }
      throw error;
    }
  }

  async function select(mailbox: string): Promise<ImapMailboxStatus> {
    assertSafeAtom(mailbox, 'mailbox');
    const untagged = await command(`SELECT ${quotedString(mailbox)}`);
    let exists = 0;
    let uidNext: number | null = null;
    for (const line of untagged) {
      const existsMatch = EXISTS_OR_EXPUNGE.exec(line);
      if (existsMatch !== null && existsMatch[2].toUpperCase() === 'EXISTS') exists = Number(existsMatch[1]);
      const uidNextMatch = UIDNEXT.exec(line);
      if (uidNextMatch !== null) uidNext = Number(uidNextMatch[1]);
    }
    return Object.freeze({ exists, uidNext });
  }

  async function fetchSummaries(first: number, last: number): Promise<readonly ImapMessageSummary[]> {
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
      throw imapClientError('fetch range is invalid', 'INVALID_INPUT');
    }
    const untagged = await command(`FETCH ${first}:${last} (UID FLAGS INTERNALDATE ENVELOPE)`);
    const summaries: ImapMessageSummary[] = [];
    for (const line of mergeLiterals(untagged)) {
      const summary = parseSummary(line);
      if (summary !== null) summaries.push(summary);
    }
    return Object.freeze(summaries.sort((a, b) => b.sequence - a.sequence));
  }

  async function idle(onEvent: ImapIdleEventHandler): Promise<ImapIdleSession> {
    if (socket === null) throw imapClientError('not connected', 'NOT_CONNECTED');
    let tag = nextTag();
    let phase: 'starting' | 'active' | 'ending' = 'starting';
    let stopped = false;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let refreshing = false;

    function handleUnsolicited(line: string): boolean {
      if (phase === 'starting') return false;
      if (line.startsWith(`${tag} `)) return false;
      const match = EXISTS_OR_EXPUNGE.exec(line);
      if (match !== null) {
        onEvent({ kind: match[2].toUpperCase() === 'EXISTS' ? 'exists' : 'expunge', sequence: Number(match[1]) });
      }
      return true;
    }

    unsolicitedHandler = handleUnsolicited;
    writeLine(`${tag} IDLE`);
    const continuation = await readLine();
    if (!continuation.startsWith('+')) {
      unsolicitedHandler = null;
      throw imapClientError(`IDLE was not accepted: ${continuation}`, 'COMMAND_REJECTED');
    }
    phase = 'active';

    async function refresh(): Promise<void> {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        phase = 'ending';
        writeLine('DONE');
        await readLine();
        tag = nextTag();
        phase = 'starting';
        writeLine(`${tag} IDLE`);
        const cont = await readLine();
        if (!cont.startsWith('+')) throw imapClientError(`IDLE renewal was not accepted: ${cont}`, 'COMMAND_REJECTED');
        phase = 'active';
      } catch (error) {
        logger.warn?.('imap_idle_refresh_failed', { error: { name: error instanceof Error ? error.name : 'Error' } });
      } finally {
        refreshing = false;
      }
    }

    if (idleRefreshMs > 0) {
      refreshTimer = setInterval(() => {
        void refresh();
      }, idleRefreshMs);
      refreshTimer.unref?.();
    }

    async function stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (refreshTimer !== null) clearInterval(refreshTimer);
      phase = 'ending';
      writeLine('DONE');
      await readLine();
      unsolicitedHandler = null;
    }

    return Object.freeze({ stop });
  }

  async function logout(): Promise<void> {
    try {
      await command('LOGOUT');
    } finally {
      close();
    }
  }

  function close(): void {
    unsolicitedHandler = null;
    lineWaiters = [];
    socket?.destroy();
    socket = null;
  }

  return Object.freeze({ connect, login, select, fetchSummaries, idle, logout, close });
}

export { imapClientError };
