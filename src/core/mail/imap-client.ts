// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// A deliberately minimal IMAP4rev1 client (RFC 3501) plus the IDLE extension
// (RFC 2177). It implements only what the Dovecot IMAP IDLE adapter needs:
// connect, LOGIN, SELECT, IDLE/DONE, and line-level response parsing. This is
// the layer that opens the real socket; `imap-idle.ts` stays a pure,
// dependency-free event broker and never imports this file directly — only
// `imap-idle-adapter.ts` wires the two together.

import { StringDecoder } from 'node:string_decoder';
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

export interface ImapFetchedMessage {
  readonly uid: number;
  readonly flags: readonly string[];
  /** The raw RFC 5322 message, at most `maxBytes` of it. */
  readonly raw: string;
  /** True when the server holds more than `maxBytes` and `raw` was cut short. */
  readonly truncated: boolean;
}

export interface ImapClient {
  connect(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  select(mailbox: string): Promise<ImapMailboxStatus>;
  /** `UID FETCH` of one message from the selected mailbox without setting `\Seen`; resolves to null when the UID does not exist. */
  fetchMessage(uid: number, maxBytes: number): Promise<ImapFetchedMessage | null>;
  /** `UID MOVE` (RFC 6851) of one message from the selected mailbox, creating `destination` first when it does not exist yet. */
  moveMessage(uid: number, destination: string): Promise<void>;
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
const LITERAL_SUFFIX = /\{(\d+)\}$/u;
const FETCH_FLAGS = /FLAGS\s+\(([^)]*)\)/iu;
const MAX_LITERAL_BYTES = 8 * 1024 * 1024;

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
  const decoder = new StringDecoder('utf8');
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
    buffer += decoder.write(chunk);
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

  /**
   * Reads one `{N}` literal that follows `line` and returns the literal plus
   * the remainder of the response line that comes after it. The line-based
   * reader has already split the literal at its own CRLFs, so they are put
   * back until N bytes are collected.
   */
  async function readLiteral(size: number): Promise<{ literal: string; tail: string }> {
    if (size > MAX_LITERAL_BYTES) throw imapClientError('server literal is too large', 'PROTOCOL_ERROR');
    let collected = '';
    while (Buffer.byteLength(collected, 'utf8') < size) {
      collected += `${await readLine()}${CRLF}`;
    }
    const bytes = Buffer.from(collected, 'utf8');
    const literal = bytes.subarray(0, size).toString('utf8');
    const rest = bytes.subarray(size).toString('utf8');
    const tail = rest.length === 0 ? await readLine() : rest.replace(/\r\n$/u, '');
    return { literal, tail };
  }

  async function command(text: string, literals?: string[]): Promise<readonly string[]> {
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
      let current = line;
      let literalMatch = LITERAL_SUFFIX.exec(current);
      while (literalMatch !== null) {
        const { literal, tail } = await readLiteral(Number(literalMatch[1]));
        literals?.push(literal);
        untagged.push(tail);
        current = tail;
        literalMatch = LITERAL_SUFFIX.exec(current);
      }
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

  async function fetchMessage(uid: number, maxBytes: number): Promise<ImapFetchedMessage | null> {
    if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LITERAL_BYTES) {
      throw imapClientError('fetch arguments are invalid', 'INVALID_INPUT');
    }
    const literals: string[] = [];
    // Ask for one byte more than the cap so a message that exactly fills it is not mistaken for a cut one.
    const untagged = await command(`UID FETCH ${uid} (UID FLAGS BODY.PEEK[]<0.${maxBytes + 1}>)`, literals);
    if (literals.length === 0) return null;
    const header = untagged.find((line) => /\sFETCH\s/iu.test(line)) ?? '';
    const flagsMatch = FETCH_FLAGS.exec(header);
    const flags = flagsMatch === null ? [] : flagsMatch[1].split(/\s+/u).filter((flag) => flag.length > 0);
    const bytes = Buffer.from(literals[0], 'utf8');
    const truncated = bytes.length > maxBytes;
    return Object.freeze({ uid, flags: Object.freeze(flags), raw: truncated ? bytes.subarray(0, maxBytes).toString('utf8') : literals[0], truncated });
  }

  async function moveMessage(uid: number, destination: string): Promise<void> {
    if (!Number.isSafeInteger(uid) || uid < 1) throw imapClientError('uid is invalid', 'INVALID_INPUT');
    assertSafeAtom(destination, 'destination');
    try {
      await command(`CREATE ${quotedString(destination)}`);
    } catch (error) {
      // An existing mailbox is answered with NO; any other failure surfaces on the MOVE below.
      if (!(error instanceof Error && (error as CodedError).code === 'COMMAND_REJECTED')) throw error;
    }
    await command(`UID MOVE ${uid} ${quotedString(destination)}`);
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

  return Object.freeze({ connect, login, select, fetchMessage, moveMessage, idle, logout, close });
}

export { imapClientError };
