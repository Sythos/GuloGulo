// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID } from 'node:crypto';

/**
 * Account deletion lifecycle contract.
 *
 * This is an auditable state machine, not a destructive account deleter. It
 * records the authorization and recovery window that an adapter must enforce
 * across aliases, delegations, factors, backups, mailbox data, and DAV data.
 * Permanent resource deletion is deliberately a separate operation.
 */

export const ACCOUNT_LIFECYCLE_SCHEMA_VERSION = 1;
export const DEFAULT_ACCOUNT_RECOVERY_DAYS = 28;
export const ACCOUNT_STATES = Object.freeze({
  ACTIVE: 'active',
  DELETION_REQUESTED: 'deletion_requested',
  SOFT_DELETED: 'soft_deleted',
  PURGE_PENDING: 'purge_pending',
  PURGED: 'purged',
});

export const ACCOUNT_RESOURCE_TYPES = Object.freeze([
  'aliases',
  'delegations',
  'factors',
  'backups',
  'mailbox',
  'dav_collections',
  'preferences',
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON_PATTERN = /^[^\r\n]{1,256}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

function accountError(message, code = 'ACCOUNT_LIFECYCLE_ERROR') {
  const error = new Error(`Account lifecycle error: ${message}`);
  error.code = code;
  return error;
}

function assertObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw accountError(`${field} must be an object`, 'INVALID_INPUT');
  }
  return value;
}

function assertId(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw accountError(`${field} is invalid`, 'INVALID_IDENTITY');
  }
  return value;
}

function assertOperationId(value, field = 'operationId') {
  if (typeof value !== 'string' || !OPERATION_PATTERN.test(value)) {
    throw accountError(`${field} is invalid`, 'INVALID_OPERATION_ID');
  }
  return value;
}

function assertReason(value, field = 'reason') {
  if (typeof value !== 'string' || !REASON_PATTERN.test(value)) {
    throw accountError(`${field} must be a single-line value of 1-256 characters`, 'INVALID_REASON');
  }
  return value;
}

function parseDate(value, field, fallback) {
  const candidate = value === undefined ? fallback : value;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(date.getTime())) throw accountError(`${field} is invalid`, 'INVALID_TIMESTAMP');
  return date;
}

function iso(value, field, fallback) {
  return parseDate(value, field, fallback).toISOString();
}

function assertRecoveryDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw accountError('recoveryDays must be an integer between 1 and 3650', 'INVALID_RECOVERY_POLICY');
  }
  return value;
}

function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => deepFreeze(item)));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = deepFreeze(item);
    return Object.freeze(copy);
  }
  return value;
}

function normalizeActor(actor, fallbackId = undefined) {
  if (actor === undefined) {
    return Object.freeze({ actorId: fallbackId ?? 'account-lifecycle', role: fallbackId ? 'user' : 'system' });
  }
  assertObject(actor, 'actor');
  return Object.freeze({
    actorId: assertId(actor.actorId, 'actor.actorId'),
    role: assertId(actor.role ?? 'system', 'actor.role'),
  });
}

function accountKey(tenantId, userId) {
  return `${tenantId}\u0000${userId}`;
}

function confirmationFor(userId) {
  return `DELETE:${userId}`;
}

function publicAccount(account) {
  return deepFreeze({
    schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
    tenantId: account.tenantId,
    userId: account.userId,
    accountType: account.accountType,
    state: account.state,
    createdAt: account.createdAt,
    deletionRequestedAt: account.deletionRequestedAt,
    softDeletedAt: account.softDeletedAt,
    recoveryUntil: account.recoveryUntil,
    purgeQueuedAt: account.purgeQueuedAt,
    purgedAt: account.purgedAt,
    cleanupPlan: [...account.cleanupPlan],
    activeHoldIds: [...account.holds.keys()],
    deletionRequestId: account.deletionRequestId,
  });
}

function createAuditEvent({ event, account, actor, occurredAt, operationId, metadata = {} }) {
  return deepFreeze({
    schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
    event,
    occurredAt: iso(occurredAt, 'occurredAt'),
    tenantId: account.tenantId,
    userId: account.userId,
    actorId: actor.actorId,
    actorRole: actor.role,
    ...(operationId ? { operationId } : {}),
    metadata,
  });
}

function normalizeCleanupPlan(plan) {
  const selected = plan === undefined ? ACCOUNT_RESOURCE_TYPES : plan;
  if (!Array.isArray(selected) || selected.length === 0) {
    throw accountError('cleanupPlan must be a non-empty list', 'INVALID_CLEANUP_PLAN');
  }
  const unique = [...new Set(selected)];
  if (unique.some((item) => !ACCOUNT_RESOURCE_TYPES.includes(item))) {
    throw accountError('cleanupPlan contains an unsupported resource type', 'INVALID_CLEANUP_PLAN');
  }
  return unique;
}

