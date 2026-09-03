#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/**
 * CLI entry point that runs one `retention.ts` purge batch and exits. Meant
 * to be invoked periodically by a host-level scheduler — a systemd timer on
 * every current packaging target, matching the project's existing "the host
 * owns scheduling" convention (systemd manages the long-running service
 * itself; see `packaging/shared/gulogulo-rpm.service`). See
 * `packaging/shared/gulogulo-purge.timer` / `gulogulo-purge.service`.
 *
 * VERIFY BEFORE USE — this script's real-world effect today is "logs a
 * message and exits 0": `createRetentionStore()` (`./retention.ts`) keeps
 * its state in a process-local `Map`, so a fresh `node run-purge-batch.ts`
 * invocation always starts with zero trashed items and purges nothing,
 * regardless of what a previous run did. That is not a bug in this script —
 * it is the actual, honest state of `retention.ts` today (see its own file
 * comment: "Metadata-only trash retention contract"; no persistent backing
 * store exists in this repository yet). `resolveRetentionStore()` below is
 * the seam: it reports `persistent: false` for the in-memory store, and this
 * script treats that as "nothing to purge" — mirroring exactly how
 * `packaging/standalone/scripts/run-migrations.mjs` exits cleanly with
 * `POSTGRES_ENABLED=false`. The day a persistent retention store exists
 * (e.g. PostgreSQL-backed, mirroring
 * `src/core/dav/caldav/postgres-caldav-store.ts`), swap it in here — the
 * timer/service files and this script's process/exit-code plumbing do not
 * need to change.
 *
 * Not wired into `npm run build:server` or any packaging script yet — see
 * `doc/lifecycle-backup-dr.md` for what that follow-up requires.
 */

import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRetentionStore } from './retention.ts';
import type { PurgeBatchResult, RetentionStore } from './retention.ts';

export interface RetentionStoreResolution {
  readonly store: RetentionStore;
  /** `false` for the in-memory store this repository ships today — see the file comment above. */
  readonly persistent: boolean;
}

export type RetentionStoreResolver = () => RetentionStoreResolution | Promise<RetentionStoreResolution>;

/**
 * Default resolver: the only `RetentionStore` implementation this repository
 * has. Always reports `persistent: false` — see the file comment above for
 * why that is the honest answer today, not a placeholder bug.
 */
export function resolveDefaultRetentionStore(): RetentionStoreResolution {
  return { store: createRetentionStore(), persistent: false };
}

const WORKER_ID_SANITIZE_PATTERN = /[^A-Za-z0-9._:@/-]/gu;

/** Keeps a generated worker id inside `retention.ts`'s `assertId()` charset (`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`) without depending on that regex directly. */
export function sanitizeWorkerId(value: string): string {
  const cleaned = value.replaceAll(WORKER_ID_SANITIZE_PATTERN, '-').slice(0, 128);
  return /^[A-Za-z0-9]/u.test(cleaned) ? cleaned : `worker-${cleaned}`.slice(0, 128);
}

export interface RunPurgeBatchOptions {
  readonly workerId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly limit?: number;
  readonly resolveStore?: RetentionStoreResolver;
  readonly log?: Pick<Console, 'log' | 'error'>;
}

export interface RunPurgeBatchOutcome {
  readonly ran: boolean;
  readonly result: PurgeBatchResult | null;
}

/**
 * Runs exactly one purge batch and returns without throwing on a normal
 * "nothing to purge" outcome (unconfigured persistent store, or a
 * successful-but-empty batch). Exported so tests and a future scheduler can
 * call it directly instead of shelling out to this file.
 */
export async function runPurgeBatchOnce(options: RunPurgeBatchOptions = {}): Promise<RunPurgeBatchOutcome> {
  const {
    workerId = sanitizeWorkerId(`purge-${hostname()}-${process.pid}`),
    tenantId,
    userId,
    limit,
    resolveStore = resolveDefaultRetentionStore,
    log = console,
  } = options;

  const resolution = await resolveStore();
  if (!resolution.persistent) {
    log.log('[purge] no persistent retention store configured; nothing to purge (see doc/lifecycle-backup-dr.md).');
    return { ran: false, result: null };
  }

  const result = resolution.store.runPurgeBatch({ workerId, tenantId, userId, limit });
  log.log(`[purge] batch ${result.operationId} (worker=${workerId}): scanned=${result.scanned} purged=${result.purged} skipped=${result.skipped} failed=${result.failed} remaining=${result.remaining}`);
  if (result.failed > 0) log.error(`[purge] ${result.failed} item(s) failed this batch; see audit events for detail.`);
  return { ran: true, result };
}

async function main(): Promise<void> {
  const outcome = await runPurgeBatchOnce({
    tenantId: process.env.GULOGULO_PURGE_TENANT_ID || undefined,
    userId: process.env.GULOGULO_PURGE_USER_ID || undefined,
    limit: process.env.GULOGULO_PURGE_BATCH_LIMIT ? Number(process.env.GULOGULO_PURGE_BATCH_LIMIT) : undefined,
  });
  if (outcome.result && outcome.result.failed > 0) process.exitCode = 1;
}

const invokedDirectly = typeof process.argv[1] === 'string' && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('[purge] fatal error', error);
    process.exitCode = 1;
  });
}
