// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import dns from 'node:dns/promises';
import { isIP } from 'node:net';

const EXECUTABLE_TYPES = new Set([
  'application/java-archive', 'application/javascript', 'application/vnd.microsoft.portable-executable',
  'application/x-7z-compressed', 'application/x-dosexec', 'application/x-httpd-php',
  'application/x-msdownload', 'application/x-sh', 'application/x-shellscript',
]);

export class AttachmentPolicyError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ATTACHMENT_POLICY_ERROR') { super(`Attachment policy error: ${message}`); this.name = 'AttachmentPolicyError'; this.code = code; }
}

export type LookupAnswer = string | { address: string };
export type LookupFunction = (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly LookupAnswer[]>;

function attachmentError(message: string, code = 'ATTACHMENT_POLICY_ERROR'): AttachmentPolicyError { return new AttachmentPolicyError(message, code); }

function parseIpv4(value: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) return null;
  const octets = value.split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isReservedIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113)
    || a! >= 224;
}

function isReservedIpv6(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\[|\]/gu, '');
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
    || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
  return normalized.startsWith('::ffff:') ? isReservedIpv4(normalized.slice(7)) : false;
}

export function isPrivateOrReservedAddress(address: unknown): boolean {
  if (typeof address !== 'string') return true;
  const normalized = address.trim().toLowerCase();
  if (isIP(normalized) === 4) return isReservedIpv4(normalized);
  if (isIP(normalized) === 6) return isReservedIpv6(normalized);
  return true;
}

function normalizeHost(value: string): string { return value.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, ''); }
function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') || hostname === 'metadata.google.internal'
    || hostname === 'metadata' || hostname === 'instance-data.ec2.internal';
}

export interface AttachmentUrlOptions { allowHttp?: boolean; allowHosts?: readonly string[]; allowedPorts?: readonly number[] | null }

export function validateAttachmentUrl(rawUrl: unknown, { allowHttp = false, allowHosts = [], allowedPorts = null }: AttachmentUrlOptions = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) throw attachmentError('URL must be a non-empty string', 'INVALID_URL');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw attachmentError('URL is invalid', 'INVALID_URL'); }
  const hostname = normalizeHost(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw attachmentError('only HTTPS URLs are allowed', 'UNSAFE_PROTOCOL');
  if (url.username || url.password) throw attachmentError('URL credentials are forbidden', 'URL_CREDENTIALS_FORBIDDEN');
  if (isBlockedHostname(hostname)) throw attachmentError('hostname is not public', 'PRIVATE_HOST_BLOCKED');
  if (isIP(hostname) !== 0 && isPrivateOrReservedAddress(hostname)) throw attachmentError('address is not public', 'PRIVATE_ADDRESS_BLOCKED');
  const normalizedAllowedHosts = allowHosts.map((allowed) => normalizeHost(String(allowed)));
  if (normalizedAllowedHosts.length > 0 && !normalizedAllowedHosts.includes(hostname)) throw attachmentError('hostname is not allow-listed', 'HOST_NOT_ALLOWED');
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const ports = allowedPorts ?? [defaultPort];
  const port = url.port ? Number(url.port) : defaultPort;
  if (!ports.includes(port)) throw attachmentError('port is not allowed', 'PORT_NOT_ALLOWED');
  return Object.freeze({ url: url.toString(), protocol: url.protocol, hostname, port, redirect: 'error' as const, credentials: 'omit' as const });
}

export async function resolveAndValidateAttachmentUrl(rawUrl: unknown, { lookup = dns.lookup as unknown as LookupFunction, ...options }: AttachmentUrlOptions & { lookup?: LookupFunction } = {}) {
  const validated = validateAttachmentUrl(rawUrl, options);
  if (isIP(validated.hostname) !== 0) return Object.freeze({ ...validated, addresses: Object.freeze([validated.hostname]) });
  let answers: readonly LookupAnswer[];
  try { answers = await lookup(validated.hostname, { all: true, verbatim: true }); } catch { throw attachmentError('hostname could not be resolved', 'DNS_RESOLUTION_FAILED'); }
  const addresses = answers.map((answer) => typeof answer === 'string' ? answer : answer.address).filter(Boolean);
  if (addresses.length === 0 || addresses.some(isPrivateOrReservedAddress)) throw attachmentError('DNS resolved to a non-public address', 'PRIVATE_ADDRESS_BLOCKED');
  return Object.freeze({ ...validated, addresses: Object.freeze(addresses) });
}

export function sanitizeAttachmentFilename(filename: unknown, { fallback = 'attachment', maxLength = 255 }: { fallback?: string; maxLength?: number } = {}): string {
  const value = typeof filename === 'string' ? filename.normalize('NFKC') : '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/[\\/:*?"<>|]/gu, '_').replace(/^\.+/u, '').trim();
  return cleaned.slice(0, maxLength) || fallback;
}

export interface AttachmentMetadata { filename?: unknown; contentType?: unknown; sizeBytes?: unknown; sha256?: unknown }

export function validateAttachmentMetadata({ filename, contentType = 'application/octet-stream', sizeBytes, sha256 = null }: AttachmentMetadata = {}, { maxBytes = 25 * 1024 * 1024, allowedContentTypes = null }: { maxBytes?: number; allowedContentTypes?: readonly string[] | null } = {}) {
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0 || (sizeBytes as number) > maxBytes) throw attachmentError('attachment size exceeds policy', 'ATTACHMENT_TOO_LARGE');
  const normalizedType = String(contentType).split(';', 1)[0]!.trim().toLowerCase();
  if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/u.test(normalizedType)) throw attachmentError('content type is invalid', 'INVALID_CONTENT_TYPE');
  if (EXECUTABLE_TYPES.has(normalizedType)) throw attachmentError('executable content is not accepted as a safe attachment', 'EXECUTABLE_CONTENT_BLOCKED');
  if (allowedContentTypes && !allowedContentTypes.map((item) => item.toLowerCase()).includes(normalizedType)) throw attachmentError('content type is not allowed', 'CONTENT_TYPE_NOT_ALLOWED');
  if (sha256 !== null && !/^[a-f0-9]{64}$/iu.test(String(sha256))) throw attachmentError('sha256 is invalid', 'INVALID_DIGEST');
  return Object.freeze({ filename: sanitizeAttachmentFilename(filename), contentType: normalizedType, sizeBytes: sizeBytes as number, sha256: sha256 === null ? null : String(sha256).toLowerCase(), disposition: 'attachment' as const, render: 'download' as const });
}

export { attachmentError };
