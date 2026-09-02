// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import {
  assertSafeUserId,
  authorizationError,
  normalizeActor,
} from './rbac.ts';

const PERMISSION_SET = new Set(['read', 'write']);
const REASON_PATTERN = /^[\x20-\x7E]{1,256}$/u;

function delegationError(message, code = 'DELEGATION_ERROR', status = 403) {
  const error = new Error(`Delegation error: ${message}`);
  error.name = 'DelegationError';
  error.code = code;
  error.status = status;
  return error;
}

function normalizePermissions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !PERMISSION_SET.has(item))) {
    throw delegationError('permissions must contain read or write', 'INVALID_PERMISSIONS', 400);
  }
  const permissions = new Set(value);
  if (permissions.has('write')) permissions.add('read');
  return Object.freeze([...permissions].sort());
}

function normalizeReason(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw delegationError('forced delegation requires a reason', 'REASON_REQUIRED', 400);
    return null;
  }
  if (typeof value !== 'string' || !REASON_PATTERN.test(value.trim())) {
    throw delegationError('reason is invalid', 'INVALID_REASON', 400);
  }
  return value.trim();
}

function normalizeTimestamp(value, field, { allowNull = true } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw delegationError(`${field} is required`, 'INVALID_TIMESTAMP', 400);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw delegationError(`${field} is invalid`, 'INVALID_TIMESTAMP', 400);
  return date;
}

function cloneDelegation(record, now) {
  const expired = record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime();
  return Object.freeze({
    schemaVersion: 1,
    tenantId: record.tenantId,
    ownerUserId: record.ownerUserId,
    delegateUserId: record.delegateUserId,
    permissions: Object.freeze([...record.permissions]),
    forced: record.forced,
    policySource: record.policySource,
    reason: record.reason,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null,
    status: expired ? 'expired' : 'active',
    actorId: record.actorId,
  });
}

function isActive(record, now) {
  return record.expiresAt === null || record.expiresAt.getTime() > now.getTime();
}

/**
 * Deterministic one-delegate-per-owner contract. The production adapter may
 * persist the same record in PostgreSQL, but it must retain the unique active
 * owner rule and the explicit user/master policy source.
 */
