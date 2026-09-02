// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { assertTenantContext } from '../../integrations/tenant-context.ts';
import { assertAdminActor, assertSafeUserId, authorize } from './rbac.ts';

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function quotaError(message, code = 'QUOTA_ERROR', status = 403) {
  const error = new Error(`Quota error: ${message}`);
  error.name = 'QuotaError';
  error.code = code;
  error.status = status;
  return error;
}

function assertBytes(value, field, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    throw quotaError(`${field} must be a ${positive ? 'positive' : 'non-negative'} safe integer`, 'INVALID_QUOTA', 400);
  }
  return value;
}

function assertTenantId(value) {
  if (typeof value !== 'string' || !TENANT_ID_PATTERN.test(value)) {
    throw quotaError('tenantId is invalid', 'INVALID_TENANT', 400);
  }
  return value;
}

function cloneAllocation(tenantId, userId, allocatedQuotaBytes, usedBytes) {
  return Object.freeze({
    tenantId,
    userId,
    allocatedQuotaBytes,
    usedBytes,
    remainingBytes: allocatedQuotaBytes - usedBytes,
  });
}

/**
 * In-memory quota ledger used as the deterministic M6 contract double.
 * PostgreSQL remains the durable source of truth; the production adapter must
 * preserve the same locked, all-or-nothing allocation decision.
 */
