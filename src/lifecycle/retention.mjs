// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID } from 'node:crypto';

/**
 * Server-side trash retention contract.
 *
 * This module stores metadata only. The mailbox, DAV, and backup stores remain
 * the sources of truth for user content and can be connected through the
 * optional `purgeItem` callback. A record is marked purged only after that
 * callback succeeds, which makes a retry safe after a worker or container
 * restart.
 */

export const RETENTION_SCHEMA_VERSION = 1;
export const DEFAULT_TRASH_RETENTION_DAYS = 28;
export const DEFAULT_PURGE_BATCH_SIZE = 100;
export const DEFAULT_LOCK_LEASE_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const MAX_REASON_LENGTH = 256;
const DEFAULT_RESOURCE_TYPES = new Set([
  'mail',
  'calendar',
  'contacts',
  'preferences',
  'backup',
]);

export const RETENTION_ITEM_STATES = Object.freeze({
  TRASHED: 'trashed',
  RESTORED: 'restored',
  PURGED: 'purged',
});

export const RETENTION_METRIC_NAMES = Object.freeze({
  ITEMS_TRASHED: 'gulogulo_retention_items_trashed_total',
  ITEMS_RESTORED: 'gulogulo_retention_items_restored_total',
  ITEMS_HELD: 'gulogulo_retention_items_held_total',
  ITEMS_LOCKED: 'gulogulo_retention_items_locked_total',
  PURGE_BATCHES: 'gulogulo_retention_purge_batches_total',
  PURGE_CANDIDATES: 'gulogulo_retention_purge_candidates_total',
  ITEMS_PURGED: 'gulogulo_retention_items_purged_total',
  ITEMS_SKIPPED: 'gulogulo_retention_items_skipped_total',
  PURGE_FAILURES: 'gulogulo_retention_purge_failures_total',
  HOLDS_ADDED: 'gulogulo_retention_holds_added_total',
  HOLDS_RELEASED: 'gulogulo_retention_holds_released_total',
});

function retentionError(message, code = 'RETENTION_ERROR') {
  const error = new Error(`Retention error: ${message}`);
  error.code = code;
  return error;
}

function assertObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw retentionError(`${field} must be an object`, 'INVALID_INPUT');
  }
  return value;
}

function assertId(value, field) {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) {
    throw retentionError(`${field} is invalid`, 'INVALID_IDENTITY');
  }
  return value;
}

function assertOperationId(value, field = 'operationId') {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw retentionError(`${field} is invalid`, 'INVALID_OPERATION_ID');
  }
  return value;
}

function assertRole(value, field = 'role') {
  if (typeof value !== 'string' || !ROLE_PATTERN.test(value)) {
    throw retentionError(`${field} is invalid`, 'INVALID_ROLE');
  }
  return value;
}

function toDate(value, field, fallback = undefined) {
  const candidate = value === undefined ? fallback : value;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw retentionError(`${field} is invalid`, 'INVALID_TIMESTAMP');
  }
  return date;
}

function toIso(value, field, fallback = undefined) {
  return toDate(value, field, fallback).toISOString();
}

function assertSafeResourceType(value, field = 'resourceType') {
  if (typeof value !== 'string' || !RESOURCE_TYPE_PATTERN.test(value)) {
    throw retentionError(`${field} is invalid`, 'INVALID_RESOURCE_TYPE');
  }
  return value;
}

function assertRetentionDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw retentionError('retentionDays must be an integer between 1 and 3650', 'INVALID_RETENTION_POLICY');
  }
  return value;
}

function assertBatchSize(value, maxBatchSize) {
  if (!Number.isInteger(value) || value < 1 || value > maxBatchSize) {
    throw retentionError(`limit must be an integer between 1 and ${maxBatchSize}`, 'INVALID_BATCH_SIZE');
  }
  return value;
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneAndFreeze(item)));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneAndFreeze(item);
    return Object.freeze(copy);
  }
  return value;
}

function normalizeActor(actor, fallbackUserId = undefined) {
  if (actor === undefined) {
    return Object.freeze({
      actorId: fallbackUserId ?? 'retention-worker',
      role: fallbackUserId ? 'user' : 'system',
    });
  }
  assertObject(actor, 'actor');
  const actorId = assertId(actor.actorId, 'actor.actorId');
  const role = assertRole(actor.role ?? 'user', 'actor.role');
  return Object.freeze({ actorId, role });
}

