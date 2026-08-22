// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_BYTES = 10;
export const RECOVERY_CODE_LENGTH = 16;
export const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const ID_PATTERN = /^[a-z0-9][a-z0-9._:@/-]{0,127}$/u;
const FACTOR_ID_PATTERN = /^recovery_[A-Za-z0-9_-]{16,64}$/u;
const CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/u;
const FORBIDDEN_ROLES = new Set(['provider', 'tenant_master', 'master', 'monitor', 'admin']);

function authError(message, code = 'RECOVERY_ERROR') {
  const error = new Error(`Recovery code error: ${message}`);
  error.code = code;
  return error;
}

function readTime(clock) {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0) throw authError('clock must return a non-negative millisecond timestamp', 'INVALID_CLOCK');
  return Math.trunc(time);
}

function assertIdentityPart(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw authError(`${name} is invalid`, 'INVALID_IDENTITY');
  return value;
}

function assertFactorId(value) {
  if (typeof value !== 'string' || !FACTOR_ID_PATTERN.test(value)) throw authError('factorId is invalid', 'INVALID_FACTOR');
  return value;
}

function assertUserActor({ tenantId, userId, actorId = userId, role = 'user' }) {
  assertIdentityPart(tenantId, 'tenantId');
  assertIdentityPart(userId, 'userId');
  assertIdentityPart(actorId, 'actorId');
  if (actorId !== userId || FORBIDDEN_ROLES.has(role)) throw authError('recovery code management must be initiated by the user', 'FACTOR_SCOPE_VIOLATION');
  return { tenantId, userId, actorId, role };
}

function assertRandomBytes(randomBytesFn, size) {
  const bytes = randomBytesFn(size);
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw authError(`randomBytesFn must return ${size} bytes`, 'INVALID_RANDOM_SOURCE');
  return bytes;
}

function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const canonical = code.replace(/[\s-]/gu, '').toUpperCase();
  return CODE_PATTERN.test(canonical) ? canonical : null;
}

function hashCode(salt, code) {
  return createHash('sha256').update(salt).update(code, 'ascii').digest();
}

function codesEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function metadata(record) {
  return Object.freeze({
    factorId: record.factorId,
    type: 'recovery_codes',
    tenantId: record.tenantId,
    userId: record.userId,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    usedAt: record.usedAt,
    totalCodes: record.codes.size,
    remainingCodes: [...record.codes.values()].filter((entry) => entry.usedAt === undefined).length,
  });
}

function auditEvent(audit, event) {
  try {
    audit(Object.freeze({ ...event }));
  } catch {
    // An audit sink must not receive or force output of a recovery code.
  }
}

export function generateRecoveryCode(randomBytesFn = nodeRandomBytes) {
  const bytes = assertRandomBytes(randomBytesFn, RECOVERY_CODE_BYTES);
  let buffer = 0;
  let bits = 0;
  let code = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += RECOVERY_CODE_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) code += RECOVERY_CODE_ALPHABET[(buffer << (5 - bits)) & 31];
  if (code.length !== RECOVERY_CODE_LENGTH) throw authError('recovery code generation failed', 'INVALID_RANDOM_SOURCE');
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
}

/**
 * One-time recovery code contract. Only the enrollment response contains
 * clear codes, and it must be treated as a write-only delivery to the user.
 * Stored entries contain salted SHA-256 digests and no recoverable plaintext.
 */