export function createQuotaLedger({ tenantId, grossQuotaBytes, initialUsers = [] } = {}) {
  const canonicalTenantId = assertTenantId(tenantId);
  const gross = assertBytes(grossQuotaBytes, 'grossQuotaBytes', { positive: true });
  const allocations = new Map();
  const usage = new Map();
  let reservationSequence = 0;
  const reservations = new Map();

  function totalAllocated(excludeUserId = null) {
    let total = 0;
    for (const [userId, allocated] of allocations.entries()) {
      if (userId === excludeUserId) continue;
      total += allocated;
      if (!Number.isSafeInteger(total)) throw quotaError('quota total exceeds safe integer range', 'QUOTA_OVERFLOW', 500);
    }
    return total;
  }

  function assertSameTenant(context) {
    let canonical;
    try {
      canonical = assertTenantContext(context);
    } catch {
      throw quotaError('authenticated tenant context is required', 'AUTHENTICATION_REQUIRED', 401);
    }
    if (canonical.tenantId !== canonicalTenantId) throw quotaError('cross-tenant quota access denied', 'CROSS_TENANT_DENIED');
    return canonical;
  }

  function assertLedgerTenant(canonical) {
    if (canonical.tenantId !== canonicalTenantId) throw quotaError('cross-tenant quota access denied', 'CROSS_TENANT_DENIED');
    return canonical;
  }

  function requireKnownUser(userId) {
    const canonical = assertSafeUserId(userId, 'userId');
    if (!allocations.has(canonical)) throw quotaError('user quota allocation does not exist', 'NOT_FOUND', 404);
    return canonical;
  }

  function setAllocation(userId, allocatedQuotaBytes) {
    const allocated = assertBytes(allocatedQuotaBytes, 'allocatedQuotaBytes');
    const nextTotal = totalAllocated(userId) + allocated;
    if (!Number.isSafeInteger(nextTotal)) throw quotaError('quota total exceeds safe integer range', 'QUOTA_OVERFLOW', 500);
    if (nextTotal > gross) throw quotaError('tenant gross quota would be exceeded', 'QUOTA_EXCEEDED', 409);
    allocations.set(userId, allocated);
    if (!usage.has(userId)) usage.set(userId, 0);
  }

  for (const initial of initialUsers) {
    if (initial === null || typeof initial !== 'object' || Array.isArray(initial)) {
      throw quotaError('initialUsers entries must be objects', 'INVALID_USER', 400);
    }
    const userId = assertSafeUserId(initial.userId, 'initialUsers.userId');
    if (allocations.has(userId)) throw quotaError('duplicate initial user', 'CONFLICT', 409);
    setAllocation(userId, initial.allocatedQuotaBytes ?? 0);
    const initialUsed = assertBytes(initial.usedBytes ?? 0, 'initialUsers.usedBytes');
    if (initialUsed > allocations.get(userId)) throw quotaError('initial usage exceeds user allocation', 'INVALID_USAGE', 400);
    usage.set(userId, initialUsed);
  }

  function registerUser(actor, { userId, allocatedQuotaBytes = 0 } = {}) {
    const canonical = assertLedgerTenant(assertAdminActor(actor));
    const target = assertSafeUserId(userId, 'userId');
    authorize(canonical, { permission: 'user.manage', targetUserId: target });
    if (allocations.has(target)) throw quotaError('user quota allocation already exists', 'CONFLICT', 409);
    setAllocation(target, allocatedQuotaBytes);
    return read(canonical, { userId: target });
  }

  function allocate(actor, { userId, allocatedQuotaBytes } = {}) {
    const canonical = assertLedgerTenant(assertAdminActor(actor));
    const target = requireKnownUser(userId);
    authorize(canonical, { permission: 'quota.manage', targetUserId: target, resource: 'quota' });
    const currentUsage = usage.get(target) ?? 0;
    const requested = assertBytes(allocatedQuotaBytes, 'allocatedQuotaBytes');
    if (requested < currentUsage) throw quotaError('allocation cannot be below current usage', 'ALLOCATION_BELOW_USAGE', 409);
    // setAllocation performs the complete check before changing the map. No
    // partial allocation is observable when the tenant ceiling is exceeded.
    setAllocation(target, requested);
    return read(canonical, { userId: target });
  }

  function read(actor, { userId = actor?.userId } = {}) {
    const canonical = assertLedgerTenant(assertAdminActor(actor));
    const target = requireKnownUser(userId);
    authorize(canonical, { permission: 'quota.read', targetUserId: target, resource: 'quota' });
    return cloneAllocation(canonicalTenantId, target, allocations.get(target), usage.get(target) ?? 0);
  }

  function snapshot(actor) {
    const canonical = assertLedgerTenant(assertAdminActor(actor));
    authorize(canonical, { permission: 'quota.read', resource: 'quota' });
    const values = [...allocations.keys()].sort().map((userId) => cloneAllocation(
      canonicalTenantId,
      userId,
      allocations.get(userId),
      usage.get(userId) ?? 0,
    ));
    return Object.freeze({
      tenantId: canonicalTenantId,
      grossQuotaBytes: gross,
      allocatedQuotaBytes: totalAllocated(),
      remainingQuotaBytes: gross - totalAllocated(),
      users: Object.freeze(values),
    });
  }

  /**
   * Reserve mailbox/DAV usage before acknowledging a delivery. The call is a
   * tenant-scoped protocol adapter operation, not an administrative mutation.
   */
  function reserve(context, { userId, sizeBytes = 0 } = {}) {
    const canonical = assertSameTenant(context);
    const target = requireKnownUser(userId);
    const size = assertBytes(sizeBytes, 'sizeBytes');
    const currentUsage = usage.get(target) ?? 0;
    const allocation = allocations.get(target);
    if (size > allocation - currentUsage) {
      return Object.freeze({ accepted: false, reason: 'quota_exceeded', tenantId: canonicalTenantId, userId: target });
    }
    const nextUsage = currentUsage + size;
    if (!Number.isSafeInteger(nextUsage)) return Object.freeze({ accepted: false, reason: 'quota_overflow', tenantId: canonicalTenantId, userId: target });
    usage.set(target, nextUsage);
    const reservationId = `quota-${String(++reservationSequence).padStart(8, '0')}`;
    reservations.set(reservationId, { tenantId: canonicalTenantId, userId: target, sizeBytes: size, released: false });
    return Object.freeze({ accepted: true, reservationId, tenantId: canonicalTenantId, userId: target, sizeBytes: size });
  }

  function release(context, reservationId) {
    const canonical = assertSameTenant(context);
    if (typeof reservationId !== 'string' || !/^quota-[0-9]{8}$/u.test(reservationId)) {
      throw quotaError('reservationId is invalid', 'INVALID_RESERVATION', 400);
    }
    const reservation = reservations.get(reservationId);
    if (!reservation || reservation.tenantId !== canonicalTenantId) throw quotaError('reservation does not exist', 'NOT_FOUND', 404);
    if (reservation.released) return Object.freeze({ released: false, alreadyReleased: true, reservationId });
    const currentUsage = usage.get(reservation.userId) ?? 0;
    usage.set(reservation.userId, Math.max(0, currentUsage - reservation.sizeBytes));
    reservation.released = true;
    return Object.freeze({ released: true, alreadyReleased: false, reservationId });
  }

  function grossQuota() {
    return gross;
  }

  return Object.freeze({
    registerUser,
    allocate,
    read,
    snapshot,
    reserve,
    release,
    grossQuota,
  });
}

export { quotaError, assertBytes };
