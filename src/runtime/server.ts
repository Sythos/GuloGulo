// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { createDependencyRegistry, createMetrics } from './metrics.js';
import { createLogger } from './logger.js';
import { getWellKnownResource, WELL_KNOWN_PATHS } from '../core/dav/discovery/index.ts';
import { createRateLimiter } from '../core/ops/abuse/index.ts';
import { parsePatchStatus, type PatchStatusDto } from '../core/ops/patch/status.ts';
import { CSRF_HEADER_NAME, createWebSecurity } from '../web/security/index.ts';
import type { SessionIdentity, WebSecurity, WebSession } from '../web/security/index.ts';
import type { DavStore } from '../platform/contract/platform-adapter.ts';

type RuntimeConfig = ReturnType<typeof loadConfig> & Record<string, any>;
type RuntimeLogger = ReturnType<typeof createLogger>;
type RequestDetails = Readonly<{ request_id: string; correlation_id: string }>;
type ApiResourceName = 'mail' | 'calendar' | 'contacts' | 'discovery';
interface LoginCredentials { email: string; password: string; rememberMe: boolean }
interface ApiScope { tenantId: string; userId: string; role: string }
type LoginAuthenticator = (credentials: LoginCredentials, requestDetails?: RequestDetails) => Promise<SessionIdentity | null> | SessionIdentity | null;
type ApiResource = (scope: ApiScope) => Promise<Record<string, unknown>> | Record<string, unknown>;
type ApiResources = Record<ApiResourceName, ApiResource>;
interface RuntimeServerOptions {
  config?: RuntimeConfig;
  logger?: RuntimeLogger;
  clock?: () => Date;
  metrics?: any;
  dependencies?: Record<string, any>;
  dependencyRegistry?: any;
  webRoot?: string;
  discoveryContract?: any;
  discoveryTenantId?: string;
  webSecurity?: WebSecurity;
  rateLimiter?: any;
  authenticateLogin?: LoginAuthenticator;
  apiResources?: Partial<ApiResources>;
  /** The persistent CalDAV/CardDAV storage backends (`PlatformAdapter.createDavStore()`). Undefined means the `/dav/*` surface responds 503 instead of touching a store. */
  davStore?: DavStore;
}
export interface RuntimeServer {
  config: RuntimeConfig;
  logger: RuntimeLogger;
  metrics: any;
  dependencies: any;
  state: { ready: boolean; shuttingDown: boolean };
  clock: () => Date;
  webRoot: string;
  discoveryContract: any;
  discoveryTenantId: string | undefined;
  webSecurity: WebSecurity;
  rateLimiter: any;
  authenticateLogin: LoginAuthenticator;
  apiResources: ApiResources;
  loginFailures: Map<string, { startedAt: number; count: number }>;
  davStore: DavStore | undefined;
  server: Server;
}

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};
const METRICS_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  'x-content-type-options': 'nosniff',
};
const STATIC_SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
const STATIC_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WELL_KNOWN_PATH_VALUES = new Set<string>(Object.values(WELL_KNOWN_PATHS));
const API_BODY_MAX_BYTES = 16 * 1024;
// One iCalendar object is capped at 1 MiB and one vCard at 256 KiB by the
// contracts themselves (caldav-contract.ts/carddav-store.ts); this is only a
// coarse guard against reading an unbounded request body into memory before
// that real, content-aware validation runs.
const DAV_BODY_MAX_BYTES = 2 * 1024 * 1024;
const DAV_XML_CONTENT_TYPE = 'application/xml; charset=utf-8';
// PROPFIND/GET/HEAD are read-only; PUT/DELETE/REPORT are the minimal
// interoperable WebDAV/CalDAV/CardDAV write and report surface this adapter
// implements against the Postgres-backed contracts. Anything else (MKCOL,
// PROPPATCH, COPY, MOVE, LOCK, ACL, OPTIONS, ...) is explicitly out of scope
// for this milestone and answers 501 Not Implemented rather than being
// silently ignored or falling through to the generic 405 handler.
const SUPPORTED_DAV_METHODS = new Set(['PROPFIND', 'GET', 'HEAD', 'PUT', 'DELETE', 'REPORT']);
const DAV_ALLOW_HEADER = [...SUPPORTED_DAV_METHODS].join(', ');
const CALDAV_COLLECTION_PATTERN = /^\/dav\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\/$/u;
const CALDAV_OBJECT_PATTERN = /^\/dav\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/u;
const CARDDAV_COLLECTION_PATTERN = /^\/dav\/contacts\/([^/]+)\/([^/]+)\/([^/]+)\/$/u;
const CARDDAV_OBJECT_PATTERN = /^\/dav\/contacts\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/u;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const API_GET_ROUTES = new Map<string, ApiResourceName>([
  ['/api/mail/messages', 'mail'],
  ['/api/calendar/events', 'calendar'],
  ['/api/contacts', 'contacts'],
  ['/api/discovery', 'discovery'],
]);

function buildMetadata(config: RuntimeConfig) {
  const contract = config?.contract ?? config ?? {};
  return {
    version: contract.buildVersion ?? config?.buildVersion ?? '0.1.4',
    build_digest: contract.buildDigest ?? config?.buildDigest ?? 'development',
  };
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    return undefined;
  }

  return value;
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestContext(request: IncomingMessage): RequestDetails {
  const requestId = safeRequestId(requestHeader(request, 'x-request-id')) ?? randomUUID();
  const correlationId =
    safeRequestId(requestHeader(request, 'x-correlation-id')) ?? requestId;

  return {
    request_id: requestId,
    correlation_id: correlationId,
  };
}

function responsePayload(runtime: RuntimeServer, status: string, requestDetails: RequestDetails, details: Record<string, unknown> = {}) {
  return {
    status,
    service: runtime.config.serviceName,
    timestamp: runtime.clock().toISOString(),
    ...buildMetadata(runtime.config),
    request_id: requestDetails.request_id,
    correlation_id: requestDetails.correlation_id,
    ...details,
  };
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown, method: string, requestDetails: RequestDetails): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestDetails.request_id,
    'x-correlation-id': requestDetails.correlation_id,
  });

  if (method !== 'HEAD') {
    response.end(body);
    return;
  }

  response.end();
}

function writeMetrics(response: ServerResponse, body: string, method: string, requestDetails: RequestDetails): void {
  response.writeHead(200, {
    ...METRICS_HEADERS,
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestDetails.request_id,
    'x-correlation-id': requestDetails.correlation_id,
  });

  if (method !== 'HEAD') {
    response.end(body);
    return;
  }

  response.end();
}

function writeStatic(response: ServerResponse, statusCode: number, body: Buffer, contentType: string, method: string, requestDetails: RequestDetails, cacheControl: string): void {
  response.writeHead(statusCode, {
    ...STATIC_SECURITY_HEADERS,
    'cache-control': cacheControl,
    'content-length': body.length,
    'content-type': contentType,
    'x-request-id': requestDetails.request_id,
    'x-correlation-id': requestDetails.correlation_id,
  });

  if (method !== 'HEAD') {
    response.end(body);
    return;
  }

  response.end();
}

