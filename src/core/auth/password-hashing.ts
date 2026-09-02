// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import {
  randomBytes as nodeRandomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import { createPasswordPolicy } from './password-policy.ts';

export const PASSWORD_HASH_ALGORITHM = 'scrypt';
export const PASSWORD_HASH_VERSION = 1;
export const PASSWORD_HASH_KEY_BYTES = 32;
export const PASSWORD_HASH_SALT_BYTES = 16;
export const DEFAULT_PASSWORD_HASH_COST = Object.freeze({ N: 16_384, r: 8, p: 1 });

const HASH_PATTERN = /^scrypt\$v(\d+)\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u;

function hashError(message, code = 'PASSWORD_HASH_ERROR') {
  const error = new Error(`Password hash error: ${message}`);
  error.code = code;
  return error;
}

function assertCost(cost) {
  if (cost === null || typeof cost !== 'object' || !Number.isSafeInteger(cost.N) || !Number.isSafeInteger(cost.r) || !Number.isSafeInteger(cost.p)
    || cost.N < 16_384 || cost.N > 1_048_576 || (cost.N & (cost.N - 1)) !== 0 || cost.r < 1 || cost.r > 32 || cost.p < 1 || cost.p > 8) {
    throw hashError('scrypt cost parameters are invalid', 'INVALID_HASH_CONFIGURATION');
  }
  return Object.freeze({ N: cost.N, r: cost.r, p: cost.p });
}

function randomSalt(randomBytesFn) {
  const salt = randomBytesFn(PASSWORD_HASH_SALT_BYTES);
  if (!Buffer.isBuffer(salt) || salt.length !== PASSWORD_HASH_SALT_BYTES) throw hashError('randomBytesFn must return 16 bytes', 'INVALID_RANDOM_SOURCE');
  return salt;
}

function derive(password, salt, cost) {
  try {
    return scryptSync(password, salt, PASSWORD_HASH_KEY_BYTES, {
      N: cost.N,
      r: cost.r,
      p: cost.p,
      maxmem: Math.max(32 * 1024 * 1024, 128 * cost.N * cost.r + 1024),
    });
  } catch {
    throw hashError('password derivation failed', 'HASH_DERIVATION_FAILED');
  }
}

function parseHash(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 512) return null;
  const match = HASH_PATTERN.exec(encoded);
  if (match === null || Number(match[1]) !== PASSWORD_HASH_VERSION) return null;
  const cost = { N: Number(match[2]), r: Number(match[3]), p: Number(match[4]) };
  try {
    assertCost(cost);
  } catch {
    return null;
  }
  const salt = Buffer.from(match[5], 'base64url');
  const digest = Buffer.from(match[6], 'base64url');
  if (salt.length !== PASSWORD_HASH_SALT_BYTES || digest.length !== PASSWORD_HASH_KEY_BYTES) return null;
  return { cost, salt, digest };
}

/**
 * Versioned scrypt password-hash contract. The caller supplies the external
 * LDAP adapter; this module never logs or returns the submitted password.
 */
export function createPasswordHasher({
  policy = createPasswordPolicy(),
  randomBytesFn = nodeRandomBytes,
  cost = DEFAULT_PASSWORD_HASH_COST,
} = {}) {
  if (policy === null || typeof policy.assert !== 'function' || typeof policy.validate !== 'function') throw hashError('policy must be a password policy', 'INVALID_POLICY');
  const currentCost = assertCost(cost);

  function hash(password) {
    policy.assert(password);
    const salt = randomSalt(randomBytesFn);
    const digest = derive(password, salt, currentCost);
    return `scrypt$v${PASSWORD_HASH_VERSION}$N=${currentCost.N},r=${currentCost.r},p=${currentCost.p}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  }

  function verify(password, encoded) {
    if (typeof password !== 'string') return Object.freeze({ valid: false, needsRehash: false, code: 'PASSWORD_NOT_STRING' });
    const parsed = parseHash(encoded);
    if (parsed === null) return Object.freeze({ valid: false, needsRehash: false, code: 'HASH_INVALID' });
    let digest;
    try {
      digest = derive(password, parsed.salt, parsed.cost);
    } catch {
      return Object.freeze({ valid: false, needsRehash: false, code: 'HASH_INVALID' });
    }
    const valid = timingSafeEqual(digest, parsed.digest);
    const needsRehash = valid && (parsed.cost.N !== currentCost.N || parsed.cost.r !== currentCost.r || parsed.cost.p !== currentCost.p);
    return Object.freeze({ valid, needsRehash, code: valid ? undefined : 'PASSWORD_INVALID' });
  }

  return Object.freeze({ algorithm: PASSWORD_HASH_ALGORITHM, version: PASSWORD_HASH_VERSION, cost: currentCost, hash, verify });
}