function normalizeScope(input, { requireItem = true } = {}) {
  assertObject(input, 'scope');
  const tenantId = assertId(input.tenantId, 'scope.tenantId');
  const userId = assertId(input.userId, 'scope.userId');
  const result = { tenantId, userId };
  if (requireItem) result.itemId = assertId(input.itemId, 'scope.itemId');
  return result;
}

function scopeKey({ tenantId, userId, itemId }) {
  return `${tenantId}\u0000${userId}\u0000${itemId}`;
}

function operationKey(scope, idempotencyKey) {
  return `${scopeKey(scope)}\u0000${idempotencyKey}`;
}

function normalizeHoldId(value) {
  return assertOperationId(value, 'holdId');
}

function normalizeReasonCode(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REASON_LENGTH || /[\r\n]/u.test(value)) {
    throw retentionError(`reasonCode must contain 1-${MAX_REASON_LENGTH} single-line characters`, 'INVALID_HOLD_REASON');
  }
  return value;
}

function assertLeaseMs(value) {
  if (!Number.isInteger(value) || value < 1000 || value > 24 * 60 * 60 * 1000) {
    throw retentionError('leaseMs must be between 1000 and 86400000 milliseconds', 'INVALID_LOCK_LEASE');
  }
  return value;
}

function createMetrics() {
  return Object.fromEntries(Object.values(RETENTION_METRIC_NAMES).map((name) => [name, 0]));
}

function increment(metrics, name, amount = 1) {
  metrics[name] = (metrics[name] ?? 0) + amount;
}

function createAuditEvent({ event, scope, actor, occurredAt, operationId, metadata = {} }) {
  return cloneAndFreeze({
    schemaVersion: RETENTION_SCHEMA_VERSION,
    event,
    occurredAt: toIso(occurredAt, 'occurredAt'),
    tenantId: scope.tenantId,
    userId: scope.userId,
    ...(scope.itemId ? { itemId: scope.itemId } : {}),
    actorId: actor.actorId,
    actorRole: actor.role,
    ...(operationId ? { operationId } : {}),
    metadata,
  });
}

function publicItem(record) {
  if (!record) return null;
  return cloneAndFreeze({
    schemaVersion: RETENTION_SCHEMA_VERSION,
    tenantId: record.tenantId,
    userId: record.userId,
    itemId: record.itemId,
    resourceType: record.resourceType,
    generation: record.generation,
    state: record.state,
    deletedAt: record.deletedAt,
    retentionUntil: record.retentionUntil,
    restoredAt: record.restoredAt,
    purgedAt: record.purgedAt,
    holdIds: [...record.holds.keys()],
    lock: record.lock
      ? {
          owner: record.lock.owner,
          acquiredAt: record.lock.acquiredAt,
          leaseExpiresAt: record.lock.leaseExpiresAt,
        }
      : null,
  });
}

function publicOperationResult(result) {
  return cloneAndFreeze(result);
}

function activeHolds(record, now) {
  const nowMs = now.getTime();
  return [...record.holds.values()].filter((hold) => hold.expiresAt === null || new Date(hold.expiresAt).getTime() > nowMs);
}

function isLockActive(record, now) {
  return record.lock !== null && new Date(record.lock.leaseExpiresAt).getTime() > now.getTime();
}

function assertPurgeWorker(actor) {
  if (actor.role !== 'system' && actor.role !== 'operations' && actor.role !== 'provider') {
    throw retentionError('only an operational worker may purge content', 'PURGE_ACTOR_DENIED');
  }
}

/**
 * Create an in-memory retention contract suitable for deterministic tests and
 * for an adapter-backed implementation. The contract deliberately returns
 * metadata envelopes, never message bodies, calendar data, or contact data.
 */