function normalizeResourceResults(account, value) {
  assertObject(value, 'resourceResults');
  const result = {};
  for (const resource of account.cleanupPlan) {
    if (value[resource] !== 'purged') {
      throw accountError(`resource purge is incomplete: ${resource}`, 'PURGE_INCOMPLETE');
    }
    result[resource] = 'purged';
  }
  return result;
}

function requireState(account, expected) {
  if (account.state !== expected) {
    throw accountError(`account must be ${expected}, not ${account.state}`, 'INVALID_STATE_TRANSITION');
  }
}

function assertAccountScope(input) {
  assertObject(input, 'scope');
  const { tenantId, userId } = input;
  return {
    tenantId: assertId(tenantId, 'tenantId'),
    userId: assertId(userId, 'userId'),
  };
}

/**
 * Create an in-memory account lifecycle state machine. Adapters should persist
 * the same immutable state transitions transactionally in PostgreSQL.
 */
export function createAccountLifecycleStore({
  now = () => new Date(),
  recoveryDays = DEFAULT_ACCOUNT_RECOVERY_DAYS,
} = {}) {
  if (typeof now !== 'function') throw accountError('now must be a function', 'INVALID_CLOCK');
  const defaultRecoveryDays = assertRecoveryDays(recoveryDays);
  const accounts = new Map();
  const operationResults = new Map();
  const auditEvents = [];

  function currentDate() {
    return parseDate(now(), 'clock');
  }

  function requireAccount(scope) {
    const normalized = assertAccountScope(scope);
    const account = accounts.get(accountKey(normalized.tenantId, normalized.userId));
    if (!account) throw accountError('account does not exist', 'ACCOUNT_NOT_FOUND');
    return { normalized, account };
  }

  function appendAudit(event) {
    auditEvents.push(event);
    return event;
  }

  function registerAccount({
    tenantId,
    userId,
    accountType = 'user',
    createdAt = currentDate(),
    cleanupPlan = undefined,
    actor = undefined,
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const type = assertId(accountType, 'accountType');
    const key = accountKey(scope.tenantId, scope.userId);
    if (accounts.has(key)) throw accountError('account already exists', 'ACCOUNT_EXISTS');
    const account = {
      ...scope,
      accountType: type,
      state: ACCOUNT_STATES.ACTIVE,
      createdAt: iso(createdAt, 'createdAt'),
      deletionRequestedAt: null,
      softDeletedAt: null,
      recoveryUntil: null,
      purgeQueuedAt: null,
      purgedAt: null,
      cleanupPlan: normalizeCleanupPlan(cleanupPlan),
      holds: new Map(),
      deletionRequestId: null,
    };
    accounts.set(key, account);
    const audit = appendAudit(createAuditEvent({
      event: 'account.registered',
      account,
      actor: normalizeActor(actor, scope.userId),
      occurredAt: createdAt,
      metadata: { accountType: type, cleanupPlan: account.cleanupPlan },
    }));
    return deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'account_registered',
      account: publicAccount(account),
      audit,
    });
  }

  function requestDeletion({
    tenantId,
    userId,
    actor,
    confirmation,
    reason,
    requestId = randomUUID(),
    requestedAt = currentDate(),
    recoveryDays = defaultRecoveryDays,
    cleanupPlan = undefined,
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const request = assertOperationId(requestId, 'requestId');
    const key = `request\u0000${scope.tenantId}\u0000${scope.userId}\u0000${request}`;
    const priorResult = operationResults.get(key);
    if (priorResult) return priorResult;
    if (confirmation !== confirmationFor(scope.userId)) {
      throw accountError('strong deletion confirmation is required', 'STRONG_CONFIRMATION_REQUIRED');
    }
    const actorInfo = normalizeActor(actor, scope.userId);
    const deletionReason = assertReason(reason ?? 'user_requested');
    const days = assertRecoveryDays(recoveryDays);
    const date = parseDate(requestedAt, 'requestedAt');
    const { account } = requireAccount(scope);
    requireState(account, ACCOUNT_STATES.ACTIVE);
    if (account.holds.size > 0) throw accountError('account has an active hold', 'ACCOUNT_ON_HOLD');
    account.state = ACCOUNT_STATES.DELETION_REQUESTED;
    account.deletionRequestedAt = date.toISOString();
    account.recoveryUntil = new Date(date.getTime() + days * DAY_MS).toISOString();
    account.cleanupPlan = normalizeCleanupPlan(cleanupPlan ?? account.cleanupPlan);
    account.deletionRequestId = request;
    const audit = appendAudit(createAuditEvent({
      event: 'account.deletion_requested',
      account,
      actor: actorInfo,
      occurredAt: date,
      operationId: request,
      metadata: {
        reason: deletionReason,
        recoveryUntil: account.recoveryUntil,
        recoveryDays: days,
        cleanupPlan: account.cleanupPlan,
      },
    }));
    const result = deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'deletion_requested',
      requestId: request,
      account: publicAccount(account),
      audit,
    });
    operationResults.set(key, result);
    return result;
  }

  function softDeleteAccount({
    tenantId,
    userId,
    actor,
    confirmation,
    requestId,
    deletedAt = currentDate(),
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const { account } = requireAccount(scope);
    requireState(account, ACCOUNT_STATES.DELETION_REQUESTED);
    if (confirmation !== confirmationFor(scope.userId)) {
      throw accountError('strong deletion confirmation is required', 'STRONG_CONFIRMATION_REQUIRED');
    }
    if (requestId !== undefined && requestId !== account.deletionRequestId) {
      throw accountError('requestId does not match the pending deletion', 'DELETION_REQUEST_MISMATCH');
    }
    const actorInfo = normalizeActor(actor, scope.userId);
    const date = parseDate(deletedAt, 'deletedAt');
    account.state = ACCOUNT_STATES.SOFT_DELETED;
    account.softDeletedAt = date.toISOString();
    const audit = appendAudit(createAuditEvent({
      event: 'account.soft_deleted',
      account,
      actor: actorInfo,
      occurredAt: date,
      operationId: account.deletionRequestId,
      metadata: { recoveryUntil: account.recoveryUntil, cleanupPlan: account.cleanupPlan },
    }));
    return deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'soft_deleted',
      account: publicAccount(account),
      audit,
    });
  }

  function restoreAccount({
    tenantId,
    userId,
    actor,
    restoredAt = currentDate(),
    reason = 'account_recovery',
    operationId = randomUUID(),
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const operation = assertOperationId(operationId);
    const key = `restore\u0000${scope.tenantId}\u0000${scope.userId}\u0000${operation}`;
    const priorResult = operationResults.get(key);
    if (priorResult) return priorResult;
    const { account } = requireAccount(scope);
    if (![ACCOUNT_STATES.DELETION_REQUESTED, ACCOUNT_STATES.SOFT_DELETED, ACCOUNT_STATES.PURGE_PENDING].includes(account.state)) {
      throw accountError('account is not recoverable in its current state', 'ACCOUNT_NOT_RECOVERABLE');
    }
    const date = parseDate(restoredAt, 'restoredAt');
    if (account.recoveryUntil && date.getTime() > new Date(account.recoveryUntil).getTime()) {
      throw accountError('the account recovery window has elapsed', 'RECOVERY_WINDOW_EXPIRED');
    }
    const actorInfo = normalizeActor(actor, scope.userId);
    account.state = ACCOUNT_STATES.ACTIVE;
    account.recoveryUntil = null;
    account.purgeQueuedAt = null;
    account.deletionRequestedAt = null;
    account.softDeletedAt = null;
    account.deletionRequestId = null;
    const audit = appendAudit(createAuditEvent({
      event: 'account.restored',
      account,
      actor: actorInfo,
      occurredAt: date,
      operationId: operation,
      metadata: { reason: assertReason(reason) },
    }));
    const result = deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'account_restored',
      operationId: operation,
      account: publicAccount(account),
      audit,
    });
    operationResults.set(key, result);
    return result;
  }

  function addAccountHold({
    tenantId,
    userId,
    holdId,
    reasonCode,
    actor,
    addedAt = currentDate(),
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const hold = assertOperationId(holdId, 'holdId');
    const reason = assertReason(reasonCode ?? 'administrative_hold', 'reasonCode');
    const { account } = requireAccount(scope);
    const actorInfo = normalizeActor(actor);
    if (account.holds.has(hold)) return deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'account_hold_added',
      holdId: hold,
      account: publicAccount(account),
      idempotent: true,
    });
    account.holds.set(hold, { holdId: hold, reasonCode: reason, addedAt: iso(addedAt, 'addedAt') });
    const audit = appendAudit(createAuditEvent({
      event: 'account.hold_added',
      account,
      actor: actorInfo,
      occurredAt: addedAt,
      metadata: { holdId: hold, reasonCode: reason },
    }));
    return deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'account_hold_added',
      holdId: hold,
      account: publicAccount(account),
      audit,
    });
  }

  function releaseAccountHold({
    tenantId,
    userId,
    holdId,
    actor,
    releasedAt = currentDate(),
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const hold = assertOperationId(holdId, 'holdId');
    const { account } = requireAccount(scope);
    const actorInfo = normalizeActor(actor);
    if (!account.holds.delete(hold)) return deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'account_hold_released',
      holdId: hold,
      account: publicAccount(account),
      idempotent: true,
    });
    const audit = appendAudit(createAuditEvent({
      event: 'account.hold_released',
      account,
      actor: actorInfo,
      occurredAt: releasedAt,
      metadata: { holdId: hold },
    }));
    return deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'account_hold_released',
      holdId: hold,
      account: publicAccount(account),
      audit,
    });
  }

  function queuePurge({
    tenantId,
    userId,
    actor,
    queuedAt = currentDate(),
    operationId = randomUUID(),
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const operation = assertOperationId(operationId);
    const key = `queue\u0000${scope.tenantId}\u0000${scope.userId}\u0000${operation}`;
    const priorResult = operationResults.get(key);
    if (priorResult) return priorResult;
    const { account } = requireAccount(scope);
    requireState(account, ACCOUNT_STATES.SOFT_DELETED);
    const date = parseDate(queuedAt, 'queuedAt');
    if (!account.recoveryUntil || date.getTime() < new Date(account.recoveryUntil).getTime()) {
      throw accountError('the account recovery window has not elapsed', 'RECOVERY_WINDOW_ACTIVE');
    }
    if (account.holds.size > 0) throw accountError('account has an active hold', 'ACCOUNT_ON_HOLD');
    const actorInfo = normalizeActor(actor);
    account.state = ACCOUNT_STATES.PURGE_PENDING;
    account.purgeQueuedAt = date.toISOString();
    const audit = appendAudit(createAuditEvent({
      event: 'account.purge_queued',
      account,
      actor: actorInfo,
      occurredAt: date,
      operationId: operation,
      metadata: { cleanupPlan: account.cleanupPlan },
    }));
    const result = deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'purge_queued',
      operationId: operation,
      account: publicAccount(account),
      audit,
    });
    operationResults.set(key, result);
    return result;
  }

  function completePurge({
    tenantId,
    userId,
    actor,
    confirmation,
    completedAt = currentDate(),
    operationId = randomUUID(),
    resourceResults = undefined,
  } = {}) {
    const scope = assertAccountScope({ tenantId, userId });
    const operation = assertOperationId(operationId);
    const key = `complete\u0000${scope.tenantId}\u0000${scope.userId}\u0000${operation}`;
    const priorResult = operationResults.get(key);
    if (priorResult) return priorResult;
    const { account } = requireAccount(scope);
    requireState(account, ACCOUNT_STATES.PURGE_PENDING);
    if (confirmation !== `PURGE:${scope.userId}`) {
      throw accountError('strong purge confirmation is required', 'STRONG_CONFIRMATION_REQUIRED');
    }
    if (account.holds.size > 0) throw accountError('account has an active hold', 'ACCOUNT_ON_HOLD');
    const adapterResults = normalizeResourceResults(account, resourceResults === undefined ? {} : resourceResults);
    const date = parseDate(completedAt, 'completedAt');
    const actorInfo = normalizeActor(actor);
    account.state = ACCOUNT_STATES.PURGED;
    account.purgedAt = date.toISOString();
    const audit = appendAudit(createAuditEvent({
      event: 'account.purged',
      account,
      actor: actorInfo,
      occurredAt: date,
      operationId: operation,
      metadata: { cleanupPlan: account.cleanupPlan, resourceResults: adapterResults },
    }));
    const result = deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      operation: 'account_purged',
      operationId: operation,
      account: publicAccount(account),
      audit,
    });
    operationResults.set(key, result);
    return result;
  }

  function getAccount(scope) {
    return publicAccount(requireAccount(scope).account);
  }

  function getAuditEvents({ tenantId = undefined, userId = undefined, event = undefined } = {}) {
    const tenant = tenantId === undefined ? undefined : assertId(tenantId, 'tenantId');
    const user = userId === undefined ? undefined : assertId(userId, 'userId');
    if (user && !tenant) throw accountError('tenantId is required with userId', 'INVALID_SCOPE');
    if (event !== undefined && (typeof event !== 'string' || !/^account\.[a-z_]+$/u.test(event))) {
      throw accountError('event is invalid', 'INVALID_AUDIT_FILTER');
    }
    return deepFreeze(auditEvents.filter((entry) =>
      (tenant === undefined || entry.tenantId === tenant) &&
      (user === undefined || entry.userId === user) &&
      (event === undefined || entry.event === event)));
  }

  function exportState() {
    return deepFreeze({
      schemaVersion: ACCOUNT_LIFECYCLE_SCHEMA_VERSION,
      recoveryDays: defaultRecoveryDays,
      accounts: [...accounts.values()].map((account) => publicAccount(account)),
    });
  }

  return Object.freeze({
    recoveryDays: defaultRecoveryDays,
    registerAccount,
    requestDeletion,
    softDeleteAccount,
    restoreAccount,
    addAccountHold,
    releaseAccountHold,
    queuePurge,
    completePurge,
    getAccount,
    getAuditEvents,
    exportState,
    confirmationFor,
  });
}

export {
  accountError,
  confirmationFor,
};