function writeResource(response: ServerResponse, resource: any, method: string, requestDetails: RequestDetails): void {
  const body = Buffer.from(resource.body ?? '', 'utf8');
  response.writeHead(resource.statusCode, {
    ...STATIC_SECURITY_HEADERS,
    ...resource.headers,
    'content-length': body.length,
    'content-type': resource.contentType,
    'x-request-id': requestDetails.request_id,
    'x-correlation-id': requestDetails.correlation_id,
  });

  if (method !== 'HEAD') {
    response.end(body);
    return;
  }

  response.end();
}

function requestPath(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? '/', 'http://gulogulo.invalid').pathname;
  } catch {
    return null;
  }
}

function routeName(path: string | null): string {
  if (path === '/api/session/login') return '/api/session/login';
  if (path === '/api/session/logout') return '/api/session/logout';
  if (path === '/api/session') return '/api/session';
  if (path !== null && API_GET_ROUTES.has(path)) return `/api/${API_GET_ROUTES.get(path)}`;
  if (path === '/health/live' || path === '/healthz') {
    return '/health/live';
  }
  if (path === '/health/ready' || path === '/readyz') {
    return '/health/ready';
  }
  if (path === '/metrics') {
    return '/metrics';
  }
  if (path === '/ops/patch/status') {
    return '/ops/patch/status';
  }
  if (path !== null && WELL_KNOWN_PATH_VALUES.has(path)) {
    return '/discovery/well-known';
  }
  if (path !== null && path.startsWith('/dav/calendars/')) {
    return '/dav/calendars';
  }
  if (path !== null && path.startsWith('/dav/contacts/')) {
    return '/dav/contacts';
  }
  if (path === '/assets/gulo-gulo-calendar-mail.png') {
    return '/assets';
  }
  if (path === '/' || path === '/login') {
    return '/';
  }
  if (typeof path === 'string' && path.startsWith('/web/')) {
    return '/web/static';
  }
  return 'unmatched';
}

function staticFile(config: RuntimeConfig, path: string) {
  const isArtwork = path === '/assets/gulo-gulo-calendar-mail.png';
  if (!isArtwork && path !== '/' && path !== '/login' && !(typeof path === 'string' && path.startsWith('/web/'))) {
    return null;
  }

  const webRoot = config?.webRoot ?? config?.web?.staticRoot ?? join(process.cwd(), 'web');
  if (typeof webRoot !== 'string' || webRoot.length === 0) {
    return null;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(isArtwork ? '/gulo-gulo-calendar-mail.png' : path === '/' || path === '/login' ? '/index.html' : path.slice('/web'.length));
  } catch {
    return null;
  }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) {
    return null;
  }

  const root = resolve(isArtwork ? join(webRoot, '..', 'assets') : webRoot);
  const target = resolve(root, `.${pathname}`);
  const withinRoot = target === root || relative(root, target) && !relative(root, target).startsWith('..') && !relative(root, target).includes('\\');
  if (!withinRoot || !existsSync(target)) {
    return null;
  }
  try {
    if (!statSync(target).isFile()) return null;
    const extension = extname(target).toLowerCase();
    const contentType = STATIC_MIME_TYPES[extension];
    if (contentType === undefined) return null;
    return {
      body: readFileSync(target),
      contentType,
      cacheControl: extension === '.html' ? 'no-cache' : 'public, max-age=300',
    };
  } catch {
    return null;
  }
}

function patchStatusFile(config: RuntimeConfig): string {
  return config?.contract?.patching?.statusFile ?? config?.patching?.statusFile ?? '/var/lib/gulogulo/patch/status.json';
}

function readPatchStatus(config: RuntimeConfig): PatchStatusDto {
  try {
    return parsePatchStatus(readFileSync(patchStatusFile(config), 'utf8'));
  } catch {
    return parsePatchStatus(undefined);
  }
}

