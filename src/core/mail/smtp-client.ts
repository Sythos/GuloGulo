// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// A deliberately minimal SMTP client (RFC 5321) covering only what
// submission needs: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL FROM/RCPT TO/DATA, and
// QUIT. Commands are exposed individually (not as one `sendMail()` call) so
// `smtp-queue-adapter.ts` can decide per-recipient accept/reject and map SMTP
// reply codes onto the existing queue's defer/bounce states itself.

import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { ConnectionOptions as TlsConnectionOptions, TLSSocket } from 'node:tls';

type SmtpSocket = Socket | TLSSocket;

export type SmtpTlsMode = 'implicit' | 'starttls' | 'none';

export interface SmtpClientLogger {
  readonly warn?: (event: string, details?: Record<string, unknown>) => void;
}

export interface SmtpClientOptions {
  readonly host: string;
  readonly port: number;
  /** 'implicit' (e.g. port 465), 'starttls' (e.g. port 587, the default), or 'none' for a trusted local/plaintext hop. */
  readonly tls?: SmtpTlsMode;
  readonly tlsOptions?: TlsConnectionOptions;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly logger?: SmtpClientLogger;
}

export interface SmtpResponse {
  readonly code: number;
  readonly lines: readonly string[];
  readonly message: string;
}

export class SmtpCommandError extends Error {
  readonly code: number;
  readonly temporary: boolean;
  readonly response: SmtpResponse;

  constructor(response: SmtpResponse) {
    super(`SMTP command failed (${response.code}): ${response.message}`);
    this.name = 'SmtpCommandError';
    this.code = response.code;
    this.temporary = response.code >= 400 && response.code < 500;
    this.response = response;
  }
}

/** `SmtpClientError.code` when the connection fails after the message and the end-of-data line were sent: the server may or may not have accepted the message. */
export const SMTP_DATA_OUTCOME_UNKNOWN = 'DATA_OUTCOME_UNKNOWN';

export interface SmtpClient {
  /** The TLS mode this client was created with; callers run `startTls()` only when it is 'starttls'. */
  readonly tls: SmtpTlsMode;
  connect(): Promise<SmtpResponse>;
  ehlo(clientHostname: string): Promise<{ readonly response: SmtpResponse; readonly capabilities: readonly string[] }>;
  startTls(): Promise<SmtpResponse>;
  authLogin(username: string, password: string): Promise<SmtpResponse>;
  authPlain(username: string, password: string): Promise<SmtpResponse>;
  /** Picks AUTH PLAIN, else AUTH LOGIN, from the mechanisms in the latest EHLO `capabilities`; fails when the server offers neither. */
  authenticate(username: string, password: string, capabilities: readonly string[]): Promise<SmtpResponse>;
  mailFrom(address: string): Promise<SmtpResponse>;
  rcptTo(address: string): Promise<SmtpResponse>;
  data(content: string | Buffer): Promise<SmtpResponse>;
  quit(): Promise<SmtpResponse>;
  close(): void;
}

interface CodedError extends Error {
  readonly code: string;
}

