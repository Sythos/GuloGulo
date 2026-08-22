// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { isIP } from 'node:net';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8080;
const DEFAULT_SERVICE_NAME = 'gulogulo-runtime';
const DEFAULT_ENVIRONMENT = 'development';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readText(value, name, pattern) {
  if (typeof value !== 'string' || value.length === 0 || !pattern.test(value)) {
    throw new Error(`${name} must be a non-empty value using the supported characters`);
  }

  return value;
}

function readPort(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('GULOGULO_PORT must be an integer between 1 and 65535');
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('GULOGULO_PORT must be an integer between 1 and 65535');
  }

  return port;
}

function readShutdownTimeout(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('GULOGULO_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 60000');
  }

  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
    throw new Error('GULOGULO_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 60000');
  }

  return timeout;
}

function readHost(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('GULOGULO_HOST must be a valid IP address or hostname');
  }

  if (isIP(value) !== 0 || HOSTNAME_PATTERN.test(value)) {
    return value;
  }

  throw new Error('GULOGULO_HOST must be a valid IP address or hostname');
}

/**
 * Read only the runtime settings that are safe to expose to the process.
 * Secrets and external-service credentials are intentionally not part of this
 * scaffold configuration object.
 */
export function loadConfig(environment = process.env) {
  const host = readHost(environment.GULOGULO_HOST ?? environment.HOST ?? DEFAULT_HOST);
  const port = readPort(environment.GULOGULO_PORT ?? environment.PORT ?? String(DEFAULT_PORT));
  const serviceName = readText(
    environment.GULOGULO_SERVICE_NAME ?? DEFAULT_SERVICE_NAME,
    'GULOGULO_SERVICE_NAME',
    SAFE_NAME_PATTERN,
  );
  const runtimeEnvironment = readText(
    environment.GULOGULO_ENV ?? environment.APP_ENV ?? DEFAULT_ENVIRONMENT,
    'GULOGULO_ENV',
    SAFE_NAME_PATTERN,
  );
  const shutdownTimeoutMs = readShutdownTimeout(
    environment.GULOGULO_SHUTDOWN_TIMEOUT_MS ?? String(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  );

  return Object.freeze({
    host,
    port,
    serviceName,
    environment: runtimeEnvironment,
    shutdownTimeoutMs,
  });
}
