// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';

import { loadConfig } from './config.mjs';
import { createDependencyRegistry, createMetrics } from './metrics.mjs';
import { createLogger } from './logger.mjs';

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
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATCH_STATUS_VALUES = new Set([
  'unknown',
  'checking',
  'updates_available',
  'applying',
  'current',
  'failed',
]);

function buildMetadata(config) {
  const contract = config?.contract ?? config ?? {};
  return {
    version: contract.buildVersion ?? config?.buildVersion ?? '0.0.0',
    build_digest: contract.buildDigest ?? config?.buildDigest ?? 'development',
  };
}

function safeRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    return undefined;
  }

  return value;
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestContext(request) {
  const requestId = safeRequestId(requestHeader(request, 'x-request-id')) ?? randomUUID();
  const correlationId =
    safeRequestId(requestHeader(request, 'x-correlation-id')) ?? requestId;

  return {
    request_id: requestId,
    correlation_id: correlationId,
  };
}

function responsePayload(runtime, status, requestDetails, details = {}) {
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

function writeJson(response, statusCode, payload, method, requestDetails) {
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

function writeMetrics(response, body, method, requestDetails) {
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

function requestPath(request) {
  try {
    return new URL(request.url ?? '/', 'http://gulogulo.invalid').pathname;
  } catch {
    return null;
  }
}

function routeName(path) {
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
  if (path === '/') {
    return '/';
  }
  return 'unmatched';
}

function patchStatusFile(config) {
  return config?.contract?.patching?.statusFile ?? config?.patching?.statusFile ?? '/var/lib/gulogulo/patch/status.json';
}

function readPatchStatus(config) {
  try {
    const parsed = JSON.parse(readFileSync(patchStatusFile(config), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid_status_shape');
    }

    const state = PATCH_STATUS_VALUES.has(parsed.state) ? parsed.state : 'unknown';
    const result = {
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

function elapsedMilliseconds(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function requestLogger(logger, requestDetails) {
  if (typeof logger.child === 'function') {
    return logger.child(requestDetails);
  }

  return logger;
}

function dependencyChecks(runtime) {
  return {
    process: runtime.state.ready ? 'ok' : 'starting',
    configuration: runtime.state.ready ? 'ok' : 'starting',
    dependencies: runtime.dependencies.snapshot(),
  };
}

function readiness(runtime) {
  return (
    runtime.state.ready &&
    !runtime.state.shuttingDown &&
    runtime.dependencies.isReady()
  );
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
} = {}) {
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

  const runtime = {
    config,
    logger,
    metrics: runtimeMetrics,
    dependencies: runtimeDependencies,
    state,
    clock,
    server: null,
  };

  runtime.server = createHttpServer((request, response) => {
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

    const finish = (statusCode, payload, contentType = 'json') => {
      if (completed) {
        return;
      }
      completed = true;

      if (contentType === 'metrics') {
        writeMetrics(response, payload, method, requestDetails);
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

    if (path === '/') {
      finish(
        200,
        responsePayload(runtime, 'ok', requestDetails, {
          endpoints: ['/health/live', '/health/ready', '/healthz', '/readyz', '/metrics', '/ops/patch/status'],
        }),
      );
      return;
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

export function startServer(runtime = createRuntimeServer()) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      runtime.server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
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
  runtime,
  { signal = 'manual', timeoutMs = runtime.config.shutdownTimeoutMs } = {},
) {
  if (runtime.state.shuttingDown) {
    return Promise.resolve();
  }

  runtime.state.shuttingDown = true;
  runtime.state.ready = false;
  runtime.logger.info('runtime_shutdown_requested', { signal });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (event, details = {}) => {
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

    runtime.server.close((error) => {
      if (error) {
        runtime.logger.error('runtime_shutdown_error', { error });
        finish('runtime_stopped', { forced: false, error: error.name });
        return;
      }

      finish('runtime_stopped', { forced: false });
    });
  });
}