export function createRetentionStore({
  now = () => new Date(),
  retentionDays = DEFAULT_TRASH_RETENTION_DAYS,
  maxBatchSize = DEFAULT_PURGE_BATCH_SIZE,
  resourceTypes = DEFAULT_RESOURCE_TYPES,
  purgeItem = undefined,
} = {}) {
  if (typeof now !== 'function') throw retentionError('now must be a function', 'INVALID_CLOCK');
  const policyDays = assertRetentionDays(retentionDays);
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 10_000) {
    throw retentionError('maxBatchSize must be between 1 and 10000', 'INVALID_BATCH_SIZE');
  }
  if (typeof purgeItem !== 'undefined' && typeof purgeItem !== 'function') {
    throw retentionError('purgeItem must be a function when provided', 'INVALID_PURGE_ADAPTER');
  }
  const allowedResourceTypes = new Set(resourceTypes);
  for (const type of allowedResourceTypes) assertSafeResourceType(type, 'resourceTypes item');

  const records = new Map();
  const operationResults = new Map();
  const auditEvents = [];
  const metrics = createMetrics();

  function currentDate() {
    return toDate(now(), 'clock');
  }

  function requireItem(input) {
    const scope = normalizeScope(input);
    const record = records.get(scopeKey(scope));
    if (!record) throw retentionError('item does not exist', 'ITEM_NOT_FOUND');
    return { scope, record };
  }

  function appendAudit(event) {
    auditEvents.push(event);
    return event;
  }

  function checkResourceType(resourceType) {
    const type = assertSafeResourceType(resourceType);
    if (!allowedResourceTypes.has(type)) {
      throw retentionError(`resourceType ${type} is not enabled`, 'RESOURCE_TYPE_DISABLED');
    }
    return type;
  }

  function markDeleted({
    tenantId,
    userId,
    itemId,
    resourceType,
    deletedAt = currentDate(),
    idempotencyKey = randomUUID(),
    actor = undefined,
  } = {}) {
    const scope = normalizeScope({ tenantId, userId, itemId });
    const type = checkResourceType(resourceType);
    const key = assertOperationId(idempotencyKey, 'idempotencyKey');
    const opKey = operationKey(scope, key);
    const priorResult = operationResults.get(`delete\u0000${opKey}`);
    if (priorResult) return priorResult;
    const actorInfo = normalizeActor(actor, userId);
    const deletionDate = toDate(deletedAt, 'deletedAt');
    const old = records.get(scopeKey(scope));
    const generation = old ? old.generation + 1 : 1;
    const record = {
      ...scope,
      resourceType: type,
      generation,
      state: RETENTION_ITEM_STATES.TRASHED,
      deletedAt: deletionDate.toISOString(),
      retentionUntil: new Date(deletionDate.getTime() + policyDays * DAY_MS).toISOString(),
      restoredAt: null,
      purgedAt: null,
      holds: old?.holds ?? new Map(),
      lock: null,
    };
    records.set(scopeKey(scope), record);
    increment(metrics, RETENTION_METRIC_NAMES.ITEMS_TRASHED);
    const audit = appendAudit(createAuditEvent({
      event: 'retention.item_trashed',
      scope,
      actor: actorInfo,
      occurredAt: deletionDate,
      operationId: key,
      metadata: {
        resourceType: type,
        generation,
        retentionUntil: record.retentionUntil,
      },
    }));
    const result = publicOperationResult({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'item_trashed',
      idempotencyKey: key,
      item: publicItem(record),
      audit,
    });
    operationResults.set(`delete\u0000${opKey}`, result);
    return result;
  }

  function restoreItem({
    tenantId,
    userId,
    itemId,
    restoredAt = currentDate(),
    idempotencyKey = randomUUID(),
    actor = undefined,
  } = {}) {
    const scope = normalizeScope({ tenantId, userId, itemId });
    const key = assertOperationId(idempotencyKey, 'idempotencyKey');
    const opKey = operationKey(scope, key);
    const priorResult = operationResults.get(`restore\u0000${opKey}`);
    if (priorResult) return priorResult;
    const actorInfo = normalizeActor(actor, userId);
    const { record } = requireItem(scope);
    if (record.state === RETENTION_ITEM_STATES.PURGED) {
      throw retentionError('purged content cannot be restored by this contract', 'ITEM_ALREADY_PURGED');
    }
    const restoreDate = toDate(restoredAt, 'restoredAt');
    record.state = RETENTION_ITEM_STATES.RESTORED;
    record.restoredAt = restoreDate.toISOString();
    record.retentionUntil = null;
    record.lock = null;
    increment(metrics, RETENTION_METRIC_NAMES.ITEMS_RESTORED);
    const audit = appendAudit(createAuditEvent({
      event: 'retention.item_restored',
      scope,
      actor: actorInfo,
      occurredAt: restoreDate,
      operationId: key,
      metadata: { generation: record.generation },
    }));
    const result = publicOperationResult({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'item_restored',
      idempotencyKey: key,
      item: publicItem(record),
      audit,
    });
    operationResults.set(`restore\u0000${opKey}`, result);
    return result;
  }

  function addHold({
    tenantId,
    userId,
    itemId,
    holdId,
    reasonCode,
    expiresAt = null,
    actor,
    occurredAt = currentDate(),
  } = {}) {
    const scope = normalizeScope({ tenantId, userId, itemId });
    const hold = normalizeHoldId(holdId);
    const reason = normalizeReasonCode(reasonCode);
    const actorInfo = normalizeActor(actor, userId);
    const { record } = requireItem(scope);
    const expiry = expiresAt === null ? null : toIso(expiresAt, 'expiresAt');
    if (expiry && new Date(expiry).getTime() <= currentDate().getTime()) {
      throw retentionError('expiresAt must be in the future', 'INVALID_HOLD_EXPIRY');
    }
    if (record.holds.has(hold)) return cloneAndFreeze({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'hold_added',
      holdId: hold,
      item: publicItem(record),
      idempotent: true,
    });
    record.holds.set(hold, {
      holdId: hold,
      reasonCode: reason,
      createdAt: toIso(occurredAt, 'occurredAt'),
      expiresAt: expiry,
    });
    increment(metrics, RETENTION_METRIC_NAMES.ITEMS_HELD);
    increment(metrics, RETENTION_METRIC_NAMES.HOLDS_ADDED);
    const audit = appendAudit(createAuditEvent({
      event: 'retention.hold_added',
      scope,
      actor: actorInfo,
      occurredAt,
      metadata: { holdId: hold, reasonCode: reason, expiresAt: expiry },
    }));
    return cloneAndFreeze({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'hold_added',
      holdId: hold,
      item: publicItem(record),
      audit,
    });
  }

  function releaseHold({
    tenantId,
    userId,
    itemId,
    holdId,
    actor,
    occurredAt = currentDate(),
  } = {}) {
    const scope = normalizeScope({ tenantId, userId, itemId });
    const hold = normalizeHoldId(holdId);
    const actorInfo = normalizeActor(actor, userId);
    const { record } = requireItem(scope);
    if (!record.holds.has(hold)) {
      return cloneAndFreeze({
        schemaVersion: RETENTION_SCHEMA_VERSION,
        operation: 'hold_released',
        holdId: hold,
        item: publicItem(record),
        idempotent: true,
      });
    }
    record.holds.delete(hold);
    increment(metrics, RETENTION_METRIC_NAMES.HOLDS_RELEASED);
    const audit = appendAudit(createAuditEvent({
      event: 'retention.hold_released',
      scope,
      actor: actorInfo,
      occurredAt,
      metadata: { holdId: hold },
    }));
    return cloneAndFreeze({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'hold_released',
      holdId: hold,
      item: publicItem(record),
      audit,
    });
  }

  function acquireLock({
    tenantId,
    userId,
    itemId,
    lockId = randomUUID(),
    owner,
    leaseMs = DEFAULT_LOCK_LEASE_MS,
    acquiredAt = currentDate(),
  } = {}) {
    const scope = normalizeScope({ tenantId, userId, itemId });
    const lock = assertOperationId(lockId, 'lockId');
    const lockOwner = assertId(owner, 'owner');
    const duration = assertLeaseMs(leaseMs);
    const date = toDate(acquiredAt, 'acquiredAt');
    const { record } = requireItem(scope);
    if (record.lock && isLockActive(record, date) && record.lock.owner !== lockOwner) {
      throw retentionError('item is locked by another worker', 'ITEM_LOCKED');
    }
    record.lock = {
      lockId: lock,
      owner: lockOwner,
      acquiredAt: date.toISOString(),
      leaseExpiresAt: new Date(date.getTime() + duration).toISOString(),
    };
    increment(metrics, RETENTION_METRIC_NAMES.ITEMS_LOCKED);
    return cloneAndFreeze({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'item_locked',
      lockId: lock,
      item: publicItem(record),
    });
  }

  function releaseLock({ tenantId, userId, itemId, lockId, owner } = {}) {
    const scope = normalizeScope({ tenantId, userId, itemId });
    const lock = assertOperationId(lockId, 'lockId');
    const lockOwner = assertId(owner, 'owner');
    const { record } = requireItem(scope);
    if (!record.lock || record.lock.lockId !== lock || record.lock.owner !== lockOwner) {
      throw retentionError('lock does not belong to the owner', 'LOCK_NOT_OWNED');
    }
    record.lock = null;
    return cloneAndFreeze({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'item_unlocked',
      item: publicItem(record),
    });
  }

  function listCandidates({ tenantId, userId, asOf = currentDate(), limit = maxBatchSize } = {}) {
    const date = toDate(asOf, 'asOf');
    const batch = assertBatchSize(limit, maxBatchSize);
    const tenant = tenantId === undefined ? undefined : assertId(tenantId, 'tenantId');
    const user = userId === undefined ? undefined : assertId(userId, 'userId');
    if (user && !tenant) throw retentionError('tenantId is required with userId', 'INVALID_SCOPE');
    return [...records.values()]
      .filter((record) => record.state === RETENTION_ITEM_STATES.TRASHED)
      .filter((record) => tenant === undefined || record.tenantId === tenant)
      .filter((record) => user === undefined || record.userId === user)
      .filter((record) => new Date(record.retentionUntil).getTime() <= date.getTime())
      .filter((record) => activeHolds(record, date).length === 0)
      .filter((record) => !isLockActive(record, date))
      .sort((left, right) => left.retentionUntil.localeCompare(right.retentionUntil) || scopeKey(left).localeCompare(scopeKey(right)))
      .slice(0, batch)
      .map((record) => publicItem(record));
  }

  function runPurgeBatch({
    workerId,
    operationId = randomUUID(),
    tenantId = undefined,
    userId = undefined,
    limit = maxBatchSize,
    startedAt = currentDate(),
    purgeItem: purgeCallback = purgeItem,
  } = {}) {
    const worker = assertId(workerId, 'workerId');
    const operation = assertOperationId(operationId);
    const batch = assertBatchSize(limit, maxBatchSize);
    const actor = normalizeActor({ actorId: worker, role: 'system' });
    const tenant = tenantId === undefined ? '*' : assertId(tenantId, 'tenantId');
    const user = userId === undefined ? '*' : assertId(userId, 'userId');
    if (user !== '*' && tenant === '*') throw retentionError('tenantId is required with userId', 'INVALID_SCOPE');
    const resultKey = `purge\u0000${worker}\u0000${tenant}\u0000${user}\u0000${operation}`;
    const priorResult = operationResults.get(resultKey);
    if (priorResult) return priorResult;
    assertPurgeWorker(actor);
    const start = toDate(startedAt, 'startedAt');
    const candidates = listCandidates({
      tenantId: tenant === '*' ? undefined : tenant,
      userId: user === '*' ? undefined : user,
      asOf: start,
      limit: batch,
    });
    increment(metrics, RETENTION_METRIC_NAMES.PURGE_BATCHES);
    increment(metrics, RETENTION_METRIC_NAMES.PURGE_CANDIDATES, candidates.length);
    const purged = [];
    const skipped = [];
    const failures = [];
    const events = [];

    for (const candidate of candidates) {
      const key = scopeKey(candidate);
      const record = records.get(key);
      if (!record || record.state !== RETENTION_ITEM_STATES.TRASHED) {
        skipped.push({ itemId: candidate.itemId, reason: 'state_changed' });
        continue;
      }
      if (new Date(record.retentionUntil).getTime() > start.getTime()) {
        skipped.push({ itemId: candidate.itemId, reason: 'retention_not_elapsed' });
        continue;
      }
      if (activeHolds(record, start).length > 0) {
        skipped.push({ itemId: candidate.itemId, reason: 'retention_hold' });
        increment(metrics, RETENTION_METRIC_NAMES.ITEMS_HELD);
        continue;
      }
      if (isLockActive(record, start)) {
        skipped.push({ itemId: candidate.itemId, reason: 'item_locked' });
        increment(metrics, RETENTION_METRIC_NAMES.ITEMS_SKIPPED);
        continue;
      }
      record.lock = {
        lockId: operation,
        owner: worker,
        acquiredAt: start.toISOString(),
        leaseExpiresAt: new Date(start.getTime() + DEFAULT_LOCK_LEASE_MS).toISOString(),
      };
      let purgeSucceeded = true;
      try {
        const adapterResult = purgeCallback
          ? purgeCallback(publicItem(record))
          : undefined;
        if (adapterResult === false) {
          purgeSucceeded = false;
          throw retentionError('purge adapter rejected the item', 'PURGE_REJECTED');
        }
        if (adapterResult && typeof adapterResult.then === 'function') {
          throw retentionError('purgeItem must be synchronous in this contract', 'ASYNC_PURGE_ADAPTER');
        }
      } catch (error) {
        purgeSucceeded = false;
        failures.push({ itemId: record.itemId, code: error.code ?? 'PURGE_ADAPTER_ERROR' });
        increment(metrics, RETENTION_METRIC_NAMES.PURGE_FAILURES);
        const failureAudit = appendAudit(createAuditEvent({
          event: 'retention.purge_failed',
          scope: record,
          actor,
          occurredAt: start,
          operationId: operation,
          metadata: { resourceType: record.resourceType, generation: record.generation, code: error.code ?? 'PURGE_ADAPTER_ERROR' },
        }));
        events.push(failureAudit);
      }
      if (!purgeSucceeded) {
        record.lock = null;
        skipped.push({ itemId: record.itemId, reason: 'purge_failed' });
        continue;
      }
      // Re-read the metadata after the adapter callback. A restore or hold
      // added by a concurrent adapter must win over a stale purge decision.
      if (
        record.state !== RETENTION_ITEM_STATES.TRASHED ||
        new Date(record.retentionUntil).getTime() > start.getTime() ||
        activeHolds(record, start).length > 0
      ) {
        record.lock = null;
        skipped.push({ itemId: record.itemId, reason: 'state_changed' });
        continue;
      }
      record.state = RETENTION_ITEM_STATES.PURGED;
      record.purgedAt = start.toISOString();
      record.lock = null;
      increment(metrics, RETENTION_METRIC_NAMES.ITEMS_PURGED);
      const purgeAudit = appendAudit(createAuditEvent({
        event: 'retention.purge',
        scope: record,
        actor,
        occurredAt: start,
        operationId: operation,
        metadata: { resourceType: record.resourceType, generation: record.generation },
      }));
      events.push(purgeAudit);
      purged.push(publicItem(record));
    }

    increment(metrics, RETENTION_METRIC_NAMES.ITEMS_SKIPPED, skipped.length);
    const completedAt = currentDate();
    const remaining = listCandidates({
      tenantId: tenant === '*' ? undefined : tenant,
      userId: user === '*' ? undefined : user,
      asOf: completedAt,
      limit: maxBatchSize,
    }).length;
    const result = publicOperationResult({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      operation: 'purge_batch',
      operationId: operation,
      workerId: worker,
      startedAt: start.toISOString(),
      completedAt: completedAt.toISOString(),
      batchSize: batch,
      scanned: candidates.length,
      purged: purged.length,
      skipped: skipped.length,
      failed: failures.length,
      remaining,
      items: purged,
      skippedItems: skipped,
      failures,
      auditEvents: events,
      metrics: { ...metrics },
    });
    operationResults.set(resultKey, result);
    return result;
  }

  function getItem(input) {
    return publicItem(requireItem(input).record);
  }

  function getAuditEvents({ tenantId = undefined, userId = undefined, event = undefined } = {}) {
    const tenant = tenantId === undefined ? undefined : assertId(tenantId, 'tenantId');
    const user = userId === undefined ? undefined : assertId(userId, 'userId');
    if (user && !tenant) throw retentionError('tenantId is required with userId', 'INVALID_SCOPE');
    if (event !== undefined && (typeof event !== 'string' || !/^retention\.[a-z_]+$/u.test(event))) {
      throw retentionError('event is invalid', 'INVALID_AUDIT_FILTER');
    }
    return cloneAndFreeze(auditEvents.filter((entry) =>
      (tenant === undefined || entry.tenantId === tenant) &&
      (user === undefined || entry.userId === user) &&
      (event === undefined || entry.event === event)));
  }

  function getMetrics() {
    return cloneAndFreeze({ ...metrics });
  }

  function exportState() {
    return cloneAndFreeze({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      retentionDays: policyDays,
      items: [...records.values()].map((record) => publicItem(record)),
      metrics: { ...metrics },
    });
  }

  return Object.freeze({
    retentionDays: policyDays,
    maxBatchSize,
    markDeleted,
    restoreItem,
    addHold,
    releaseHold,
    acquireLock,
    releaseLock,
    listCandidates,
    runPurgeBatch,
    getItem,
    getAuditEvents,
    getMetrics,
    exportState,
  });
}

export {
  assertId,
  assertOperationId,
  retentionError,
};