function abuseChannelForPath(path: string | null): string {
  if (path === '/api/session/login') return 'login';
  if (path !== null && path.startsWith('/api/')) return 'api';
  if (path !== null && (WELL_KNOWN_PATH_VALUES.has(path) || path.startsWith('/dav/'))) return 'dav';
  return 'http';
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function requestLogger(logger: RuntimeLogger, requestDetails: RequestDetails): RuntimeLogger {
  if (typeof logger.child === 'function') {
    return logger.child(requestDetails);
  }

  return logger;
}

function dependencyChecks(runtime: RuntimeServer) {
  return {
    process: runtime.state.ready ? 'ok' : 'starting',
    configuration: runtime.state.ready ? 'ok' : 'starting',
    dependencies: runtime.dependencies.snapshot(),
  };
}

function readiness(runtime: RuntimeServer): boolean {
  return (
    runtime.state.ready &&
    !runtime.state.shuttingDown &&
    runtime.dependencies.isReady()
  );
}

function readJsonBody(request: IncomingMessage, maxBytes = API_BODY_MAX_BYTES): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let failed = false;
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed = true;
        reject(Object.assign(new Error('request body is too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      if (!failed) chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      try {
        if (failed) return;
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
        resolve(value as Record<string, unknown>);
      } catch {
        reject(Object.assign(new Error('request body is invalid'), { code: 'INVALID_JSON' }));
      }
    });
    request.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// DAV (CalDAV/CardDAV) HTTP surface
//
// This section maps the minimal interoperable WebDAV method/report subset
// already supported by the pure contracts (src/core/dav/caldav/caldav-
// contract.ts, src/core/dav/carddav/carddav-store.ts) onto HTTP, against the
// injected Postgres-backed stores (runtime.davStore, from
// PlatformAdapter.createDavStore()). It intentionally does not implement the
// full RFC 4791/6352 method set (no MKCOL/MKCALENDAR, PROPPATCH, COPY, MOVE,
// LOCK/UNLOCK, ACL, or free-busy) — calendars and address books are expected
// to already exist (created directly against the contract, e.g. during
// provisioning) before a client ever reaches this HTTP surface.
//
// Authentication reuses the exact same cookie session as every other
// `/api/*` route (`runtime.webSecurity.authenticate()` in the request
// handler below) — there is no separate DAV credential path. Authorization
// never trusts the tenantId/ownerUserId path segments on their own: the
// authenticated session's tenantId must match the URL's tenantId segment
// (checked here) and every store call is made with an actor/scope built
// from the *session*, so PostgreSQL RLS and the contract's own ACL checks
// are always evaluated against who is actually logged in, never against
// what the URL claims. CardDAV has no delegate/sharing concept in this
// codebase, so its URL's userId segment must equal the session's userId;
// CalDAV's ownerUserId segment may legitimately differ from the session
// user for a delegated (shared, read or write) calendar — the contract's
// own ACL check (owner vs. delegate) decides that, not this router.
//
// Real DAV clients (Apple Calendar, Thunderbird, DAVx5, ...) cannot obtain
// or send the double-submit CSRF token the browser SPA uses for its own
// mutating requests (POST /api/session/logout), so PUT/DELETE/REPORT here
// are authenticated by session cookie alone, relying on the session
// cookie's own SameSite=Lax/Strict attribute (src/web/security/session-
// manager.ts) as the cross-site request forgery mitigation. This is a
// deliberate, documented trade-off, not an oversight — see doc/dav-and-
// discovery.md.

function xmlEscapeDav(value: unknown): string {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function davMultistatus(innerXml: string, extra = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CARD="urn:ietf:params:xml:ns:carddav">\n${innerXml}${extra}\n</D:multistatus>\n`;
}

function davPropResponse(href: string, propsInnerXml: string): string {
  return `  <D:response>\n    <D:href>${xmlEscapeDav(href)}</D:href>\n    <D:propstat>\n      <D:prop>\n${propsInnerXml}\n      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n    </D:propstat>\n  </D:response>\n`;
}

function davTombstoneResponse(href: string): string {
  return `  <D:response>\n    <D:href>${xmlEscapeDav(href)}</D:href>\n    <D:status>HTTP/1.1 404 Not Found</D:status>\n  </D:response>\n`;
}

function davErrorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:code>${xmlEscapeDav(code)}</D:code><D:message>${xmlEscapeDav(message)}</D:message></D:error>\n`;
}

function caldavCollectionHref(tenantId: string, ownerUserId: string, collectionId: string): string {
  return `/dav/calendars/${encodeURIComponent(tenantId)}/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(collectionId)}/`;
}

function davObjectHref(collectionHref: string, objectId: string): string {
  return `${collectionHref}${encodeURIComponent(objectId)}`;
}

function carddavCollectionHref(tenantId: string, userId: string, addressBookId: string): string {
  return `/dav/contacts/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}/${encodeURIComponent(addressBookId)}/`;
}

function caldavObjectPropXml(etag: string): string {
  return `        <D:getetag>${xmlEscapeDav(etag)}</D:getetag>\n        <D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>\n        <D:resourcetype/>`;
}

function carddavObjectPropXml(etag: string): string {
  return `        <D:getetag>${xmlEscapeDav(etag)}</D:getetag>\n        <D:getcontenttype>text/vcard</D:getcontenttype>\n        <D:resourcetype/>`;
}

function caldavCollectionPropXml(collection: any): string {
  return [
    '        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
    `        <D:displayname>${xmlEscapeDav(collection.displayName)}</D:displayname>`,
    `        <D:getlastmodified>${xmlEscapeDav(new Date(collection.updatedAt).toUTCString())}</D:getlastmodified>`,
    `        <D:sync-token>${xmlEscapeDav(collection.syncToken)}</D:sync-token>`,
  ].join('\n');
}

function carddavCollectionPropXml(addressBook: any): string {
  return [
    '        <D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>',
    `        <D:displayname>${xmlEscapeDav(addressBook.displayName)}</D:displayname>`,
    `        <D:getlastmodified>${xmlEscapeDav(new Date(addressBook.updatedAt).toUTCString())}</D:getlastmodified>`,
    `        <D:sync-token>${xmlEscapeDav(addressBook.syncToken)}</D:sync-token>`,
  ].join('\n');
}

function readRawBody(request: IncomingMessage, maxBytes = DAV_BODY_MAX_BYTES): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let failed = false;
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed = true;
        reject(Object.assign(new Error('request body is too large'), { code: 'BODY_TOO_LARGE', status: 413 }));
        return;
      }
      if (!failed) chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (failed) return;
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

/** '0'/'1' per RFC 4918; 'infinity' is rejected by the caller — this adapter never enumerates an unbounded tree. */
function parseDavDepth(request: IncomingMessage): '0' | '1' | 'infinity' {
  const value = requestHeader(request, 'depth');
  if (value === '0') return '0';
  if (value === 'infinity') return 'infinity';
  return '1';
}

/** Namespace-agnostic report-type sniff: matches the report's root element regardless of the client's chosen XML prefix. */
function detectDavReportType(xmlBody: string): 'calendar-query' | 'addressbook-query' | 'sync-collection' | null {
  if (/<[^>]*:?sync-collection[\s/>]/iu.test(xmlBody)) return 'sync-collection';
  if (/<[^>]*:?calendar-query[\s/>]/iu.test(xmlBody)) return 'calendar-query';
  if (/<[^>]*:?addressbook-query[\s/>]/iu.test(xmlBody)) return 'addressbook-query';
  return null;
}

function extractDavSyncToken(xmlBody: string): string | undefined {
  const match = /<[^>]*:?sync-token[^>]*>([^<]*)<\/[^>]*:?sync-token>/iu.exec(xmlBody);
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

function davErrorFromCaught(error: unknown): { status: number; code: string; message: string } {
  const record = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof record.status === 'number' && record.status >= 400 && record.status < 600 ? record.status : 500;
  const code = typeof record.code === 'string' ? record.code : 'INTERNAL_ERROR';
  const message = status === 500 ? 'an internal error occurred' : (error instanceof Error ? error.message : 'request failed');
  return { status, code, message };
}

function writeDavResponse(response: ServerResponse, statusCode: number, body: string, contentType: string, method: string, requestDetails: RequestDetails, extraHeaders: Record<string, string> = {}): void {
  const bodyBuffer = Buffer.from(body ?? '', 'utf8');
  response.writeHead(statusCode, {
    ...STATIC_SECURITY_HEADERS,
    ...extraHeaders,
    'cache-control': 'no-store',
    'content-length': bodyBuffer.length,
    'content-type': contentType,
    'x-request-id': requestDetails.request_id,
    'x-correlation-id': requestDetails.correlation_id,
  });

  if (method !== 'HEAD') {
    response.end(bodyBuffer);
    return;
  }

  response.end();
}

interface DavRouteMatch {
  readonly kind: 'caldav' | 'carddav';
  readonly level: 'collection' | 'object';
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly collectionId: string;
  readonly objectSegment: string | null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function matchDavRoute(path: string): DavRouteMatch | null {
  const caldavObject = CALDAV_OBJECT_PATTERN.exec(path);
  if (caldavObject) {
    const [, tenantId, ownerUserId, collectionId, objectSegment] = caldavObject;
    const decoded = [tenantId, ownerUserId, collectionId, objectSegment].map(decodeSegment);
    if (decoded.some((segment) => segment === null)) return null;
    return { kind: 'caldav', level: 'object', tenantId: decoded[0]!, ownerUserId: decoded[1]!, collectionId: decoded[2]!, objectSegment: decoded[3]! };
  }
  const caldavCollection = CALDAV_COLLECTION_PATTERN.exec(path);
  if (caldavCollection) {
    const [, tenantId, ownerUserId, collectionId] = caldavCollection;
    const decoded = [tenantId, ownerUserId, collectionId].map(decodeSegment);
    if (decoded.some((segment) => segment === null)) return null;
    return { kind: 'caldav', level: 'collection', tenantId: decoded[0]!, ownerUserId: decoded[1]!, collectionId: decoded[2]!, objectSegment: null };
  }
  const carddavObject = CARDDAV_OBJECT_PATTERN.exec(path);
  if (carddavObject) {
    const [, tenantId, ownerUserId, collectionId, objectSegment] = carddavObject;
    const decoded = [tenantId, ownerUserId, collectionId, objectSegment].map(decodeSegment);
    if (decoded.some((segment) => segment === null)) return null;
    return { kind: 'carddav', level: 'object', tenantId: decoded[0]!, ownerUserId: decoded[1]!, collectionId: decoded[2]!, objectSegment: decoded[3]! };
  }
  const carddavCollection = CARDDAV_COLLECTION_PATTERN.exec(path);
  if (carddavCollection) {
    const [, tenantId, ownerUserId, collectionId] = carddavCollection;
    const decoded = [tenantId, ownerUserId, collectionId].map(decodeSegment);
    if (decoded.some((segment) => segment === null)) return null;
    return { kind: 'carddav', level: 'collection', tenantId: decoded[0]!, ownerUserId: decoded[1]!, collectionId: decoded[2]!, objectSegment: null };
  }
  return null;
}

interface DavRouteContext {
  runtime: RuntimeServer;
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  path: string;
  session: WebSession;
  requestDetails: RequestDetails;
  scopedLogger: RuntimeLogger;
  startedAt: bigint;
  route: string;
}

/**
 * Handles every `/dav/calendars/*` and `/dav/contacts/*` request. Always
 * writes exactly one response and never throws — every contract/store error
 * is caught and mapped through `davErrorFromCaught()` to the HTTP status the
 * contract already chose (see caldav-contract.ts's `CalDavError.status` /
 * carddav-store.ts's `CardDavError.status`, both reused unmodified by the
 * PostgreSQL adapters).
 */
async function handleDavRoute(context: DavRouteContext): Promise<void> {
  const { runtime, request, response, method, path, session, requestDetails, scopedLogger, startedAt, route } = context;

  const finishDav = (statusCode: number, body: string, contentType: string, extraHeaders: Record<string, string> = {}): void => {
    writeDavResponse(response, statusCode, body, contentType, method, requestDetails, extraHeaders);
    const durationMs = elapsedMilliseconds(startedAt);
    runtime.metrics.recordRequest({ method, route, statusCode, durationMs });
    scopedLogger.info('request_completed', {
      method,
      route,
      status_code: statusCode,
      duration_ms: Number(durationMs.toFixed(3)),
      result: statusCode < 400 ? 'success' : 'failure',
    });
  };

  if (!SUPPORTED_DAV_METHODS.has(method)) {
    response.setHeader('allow', DAV_ALLOW_HEADER);
    finishDav(501, davErrorXml('NOT_IMPLEMENTED', `method ${method} is not implemented for DAV resources`), DAV_XML_CONTENT_TYPE);
    return;
  }

  if (runtime.davStore === undefined) {
    finishDav(503, davErrorXml('DAV_STORE_UNAVAILABLE', 'DAV storage is not configured'), DAV_XML_CONTENT_TYPE);
    return;
  }

  const match = matchDavRoute(path);
  if (match === null) {
    finishDav(404, davErrorXml('NOT_FOUND', 'the requested DAV resource path is not recognized'), DAV_XML_CONTENT_TYPE);
    return;
  }

  // Authorization never trusts the URL: the session's own tenant must match
  // the URL's tenant segment. CardDAV additionally has no delegate concept,
  // so its "owner" segment must be the session user itself.
  if (match.tenantId !== session.tenantId) {
    finishDav(403, davErrorXml('CROSS_TENANT_DENIED', 'cross-tenant DAV access is denied'), DAV_XML_CONTENT_TYPE);
    return;
  }
  if (match.kind === 'carddav' && match.ownerUserId !== session.userId) {
    finishDav(403, davErrorXml('SCOPE_TARGET_DENIED', 'an address book may only be accessed by its own user'), DAV_XML_CONTENT_TYPE);
    return;
  }

  const davStore = runtime.davStore;

  try {
    if (match.kind === 'caldav') {
      if (!davStore.caldav.enabled) {
        finishDav(503, davErrorXml('DAV_STORE_UNAVAILABLE', 'CalDAV storage is not configured'), DAV_XML_CONTENT_TYPE);
        return;
      }
      const actor = { tenantId: session.tenantId, domain: session.domain, userId: session.userId, role: session.role };
      const calendarId = `${match.ownerUserId}/${match.collectionId}`;
      const collectionHref = caldavCollectionHref(match.tenantId, match.ownerUserId, match.collectionId);

      if (match.level === 'collection') {
        if (method === 'PROPFIND') {
          const depth = parseDavDepth(request);
          if (depth === 'infinity') { finishDav(403, davErrorXml('DEPTH_NOT_SUPPORTED', 'Depth: infinity is not supported'), DAV_XML_CONTENT_TYPE); return; }
          const collection = await davStore.caldav.getCalendarCollection(actor, calendarId);
          let innerXml = davPropResponse(collectionHref, caldavCollectionPropXml(collection));
          if (depth === '1') {
            const listing = await davStore.caldav.listCalendarObjects(actor, { calendarId });
            for (const object of listing.objects) innerXml += davPropResponse(object.href, caldavObjectPropXml(object.etag));
          }
          finishDav(207, davMultistatus(innerXml), DAV_XML_CONTENT_TYPE);
          return;
        }
        if (method === 'REPORT') {
          const xmlBody = await readRawBody(request);
          const reportType = detectDavReportType(xmlBody);
          if (reportType === 'sync-collection') {
            const syncToken = extractDavSyncToken(xmlBody);
            const result = await davStore.caldav.listCalendarObjects(actor, { calendarId, syncToken });
            let innerXml = '';
            for (const object of result.objects) innerXml += davPropResponse(object.href, caldavObjectPropXml(object.etag));
            for (const deletedObjectId of result.deletedObjectIds) innerXml += davTombstoneResponse(davObjectHref(collectionHref, deletedObjectId));
            finishDav(207, davMultistatus(innerXml, `  <D:sync-token>${xmlEscapeDav(result.syncToken)}</D:sync-token>\n`), DAV_XML_CONTENT_TYPE);
            return;
          }
          if (reportType === 'calendar-query') {
            const result = await davStore.caldav.listCalendarObjects(actor, { calendarId });
            let innerXml = '';
            for (const object of result.objects) innerXml += davPropResponse(object.href, caldavObjectPropXml(object.etag));
            finishDav(207, davMultistatus(innerXml), DAV_XML_CONTENT_TYPE);
            return;
          }
          finishDav(501, davErrorXml('REPORT_NOT_SUPPORTED', 'only calendar-query and sync-collection reports are supported'), DAV_XML_CONTENT_TYPE);
          return;
        }
        if (method === 'DELETE') {
          const ifMatch = requestHeader(request, 'if-match');
          await davStore.caldav.deleteCalendarCollection(actor, { calendarId, ifMatch });
          finishDav(204, '', DAV_XML_CONTENT_TYPE);
          return;
        }
        finishDav(404, davErrorXml('NOT_FOUND', 'GET/PUT are not supported on a calendar collection; address an object inside it'), DAV_XML_CONTENT_TYPE);
        return;
      }

      // level === 'object'
      const objectId = match.objectSegment!;
      if (method === 'GET' || method === 'HEAD') {
        const object = await davStore.caldav.getCalendarObject(actor, { calendarId, objectId });
        finishDav(200, object.ical, 'text/calendar; charset=utf-8', { etag: object.etag });
        return;
      }
      if (method === 'PUT') {
        const ical = await readRawBody(request);
        const ifMatch = requestHeader(request, 'if-match');
        const ifNoneMatch = requestHeader(request, 'if-none-match');
        if (ifNoneMatch === '*') {
          const created = await davStore.caldav.createCalendarObject(actor, { calendarId, objectId, ical, ifNoneMatch: '*' });
          finishDav(201, '', 'text/calendar; charset=utf-8', { etag: created.etag, location: created.href });
          return;
        }
        if (ifMatch !== undefined) {
          const updated = await davStore.caldav.updateCalendarObject(actor, { calendarId, objectId, ical, ifMatch });
          finishDav(204, '', 'text/calendar; charset=utf-8', { etag: updated.etag });
          return;
        }
        const created = await davStore.caldav.createCalendarObject(actor, { calendarId, objectId, ical });
        finishDav(201, '', 'text/calendar; charset=utf-8', { etag: created.etag, location: created.href });
        return;
      }
      if (method === 'DELETE') {
        const ifMatch = requestHeader(request, 'if-match');
        await davStore.caldav.deleteCalendarObject(actor, { calendarId, objectId, ifMatch });
        finishDav(204, '', DAV_XML_CONTENT_TYPE);
        return;
      }
      if (method === 'PROPFIND') {
        const depth = parseDavDepth(request);
        if (depth === 'infinity') { finishDav(403, davErrorXml('DEPTH_NOT_SUPPORTED', 'Depth: infinity is not supported'), DAV_XML_CONTENT_TYPE); return; }
        const object = await davStore.caldav.getCalendarObject(actor, { calendarId, objectId });
        finishDav(207, davMultistatus(davPropResponse(object.href, caldavObjectPropXml(object.etag))), DAV_XML_CONTENT_TYPE);
        return;
      }
      finishDav(404, davErrorXml('NOT_FOUND', 'REPORT is not supported on a single calendar object'), DAV_XML_CONTENT_TYPE);
      return;
    }

    // match.kind === 'carddav'
    if (!davStore.carddav.enabled) {
      finishDav(503, davErrorXml('DAV_STORE_UNAVAILABLE', 'CardDAV storage is not configured'), DAV_XML_CONTENT_TYPE);
      return;
    }
    const scope = { tenantId: session.tenantId, domain: session.domain, userId: session.userId, role: session.role };
    const addressBookId = match.collectionId;
    const collectionHref = carddavCollectionHref(match.tenantId, match.ownerUserId, match.collectionId);

    if (match.level === 'collection') {
      if (method === 'PROPFIND') {
        const depth = parseDavDepth(request);
        if (depth === 'infinity') { finishDav(403, davErrorXml('DEPTH_NOT_SUPPORTED', 'Depth: infinity is not supported'), DAV_XML_CONTENT_TYPE); return; }
        const addressBook = await davStore.carddav.getAddressBook(scope, { addressBookId });
        let innerXml = davPropResponse(collectionHref, carddavCollectionPropXml(addressBook));
        if (depth === '1') {
          const contacts = await davStore.carddav.listContacts(scope, { addressBookId });
          for (const contact of contacts) innerXml += davPropResponse(davObjectHref(collectionHref, contact.href), carddavObjectPropXml(contact.etag));
        }
        finishDav(207, davMultistatus(innerXml), DAV_XML_CONTENT_TYPE);
        return;
      }
      if (method === 'REPORT') {
        const xmlBody = await readRawBody(request);
        const reportType = detectDavReportType(xmlBody);
        if (reportType === 'sync-collection') {
          const syncToken = extractDavSyncToken(xmlBody);
          const result = await davStore.carddav.syncCollection(scope, { addressBookId, syncToken });
          let innerXml = '';
          for (const change of result.changes) {
            const href = davObjectHref(collectionHref, change.href);
            if (change.status === 'deleted') innerXml += davTombstoneResponse(href);
            else innerXml += davPropResponse(href, carddavObjectPropXml(change.etag));
          }
          finishDav(207, davMultistatus(innerXml, `  <D:sync-token>${xmlEscapeDav(result.syncToken)}</D:sync-token>\n`), DAV_XML_CONTENT_TYPE);
          return;
        }
        if (reportType === 'addressbook-query') {
          const contacts = await davStore.carddav.listContacts(scope, { addressBookId });
          let innerXml = '';
          for (const contact of contacts) innerXml += davPropResponse(davObjectHref(collectionHref, contact.href), carddavObjectPropXml(contact.etag));
          finishDav(207, davMultistatus(innerXml), DAV_XML_CONTENT_TYPE);
          return;
        }
        finishDav(501, davErrorXml('REPORT_NOT_SUPPORTED', 'only addressbook-query and sync-collection reports are supported'), DAV_XML_CONTENT_TYPE);
        return;
      }
      if (method === 'DELETE') {
        const ifMatch = requestHeader(request, 'if-match');
        await davStore.carddav.deleteAddressBook(scope, { addressBookId, ifMatch });
        finishDav(204, '', DAV_XML_CONTENT_TYPE);
        return;
      }
      finishDav(404, davErrorXml('NOT_FOUND', 'GET/PUT are not supported on an address book collection; address a contact inside it'), DAV_XML_CONTENT_TYPE);
      return;
    }

    // level === 'object'
    const href = match.objectSegment!;
    if (method === 'GET' || method === 'HEAD') {
      const contact = await davStore.carddav.getContact(scope, { addressBookId, href });
      finishDav(200, contact.vCard, contact.mediaType ?? 'text/vcard', { etag: contact.etag });
      return;
    }
    if (method === 'PUT') {
      const vCard = await readRawBody(request);
      const ifMatch = requestHeader(request, 'if-match');
      const ifNoneMatch = requestHeader(request, 'if-none-match');
      const result = await davStore.carddav.putContact(scope, { addressBookId, href, ifMatch, ifNoneMatch, vCard });
      const created = ifNoneMatch === '*';
      finishDav(created ? 201 : 204, '', 'text/vcard', { etag: result.etag, location: davObjectHref(collectionHref, result.href) });
      return;
    }
    if (method === 'DELETE') {
      const ifMatch = requestHeader(request, 'if-match');
      await davStore.carddav.deleteContact(scope, { addressBookId, href, ifMatch });
      finishDav(204, '', DAV_XML_CONTENT_TYPE);
      return;
    }
    if (method === 'PROPFIND') {
      const depth = parseDavDepth(request);
      if (depth === 'infinity') { finishDav(403, davErrorXml('DEPTH_NOT_SUPPORTED', 'Depth: infinity is not supported'), DAV_XML_CONTENT_TYPE); return; }
      const contact = await davStore.carddav.getContactMetadata(scope, { addressBookId, href });
      finishDav(207, davMultistatus(davPropResponse(davObjectHref(collectionHref, contact.href), carddavObjectPropXml(contact.etag))), DAV_XML_CONTENT_TYPE);
      return;
    }
    finishDav(404, davErrorXml('NOT_FOUND', 'REPORT is not supported on a single contact'), DAV_XML_CONTENT_TYPE);
  } catch (error) {
    const mapped = davErrorFromCaught(error);
    scopedLogger.warn('dav_request_failed', { error: { code: mapped.code }, status_code: mapped.status });
    finishDav(mapped.status, davErrorXml(mapped.code, mapped.message), DAV_XML_CONTENT_TYPE);
  }
}

function publicSessionUser(session: WebSession) {
  return Object.freeze({
    tenantId: session.tenantId,
    domain: session.domain,
    userId: session.userId,
    email: session.userId.includes('@') ? session.userId : `${session.userId}@${session.domain}`,
    role: session.role,
  });
}

function equalFixtureIdentifier(supplied: unknown, expected: string): boolean {
  const suppliedBytes = Buffer.from(String(supplied), 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

const FIXTURE_PASSWORD_SALT = 'gulogulo-fixture-password-v1';
const FIXTURE_PASSWORD_KEYLEN = 32;

function deriveFixturePassword(value: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(String(value), FIXTURE_PASSWORD_SALT, FIXTURE_PASSWORD_KEYLEN, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });
}

async function equalFixturePassword(supplied: unknown, expected: string): Promise<boolean> {
  try {
    const [suppliedKey, expectedKey] = await Promise.all([
      deriveFixturePassword(supplied),
      deriveFixturePassword(expected),
    ]);
    return timingSafeEqual(suppliedKey, expectedKey);
  } catch {
    return false;
  }
}

/** Build an explicitly enabled local-proof authenticator; all other modes reject every login. */
export function createFixtureLoginAuthenticator(environment: Record<string, string | undefined> = process.env): LoginAuthenticator {
  const enabled = environment.GULOGULO_FIXTURE_MODE === 'true';
  const email = environment.GULOGULO_FIXTURE_EMAIL;
  const password = environment.GULOGULO_FIXTURE_PASSWORD;
  const tenantId = environment.GULOGULO_FIXTURE_TENANT;
  const domain = environment.GULOGULO_FIXTURE_DOMAIN;
  const userId = environment.GULOGULO_FIXTURE_USER_ID ?? email?.split('@', 1)[0];
  if (!enabled || !email || !password || !tenantId || !domain || !userId) return async () => null;
  const canonicalEmail = email.trim().toLowerCase();
  return async (credentials: LoginCredentials) => {
    const emailMatches = equalFixtureIdentifier(credentials?.email ?? '', canonicalEmail);
    const passwordMatches = await equalFixturePassword(credentials?.password ?? '', password);
    if (!emailMatches || !passwordMatches) return null;
    return Object.freeze({ tenantId, domain, userId, actorId: userId, role: 'user' });
  };
}

function defaultApiResources(): ApiResources {
  return Object.freeze({
    mail: async () => Object.freeze({ messages: Object.freeze([]) }),
    calendar: async () => Object.freeze({ events: Object.freeze([]) }),
    contacts: async () => Object.freeze({ contacts: Object.freeze([]) }),
    discovery: async () => Object.freeze({ services: Object.freeze([]) }),
  });
}

/**
 * Build the dependency-free HTTP surface used by the first Docker milestone.
 *
 * The health contract distinguishes process liveness from readiness. An empty
 * dependency registry is reported as disabled; explicitly registered
 * starting, degraded, failed, or unknown dependencies keep readiness at 503.
 * No connection is attempted and no dependency endpoint or credential is
 * exposed by this module.
 */
export function createRuntimeServer({
  config = loadConfig(),
  logger = createLogger({
    ...config,
    version: buildMetadata(config).version,
    build: buildMetadata(config).build_digest,
  }),
  clock = () => new Date(),
  metrics,
  dependencies = {},
  dependencyRegistry,
  webRoot,
  discoveryContract = config?.discoveryContract,
  discoveryTenantId = config?.discoveryTenantId ?? config?.tenantId,
  webSecurity = createWebSecurity({ clock }),
  rateLimiter,
  authenticateLogin = createFixtureLoginAuthenticator(),
  apiResources = defaultApiResources(),
  davStore,
}: RuntimeServerOptions = {}): RuntimeServer {
  const runtimeMetrics = metrics ?? createMetrics({ clock });
  const metadata = buildMetadata(config);
  runtimeMetrics.set('gulogulo_build_info', 1, {
    version: metadata.version,
    build: metadata.build_digest,
  });
  const runtimeDependencies =
    dependencyRegistry ??
    createDependencyRegistry({
      initial: dependencies,
      metrics: runtimeMetrics,
      clock,
    });
  const state = {
    ready: false,
    shuttingDown: false,
  };

  const runtime: RuntimeServer = {
    config,
    logger,
    metrics: runtimeMetrics,
    dependencies: runtimeDependencies,
    state,
    clock,
    webRoot: webRoot ?? config?.webRoot ?? config?.web?.staticRoot ?? join(process.cwd(), 'web'),
    discoveryContract,
    discoveryTenantId,
    webSecurity,
    rateLimiter: rateLimiter ?? createRateLimiter({ clock }),
    authenticateLogin,
    apiResources: { ...defaultApiResources(), ...apiResources },
    loginFailures: new Map(),
    davStore,
    server: undefined as unknown as Server,
  };

  runtime.server = createHttpServer(async (request, response) => {
    const path = requestPath(request);
    const method = request.method ?? 'GET';
    const requestDetails = requestContext(request);
    const route = routeName(path);
    const scopedLogger = requestLogger(runtime.logger, requestDetails);
    const startedAt = process.hrtime.bigint();
    let completed = false;

    response.setHeader('x-request-id', requestDetails.request_id);
    response.setHeader('x-correlation-id', requestDetails.correlation_id);
    scopedLogger.info('request_received', {
      method,
      route,
    });

    const finish = (statusCode: number, payload: unknown, contentType: 'json' | 'metrics' = 'json'): void => {
      if (completed) {
        return;
      }
      completed = true;

      if (contentType === 'metrics') {
        writeMetrics(response, typeof payload === 'string' ? payload : '', method, requestDetails);
      } else {
        writeJson(response, statusCode, payload, method, requestDetails);
      }

      const durationMs = elapsedMilliseconds(startedAt);
      runtime.metrics.recordRequest({
        method,
        route,
        statusCode,
        durationMs,
      });
      scopedLogger.info('request_completed', {
        method,
        route,
        status_code: statusCode,
        duration_ms: Number(durationMs.toFixed(3)),
        result: statusCode < 400 ? 'success' : 'failure',
      });
    };

    const cookieHeader = requestHeader(request, 'cookie');
    const session = runtime.webSecurity.authenticate(cookieHeader);
    const clearExpiredCookie = () => {
      if (typeof cookieHeader === 'string' && cookieHeader.includes('__Host-gulogulo-session=')) {
        response.setHeader('set-cookie', runtime.webSecurity.sessions.clearSessionCookie());
      }
    };
    const unauthorized = () => {
      clearExpiredCookie();
      finish(401, responsePayload(runtime, 'unauthorized', requestDetails, {
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' },
      }));
    };

    const abuseChannel = abuseChannelForPath(path);
    const abuseDecision = runtime.rateLimiter.consume({
      channel: abuseChannel,
      tenantId: session?.tenantId ?? 'anonymous',
      ipAddress: request.socket.remoteAddress ?? 'unknown',
    });
    runtime.metrics.increment(abuseDecision.allowed ? 'gulogulo_abuse_allowed_total' : 'gulogulo_abuse_limited_total', 1, {
      channel: abuseChannel,
    });
    if (!abuseDecision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(Number(abuseDecision.retryAfterMs ?? 1000) / 1000));
      response.setHeader('retry-after', String(retryAfterSeconds));
      scopedLogger.warn('abuse_rate_limited', {
        channel: abuseChannel,
        limited_by: abuseDecision.limitedBy,
        retry_after_seconds: retryAfterSeconds,
      });
      finish(429, responsePayload(runtime, 'rate_limited', requestDetails, {
        error: { code: 'RATE_LIMITED', message: 'Request rate exceeded.' },
      }));
      return;
    }

    if (path === null) {
      finish(
        400,
        responsePayload(runtime, 'bad_request', requestDetails, {
          reason: 'invalid_request_target',
        }),
      );
      return;
    }

    if (path === '/api/session/login') {
      if (method !== 'POST') {
        response.setHeader('allow', 'POST');
        finish(405, responsePayload(runtime, 'method_not_allowed', requestDetails, { allow: ['POST'] }));
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        finish(error !== null && typeof error === 'object' && 'code' in error && error.code === 'BODY_TOO_LARGE' ? 413 : 400, responsePayload(runtime, 'bad_request', requestDetails, {
          error: { code: 'INVALID_REQUEST', message: 'The request could not be processed.' },
        }));
        return;
      }
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const rememberMe = body.rememberMe === true;
      const loginKey = `${request.socket.remoteAddress ?? 'unknown'}:${email.slice(0, 254)}`;
      const now = clock().getTime();
      const previousFailure = runtime.loginFailures.get(loginKey);
      if (previousFailure && now - previousFailure.startedAt < LOGIN_FAILURE_WINDOW_MS && previousFailure.count >= LOGIN_FAILURE_LIMIT) {
        response.setHeader('retry-after', String(Math.ceil((LOGIN_FAILURE_WINDOW_MS - (now - previousFailure.startedAt)) / 1000)));
        finish(429, responsePayload(runtime, 'rate_limited', requestDetails, {
          error: { code: 'SIGN_IN_UNAVAILABLE', message: 'Unable to sign in.' },
        }));
        return;
      }
      let identity = null;
      if (/^[^\s@]+@[^\s@]+$/u.test(email) && password.length >= 1 && password.length <= 1024 && (body.rememberMe === undefined || typeof body.rememberMe === 'boolean')) {
        try {
          identity = await runtime.authenticateLogin({ email, password, rememberMe }, requestDetails);
        } catch {
          identity = null;
        }
      }
      if (identity === null || typeof identity !== 'object') {
        const active = previousFailure && now - previousFailure.startedAt < LOGIN_FAILURE_WINDOW_MS
          ? { startedAt: previousFailure.startedAt, count: previousFailure.count + 1 }
          : { startedAt: now, count: 1 };
        runtime.loginFailures.set(loginKey, active);
        finish(active.count >= LOGIN_FAILURE_LIMIT ? 429 : 401, responsePayload(runtime, active.count >= LOGIN_FAILURE_LIMIT ? 'rate_limited' : 'unauthorized', requestDetails, {
          error: { code: 'SIGN_IN_FAILED', message: 'Unable to sign in.' },
        }));
        return;
      }
      try {
        if (session !== null) runtime.webSecurity.logout(cookieHeader);
        const authenticated = runtime.webSecurity.createAuthenticatedSession(identity);
        const csrfToken = runtime.webSecurity.csrf.issue(authenticated.session).token;
        runtime.loginFailures.delete(loginKey);
        response.setHeader('set-cookie', authenticated.setCookie);
        finish(200, responsePayload(runtime, 'ok', requestDetails, {
          authenticated: true,
          user: publicSessionUser(authenticated.session),
          csrfToken,
        }));
      } catch {
        finish(401, responsePayload(runtime, 'unauthorized', requestDetails, {
          error: { code: 'SIGN_IN_FAILED', message: 'Unable to sign in.' },
        }));
      }
      return;
    }

    if (path === '/api/session') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD');
        finish(405, responsePayload(runtime, 'method_not_allowed', requestDetails, { allow: ['GET', 'HEAD'] }));
        return;
      }
      if (session === null) {
        clearExpiredCookie();
        finish(200, responsePayload(runtime, 'ok', requestDetails, { authenticated: false }));
        return;
      }
      const csrfToken = runtime.webSecurity.csrf.issue(session).token;
      finish(200, responsePayload(runtime, 'ok', requestDetails, {
        authenticated: true,
        user: publicSessionUser(session),
        csrfToken,
      }));
      return;
    }

    if (path === '/api/session/logout') {
      if (method !== 'POST') {
        response.setHeader('allow', 'POST');
        finish(405, responsePayload(runtime, 'method_not_allowed', requestDetails, { allow: ['POST'] }));
        return;
      }
      if (session === null) { unauthorized(); return; }
      try {
        runtime.webSecurity.csrf.validateRequest(session, { headerToken: requestHeader(request, CSRF_HEADER_NAME) });
      } catch {
        finish(403, responsePayload(runtime, 'forbidden', requestDetails, {
          error: { code: 'CSRF_INVALID', message: 'The request could not be verified.' },
        }));
        return;
      }
      const result = runtime.webSecurity.logout(cookieHeader);
      response.setHeader('set-cookie', result.clearCookie);
      finish(200, responsePayload(runtime, 'ok', requestDetails, { authenticated: false }));
      return;
    }

    if (API_GET_ROUTES.has(path)) {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD');
        finish(405, responsePayload(runtime, 'method_not_allowed', requestDetails, { allow: ['GET', 'HEAD'] }));
        return;
      }
      if (session === null) { unauthorized(); return; }
      const resourceName = API_GET_ROUTES.get(path)!;
      try {
        const data = await runtime.apiResources[resourceName]({
          tenantId: session.tenantId,
          userId: session.userId,
          role: session.role,
        });
        const directResource = resourceName === 'mail'
          ? { messages: Array.isArray(data?.messages) ? data.messages : [] }
          : resourceName === 'calendar'
            ? { events: Array.isArray(data?.events) ? data.events : [] }
            : resourceName === 'contacts'
              ? { contacts: Array.isArray(data?.contacts) ? data.contacts : [] }
              : { services: Array.isArray(data?.services) ? data.services : [] };
        finish(200, responsePayload(runtime, 'ok', requestDetails, {
          scope: { tenantId: session.tenantId, userId: session.userId },
          ...directResource,
          data,
        }));
      } catch {
        finish(503, responsePayload(runtime, 'unavailable', requestDetails, {
          error: { code: 'RESOURCE_UNAVAILABLE', message: 'The requested resource is unavailable.' },
        }));
      }
      return;
    }

    if (path.startsWith('/dav/calendars/') || path.startsWith('/dav/contacts/')) {
      if (session === null) { unauthorized(); return; }
      completed = true;
      await handleDavRoute({
        runtime,
        request,
        response,
        method,
        path,
        session,
        requestDetails,
        scopedLogger,
        startedAt,
        route,
      });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      finish(
        405,
        responsePayload(runtime, 'method_not_allowed', requestDetails, {
          allow: ['GET', 'HEAD'],
        }),
      );
      return;
    }

    if (WELL_KNOWN_PATH_VALUES.has(path)) {
      if (runtime.discoveryContract === undefined || runtime.discoveryTenantId === undefined) {
        finish(404, responsePayload(runtime, 'not_found', requestDetails, {
          reason: 'discovery_not_configured',
        }));
        return;
      }
      try {
        const resource = getWellKnownResource(runtime.discoveryContract, path, {
          tenantId: runtime.discoveryTenantId,
        });
        completed = true;
        writeResource(response, resource, method, requestDetails);
        const durationMs = elapsedMilliseconds(startedAt);
        runtime.metrics.recordRequest({ method, route, statusCode: resource.statusCode, durationMs });
        scopedLogger.info('request_completed', {
          method,
          route,
          status_code: resource.statusCode,
          duration_ms: Number(durationMs.toFixed(3)),
          result: resource.statusCode < 400 ? 'success' : 'failure',
        });
      } catch (error) {
        finish(404, responsePayload(runtime, 'not_found', requestDetails, {
          reason: error !== null && typeof error === 'object' && 'code' in error && error.code === 'SERVICE_DISABLED' ? 'discovery_service_disabled' : 'discovery_unavailable',
        }));
      }
      return;
    }

    if (path === '/health/live' || path === '/healthz') {
      finish(
        200,
        responsePayload(runtime, 'ok', requestDetails, {
          checks: { process: 'ok' },
        }),
      );
      return;
    }

    if (path === '/health/ready' || path === '/readyz') {
      const ready = readiness(runtime);
      finish(
        ready ? 200 : 503,
        responsePayload(runtime, ready ? 'ready' : 'not_ready', requestDetails, {
          checks: dependencyChecks(runtime),
          dependency_status: runtime.dependencies.overallStatus(),
        }),
      );
      return;
    }

    if (path === '/metrics') {
      finish(200, runtime.metrics.toPrometheus(), 'metrics');
      return;
    }

    if (path === '/ops/patch/status') {
      finish(
        200,
        responsePayload(runtime, 'ok', requestDetails, {
          patching: readPatchStatus(runtime.config),
        }),
      );
      return;
    }

    if (path === '/' || path === '/login') {
      const asset = staticFile(runtime, path);
      if (asset !== null) {
        completed = true;
        writeStatic(response, 200, asset.body, asset.contentType, method, requestDetails, asset.cacheControl);
        const durationMs = elapsedMilliseconds(startedAt);
        runtime.metrics.recordRequest({ method, route, statusCode: 200, durationMs });
        scopedLogger.info('request_completed', {
          method,
          route,
          status_code: 200,
          duration_ms: Number(durationMs.toFixed(3)),
          result: 'success',
        });
        return;
      }
      finish(
        200,
        responsePayload(runtime, 'ok', requestDetails, {
          endpoints: ['/health/live', '/health/ready', '/healthz', '/readyz', '/metrics', '/ops/patch/status'],
        }),
      );
      return;
    }

    if (path.startsWith('/web/') || path === '/assets/gulo-gulo-calendar-mail.png') {
      const asset = staticFile(runtime, path);
      if (asset !== null) {
        completed = true;
        writeStatic(response, 200, asset.body, asset.contentType, method, requestDetails, asset.cacheControl);
        const durationMs = elapsedMilliseconds(startedAt);
        runtime.metrics.recordRequest({ method, route, statusCode: 200, durationMs });
        scopedLogger.info('request_completed', {
          method,
          route,
          status_code: 200,
          duration_ms: Number(durationMs.toFixed(3)),
          result: 'success',
        });
        return;
      }
    }

    finish(
      404,
      responsePayload(runtime, 'not_found', requestDetails, {
        reason: 'route_not_found',
      }),
    );
  });

  runtime.server.on('clientError', (error, socket) => {
    runtime.logger.warn('http_client_error', {
      error: { name: error.name },
      reason: 'malformed_request',
    });
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return runtime;
}

export function startServer(runtime: RuntimeServer = createRuntimeServer()): Promise<RuntimeServer> {
  return new Promise<RuntimeServer>((resolve, reject) => {
    const handleError = (error: Error): void => {
      runtime.server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      runtime.server.off('error', handleError);
      runtime.state.ready = true;
      const address = runtime.server.address();
      runtime.logger.info('runtime_listening', {
        host: runtime.config.host,
        port:
          typeof address === 'object' && address !== null
            ? address.port
            : runtime.config.port,
        result: 'success',
      });
      resolve(runtime);
    };

    runtime.server.once('error', handleError);
    runtime.server.once('listening', handleListening);
    runtime.logger.info('runtime_starting', {
      host: runtime.config.host,
      port: runtime.config.port,
    });
    runtime.server.listen(runtime.config.port, runtime.config.host);
  });
}

export function stopServer(
  runtime: RuntimeServer,
  { signal = 'manual', timeoutMs = runtime.config.shutdownTimeoutMs }: { signal?: string; timeoutMs?: number } = {},
): Promise<void> {
  if (runtime.state.shuttingDown) {
    return Promise.resolve();
  }

  runtime.state.shuttingDown = true;
  runtime.state.ready = false;
  runtime.logger.info('runtime_shutdown_requested', { signal });

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (event: string, details: Record<string, unknown> = {}): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      runtime.logger.info(event, { signal, ...details });
      resolve();
    };

    const timeoutHandle = setTimeout(() => {
      runtime.logger.warn('runtime_shutdown_timeout', { signal });
      runtime.server.closeAllConnections?.();
      finish('runtime_stopped', { forced: true });
    }, timeoutMs);
    timeoutHandle.unref?.();

    runtime.server.close((error?: Error) => {
      if (error) {
        runtime.logger.error('runtime_shutdown_error', { error });
        finish('runtime_stopped', { forced: false, error: error.name });
        return;
      }

      finish('runtime_stopped', { forced: false });
    });
  });
}
