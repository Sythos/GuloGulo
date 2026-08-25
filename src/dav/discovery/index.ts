// SPDX-License-Identifier: MIT
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { isIP } from 'node:net';

export const DISCOVERY_SCHEMA_VERSION = 1;

type DiscoveryValue = any;
type DiscoveryRecord = Record<string, DiscoveryValue>;

export const WELL_KNOWN_PATHS = Object.freeze({
  caldav: '/.well-known/caldav',
  carddav: '/.well-known/carddav',
  autoconfig: '/.well-known/autoconfig/mail/config-v1.1.xml',
  discovery: '/.well-known/gulogulo/discovery.json',
});

const SERVICE_DEFINITIONS = Object.freeze({
  imap: Object.freeze({ protocol: 'imap', defaultPort: 993, defaultTlsMode: 'implicit' }),
  smtp: Object.freeze({ protocol: 'smtp', defaultPort: 587, defaultTlsMode: 'starttls' }),
  pop3s: Object.freeze({ protocol: 'pop3s', defaultPort: 995, defaultTlsMode: 'implicit' }),
  caldav: Object.freeze({ protocol: 'caldav', defaultPort: 443, defaultTlsMode: 'implicit', defaultPath: '/dav/' }),
  carddav: Object.freeze({ protocol: 'carddav', defaultPort: 443, defaultTlsMode: 'implicit', defaultPath: '/dav/' }),
});

const SERVICE_NAMES = Object.freeze(Object.keys(SERVICE_DEFINITIONS));
const SERVICE_KEY_SET = new Set(SERVICE_NAMES);
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/iu;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/iu;
const USERNAME_PATTERN = /^(?:\{email\}|%EMAILADDRESS%|[A-Za-z0-9][A-Za-z0-9._:@%{}+/-]{0,253})$/u;
const PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/u;
const TLS_MODES = new Set(['implicit', 'starttls']);
const PRIVATE_HOST_SUFFIXES = Object.freeze([
  '.localhost', '.local', '.internal', '.home.arpa',
]);
const PRIVATE_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data.ec2.internal']);