function smtpClientError(message: string, code = 'SMTP_CLIENT_ERROR'): CodedError {
  const error = new Error(`SMTP client error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { configurable: true, enumerable: true, value: code, writable: false });
  return error;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const CRLF = '\r\n';
const UNSAFE_CONTROL_CHARS = /[\r\n\0]/u;

function assertSafeAtom(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || UNSAFE_CONTROL_CHARS.test(value)) {
    throw smtpClientError(`${name} is invalid`, 'INVALID_INPUT');
  }
  return value;
}

function dotStuff(content: string): string {
  const normalized = content.replace(/\r\n|\r|\n/gu, '\r\n');
  return normalized.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
}

export function createSmtpClient(options: SmtpClientOptions): SmtpClient {
  const host = assertSafeAtom(options.host, 'host');
  const port = options.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw smtpClientError('port is invalid', 'INVALID_INPUT');
  }
  const tlsMode: SmtpTlsMode = options.tls ?? 'starttls';
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const logger = options.logger ?? {};

  let socket: SmtpSocket | null = null;
  let buffer = '';
  const pendingLines: string[] = [];
  let lineWaiters: Array<(line: string | null) => void> = [];

  function dispatchLine(line: string): void {
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

  function attachSocket(s: SmtpSocket): void {
    socket = s;
    s.on('data', onData);
    s.on('error', (error: Error) => {
      logger.warn?.('smtp_socket_error', { error: { name: error.name } });
    });
    s.on('close', () => {
      socket = null;
      // A `null` line tells every pending reader that the connection is gone.
      const waiters = lineWaiters;
      lineWaiters = [];
      for (const waiter of waiters) waiter(null);
    });
  }

  function readLine(): Promise<string> {
    const queued = pendingLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lineWaiters = lineWaiters.filter((waiter) => waiter !== onLine);
        reject(smtpClientError('timed out waiting for a server response', 'TIMEOUT'));
      }, commandTimeoutMs);
      function onLine(line: string | null): void {
        clearTimeout(timer);
        if (line === null) reject(smtpClientError('connection closed while waiting for a server response', 'CONNECTION_CLOSED'));
        else resolve(line);
      }
      lineWaiters.push(onLine);
    });
  }

  function write(data: string): void {
    if (socket === null) throw smtpClientError('not connected', 'NOT_CONNECTED');
    socket.write(data);
  }

  async function readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    for (;;) {
      const line = await readLine();
      if (line.length < 4 || !/^\d{3}[ -]/u.test(line)) {
        throw smtpClientError(`malformed SMTP response: ${line}`, 'PROTOCOL_ERROR');
      }
      lines.push(line);
      if (line[3] === ' ') break;
    }
    const code = Number(lines[0].slice(0, 3));
    return Object.freeze({ code, lines: Object.freeze(lines), message: lines.map((line) => line.slice(4)).join('\n') });
  }

  async function expect(codes: readonly number[]): Promise<SmtpResponse> {
    const response = await readResponse();
    if (!codes.includes(response.code)) throw new SmtpCommandError(response);
    return response;
  }

  async function runCommand(text: string, codes: readonly number[]): Promise<SmtpResponse> {
    write(`${text}${CRLF}`);
    return expect(codes);
  }

  function connect(): Promise<SmtpResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        s.destroy();
        reject(smtpClientError('connection timed out', 'TIMEOUT'));
      }, connectTimeoutMs);

      const s: SmtpSocket = tlsMode === 'implicit'
        ? tlsConnect({ host, port, ...options.tlsOptions })
        : netConnect({ host, port });

      s.once('error', (error: Error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      });

      s.once(tlsMode === 'implicit' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        attachSocket(s);
        expect([220]).then(resolve).catch(reject);
      });
    });
  }

  async function ehlo(clientHostname: string): Promise<{ response: SmtpResponse; capabilities: readonly string[] }> {
    assertSafeAtom(clientHostname, 'clientHostname');
    const response = await runCommand(`EHLO ${clientHostname}`, [250]);
    const capabilities = response.lines.slice(1).map((line) => line.slice(4).toUpperCase());
    return { response, capabilities };
  }

  async function startTls(): Promise<SmtpResponse> {
    if (tlsMode !== 'starttls') throw smtpClientError('STARTTLS requires tls: "starttls"', 'CONFIGURATION');
    if (socket === null) throw smtpClientError('not connected', 'NOT_CONNECTED');
    const response = await runCommand('STARTTLS', [220]);
    const plainSocket = socket;
    plainSocket.removeAllListeners('data');
    plainSocket.removeAllListeners('error');
    plainSocket.removeAllListeners('close');
    buffer = '';
    const upgraded = tlsConnect({ socket: plainSocket, host, ...options.tlsOptions });
    await new Promise<void>((resolve, reject) => {
      upgraded.once('secureConnect', () => resolve());
      upgraded.once('error', reject);
    });
    attachSocket(upgraded);
    return response;
  }

  function assertCredentials(username: string, password: string): void {
    assertSafeAtom(username, 'username');
    if (typeof password !== 'string' || password.length === 0 || UNSAFE_CONTROL_CHARS.test(password)) {
      throw smtpClientError('password is invalid', 'INVALID_INPUT');
    }
  }

  function authenticationFailed(error: unknown): unknown {
    return error instanceof SmtpCommandError ? smtpClientError('authentication failed', 'AUTHENTICATION_FAILED') : error;
  }

  async function authLogin(username: string, password: string): Promise<SmtpResponse> {
    assertCredentials(username, password);
    await runCommand('AUTH LOGIN', [334]);
    await runCommand(Buffer.from(username, 'utf8').toString('base64'), [334]);
    try {
      return await runCommand(Buffer.from(password, 'utf8').toString('base64'), [235]);
    } catch (error) {
      throw authenticationFailed(error);
    }
  }

  async function authPlain(username: string, password: string): Promise<SmtpResponse> {
    assertCredentials(username, password);
    try {
      return await runCommand(`AUTH PLAIN ${Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64')}`, [235]);
    } catch (error) {
      throw authenticationFailed(error);
    }
  }

  async function authenticate(username: string, password: string, capabilities: readonly string[]): Promise<SmtpResponse> {
    const mechanisms = new Set<string>();
    for (const capability of capabilities) {
      const match = /^AUTH[ =](.+)$/u.exec(capability.trim().toUpperCase());
      if (match !== null) for (const mechanism of match[1].split(/[ =]+/u)) mechanisms.add(mechanism);
    }
    if (mechanisms.has('PLAIN')) return authPlain(username, password);
    if (mechanisms.has('LOGIN')) return authLogin(username, password);
    throw smtpClientError('the server offers no supported AUTH mechanism', 'AUTH_UNSUPPORTED');
  }

  async function mailFrom(address: string): Promise<SmtpResponse> {
    assertSafeAtom(address, 'address');
    return runCommand(`MAIL FROM:<${address}>`, [250]);
  }

  async function rcptTo(address: string): Promise<SmtpResponse> {
    assertSafeAtom(address, 'address');
    return runCommand(`RCPT TO:<${address}>`, [250, 251]);
  }

  async function data(content: string | Buffer): Promise<SmtpResponse> {
    await runCommand('DATA', [354]);
    const body = typeof content === 'string' ? content : content.toString('utf8');
    if (socket === null) throw smtpClientError('not connected', 'NOT_CONNECTED');
    const active = socket;
    const flushed = await new Promise<boolean>((resolve) => {
      active.write(`${dotStuff(body)}${CRLF}.${CRLF}`, (error) => resolve(error === undefined || error === null));
    });
    // A failed write means the end-of-data line did not reach the server, so the message was not accepted.
    if (!flushed) throw smtpClientError('the connection failed while the message was sent', 'CONNECTION_CLOSED');
    try {
      return await expect([250]);
    } catch (error) {
      // An explicit reply code is a definite answer. Any other failure here leaves the outcome unknown.
      if (error instanceof SmtpCommandError) throw error;
      throw smtpClientError('the connection failed before the server confirmed the message', SMTP_DATA_OUTCOME_UNKNOWN);
    }
  }

  async function quit(): Promise<SmtpResponse> {
    try {
      return await runCommand('QUIT', [221]);
    } finally {
      close();
    }
  }

  function close(): void {
    lineWaiters = [];
    socket?.destroy();
    socket = null;
  }

  return Object.freeze({ tls: tlsMode, connect, ehlo, startTls, authLogin, authPlain, authenticate, mailFrom, rcptTo, data, quit, close });
}

export { smtpClientError };
