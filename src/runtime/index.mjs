// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createRuntimeServer, startServer, stopServer } from './server.mjs';

let runtime;
let stopping = false;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
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
