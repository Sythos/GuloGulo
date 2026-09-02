// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const TOTP_DEFAULT_PERIOD_SECONDS = 30;
export const TOTP_DEFAULT_DIGITS = 6;
export const TOTP_DEFAULT_ALGORITHM = 'sha1';
export const TOTP_DEFAULT_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_MAX_FAILURES = 5;
export const TOTP_DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ID_PATTERN = /^[a-z0-9][a-z0-9._:@/-]{0,127}$/u;
const FACTOR_ID_PATTERN = /^totp_[A-Za-z0-9_-]{16,64}$/u;
const CODE_PATTERN = /^\d{6,8}$/u;
const HASH_ALGORITHMS = new Set(['sha1', 'sha256', 'sha512']);
const PROTECTOR_PAYLOAD_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;

function authError(message, code = 'TOTP_ERROR') {
  const error = new Error(`TOTP error: ${message}`);
  error.code = code;
  return error;
}

function readTime(clock) {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0) {
    throw authError('clock must return a non-negative millisecond timestamp', 'INVALID_CLOCK');
  }
  return Math.trunc(time);
}

function assertIdentityPart(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw authError(`${name} is invalid`, 'INVALID_IDENTITY');
  }
  return value;
}

function assertFactorId(value) {
  if (typeof value !== 'string' || !FACTOR_ID_PATTERN.test(value)) {
    throw authError('factorId is invalid', 'INVALID_FACTOR');
  }
  return value;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw authError(`${name} is invalid`, 'INVALID_SECRET_PAYLOAD');
  }
  return Buffer.from(value, 'base64url');
}

export function encodeBase32(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw authError('base32 input must be a non-empty buffer', 'INVALID_SECRET');
  }
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(secret) {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) {
    throw authError('secret must be a base32 string', 'INVALID_SECRET');
  }
  const canonical = secret.replace(/[ =-]/gu, '').toUpperCase();
  if (!/^[A-Z2-7]+$/u.test(canonical)) {
    throw authError('secret contains a non-base32 character', 'INVALID_SECRET');
  }
  let buffer = 0;
  let bits = 0;
  const output = [];
  for (const character of canonical) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }
  if (output.length < 10 || output.length > 64) {
    throw authError('secret length is outside the supported range', 'INVALID_SECRET');
  }
  return Buffer.from(output);
}

function normalizeSecret(secret) {
  const decoded = decodeBase32(secret);
  return encodeBase32(decoded);
}

function assertRandomBytes(randomBytesFn, size) {
  const bytes = randomBytesFn(size);
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
    throw authError(`randomBytesFn must return ${size} bytes`, 'INVALID_RANDOM_SOURCE');
  }
  return bytes;
}

function assertProtector(secretProtector) {
  if (secretProtector === null || typeof secretProtector !== 'object'
    || typeof secretProtector.encrypt !== 'function'
    || typeof secretProtector.decrypt !== 'function') {
    throw authError('secretProtector with encrypt/decrypt is required', 'INVALID_SECRET_PROTECTOR');
  }
}

function protectSecret(secretProtector, secret) {
  const protectedValue = secretProtector.encrypt(secret);
  if (typeof protectedValue !== 'string' && !Buffer.isBuffer(protectedValue)) {
    throw authError('secretProtector.encrypt must return a string or buffer', 'INVALID_SECRET_PROTECTOR');
  }
  return Buffer.isBuffer(protectedValue) ? protectedValue.toString('base64url') : protectedValue;
}

function unprotectSecret(secretProtector, protectedValue) {
  const secret = secretProtector.decrypt(protectedValue);
  if (typeof secret !== 'string') {
    throw authError('secretProtector.decrypt must return a base32 string', 'INVALID_SECRET_PROTECTOR');
  }
  return normalizeSecret(secret);
}

function assertCode(code, digits) {
  if (typeof code !== 'string' || code.length !== digits || !/^\d+$/u.test(code)) {
    return false;
  }
  return CODE_PATTERN.test(code);
}

function counterBuffer(counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
}

