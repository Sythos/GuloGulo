#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Runs pending PostgreSQL migrations for a standalone Gulo Gulo install.
// Expected to run from the install root (next to dist/, .env, package.json)
// with `.env` already loaded into the environment, e.g.:
//
//   node --env-file=.env run-migrations.mjs
//
// Skips cleanly when POSTGRES_ENABLED=false, which is the .env.example
// default, so a fresh install with no external database configured yet
// completes without error. This package does not provision a secret store;
// see doc/identity-and-postgres.md in the source repository for the
// POSTGRES_DSN_SECRET_REF contract. When PostgreSQL is enabled, the operator
// must resolve that reference themselves and provide the connection string
// in the GULOGULO_POSTGRES_DSN environment variable (never written to .env
// in this script, never logged) before running this script.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configModule = join(scriptDirectory, 'dist/server/src/runtime/config.js');
const postgresModule = join(scriptDirectory, 'dist/server/src/integrations/postgres-store.js');

const { loadConfig } = await import(pathToFileURL(configModule).href);
const { createPostgresStore } = await import(pathToFileURL(postgresModule).href);

const config = loadConfig();
const postgres = config?.contract?.postgres;

if (!postgres || postgres.enabled !== true) {
  console.log('[migrations] POSTGRES_ENABLED=false; nothing to migrate.');
  process.exit(0);
}

const dsnSecretRef = postgres.dsnSecretRef;
if (!dsnSecretRef) {
  console.error('[migrations] POSTGRES_ENABLED=true but POSTGRES_DSN_SECRET_REF is not set.');
  process.exit(1);
}

const dsn = process.env.GULOGULO_POSTGRES_DSN;
if (!dsn) {
  console.error('[migrations] POSTGRES_ENABLED=true but GULOGULO_POSTGRES_DSN is not set in the environment.');
  console.error(`[migrations] It must resolve the secret referenced by POSTGRES_DSN_SECRET_REF=${dsnSecretRef}.`);
  process.exit(1);
}

const store = createPostgresStore({
  config,
  resolveSecret: async (reference) => (reference === dsnSecretRef ? dsn : undefined),
  logger: console,
});

try {
  const result = await store.runMigrations();
  const appliedThisRun = result.applied.length;
  console.log(`[migrations] schema at ${result.current ?? '(none)'} (${appliedThisRun} migration(s) applied this run).`);
} finally {
  await store.close();
}
