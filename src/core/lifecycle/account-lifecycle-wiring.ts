// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/**
 * Connects `account-lifecycle.ts`'s auditable state machine to the two real
 * adapters this repository now has: `filesystem-backup-adapter.ts`
 * (Compito 1) and `retention.ts`'s `runPurgeBatch()` (Compito 2). It does
 * NOT implement deletion itself — `account-lifecycle.ts`'s own doc comment
 * ("adapters own permanent resource deletion") is not renegotiated here.
 * This module is a thin composition layer: it calls the adapters it was
 * given, collects their results, and only then calls the underlying store's
 * `completePurge()` — exactly the same contract a caller would have to
 * satisfy by hand, just wired up once instead of at every call site.
 *
 * Why a separate module instead of hooks inside `account-lifecycle.ts`:
 * `backup-contract.ts` and `account-lifecycle.ts` are deliberately pure,
 * dependency-free contracts (see their own file comments). Adding a backup
 * or retention import to either would break that property for every
 * caller, including ones that never touch a filesystem. Composing them here
 * instead means the pure contracts stay pure, and this module is the one
 * place that is allowed to know about both.
 */

import { accountError } from './account-lifecycle.ts';
import type { AccountLifecycleStore, AccountOperation, AccountResourceType, AccountScope } from './account-lifecycle.ts';
import type { PurgeBatchResult, RetentionStore } from './retention.ts';
import type { BackupStorageAdapter } from '../backup/filesystem-backup-adapter.ts';

type UnknownRecord = Record<string, unknown>;

export interface ResourcePurgeInput {
  readonly resource: AccountResourceType;
  readonly scope: AccountScope;
}

/**
 * Adapters own permanent resource deletion: this is the seam every resource
 * type in `AccountResourceType` other than `'backups'` is routed through
 * (aliases, delegations, factors, mailbox, dav_collections, preferences).
 * `'backups'` is handled directly by the injected `backupAdapter` instead,
 * since Compito 1 already provides a real, generic implementation for it —
 * no need to make the caller re-wrap it as a `ResourcePurgeExecutor`.
 */
export type ResourcePurgeExecutor = (input: ResourcePurgeInput) => Promise<'purged'>;

export interface AccountLifecycleWiringLogger {
  readonly info?: (event: string, details?: Record<string, unknown>) => void;
  readonly warn?: (event: string, details?: Record<string, unknown>) => void;
}

export interface AccountLifecycleWiringOptions {
  readonly lifecycleStore: AccountLifecycleStore;
  /** Called for every `cleanupPlan` resource except `'backups'` (see `ResourcePurgeExecutor`). */
  readonly purgeResource: ResourcePurgeExecutor;
  /** When provided, the `'backups'` resource is purged by calling `deleteAccountArchives()` on this adapter instead of `purgeResource`. */
  readonly backupAdapter?: BackupStorageAdapter;
  /** When provided, `completePurge()` also runs one retention purge batch scoped to the account, so trashed items belonging to a fully-purged account do not linger past the account's own recovery window. */
  readonly retentionStore?: RetentionStore;
  readonly retentionWorkerId?: string;
  readonly logger?: AccountLifecycleWiringLogger;
}

export interface CompletePurgeResult {
  readonly operation: AccountOperation;
  readonly resourceResults: Readonly<Record<string, 'purged'>>;
  /** `null` when no `retentionStore` was injected. */
  readonly retentionPurge: PurgeBatchResult | null;
}

export interface AccountLifecycleWiring {
  /**
   * Thin wrapper around `lifecycleStore.queuePurge()`. Async (unlike the
   * underlying store method) only so it can, best-effort, log how many
   * backup archives already exist for the account at the moment its
   * recovery window has elapsed — informational only, never blocking and
   * never mutating state beyond what `queuePurge()` itself does.
   */
  queuePurge(input?: UnknownRecord): Promise<AccountOperation>;
  /**
   * Executes the account's `cleanupPlan` against the injected adapters, then
   * calls `lifecycleStore.completePurge()` with the resulting
   * `resourceResults`. Re-checks state/confirmation/holds itself before
   * touching any adapter, so a caller mistake (wrong state, missing
   * confirmation, an active hold) fails closed before any real deletion
   * happens — not only when the underlying store finally rejects it.
   */
  completePurge(input?: UnknownRecord): Promise<CompletePurgeResult>;
}

