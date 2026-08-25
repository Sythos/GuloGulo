// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { createDependencyRegistry, createMetrics } from './metrics.js';
import { createLogger } from './logger.js';
import { getWellKnownResource, WELL_KNOWN_PATHS } from '../dav/discovery/index.ts';
import { CSRF_HEADER_NAME, createWebSecurity } from '../web/security/index.ts';
import type { SessionIdentity, WebSecurity, WebSession } from '../web/security/index.ts';

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
  authenticateLogin?: LoginAuthenticator;
  apiResources?: Partial<ApiResources>;
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
  authenticateLogin: LoginAuthenticator;
  apiResources: ApiResources;
  loginFailures: Map<string, { startedAt: number; count: number }>;
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
const PATCH_STATUS_VALUES = new Set([
  'unknown',
  'checking',
  'updates_available',
  'applying',
  'current',
  'failed',
]);
const WELL_KNOWN_PATH_VALUES = new Set<string>(Object.values(WELL_KNOWN_PATHS));
const API_BODY_MAX_BYTES = 16 * 1024;
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
    version: contract.buildVersion ?? config?.buildVersion ?? '0.0.0',
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

function readPatchStatus(config: RuntimeConfig): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(patchStatusFile(config), 'utf8')) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid_status_shape');
    }

    const state = typeof parsed.state === 'string' && PATCH_STATUS_VALUES.has(parsed.state) ? parsed.state : 'unknown';
    const result: Record<string, unknown> = {
      schemaVersion: 1,
      state,
    };
    for (const key of ['checkedAt', 'updatedAt', 'baseImage', 'nodeVersion', 'reason']) {
      if (typeof parsed[key] === 'string' && /^[A-Za-z0-9._:+/-]{1,255}$/.test(parsed[key])) {
        result[key] = parsed[key];
      }
    }
    return result;
  } catch {
    return {
      schemaVersion: 1,
      state: 'unknown',
      reason: 'status_unavailable',
    };
  }
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

function publicSessionUser(session: WebSession) {
  return Object.freeze({
    tenantId: session.tenantId,
    domain: session.domain,
    userId: session.userId,
    email: session.userId.includes('@') ? session.userId : `${session.userId}@${session.domain}`,
    role: session.role,
  });
}

function equalFixtureSecret(supplied: unknown, expected: string): boolean {
  const suppliedDigest = createHash('sha256').update(String(supplied), 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
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
    const emailMatches = equalFixtureSecret(credentials?.email ?? '', canonicalEmail);
    const passwordMatches = equalFixtureSecret(credentials?.password ?? '', password);
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
  authenticateLogin = createFixtureLoginAuthenticator(),
  apiResources = defaultApiResources(),
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
    authenticateLogin,
    apiResources: { ...defaultApiResources(), ...apiResources },
    loginFailures: new Map(),
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

    if (path === null) {
      finish(
        400,
        responsePayload(runtime, 'bad_request', requestDetails, {
          reason: 'invalid_request_target',
        }),
      );
      return;
    }

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
