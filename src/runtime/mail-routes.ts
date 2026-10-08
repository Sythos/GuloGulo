// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Backend operations behind the web UI's message-detail, send and archive
// routes. Each call opens its own IMAP/SMTP connection logged in as the
// session's own mailbox, so mailbox access is scoped by the mail server itself;
// nothing here logs credentials or message content.

import type { ImapClient } from '../core/mail/imap-client.ts';
import { composeMessage } from '../core/mail/message-composer.ts';
import type { OutgoingMessageInput } from '../core/mail/message-composer.ts';
import { parseMessage } from '../core/mail/message-parser.ts';
import type { ParsedMessage } from '../core/mail/message-parser.ts';
import { SmtpCommandError } from '../core/mail/smtp-client.ts';
import type { SmtpClient } from '../core/mail/smtp-client.ts';

export const SEND_BODY_MAX_BYTES = 512 * 1024;
const MESSAGE_FETCH_MAX_BYTES = 1024 * 1024;
const ARCHIVE_MAILBOX = 'Archive';
const SMTP_CLIENT_HOSTNAME = 'localhost';
const MESSAGE_ID_PATTERN = /^(?:(inbox|sent|drafts|trash|archive):)?([1-9]\d{0,9})$/u;
const FOLDER_MAILBOXES: Readonly<Record<string, string>> = Object.freeze({
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  archive: ARCHIVE_MAILBOX,
});

export interface MailRouteClients {
  readonly createImapClient: () => ImapClient;
  readonly createSmtpClient: () => SmtpClient;
}

export interface MailRouteCredentials {
  readonly mailAddress: string;
  readonly password: string;
}

export class MailRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MailRouteError';
    this.status = status;
    this.code = code;
  }
}

const BACKEND_UNAVAILABLE = (): MailRouteError => new MailRouteError(502, 'MAIL_BACKEND_UNAVAILABLE', 'The mail server is unavailable.');

function errorCode(error: unknown): string | undefined {
  const code = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** `inbox:42`, `archive:7` or a bare UID (INBOX). Anything else is rejected before a connection is opened. */
export function parseMessageId(value: string): { mailbox: string; uid: number } {
  const match = MESSAGE_ID_PATTERN.exec(value);
  if (match === null) throw new MailRouteError(400, 'INVALID_MESSAGE_ID', 'The message identifier is invalid.');
  return { mailbox: FOLDER_MAILBOXES[match[1] ?? 'inbox'], uid: Number(match[2]) };
}

async function withImap<T>(clients: MailRouteClients, credentials: MailRouteCredentials, run: (client: ImapClient) => Promise<T>): Promise<T> {
  const client = clients.createImapClient();
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.login(credentials.mailAddress, credentials.password);
    return await run(client);
  } catch (error) {
    if (error instanceof MailRouteError) throw error;
    throw BACKEND_UNAVAILABLE();
  } finally {
    if (connected) {
      try { await client.logout(); } catch { client.close(); }
    } else {
      client.close();
    }
  }
}

export interface MessageDetail extends ParsedMessage {
  readonly id: string;
  readonly unread: boolean;
  readonly truncated: boolean;
}

export async function readMessageDetail(clients: MailRouteClients, credentials: MailRouteCredentials, id: string): Promise<MessageDetail> {
  const { mailbox, uid } = parseMessageId(id);
  const fetched = await withImap(clients, credentials, async (client) => {
    await client.select(mailbox);
    return client.fetchMessage(uid, MESSAGE_FETCH_MAX_BYTES);
  });
  if (fetched === null) throw new MailRouteError(404, 'MESSAGE_NOT_FOUND', 'The message was not found.');
  return Object.freeze({
    ...parseMessage(fetched.raw),
    id,
    unread: !fetched.flags.some((flag) => flag.toLowerCase() === '\\seen'),
    truncated: fetched.truncated,
  });
}

export async function archiveMessage(clients: MailRouteClients, credentials: MailRouteCredentials, id: string): Promise<void> {
  const { mailbox, uid } = parseMessageId(id);
  if (mailbox === ARCHIVE_MAILBOX) throw new MailRouteError(409, 'ALREADY_ARCHIVED', 'The message is already archived.');
  await withImap(clients, credentials, async (client) => {
    await client.select(mailbox);
    await client.moveMessage(uid, ARCHIVE_MAILBOX);
  });
}

export async function submitMessage(clients: MailRouteClients, credentials: MailRouteCredentials, input: OutgoingMessageInput, now: Date): Promise<void> {
  const payload = composeMessage({ from: credentials.mailAddress, input, now });
  const client = clients.createSmtpClient();
  try {
    await client.connect();
    await client.ehlo(SMTP_CLIENT_HOSTNAME);
    await client.startTls();
    await client.ehlo(SMTP_CLIENT_HOSTNAME);
    await client.authLogin(credentials.mailAddress, credentials.password);
    await client.mailFrom(credentials.mailAddress);
    for (const recipient of input.recipients) await client.rcptTo(recipient);
    await client.data(payload);
    await client.quit();
  } catch (error) {
    client.close();
    // A permanent refusal (bad recipient, policy) is the sender's to fix; everything else is a backend problem.
    if (error instanceof SmtpCommandError && !error.temporary) {
      throw new MailRouteError(422, 'MESSAGE_REJECTED', 'The mail server rejected the message.');
    }
    if (errorCode(error) === 'AUTHENTICATION_FAILED') {
      throw new MailRouteError(502, 'MAIL_AUTHENTICATION_FAILED', 'The mail server did not accept the account credentials.');
    }
    throw BACKEND_UNAVAILABLE();
  }
}