function scopeOf(input: UnknownRecord): AccountScope {
  const tenantId = input.tenantId;
  const userId = input.userId;
  if (typeof tenantId !== 'string' || typeof userId !== 'string') {
    throw accountError('tenantId and userId are required', 'INVALID_INPUT');
  }
  return { tenantId, userId };
}

export function createAccountLifecycleWiring(options: AccountLifecycleWiringOptions): AccountLifecycleWiring {
  const { lifecycleStore, purgeResource, backupAdapter, retentionStore, retentionWorkerId = 'account-lifecycle-wiring', logger } = options;
  if (typeof lifecycleStore !== 'object' || lifecycleStore === null) throw accountError('lifecycleStore is required', 'INVALID_INPUT');
  if (typeof purgeResource !== 'function') throw accountError('purgeResource must be a function', 'INVALID_INPUT');

  async function queuePurge(input: UnknownRecord = {}): Promise<AccountOperation> {
    const operation = lifecycleStore.queuePurge(input);
    if (backupAdapter) {
      const scope = { tenantId: operation.account.tenantId, userId: operation.account.userId };
      const existingArchives = await backupAdapter.listArchives(scope).catch(() => [] as readonly string[]);
      logger?.info?.('account_lifecycle.purge_queued', { tenantId: scope.tenantId, userId: scope.userId, existingBackupArchives: existingArchives.length });
    }
    return operation;
  }

  async function completePurge(input: UnknownRecord = {}): Promise<CompletePurgeResult> {
    const scope = scopeOf(input);
    const account = lifecycleStore.getAccount(scope);

    // Fail closed before touching any adapter: replicate the same
    // pre-conditions account-lifecycle.ts's own completePurge() enforces
    // (state, strong confirmation, active holds) so a caller mistake never
    // triggers a real, permanent deletion that the store would then refuse
    // to record.
    if (account.state !== 'purge_pending') throw accountError(`account must be purge_pending, not ${account.state}`, 'INVALID_STATE_TRANSITION');
    if (input.confirmation !== `PURGE:${scope.userId}`) throw accountError('strong purge confirmation is required', 'STRONG_CONFIRMATION_REQUIRED');
    if (account.activeHoldIds.length > 0) throw accountError('account has an active hold', 'ACCOUNT_ON_HOLD');

    const resourceResults: Record<string, 'purged'> = {};
    for (const resource of account.cleanupPlan) {
      if (resource === 'backups' && backupAdapter) {
        await backupAdapter.deleteAccountArchives(scope);
      } else {
        const outcome = await purgeResource({ resource, scope });
        if (outcome !== 'purged') throw accountError(`resource purge did not complete: ${resource}`, 'PURGE_INCOMPLETE');
      }
      resourceResults[resource] = 'purged';
    }

    let retentionPurge: PurgeBatchResult | null = null;
    if (retentionStore) {
      retentionPurge = retentionStore.runPurgeBatch({ workerId: retentionWorkerId, tenantId: scope.tenantId, userId: scope.userId });
      logger?.info?.('account_lifecycle.retention_purge_batch', { tenantId: scope.tenantId, userId: scope.userId, purged: retentionPurge.purged, skipped: retentionPurge.skipped, failed: retentionPurge.failed });
    }

    const operation = lifecycleStore.completePurge({ ...input, resourceResults });
    return Object.freeze({ operation, resourceResults: Object.freeze(resourceResults), retentionPurge });
  }

  return Object.freeze({ queuePurge, completePurge });
}