export function createRecoveryCodeManager({
  clock = () => Date.now(),
  randomBytesFn = nodeRandomBytes,
  count = RECOVERY_CODE_COUNT,
  maxFailures = 5,
  lockoutMs = 15 * 60 * 1000,
  rateLimiter = () => true,
  authorizeRevocation = () => false,
  audit = () => {},
  factors = new Map(),
} = {}) {
  if (!Number.isInteger(count) || count < 5 || count > 20 || !Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 20 || !Number.isSafeInteger(lockoutMs) || lockoutMs < 1000) {
    throw authError('recovery code configuration is invalid', 'INVALID_CONFIGURATION');
  }
  if (factors === null || typeof factors.get !== 'function' || typeof factors.set !== 'function' || typeof factors.delete !== 'function') throw authError('factors must implement get, set, and delete', 'INVALID_FACTOR_STORE');
  if (typeof authorizeRevocation !== 'function') throw authError('authorizeRevocation must be a function', 'INVALID_AUTHORIZER');
  const attempts = new Map();

  function scope(record, tenantId, userId) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    if (record.tenantId !== tenantId || record.userId !== userId) throw authError('factor is outside the requested identity scope', 'FACTOR_SCOPE_VIOLATION');
  }

  function failure(record, reason, now) {
    const previous = attempts.get(record.factorId) ?? { failed: 0, lockedUntil: 0 };
    const failed = previous.failed + 1;
    const lockedUntil = failed >= maxFailures ? now + lockoutMs : previous.lockedUntil;
    attempts.set(record.factorId, { failed, lockedUntil });
    auditEvent(audit, { eventType: 'auth.recovery.failed', tenantId: record.tenantId, userId: record.userId, factorId: record.factorId, reason, locked: lockedUntil > now, occurredAt: now });
    return Object.freeze({ recovered: false, code: reason, lockedUntil: lockedUntil > now ? lockedUntil : undefined });
  }

  function allowed(record, now) {
    const state = attempts.get(record.factorId);
    if (state?.lockedUntil > now) return false;
    if (state?.lockedUntil && state.lockedUntil <= now) attempts.delete(record.factorId);
    let result;
    try {
      result = rateLimiter({ action: 'auth.recovery.consume', key: `${record.tenantId}:${record.userId}:${record.factorId}`, tenantId: record.tenantId, userId: record.userId, factorId: record.factorId });
    } catch {
      result = false;
    }
    return result === true || (result !== false && result?.allowed === true);
  }

  function enroll({ tenantId, userId, actorId = userId, role = 'user' } = {}) {
    const identity = assertUserActor({ tenantId, userId, actorId, role });
    let factorId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = `recovery_${assertRandomBytes(randomBytesFn, 12).toString('base64url')}`;
      if (!factors.has(candidate)) {
        factorId = candidate;
        break;
      }
    }
    if (factorId === undefined) throw authError('factor identifier collision', 'FACTOR_GENERATION_FAILED');
    const now = readTime(clock);
    const codes = new Map();
    const clearCodes = [];
    for (let index = 0; index < count; index += 1) {
      const clearCode = generateRecoveryCode(randomBytesFn);
      const canonical = normalizeCode(clearCode);
      const salt = assertRandomBytes(randomBytesFn, 16);
      codes.set(`${index}:${salt.toString('base64url')}`, { salt, digest: hashCode(salt, canonical), usedAt: undefined });
      clearCodes.push(clearCode);
    }
    const record = { factorId, tenantId, userId, createdAt: now, revokedAt: undefined, usedAt: undefined, codes };
    factors.set(factorId, record);
    auditEvent(audit, { eventType: 'auth.recovery.issued', tenantId: identity.tenantId, userId: identity.userId, factorId, count, occurredAt: now });
    return Object.freeze({ factor: metadata(record), codes: Object.freeze(clearCodes) });
  }

  function consume({ factorId, tenantId, userId, code } = {}) {
    const id = assertFactorId(factorId);
    const record = factors.get(id);
    if (record === undefined) return Object.freeze({ recovered: false, code: 'FACTOR_NOT_FOUND' });
    scope(record, tenantId, userId);
    const now = readTime(clock);
    if (record.revokedAt !== undefined) return Object.freeze({ recovered: false, code: 'FACTOR_REVOKED' });
    if (!allowed(record, now)) return failure(record, 'RATE_LIMITED_OR_LOCKED', now);
    const canonical = normalizeCode(code);
    if (canonical === null) return failure(record, 'INVALID_CODE', now);
    const candidate = [...record.codes.values()].find((entry) => entry.usedAt === undefined && codesEqual(entry.digest, hashCode(entry.salt, canonical)));
    if (candidate === undefined) return failure(record, 'INVALID_CODE', now);
    candidate.usedAt = now;
    attempts.delete(id);
    record.usedAt = now;
    auditEvent(audit, { eventType: 'auth.recovery.used', tenantId, userId, factorId: id, remainingCodes: metadata(record).remainingCodes, occurredAt: now });
    return Object.freeze({ recovered: true, factor: metadata(record) });
  }

  function revoke({ factorId, tenantId, userId, actorId = userId, role = 'user', reason = 'user_request' } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    assertIdentityPart(actorId, 'actorId');
    let authorized = actorId === userId && role === 'user';
    if (!authorized && actorId !== userId) {
      try {
        authorized = authorizeRevocation({ actorId, actorRole: role, tenantId, userId, factorId });
      } catch {
        authorized = false;
      }
    }
    if (authorized !== true) throw authError('recovery factor revocation is not authorized', 'FACTOR_SCOPE_VIOLATION');
    const id = assertFactorId(factorId);
    const record = factors.get(id);
    if (record === undefined || record.tenantId !== tenantId || record.userId !== userId) return Object.freeze({ revoked: false, code: 'FACTOR_NOT_FOUND' });
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 128 || /[\r\n]/u.test(reason)) throw authError('reason is invalid', 'INVALID_REASON');
    const now = readTime(clock);
    record.revokedAt = now;
    attempts.delete(id);
    auditEvent(audit, { eventType: 'auth.recovery.revoked', tenantId, userId, factorId: id, actorId, actorRole: role, reason, occurredAt: now });
    return Object.freeze({ revoked: true, factor: metadata(record) });
  }

  function getFactor(factorId) {
    const id = assertFactorId(factorId);
    const record = factors.get(id);
    return record === undefined ? null : metadata(record);
  }

  function listFactorMetadata({ tenantId, userId } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    return Object.freeze([...factors.values()].filter((record) => record.tenantId === tenantId && record.userId === userId).map(metadata));
  }

  return Object.freeze({ enroll, consume, revoke, getFactor, listFactorMetadata, factors, configuration: Object.freeze({ count, maxFailures, lockoutMs }) });
}
