// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID } from 'node:crypto';

export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_LENGTH = 255;
export const MAX_TEXT_BYTES = 256 * 1024;

const ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/u;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export class MailInputError extends Error {
  readonly code: string;

  constructor(message: string, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'MailInputError';
    this.code = code;
  }
}

export interface OutgoingMessageInput {
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
}

/** Accepts `a@b.c`, `Name <a@b.c>` or a list of either (array, or one string separated by commas/semicolons). */
function parseRecipients(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/u) : null;
  if (entries === null) throw new MailInputError('recipients are required');
  const recipients: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new MailInputError('recipients are invalid');
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const angle = /<([^<>]+)>\s*$/u.exec(trimmed);
    const address = (angle === null ? trimmed : angle[1]).trim();
    if (address.length > 254 || !ADDRESS_PATTERN.test(address)) throw new MailInputError('a recipient address is invalid');
    if (!recipients.includes(address)) recipients.push(address);
  }
  if (recipients.length === 0) throw new MailInputError('recipients are required');
  if (recipients.length > MAX_RECIPIENTS) throw new MailInputError('too many recipients', 'TOO_MANY_RECIPIENTS');
  return recipients;
}

/** Validates the JSON body of the send route; never echoes message content in its errors. */
export function validateOutgoing(body: Record<string, unknown>): OutgoingMessageInput {
  if (Array.isArray(body.attachments) ? body.attachments.length > 0 : body.attachments !== undefined) {
    throw new MailInputError('attachments are not supported', 'ATTACHMENTS_NOT_SUPPORTED');
  }
  const recipients = parseRecipients(body.to);
  const subject = body.subject === undefined ? '' : body.subject;
  if (typeof subject !== 'string' || subject.length > MAX_SUBJECT_LENGTH || CONTROL_CHARS.test(subject)) {
    throw new MailInputError('subject is invalid');
  }
  const text = body.text === undefined ? '' : body.text;
  if (typeof text !== 'string' || text.includes('\0')) throw new MailInputError('message text is invalid');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new MailInputError('message text is too large', 'MESSAGE_TOO_LARGE');
  return Object.freeze({ recipients: Object.freeze(recipients), subject, text });
}

function encodeSubject(subject: string): string {
  if (/^[ -~]*$/u.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** Builds an RFC 5322 text/plain message. The sender is always the authenticated mailbox, never client input. */
export function composeMessage({ from, input, now }: { from: string; input: OutgoingMessageInput; now: Date }): string {
  const domain = from.slice(from.lastIndexOf('@') + 1);
  const body = Buffer.from(input.text.replace(/\r\n|\r|\n/gu, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/gu, '$&\r\n');
  return [
    `From: <${from}>`,
    `To: ${input.recipients.map((recipient) => `<${recipient}>`).join(', ')}`,
    `Subject: ${encodeSubject(input.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}
