// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createEnvironmentSecretResolver, createPlatformAdapterForTarget, createProvisionedLoginAuthenticator, resolvePlatformTarget } from './login.js';
import { createFixtureLoginAuthenticator, createRuntimeServer, startServer, stopServer } from './server.js';

let runtime;
let stopping = false;

function loggerOptions(config) {
  const contract = config?.contract ?? config ?? {};
  return {
    ...config,
    version: contract.buildVersion ?? config?.buildVersion ?? '0.1.7',
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

/**
 * Resolves the persistent CalDAV/CardDAV storage backends
 * (`PlatformAdapter.createDavStore()`) for the `/dav/*` HTTP surface in
 * `src/runtime/server.ts`, the same way `resolveLoginAuthenticator()` above
 * resolves an identity client — same target selection
 * (`GULOGULO_PLATFORM`/`resolvePlatformTarget()`), same environment secret
 * resolver. A misconfigured or unreachable PostgreSQL target must not crash
 * server startup: on failure this logs a warning and returns `undefined`,
 * which makes every `/dav/*` request respond `503 DAV_STORE_UNAVAILABLE`
 * instead of taking the whole process down.
 */
async function resolveDavStore(config, logger, environment = process.env) {
  try {
    const resolveSecret = createEnvironmentSecretResolver(environment);
    const adapter = createPlatformAdapterForTarget(resolvePlatformTarget(environment), { environment, resolveSecret, logger });
    return await adapter.createDavStore(config);
  } catch (error) {
    logger.warn?.('dav_store_unavailable', { error: { name: error?.name, code: error?.code } });
    return undefined;
  }
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(loggerOptions(config));
  const authenticateLogin = resolveLoginAuthenticator(config, logger);
  const davStore = await resolveDavStore(config, logger);
  runtime = createRuntimeServer({ config, logger, authenticateLogin, davStore });
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
