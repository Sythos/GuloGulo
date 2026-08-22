// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createServer as createHttpServer } from 'node:http';

import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

function responsePayload(runtime, status, details = {}) {
  return {
    status,
    service: runtime.config.serviceName,
    timestamp: new Date().toISOString(),
    ...details,
  };
}

function writeJson(response, statusCode, payload, method) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(body),
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

/**
 * Build the dependency-free HTTP surface used by the first Docker milestone.
 * External LDAP, PostgreSQL, mail, and DAV integrations are deliberately not
 * represented as fake readiness checks at this stage.
 */
export function createRuntimeServer({
  config = loadConfig(),
  logger = createLogger(config),
  clock = () => new Date(),
} = {}) {
  const state = {
    ready: false,
    shuttingDown: false,
  };

  const runtime = {
    config,
    logger,
    state,
    clock,
    server: null,
  };

  runtime.server = createHttpServer((request, response) => {
    const path = requestPath(request);
    const method = request.method ?? 'GET';

    if (path === null) {
      writeJson(response, 400, responsePayload(runtime, 'bad_request'), method);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      writeJson(response, 405, responsePayload(runtime, 'method_not_allowed'), method);
      return;
    }

    if (path === '/health/live' || path === '/healthz') {
      writeJson(
        response,
        200,
        responsePayload(runtime, 'ok', {
          checks: { process: 'ok' },
        }),
        method,
      );
      return;
    }

    if (path === '/health/ready' || path === '/readyz') {
      const ready = state.ready && !state.shuttingDown;
      writeJson(
        response,
        ready ? 200 : 503,
        responsePayload(runtime, ready ? 'ready' : 'not_ready', {
          checks: { configuration: ready ? 'ok' : 'starting' },
        }),
        method,
      );
      return;
    }

    if (path === '/') {
      writeJson(
        response,
        200,
        responsePayload(runtime, 'ok', { endpoints: ['/healthz', '/readyz'] }),
        method,
      );
      return;
    }

    writeJson(response, 404, responsePayload(runtime, 'not_found'), method);
  });

  runtime.server.on('clientError', (error, socket) => {
    logger.warn('http_client_error', { error: { name: error.name } });
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
        port: typeof address === 'object' && address !== null ? address.port : runtime.config.port,
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

export function stopServer(runtime, { signal = 'manual', timeoutMs = runtime.config.shutdownTimeoutMs } = {}) {
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
