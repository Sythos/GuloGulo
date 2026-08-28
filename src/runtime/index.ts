// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRuntimeServer, startServer, stopServer } from './server.js';

let runtime;
let stopping = false;

function loggerOptions(config) {
  const contract = config?.contract ?? config ?? {};
  return {
    ...config,
    version: contract.buildVersion ?? config?.buildVersion ?? '0.1.2',
    build: contract.buildDigest ?? config?.buildDigest ?? 'development',
  };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(loggerOptions(config));
  runtime = createRuntimeServer({ config, logger });
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