export function generateTotpCode(secret, counter, { digits = TOTP_DEFAULT_DIGITS, algorithm = TOTP_DEFAULT_ALGORITHM } = {}) {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw authError('counter must be a non-negative safe integer', 'INVALID_COUNTER');
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8 || !HASH_ALGORITHMS.has(algorithm)) {
    throw authError('digits or algorithm is unsupported', 'INVALID_TOTP_CONFIGURATION');
  }
  const key = decodeBase32(secret);
  const digest = createHmac(algorithm, key).update(counterBuffer(counter)).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function codesEqual(left, right) {
  const leftBuffer = Buffer.from(left, 'ascii');
  const rightBuffer = Buffer.from(right, 'ascii');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeLabel(label) {
  if (label === undefined) return 'user';
  if (typeof label !== 'string' || label.length < 1 || label.length > 64 || /[\r\n]/u.test(label)) {
    throw authError('label is invalid', 'INVALID_LABEL');
  }
  return label;
}

function metadata(record) {
  return Object.freeze({
    factorId: record.factorId,
    type: 'totp',
    tenantId: record.tenantId,
    userId: record.userId,
    label: record.label,
    status: record.status,
    createdAt: record.createdAt,
    confirmedAt: record.confirmedAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
  });
}

function auditEvent(audit, event) {
  // The shape is intentionally metadata-only. In particular it has no code,
  // secret, encrypted payload, or authenticator material.
  try {
    audit(Object.freeze({ ...event }));
  } catch {
    // Auditing must never cause a caller to accidentally log an MFA secret.
  }
}

/**
 * Create an in-memory TOTP contract. A production adapter should persist the
 * opaque factor metadata and encryptedSecret in PostgreSQL/a secret store;
 * this service deliberately exposes neither the encrypted value nor a secret
 * read operation.
 */
export function createTotpManager({
  clock = () => Date.now(),
  randomBytesFn = nodeRandomBytes,
  secretProtector,
  periodSeconds = TOTP_DEFAULT_PERIOD_SECONDS,
  digits = TOTP_DEFAULT_DIGITS,
  algorithm = TOTP_DEFAULT_ALGORITHM,
  window = TOTP_DEFAULT_WINDOW,
  maxFailures = TOTP_MAX_FAILURES,
  lockoutMs = TOTP_DEFAULT_LOCKOUT_MS,
  rateLimiter = () => true,
  authorizeRevocation = () => false,
  audit = () => {},
  factors = new Map(),
} = {}) {
  assertProtector(secretProtector);
  if (!Number.isInteger(periodSeconds) || periodSeconds < 15 || periodSeconds > 300
    || !Number.isInteger(digits) || digits < 6 || digits > 8
    || !HASH_ALGORITHMS.has(algorithm)
    || !Number.isInteger(window) || window < 0 || window > 2
    || !Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 20
    || !Number.isSafeInteger(lockoutMs) || lockoutMs < 1000) {
    throw authError('TOTP configuration is invalid', 'INVALID_TOTP_CONFIGURATION');
  }
  if (factors === null || typeof factors.get !== 'function' || typeof factors.set !== 'function' || typeof factors.delete !== 'function') {
    throw authError('factors must implement get, set, and delete', 'INVALID_FACTOR_STORE');
  }
  if (typeof authorizeRevocation !== 'function') throw authError('authorizeRevocation must be a function', 'INVALID_AUTHORIZER');
  const attempts = new Map();

  function assertScope(record, tenantId, userId) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    if (record.tenantId !== tenantId || record.userId !== userId) {
      throw authError('factor is outside the requested identity scope', 'FACTOR_SCOPE_VIOLATION');
    }
  }

  function emitFailure(record, reason, now) {
    const previous = attempts.get(record.factorId) ?? { failed: 0, lockedUntil: 0 };
    const failed = previous.failed + 1;
    const lockedUntil = failed >= maxFailures ? now + lockoutMs : previous.lockedUntil;
    attempts.set(record.factorId, { failed, lockedUntil });
    auditEvent(audit, {
      eventType: 'auth.totp.verification_failed',
      tenantId: record.tenantId,
      userId: record.userId,
      factorId: record.factorId,
      reason,
      locked: lockedUntil > now,
      occurredAt: now,
    });
    return Object.freeze({ verified: false, code: reason, lockedUntil: lockedUntil > now ? lockedUntil : undefined });
  }

  function allowAttempt(record, now) {
    const state = attempts.get(record.factorId);
    if (state?.lockedUntil > now) {
      return false;
    }
    if (state?.lockedUntil && state.lockedUntil <= now) {
      attempts.delete(record.factorId);
    }
    let allowed;
    try {
      allowed = rateLimiter({
        action: 'auth.totp.verify',
        key: `${record.tenantId}:${record.userId}:${record.factorId}`,
        tenantId: record.tenantId,
        userId: record.userId,
        factorId: record.factorId,
      });
    } catch {
      allowed = false;
    }
    return allowed === true || (allowed !== false && allowed?.allowed === true);
  }

  function evaluate(record, code, now, allowPending = false) {
    if (record.status === 'revoked') return Object.freeze({ verified: false, code: 'FACTOR_REVOKED' });
    if (!allowPending && record.status !== 'active') return Object.freeze({ verified: false, code: 'FACTOR_NOT_ACTIVE' });
    if (!assertCode(code, digits)) return emitFailure(record, 'INVALID_CODE', now);
    if (!allowAttempt(record, now)) return emitFailure(record, 'RATE_LIMITED_OR_LOCKED', now);
    let secret;
    try {
      secret = unprotectSecret(secretProtector, record.encryptedSecret);
    } catch {
      return emitFailure(record, 'SECRET_UNAVAILABLE', now);
    }
    const currentCounter = Math.floor(now / 1000 / periodSeconds);
    let matched;
    for (let offset = -window; offset <= window; offset += 1) {
      const candidateCounter = currentCounter + offset;
      if (candidateCounter < 0) continue;
      const expected = generateTotpCode(secret, candidateCounter, { digits, algorithm });
      if (codesEqual(expected, code)) {
        matched = { counter: candidateCounter, offset };
        break;
      }
    }
    if (matched === undefined) return emitFailure(record, 'INVALID_CODE', now);
    if (record.lastUsedCounter !== undefined && matched.counter <= record.lastUsedCounter) {
      return emitFailure(record, 'REPLAYED_CODE', now);
    }
    attempts.delete(record.factorId);
    record.lastUsedCounter = matched.counter;
    record.lastUsedAt = now;
    auditEvent(audit, {
      eventType: 'auth.totp.verified',
      tenantId: record.tenantId,
      userId: record.userId,
      factorId: record.factorId,
      occurredAt: now,
      timeStepOffset: matched.offset,
    });
    return Object.freeze({ verified: true, counter: matched.counter, offset: matched.offset, factor: metadata(record) });
  }

  function getFactor(factorId) {
    const id = assertFactorId(factorId);
    const record = factors.get(id);
    return record === undefined ? null : metadata(record);
  }

  function enroll({ tenantId, userId, label, actorId = userId } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    assertIdentityPart(actorId, 'actorId');
    if (actorId !== userId) {
      throw authError('TOTP enrollment must be initiated by the user', 'FACTOR_SCOPE_VIOLATION');
    }
    const secret = encodeBase32(assertRandomBytes(randomBytesFn, TOTP_SECRET_BYTES));
    let factorId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = `totp_${assertRandomBytes(randomBytesFn, 12).toString('base64url')}`;
      if (!factors.has(candidate)) {
        factorId = candidate;
        break;
      }
    }
    if (factorId === undefined) throw authError('factor identifier collision', 'FACTOR_GENERATION_FAILED');
    const now = readTime(clock);
    const record = {
      factorId,
      tenantId,
      userId,
      label: normalizeLabel(label),
      status: 'pending',
      createdAt: now,
      confirmedAt: undefined,
      revokedAt: undefined,
      lastUsedCounter: undefined,
      lastUsedAt: undefined,
      encryptedSecret: protectSecret(secretProtector, secret),
    };
    factors.set(factorId, record);
    auditEvent(audit, { eventType: 'auth.totp.enrolled', tenantId, userId, factorId, status: 'pending', occurredAt: now });
    const issuer = encodeURIComponent('Gulo Gulo');
    const account = encodeURIComponent(`${userId}@${tenantId}`);
    return Object.freeze({
      factor: metadata(record),
      // The clear secret is returned only from this enrollment response so a
      // UI can render a QR code. Callers must not persist or log this object.
      secret,
      otpauthUri: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=${algorithm.toUpperCase()}&digits=${digits}&period=${periodSeconds}`,
    });
  }

  function confirmEnrollment({ factorId, tenantId, userId, code } = {}) {
    const id = assertFactorId(factorId);
    const record = factors.get(id);
    if (record === undefined) return Object.freeze({ confirmed: false, code: 'FACTOR_NOT_FOUND' });
    assertScope(record, tenantId, userId);
    if (record.status === 'revoked') return Object.freeze({ confirmed: false, code: 'FACTOR_REVOKED' });
    if (record.status === 'active') return Object.freeze({ confirmed: false, code: 'FACTOR_ALREADY_ACTIVE' });
    const result = evaluate(record, code, readTime(clock), true);
    if (!result.verified) return Object.freeze({ confirmed: false, code: result.code, lockedUntil: result.lockedUntil });
    record.status = 'active';
    record.confirmedAt = readTime(clock);
    auditEvent(audit, { eventType: 'auth.totp.confirmed', tenantId, userId, factorId: id, occurredAt: record.confirmedAt });
    return Object.freeze({ confirmed: true, factor: metadata(record) });
  }

  function verify({ factorId, tenantId, userId, code } = {}) {
    const id = assertFactorId(factorId);
    const record = factors.get(id);
    if (record === undefined) return Object.freeze({ verified: false, code: 'FACTOR_NOT_FOUND' });
    assertScope(record, tenantId, userId);
    return evaluate(record, code, readTime(clock));
  }

  function revoke({ factorId, tenantId, userId, actorId = userId, actorRole = 'user', reason = 'user_request' } = {}) {
    const id = assertFactorId(factorId);
    const record = factors.get(id);
    if (record === undefined) return Object.freeze({ revoked: false, code: 'FACTOR_NOT_FOUND' });
    assertScope(record, tenantId, userId);
    assertIdentityPart(actorId, 'actorId');
    let authorized = actorId === userId && actorRole === 'user';
    if (!authorized && actorId !== userId) {
      try {
        authorized = authorizeRevocation({ actorId, actorRole, tenantId, userId, factorId: id });
      } catch {
        authorized = false;
      }
    }
    if (authorized !== true) throw authError('factor revocation is not authorized', 'FACTOR_SCOPE_VIOLATION');
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 128 || /[\r\n]/u.test(reason)) {
      throw authError('reason is invalid', 'INVALID_REASON');
    }
    const now = readTime(clock);
    record.status = 'revoked';
    record.revokedAt = now;
    attempts.delete(id);
    auditEvent(audit, { eventType: 'auth.totp.revoked', tenantId, userId, factorId: id, actorId, actorRole, reason, occurredAt: now });
    return Object.freeze({ revoked: true, factor: metadata(record) });
  }

  function listFactorMetadata({ tenantId, userId } = {}) {
    assertIdentityPart(tenantId, 'tenantId');
    assertIdentityPart(userId, 'userId');
    return Object.freeze([...factors.values()]
      .filter((record) => record.tenantId === tenantId && record.userId === userId)
      .map(metadata));
  }

  return Object.freeze({
    enroll,
    confirmEnrollment,
    verify,
    revoke,
    getFactor,
    listFactorMetadata,
    factors,
    configuration: Object.freeze({ periodSeconds, digits, algorithm, window, maxFailures, lockoutMs }),
  });
}

/**
 * AES-256-GCM protector suitable for a deployment secret supplied outside the
 * container. The key must come from a secret manager, never from source
 * control. The returned value contains no plaintext secret.
 */
export function createAesGcmSecretProtector({ key, randomBytesFn = nodeRandomBytes } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw authError('AES-GCM key must be exactly 32 bytes', 'INVALID_SECRET_KEY');
  }
  return Object.freeze({
    encrypt(secret) {
      const canonical = normalizeSecret(secret);
      const iv = assertRandomBytes(randomBytesFn, 12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(canonical, 'utf8'), cipher.final()]);
      return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(cipher.getAuthTag())}.${base64UrlEncode(ciphertext)}`;
    },
    decrypt(payload) {
      if (typeof payload !== 'string') throw authError('encrypted secret is invalid', 'INVALID_SECRET_PAYLOAD');
      const match = PROTECTOR_PAYLOAD_PATTERN.exec(payload);
      if (match === null) throw authError('encrypted secret payload is invalid', 'INVALID_SECRET_PAYLOAD');
      const iv = base64UrlDecode(match[1], 'iv');
      const tag = base64UrlDecode(match[2], 'auth tag');
      const ciphertext = base64UrlDecode(match[3], 'ciphertext');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
        throw authError('encrypted secret payload has invalid lengths', 'INVALID_SECRET_PAYLOAD');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  });
}
