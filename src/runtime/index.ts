// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createProvisionedLoginAuthenticator } from './login.js';
import { createFixtureLoginAuthenticator, createRuntimeServer, startServer, stopServer } from './server.js';

let runtime;
let stopping = false;

function loggerOptions(config) {
  const contract = config?.contract ?? config ?? {};
  return {
    ...config,
    version: contract.buildVersion ?? config?.buildVersion ?? '0.1.4',
    build: contract.buildDigest ?? config?.buildDigest ?? 'development',
  };
}

/**
 * `GULOGULO_FIXTURE_MODE=true` keeps using the explicit local-proof fixture
 * authenticator, unchanged, so existing fixture-driven tests/smoke checks
 * keep working. Every other run resolves the real `PlatformAdapter` for the
 * configured target (`GULOGULO_PLATFORM`, default `standalone`) and calls its
 * real identity client instead of the fixed "always reject" stub this used to
 * fall back to.
 */
function resolveLoginAuthenticator(config, logger, environment = process.env) {
  if (environment.GULOGULO_FIXTURE_MODE === 'true') {
    return createFixtureLoginAuthenticator(environment);
  }
  return createProvisionedLoginAuthenticator({ environment, config, logger });
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(loggerOptions(config));
  const authenticateLogin = resolveLoginAuthenticator(config, logger);
  runtime = createRuntimeServer({ config, logger, authenticateLogin });
  await startServer(runtime);

  const shutdown = async (signal) => {
    if (stopping) {
      return;
    }

    stopping = true;
    await stopServer(runtime, { signal });
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  const logger = createLogger();
  logger.error('runtime_start_failed', { error });
  process.exitCode = 1;
});
