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

function attachmentError(message, code = 'ATTACHMENT_POLICY_ERROR') {
  const error = new Error(`Attachment policy error: ${message}`);
  error.code = code;
  return error;
}

function parseIpv4(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) return null;
  const octets = value.split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isReservedIpv4(value) {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isReservedIpv6(value) {
  const normalized = value.toLowerCase().replace(/\[|\]/gu, '');
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
    || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('::ffff:')) return isReservedIpv4(normalized.slice(7));
  return false;
}

/** Return true for loopback, private, link-local, documentation, multicast, or otherwise non-public addresses. */
export function isPrivateOrReservedAddress(address) {
  if (typeof address !== 'string') return true;
  const normalized = address.trim().toLowerCase();
  if (isIP(normalized) === 4) return isReservedIpv4(normalized);
  if (isIP(normalized) === 6) return isReservedIpv6(normalized);
  return true;
}

function normalizeHost(value) {
  return value.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
}

function isBlockedHostname(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') || hostname === 'metadata.google.internal'
    || hostname === 'metadata' || hostname === 'instance-data.ec2.internal';
}

function matchesAllowedHost(hostname, allowHosts) {
  if (!Array.isArray(allowHosts) || allowHosts.length === 0) return true;
  return allowHosts.some((allowed) => {
    const normalized = normalizeHost(String(allowed));
    return hostname === normalized;
  });
}

/**
 * Validate a remote attachment URL before any network request. Redirects must
 * be rejected by the caller; this function intentionally returns a no-redirect
 * fetch policy and never accepts credentials, file URLs, or private address literals.
 */
export function validateAttachmentUrl(rawUrl, {
  allowHttp = false,
  allowHosts = [],
  allowedPorts = null,
} = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) throw attachmentError('URL must be a non-empty string', 'INVALID_URL');
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw attachmentError('URL is invalid', 'INVALID_URL');
  }
  const hostname = normalizeHost(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw attachmentError('only HTTPS URLs are allowed', 'UNSAFE_PROTOCOL');
  if (url.username || url.password) throw attachmentError('URL credentials are forbidden', 'URL_CREDENTIALS_FORBIDDEN');
  if (isBlockedHostname(hostname)) throw attachmentError('hostname is not public', 'PRIVATE_HOST_BLOCKED');
  if (isIP(hostname) !== 0 && isPrivateOrReservedAddress(hostname)) throw attachmentError('address is not public', 'PRIVATE_ADDRESS_BLOCKED');
  if (!matchesAllowedHost(hostname, allowHosts)) throw attachmentError('hostname is not allow-listed', 'HOST_NOT_ALLOWED');
  const ports = allowedPorts ?? (url.protocol === 'https:' ? [443] : [80]);
  if (!Array.isArray(ports) || !ports.includes(url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80))) {
    throw attachmentError('port is not allowed', 'PORT_NOT_ALLOWED');
  }
  return Object.freeze({
    url: url.toString(),
    protocol: url.protocol,
    hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    redirect: 'error',
    credentials: 'omit',
  });
}

/** Resolve and re-check every DNS answer to prevent hostname-to-private-IP SSRF. */
export async function resolveAndValidateAttachmentUrl(rawUrl, { lookup = dns.lookup, ...options } = {}) {
  const validated = validateAttachmentUrl(rawUrl, options);
  if (isIP(validated.hostname) !== 0) return Object.freeze({ ...validated, addresses: Object.freeze([validated.hostname]) });
  let answers;
  try {
    answers = await lookup(validated.hostname, { all: true, verbatim: true });
  } catch {
    throw attachmentError('hostname could not be resolved', 'DNS_RESOLUTION_FAILED');
  }
  const addresses = answers.map((answer) => typeof answer === 'string' ? answer : answer.address).filter(Boolean);
  if (addresses.length === 0 || addresses.some(isPrivateOrReservedAddress)) throw attachmentError('DNS resolved to a non-public address', 'PRIVATE_ADDRESS_BLOCKED');
  return Object.freeze({ ...validated, addresses: Object.freeze(addresses) });
}

export function sanitizeAttachmentFilename(filename, { fallback = 'attachment', maxLength = 255 } = {}) {
  const value = typeof filename === 'string' ? filename.normalize('NFKC') : '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/[\\/:*?"<>|]/gu, '_').replace(/^\.+/u, '').trim();
  const safe = cleaned.slice(0, maxLength);
  return safe || fallback;
}

export function validateAttachmentMetadata({ filename, contentType = 'application/octet-stream', sizeBytes, sha256 = null } = {}, {
  maxBytes = 25 * 1024 * 1024,
  allowedContentTypes = null,
} = {}) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maxBytes) throw attachmentError('attachment size exceeds policy', 'ATTACHMENT_TOO_LARGE');
  const normalizedType = String(contentType).split(';', 1)[0].trim().toLowerCase();
  if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/u.test(normalizedType)) throw attachmentError('content type is invalid', 'INVALID_CONTENT_TYPE');
  if (EXECUTABLE_TYPES.has(normalizedType)) throw attachmentError('executable content is not accepted as a safe attachment', 'EXECUTABLE_CONTENT_BLOCKED');
  if (Array.isArray(allowedContentTypes) && !allowedContentTypes.map((item) => String(item).toLowerCase()).includes(normalizedType)) throw attachmentError('content type is not allowed', 'CONTENT_TYPE_NOT_ALLOWED');
  if (sha256 !== null && !/^[a-f0-9]{64}$/iu.test(String(sha256))) throw attachmentError('sha256 is invalid', 'INVALID_DIGEST');
  return Object.freeze({
    filename: sanitizeAttachmentFilename(filename),
    contentType: normalizedType,
    sizeBytes,
    sha256: sha256 === null ? null : String(sha256).toLowerCase(),
    disposition: 'attachment',
    render: 'download',
  });
}

export { attachmentError };
