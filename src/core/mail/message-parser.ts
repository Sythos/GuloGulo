// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// A deliberately small RFC 5322/MIME reader for the web message-detail view:
// unfolded headers, RFC 2047 encoded words, quoted-printable/base64 bodies and
// a bounded multipart walk that yields one text part, one HTML part and
// attachment metadata. It never executes or fetches anything; the HTML is
// handed to the browser, which sanitises it before it reaches the DOM.

export interface ParsedAttachment {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

export interface ParsedMessage {
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly date: string | undefined;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: readonly ParsedAttachment[];
}

const MAX_MIME_DEPTH = 5;
const MAX_MIME_PARTS = 50;
const MAX_ATTACHMENTS = 50;

interface RawPart {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

function splitHeadersAndBody(raw: string): RawPart {
  const normalized = raw.replace(/\r\n|\r|\n/gu, '\r\n');
  const boundary = normalized.indexOf('\r\n\r\n');
  const headerBlock = boundary === -1 ? normalized : normalized.slice(0, boundary);
  const body = boundary === -1 ? '' : normalized.slice(boundary + 4);
  const headers = new Map<string, string>();
  for (const line of headerBlock.replace(/\r\n[ \t]+/gu, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function decodeQuotedPrintable(value: string, forHeader: boolean): Buffer {
  const source = forHeader ? value.replace(/_/gu, ' ') : value.replace(/=\r\n/gu, '');
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const hex = source.slice(index + 1, index + 3);
    if (char === '=' && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(char, 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

function decodeCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function decodeEncodedWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/gu, '$1$2')
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/gu, (_match, charset: string, encoding: string, text: string) => {
      const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQuotedPrintable(text, true);
      return decodeCharset(bytes, charset.split('*', 1)[0]);
    });
}

function headerParameter(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))`, 'iu').exec(value);
  if (match === null) return undefined;
  return (match[1] ?? match[2]).replace(/\\(.)/gu, '$1');
}

function mediaType(value: string | undefined): string {
  return (value ?? 'text/plain').split(';', 1)[0].trim().toLowerCase() || 'text/plain';
}

function decodeBody(part: RawPart): { text: string; size: number } {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  const charset = headerParameter(part.headers.get('content-type'), 'charset') ?? 'utf-8';
  let bytes: Buffer;
  if (encoding === 'base64') bytes = Buffer.from(part.body.replace(/\s+/gu, ''), 'base64');
  else if (encoding === 'quoted-printable') bytes = decodeQuotedPrintable(part.body, false);
  else bytes = Buffer.from(part.body, 'utf8');
  return { text: decodeCharset(bytes, charset), size: bytes.length };
}

function splitMultipart(body: string, boundary: string): RawPart[] {
  const delimiter = `--${boundary}`;
  const parts: RawPart[] = [];
  let current: string[] | null = null;
  for (const line of body.split('\r\n')) {
    if (line === `${delimiter}--`) break;
    if (line === delimiter) {
      if (current !== null) parts.push(splitHeadersAndBody(current.join('\r\n')));
      current = [];
      continue;
    }
    current?.push(line);
  }
  if (current !== null) parts.push(splitHeadersAndBody(current.join('\r\n')));
  return parts;
}

/** Parses a raw RFC 5322 message into the fields the web detail view shows. Never throws on malformed input. */
export function parseMessage(raw: string): ParsedMessage {
  const root = splitHeadersAndBody(raw);
  let text: string | undefined;
  let html: string | undefined;
  const attachments: ParsedAttachment[] = [];
  let seenParts = 0;

  function walk(part: RawPart, depth: number): void {
    seenParts += 1;
    if (seenParts > MAX_MIME_PARTS) return;
    const contentType = part.headers.get('content-type');
    const type = mediaType(contentType);
    const disposition = (part.headers.get('content-disposition') ?? '').split(';', 1)[0].trim().toLowerCase();
    const boundary = headerParameter(contentType, 'boundary');
    if (type.startsWith('multipart/') && boundary !== undefined) {
      if (depth >= MAX_MIME_DEPTH) return;
      for (const child of splitMultipart(part.body, boundary)) walk(child, depth + 1);
      return;
    }
    const filename = headerParameter(part.headers.get('content-disposition'), 'filename') ?? headerParameter(contentType, 'name');
    if (disposition === 'attachment' || filename !== undefined || (!type.startsWith('text/') && type !== 'message/rfc822')) {
      if (attachments.length < MAX_ATTACHMENTS) {
        attachments.push(Object.freeze({
          name: decodeEncodedWords(filename ?? 'attachment').replace(/[\r\n\0/\\]/gu, '_').slice(0, 255),
          contentType: type,
          size: decodeBody(part).size,
        }));
      }
      return;
    }
    if (type === 'text/plain' && text === undefined) text = decodeBody(part).text;
    else if (type === 'text/html' && html === undefined) html = decodeBody(part).text;
  }

  walk(root, 0);

  const header = (name: string): string => decodeEncodedWords(root.headers.get(name) ?? '');
  const parsedDate = new Date(root.headers.get('date') ?? '');
  return Object.freeze({
    subject: header('subject'),
    from: header('from'),
    to: header('to'),
    date: Number.isNaN(parsedDate.valueOf()) ? undefined : parsedDate.toISOString(),
    text,
    html,
    attachments: Object.freeze(attachments),
  });
}