export function createDelegationStore({ clock = () => new Date() } = {}) {
  const records = new Map();
  const history = [];

  function now() {
    const value = clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) throw delegationError('clock returned an invalid timestamp', 'CLOCK_INVALID', 500);
    return date;
  }

  function assertTenantOwner(actor, ownerUserId, { allowMaster = true } = {}) {
    const canonical = normalizeActor(actor);
    const owner = assertSafeUserId(ownerUserId, 'ownerUserId');
    if (canonical.role === 'user' && canonical.userId !== owner) {
      throw delegationError('a user can manage only their own delegation', 'OWNER_SCOPE_DENIED');
    }
    if (canonical.role === 'tenant_master' && !allowMaster) {
      throw delegationError('master delegation is not allowed for this operation', 'ROLE_DENIED');
    }
    if (!['user', 'tenant_master'].includes(canonical.role)) {
      throw delegationError('only the owner or tenant master can manage delegation', 'ROLE_DENIED');
    }
    return Object.freeze({ canonical, ownerUserId: owner });
  }

  function appendHistory(record, action, actor, result = 'success', reason = null) {
    history.push(Object.freeze({
      schemaVersion: 1,
      eventType: `delegation.${action}`,
      tenantId: record.tenantId,
      actorId: actor.actorId,
      actorRole: actor.role,
      ownerUserId: record.ownerUserId,
      delegateUserId: record.delegateUserId,
      permissions: Object.freeze([...record.permissions]),
      forced: record.forced,
      result,
      reason,
      occurredAt: record[action === 'created' ? 'createdAt' : 'updatedAt']?.toISOString() ?? now().toISOString(),
    }));
  }

  function create(actor, {
    ownerUserId,
    delegateUserId,
    permissions = ['read'],
    expiresAt = null,
    reason = null,
    forced = false,
  } = {}) {
    const { canonical, ownerUserId: owner } = assertTenantOwner(actor, ownerUserId);
    const delegate = assertSafeUserId(delegateUserId, 'delegateUserId');
    if (owner === delegate) throw delegationError('owner and delegate must be different users', 'SELF_DELEGATION', 400);

    const isMaster = canonical.role === 'tenant_master';
    if (isMaster && forced !== true) {
      throw delegationError('master-created delegation must be explicitly forced', 'FORCED_FLAG_REQUIRED', 400);
    }
    if (!isMaster && forced === true) {
      throw delegationError('only a tenant master can create forced delegation', 'FORCED_FLAG_DENIED');
    }

    const timestamp = now();
    const expiry = normalizeTimestamp(expiresAt, 'expiresAt');
    if (expiry !== null && expiry.getTime() <= timestamp.getTime()) {
      throw delegationError('expiresAt must be in the future', 'INVALID_EXPIRY', 400);
    }
    const normalizedReason = normalizeReason(reason, isMaster);
    const existing = records.get(owner);
    if (existing && isActive(existing, timestamp)) {
      throw delegationError('an active delegate already exists for this owner', 'ACTIVE_DELEGATE_EXISTS', 409);
    }

    const record = {
      tenantId: canonical.tenantId,
      ownerUserId: owner,
      delegateUserId: delegate,
      permissions: normalizePermissions(permissions),
      forced: isMaster,
      policySource: isMaster ? 'master_forced' : 'user_delegated',
      reason: normalizedReason,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: expiry,
      actorId: canonical.actorId,
    };
    records.set(owner, record);
    appendHistory(record, 'created', canonical, 'success', normalizedReason);
    return cloneDelegation(record, timestamp);
  }

  function update(actor, ownerUserId, {
    delegateUserId,
    permissions,
    expiresAt,
    reason,
  } = {}) {
    const { canonical, ownerUserId: owner } = assertTenantOwner(actor, ownerUserId);
    const record = records.get(owner);
    const timestamp = now();
    if (!record || !isActive(record, timestamp)) throw delegationError('active delegation does not exist', 'NOT_FOUND', 404);
    if (record.tenantId !== canonical.tenantId) throw delegationError('cross-tenant delegation denied', 'CROSS_TENANT_DENIED');
    if (record.forced && canonical.role === 'user') {
      throw delegationError('a user cannot change a master-forced delegation', 'FORCED_DELEGATION_LOCKED');
    }

    const delegate = delegateUserId === undefined ? record.delegateUserId : assertSafeUserId(delegateUserId, 'delegateUserId');
    if (delegate === owner) throw delegationError('owner and delegate must be different users', 'SELF_DELEGATION', 400);
    const expiry = expiresAt === undefined ? record.expiresAt : normalizeTimestamp(expiresAt, 'expiresAt');
    if (expiry !== null && expiry.getTime() <= timestamp.getTime()) throw delegationError('expiresAt must be in the future', 'INVALID_EXPIRY', 400);
    const normalizedReason = reason === undefined ? record.reason : normalizeReason(reason, record.forced);
    const updated = {
      ...record,
      delegateUserId: delegate,
      permissions: permissions === undefined ? record.permissions : normalizePermissions(permissions),
      expiresAt: expiry,
      reason: normalizedReason,
      updatedAt: timestamp,
      actorId: canonical.actorId,
    };
    records.set(owner, updated);
    appendHistory(updated, 'updated', canonical, 'success', normalizedReason);
    return cloneDelegation(updated, timestamp);
  }

  function revoke(actor, ownerUserId, { reason = 'owner_revoked' } = {}) {
    const { canonical, ownerUserId: owner } = assertTenantOwner(actor, ownerUserId);
    const record = records.get(owner);
    const timestamp = now();
    if (!record || !isActive(record, timestamp)) throw delegationError('active delegation does not exist', 'NOT_FOUND', 404);
    if (record.tenantId !== canonical.tenantId) throw delegationError('cross-tenant delegation denied', 'CROSS_TENANT_DENIED');
    if (record.forced && canonical.role === 'user') {
      throw delegationError('a user cannot revoke a master-forced delegation', 'FORCED_DELEGATION_LOCKED');
    }
    const normalizedReason = normalizeReason(reason, true);
    const revoked = { ...record, expiresAt: timestamp, updatedAt: timestamp, actorId: canonical.actorId };
    records.set(owner, revoked);
    appendHistory(revoked, 'revoked', canonical, 'success', normalizedReason);
    return cloneDelegation(revoked, timestamp);
  }

  function canAccess(actor, ownerUserId, permission = 'read') {
    let canonical;
    try {
      canonical = normalizeActor(actor);
    } catch {
      return false;
    }
    if (canonical.role !== 'user') return false;
    let owner;
    try {
      owner = assertSafeUserId(ownerUserId, 'ownerUserId');
    } catch {
      return false;
    }
    if (!PERMISSION_SET.has(permission)) return false;
    if (canonical.userId === owner) return true;
    const record = records.get(owner);
    if (!record || record.tenantId !== canonical.tenantId || record.delegateUserId !== canonical.userId) return false;
    if (!isActive(record, now())) return false;
    return record.permissions.includes(permission);
  }

  function get(actor, ownerUserId) {
    const canonical = normalizeActor(actor);
    const owner = assertSafeUserId(ownerUserId, 'ownerUserId');
    const record = records.get(owner);
    if (!record || record.tenantId !== canonical.tenantId) throw delegationError('delegation does not exist', 'NOT_FOUND', 404);
    if (canonical.role === 'user' && canonical.userId !== owner && canonical.userId !== record.delegateUserId) {
      throw authorizationError('delegation metadata is outside the user scope', 'USER_SCOPE_DENIED');
    }
    if (!['user', 'tenant_master', 'provider'].includes(canonical.role)) {
      throw delegationError('role cannot inspect delegation metadata', 'ROLE_DENIED');
    }
    return cloneDelegation(record, now());
  }

  function list(actor) {
    const canonical = normalizeActor(actor);
    if (!['provider', 'tenant_master'].includes(canonical.role)) {
      throw delegationError('only administrative roles can enumerate delegations', 'ROLE_DENIED');
    }
    const timestamp = now();
    return Object.freeze([...records.values()]
      .filter((record) => record.tenantId === canonical.tenantId)
      .sort((left, right) => left.ownerUserId.localeCompare(right.ownerUserId))
      .map((record) => cloneDelegation(record, timestamp)));
  }

  function events(actor, { masterLogAccess = false } = {}) {
    const canonical = normalizeActor(actor);
    if (!['provider', 'tenant_master'].includes(canonical.role)) {
      throw delegationError('only administrative roles can inspect delegation events', 'ROLE_DENIED');
    }
    if (canonical.role === 'tenant_master' && masterLogAccess !== true) {
      throw delegationError('master log visibility is disabled by tenant policy', 'MASTER_LOG_ACCESS_DISABLED');
    }
    return Object.freeze(history
      .filter((event) => event.tenantId === canonical.tenantId)
      .map((event) => Object.freeze({ ...event, permissions: Object.freeze([...event.permissions]) })));
  }

  return Object.freeze({ create, update, revoke, canAccess, get, list, events });
}

export { delegationError, normalizePermissions, normalizeReason };