function discoveryError(message: string, code = 'DISCOVERY_ERROR'): Error & { code: string } {
  const error = new Error(`Discovery error: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function assertPlainObject(value: DiscoveryValue, field: string): asserts value is DiscoveryRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw discoveryError(`${field} must be an object`, 'INVALID_INPUT');
  }
  return value;
}

function normalizeTenantId(value: DiscoveryValue): string {
  if (typeof value !== 'string' || !TENANT_ID_PATTERN.test(value)) {
    throw discoveryError('tenantId is invalid', 'INVALID_TENANT');
  }
  return value;
}

function normalizeDomain(value: DiscoveryValue, field = 'domain'): string {
  if (typeof value !== 'string' || !DOMAIN_PATTERN.test(value)) {
    throw discoveryError(`${field} is invalid`, 'INVALID_DOMAIN');
  }
  return value.toLowerCase();
}

function parseIpv4(value: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) return null;
  const octets = value.split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isReservedIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isReservedIpv6(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('::ffff:')) return isReservedIpv4(normalized.slice(7));
  return false;
}

function isPrivateOrReservedAddress(value: DiscoveryValue): boolean {
  if (isIP(value) === 4) return isReservedIpv4(value);
  if (isIP(value) === 6) return isReservedIpv6(value);
  return true;
}

function normalizeHost(value: DiscoveryValue, field = 'host'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw discoveryError(`${field} is invalid`, 'INVALID_HOST');
  }
  const candidate = value.trim().toLowerCase().replace(/\.$/u, '');
  if (candidate.length === 0 || /[\u0000-\u0020\u007f]/u.test(candidate) || candidate.includes('/')
    || candidate.includes('\\') || candidate.includes('@') || candidate.includes('%')
    || candidate.includes('://')) {
    throw discoveryError(`${field} is invalid`, 'INVALID_HOST');
  }
  const bracketed = candidate.startsWith('[') && candidate.endsWith(']');
  const unbracketed = bracketed ? candidate.slice(1, -1) : candidate;
  if (bracketed && isIP(unbracketed) !== 6) throw discoveryError(`${field} is invalid`, 'INVALID_HOST');
  if (!bracketed && unbracketed.includes(':')) throw discoveryError(`${field} is invalid`, 'INVALID_HOST');

  if (isIP(unbracketed) !== 0) {
    if (isPrivateOrReservedAddress(unbracketed)) throw discoveryError(`${field} is private or reserved`, 'UNSAFE_HOST');
    return bracketed ? `[${unbracketed}]` : unbracketed;
  }
  if (!HOSTNAME_PATTERN.test(unbracketed) || PRIVATE_HOSTNAMES.has(unbracketed)
    || PRIVATE_HOST_SUFFIXES.some((suffix) => unbracketed.endsWith(suffix))) {
    throw discoveryError(`${field} is private or reserved`, 'UNSAFE_HOST');
  }
  return unbracketed;
}

function normalizePort(value: DiscoveryValue, field = 'port'): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw discoveryError(`${field} is invalid`, 'INVALID_PORT');
  }
  return value;
}

function normalizePath(value: DiscoveryValue, field = 'path'): string {
  if (typeof value !== 'string' || !PATH_PATTERN.test(value) || value.includes('//')
    || value.includes('..') || value.includes('\\') || value.includes('%')) {
    throw discoveryError(`${field} is invalid`, 'INVALID_PATH');
  }
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizeUsername(value: DiscoveryValue, field = 'username'): string {
  if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) {
    throw discoveryError(`${field} is invalid`, 'INVALID_USERNAME');
  }
  return value;
}

function normalizeTls(input: DiscoveryValue, defaultMode: string, field = 'tls'): Readonly<DiscoveryRecord> {
  if (input === false || input === 'none') {
    throw discoveryError(`${field} must require TLS`, 'PLAINTEXT_DISCOVERY_FORBIDDEN');
  }
  if (input === true || input === undefined || input === null) {
    return Object.freeze({ tls: true, tlsMode: defaultMode });
  }
  if (typeof input !== 'string' || !TLS_MODES.has(input)) {
    throw discoveryError(`${field} is invalid`, 'INVALID_TLS');
  }
  return Object.freeze({ tls: true, tlsMode: input });
}

function normalizeOrigin(origin: DiscoveryValue, domain: string): string {
  if (origin === undefined || origin === null) origin = `https://${domain}`;
  if (typeof origin !== 'string') throw discoveryError('origin is invalid', 'INVALID_ORIGIN');
  let parsed;
  try { parsed = new URL(origin); } catch { throw discoveryError('origin is invalid', 'INVALID_ORIGIN'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/') throw discoveryError('origin must be an HTTPS origin without credentials or a path', 'UNSAFE_ORIGIN');
  const host = normalizeHost(parsed.hostname, 'origin hostname');
  if (host !== domain) throw discoveryError('origin hostname must match the tenant domain', 'TENANT_ORIGIN_MISMATCH');
  return `https://${host}${parsed.port ? `:${normalizePort(Number(parsed.port), 'origin port')}` : ''}`;
}

function endpointUrl(endpoint: DiscoveryRecord, service: string): string | null {
  if (service === 'caldav' || service === 'carddav') {
    const host = endpoint.host.startsWith('[') ? endpoint.host : endpoint.host;
    const defaultPort = endpoint.port === 443;
    return `https://${host}${defaultPort ? '' : `:${endpoint.port}`}${endpoint.path}`;
  }
  return null;
}

function normalizeEndpoint(service: string, input: DiscoveryRecord = {}, baseHost: string, { partial = false, fieldPrefix = service }: DiscoveryRecord = {}): Readonly<DiscoveryRecord> {
  assertPlainObject(input, fieldPrefix);
  const definition = (SERVICE_DEFINITIONS as DiscoveryRecord)[service];
  const allowedKeys = new Set(['enabled', 'host', 'port', 'tls', 'tlsMode', 'username', 'path']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw discoveryError(`${fieldPrefix}.${key} is not supported`, 'INVALID_INPUT');
  }
  if (!partial && input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw discoveryError(`${fieldPrefix}.enabled is invalid`, 'INVALID_ENABLED');
  }
  const enabled = input.enabled === undefined ? service !== 'pop3s' : input.enabled;
  if (!enabled) return Object.freeze({ enabled: false, service, protocol: definition.protocol });
  const host = input.host === undefined && partial ? undefined : normalizeHost(input.host ?? baseHost, `${fieldPrefix}.host`);
  const port = input.port === undefined && partial ? undefined : normalizePort(input.port ?? definition.defaultPort, `${fieldPrefix}.port`);
  if (input.tls !== undefined && input.tls !== true && input.tlsMode !== undefined) {
    throw discoveryError(`${fieldPrefix}.tls and tlsMode conflict`, 'INVALID_TLS');
  }
  const tlsInput = input.tlsMode ?? input.tls;
  const tls = (tlsInput === undefined && partial)
    ? Object.freeze({})
    : normalizeTls(tlsInput, definition.defaultTlsMode, `${fieldPrefix}.tls`);
  const username = input.username === undefined && partial ? undefined : normalizeUsername(input.username ?? '{email}', `${fieldPrefix}.username`);
  const path = service === 'caldav' || service === 'carddav'
    ? (input.path === undefined && partial ? undefined : normalizePath(input.path ?? definition.defaultPath, `${fieldPrefix}.path`))
    : (input.path === undefined ? undefined : (() => { throw discoveryError(`${fieldPrefix}.path is not supported`, 'INVALID_PATH'); })());
  return Object.freeze({
    enabled: true,
    service,
    protocol: definition.protocol,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...tls,
    ...(username === undefined ? {} : { username }),
    ...(path === undefined ? {} : { path }),
  });
}

function mergeEndpoint(base: DiscoveryRecord, override: DiscoveryValue, service: string, baseHost: string): Readonly<DiscoveryRecord> {
  if (override === undefined || override === null) return base;
  const normalized = normalizeEndpoint(service, override, baseHost, { partial: true, fieldPrefix: `manualOverrides.${service}` });
  if (normalized.enabled === false) return normalized;
  if (base.enabled === false) throw discoveryError(`${service} is disabled and cannot be enabled by an override`, 'SERVICE_DISABLED');
  return normalizeEndpoint(service, {
    enabled: true,
    host: normalized.host ?? base.host,
    port: normalized.port ?? base.port,
    tls: normalized.tls ?? base.tls,
    tlsMode: normalized.tlsMode ?? base.tlsMode,
    username: normalized.username ?? base.username,
    ...(service === 'caldav' || service === 'carddav' ? { path: normalized.path ?? base.path } : {}),
  }, baseHost, { fieldPrefix: `manualOverrides.${service}` });
}

function publicEndpoint(endpoint: DiscoveryRecord): DiscoveryRecord {
  const output: DiscoveryRecord = {
    service: endpoint.service,
    protocol: endpoint.protocol,
    host: endpoint.host,
    port: endpoint.port,
    tls: endpoint.tls,
    tlsMode: endpoint.tlsMode,
    username: endpoint.username,
  };
  if (endpoint.path !== undefined) {
    output.path = endpoint.path;
    output.url = endpointUrl(endpoint, endpoint.service);
  }
  return Object.freeze(output);
}

function assertDiscoveryContract(contract: DiscoveryValue): asserts contract is DiscoveryRecord {
  assertPlainObject(contract, 'contract');
  if (contract.schemaVersion !== DISCOVERY_SCHEMA_VERSION) throw discoveryError('contract schema is unsupported', 'INVALID_CONTRACT');
  const tenantId = normalizeTenantId(contract.tenantId);
  const domain = normalizeDomain(contract.domain);
  normalizeOrigin(contract.origin, domain);
  assertPlainObject(contract.services, 'contract.services');
  assertPlainObject(contract.manualOverrides, 'contract.manualOverrides');
  for (const service of SERVICE_NAMES) {
    if (!(service in contract.services) || !(service in contract.manualOverrides)) throw discoveryError('contract service map is incomplete', 'INVALID_CONTRACT');
    for (const [mapName, endpoint] of [['services', contract.services[service]], ['manualOverrides', contract.manualOverrides[service]]]) {
      assertPlainObject(endpoint, `contract.${mapName}.${service}`);
      if (endpoint.service !== service || endpoint.protocol !== (SERVICE_DEFINITIONS as DiscoveryRecord)[service].protocol) {
        throw discoveryError(`contract.${mapName}.${service} identifies the wrong service`, 'INVALID_CONTRACT');
      }
      const rawEndpoint = { ...endpoint };
      delete rawEndpoint.service;
      delete rawEndpoint.protocol;
      normalizeEndpoint(service, rawEndpoint, domain, { fieldPrefix: `contract.${mapName}.${service}` });
    }
  }
  if (!Array.isArray(contract.manualOverrideServices) || contract.manualOverrideServices.some((service) => !SERVICE_KEY_SET.has(service))) {
    throw discoveryError('contract manual override map is invalid', 'INVALID_CONTRACT');
  }
  if (tenantId !== contract.tenantId || domain !== contract.domain) throw discoveryError('contract values are not canonical', 'INVALID_CONTRACT');
}

function assertTenantMatch(contract: DiscoveryRecord, tenantId: DiscoveryValue): void {
  if (tenantId !== contract.tenantId) throw discoveryError('tenant context does not match discovery contract', 'TENANT_MISMATCH');
}

/**
 * Build the immutable, tenant-bound discovery configuration consumed by HTTP
 * and DAV adapters. It contains no secrets and rejects plaintext or private
 * destinations before anything can be published to a client.
 */
export function createDiscoveryContract({
  tenantId,
  domain,
  origin,
  services = {},
  manualOverrides = {},
}: DiscoveryRecord = {}): Readonly<DiscoveryRecord> {
  const canonicalTenantId = normalizeTenantId(tenantId);
  const canonicalDomain = normalizeDomain(domain);
  const canonicalOrigin = normalizeOrigin(origin, canonicalDomain);
  assertPlainObject(services, 'services');
  assertPlainObject(manualOverrides, 'manualOverrides');
  for (const key of Object.keys(services)) if (!SERVICE_KEY_SET.has(key)) throw discoveryError(`services.${key} is unsupported`, 'INVALID_SERVICE');
  for (const key of Object.keys(manualOverrides)) if (!SERVICE_KEY_SET.has(key)) throw discoveryError(`manualOverrides.${key} is unsupported`, 'INVALID_SERVICE');

  const serviceMap: DiscoveryRecord = {};
  const overrideMap: DiscoveryRecord = {};
  const explicitOverrideServices: string[] = [];
  for (const service of SERVICE_NAMES) {
    const configured = normalizeEndpoint(service, services[service] ?? {}, canonicalDomain, { fieldPrefix: `services.${service}` });
    const hasOverride = manualOverrides[service] !== undefined;
    const overridden = !hasOverride
      ? configured
      : mergeEndpoint(configured, manualOverrides[service], service, canonicalDomain);
    serviceMap[service] = configured;
    overrideMap[service] = overridden;
    if (hasOverride) explicitOverrideServices.push(service);
  }

  return Object.freeze({
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    tenantId: canonicalTenantId,
    domain: canonicalDomain,
    origin: canonicalOrigin,
    services: Object.freeze(serviceMap),
    manualOverrides: Object.freeze(overrideMap),
    manualOverrideServices: Object.freeze(explicitOverrideServices),
  });
}

/** Resolve a service, optionally applying a validated per-user manual override. */
export function resolveDiscoveryService(contract: DiscoveryValue, service: string, { manualOverride = null }: DiscoveryRecord = {}): Readonly<DiscoveryRecord> {
  assertDiscoveryContract(contract);
  if (!SERVICE_KEY_SET.has(service)) throw discoveryError('service is unsupported', 'INVALID_SERVICE');
  const base = contract.services?.[service];
  if (!base || base.enabled !== true) throw discoveryError(`${service} is disabled`, 'SERVICE_DISABLED');
  const endpoint = manualOverride === null || manualOverride === undefined
    ? contract.manualOverrides?.[service] ?? base
    : mergeEndpoint(base, manualOverride, service, contract.domain);
  if (!endpoint || endpoint.enabled !== true) throw discoveryError(`${service} is disabled`, 'SERVICE_DISABLED');
  const isContractOverride = Array.isArray(contract.manualOverrideServices)
    && contract.manualOverrideServices.includes(service);
  return Object.freeze({ source: manualOverride ? 'manual' : (isContractOverride ? 'manual' : 'discovered'), ...publicEndpoint(endpoint) });
}

function publicDiscoveryDocument(contract: DiscoveryRecord, tenantId: DiscoveryValue): Readonly<DiscoveryRecord> {
  assertTenantMatch(contract, tenantId);
  const services: DiscoveryRecord = {};
  for (const service of SERVICE_NAMES) {
    const endpoint = contract.manualOverrides?.[service] ?? contract.services?.[service];
    if (endpoint?.enabled === true) services[service] = publicEndpoint(endpoint);
  }
  return Object.freeze({ schemaVersion: DISCOVERY_SCHEMA_VERSION, domain: contract.domain, services: Object.freeze(services) });
}

/** Build the JSON document exposed at the Gulo Gulo discovery well-known path. */
export function buildDiscoveryDocument(contract: DiscoveryValue, { tenantId }: DiscoveryRecord = {}): Readonly<DiscoveryRecord> {
  assertDiscoveryContract(contract);
  return publicDiscoveryDocument(contract, tenantId);
}

function xmlEscape(value: DiscoveryValue): string {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function socketType(endpoint: DiscoveryRecord): string {
  return endpoint.tlsMode === 'implicit' ? 'SSL' : 'STARTTLS';
}

function autoconfigXml(contract: DiscoveryRecord, tenantId: DiscoveryValue): string {
  assertTenantMatch(contract, tenantId);
  const imap = contract.manualOverrides?.imap ?? contract.services.imap;
  const smtp = contract.manualOverrides?.smtp ?? contract.services.smtp;
  if (imap?.enabled !== true || smtp?.enabled !== true) throw discoveryError('IMAP and SMTP are required for mail autoconfig', 'SERVICE_DISABLED');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<clientConfig version="1.1">',
    `  <emailProvider id="${xmlEscape(contract.domain)}">`,
    `    <domain>${xmlEscape(contract.domain)}</domain>`,
    '    <displayName>Gulo Gulo</displayName>',
    '    <incomingServer type="imap">',
    `      <hostname>${xmlEscape(imap.host)}</hostname>`,
    `      <port>${imap.port}</port>`,
    `      <socketType>${socketType(imap)}</socketType>`,
    `      <username>${xmlEscape(imap.username)}</username>`,
    '      <authentication>password-cleartext</authentication>',
    '    </incomingServer>',
    '    <outgoingServer type="smtp">',
    `      <hostname>${xmlEscape(smtp.host)}</hostname>`,
    `      <port>${smtp.port}</port>`,
    `      <socketType>${socketType(smtp)}</socketType>`,
    `      <username>${xmlEscape(smtp.username)}</username>`,
    '      <authentication>password-cleartext</authentication>',
    '    </outgoingServer>',
    '  </emailProvider>',
    '</clientConfig>',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Produce a safe HTTP response for one exact .well-known resource. The caller
 * must pass the authenticated/requested tenant; path traversal and cross-
 * tenant access are rejected instead of being guessed or redirected.
 */
export function getWellKnownResource(contract: DiscoveryValue, path: string, { tenantId }: DiscoveryRecord = {}): Readonly<DiscoveryRecord> {
  assertDiscoveryContract(contract);
  assertTenantMatch(contract, tenantId);
  if (typeof path !== 'string' || path.length === 0 || path !== path.trim() || path.includes('?')
    || path.includes('#') || path.includes('\\') || path.includes('%') || path.includes('//')
    || path.includes('..')) throw discoveryError('well-known path is unsafe', 'UNSAFE_PATH');
  if (!(Object.values(WELL_KNOWN_PATHS) as readonly string[]).includes(path)) throw discoveryError('well-known resource is not supported', 'NOT_FOUND');

  if (path === WELL_KNOWN_PATHS.caldav || path === WELL_KNOWN_PATHS.carddav) {
    const service = path === WELL_KNOWN_PATHS.caldav ? 'caldav' : 'carddav';
    const endpoint = contract.manualOverrides?.[service] ?? contract.services?.[service];
    if (endpoint?.enabled !== true) throw discoveryError(`${service} is disabled`, 'SERVICE_DISABLED');
    return Object.freeze({
      statusCode: 308,
      headers: Object.freeze({ location: endpointUrl(endpoint, service), 'cache-control': 'no-store' }),
      contentType: 'text/plain; charset=utf-8',
      body: '',
    });
  }
  if (path === WELL_KNOWN_PATHS.autoconfig) {
    const body = autoconfigXml(contract, tenantId);
    return Object.freeze({
      statusCode: 200,
      headers: Object.freeze({ 'cache-control': 'no-store' }),
      contentType: 'application/xml; charset=utf-8',
      body,
    });
  }
  const body = `${JSON.stringify(publicDiscoveryDocument(contract, tenantId), null, 2)}\n`;
  return Object.freeze({
    statusCode: 200,
    headers: Object.freeze({ 'cache-control': 'no-store' }),
    contentType: 'application/json; charset=utf-8',
    body,
  });
}

export { discoveryError, isPrivateOrReservedAddress, normalizeHost, normalizePath, normalizePort, normalizeUsername };
