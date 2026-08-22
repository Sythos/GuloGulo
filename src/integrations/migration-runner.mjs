// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_FILE_PATTERN = /^(\d{4}_[A-Za-z0-9_-]+)\.sql$/;
const LOCK_KEY = 'gulogulo.schema';

function migrationError(message) {
  return new Error(`Migration error: ${message}`);
}

async function loadMigrations(directory) {
  const names = (await readdir(directory)).filter((name) => MIGRATION_FILE_PATTERN.test(name)).sort();
  const migrations = [];
  for (const name of names) {
    const version = name.slice(0, -4);
    const sql = await readFile(join(directory, name), 'utf8');
    migrations.push({ version, checksum: createHash('sha256').update(sql).digest('hex'), sql });
  }
  return migrations;
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export function createMigrationRunner({ client, migrationDirectory = new URL('../db/migrations', import.meta.url), logger = console } = {}) {
  if (!client || typeof client.query !== 'function') {
    throw migrationError('a PostgreSQL client is required');
  }
  const directory = migrationDirectory instanceof URL ? fileURLToPath(migrationDirectory) : String(migrationDirectory);

  return {
    async run() {
      const migrations = await loadMigrations(directory);
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
        await ensureTable(client);
        const existing = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
        const checksums = new Map(existing.rows.map((row) => [row.version, row.checksum]));
        for (const migration of migrations) {
          const knownChecksum = checksums.get(migration.version);
          if (knownChecksum !== undefined && knownChecksum !== migration.checksum) {
            throw migrationError(`checksum mismatch for ${migration.version}`);
          }
          if (knownChecksum === undefined) {
            await client.query(migration.sql);
            await client.query(
              'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
              [migration.version, migration.checksum],
            );
            logger.info?.('migration_applied', { version: migration.version });
          }
        }
        await client.query('COMMIT');
        return { current: migrations.at(-1)?.version ?? null, applied: migrations.map(({ version }) => version) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },

    async status() {
      await ensureTable(client);
      const result = await client.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version');
      return result.rows.map((row) => ({ ...row }));
    },
  };
}
