// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Holds the plaintext webmail login password only long enough for the mail
// core to reuse it as IMAP credentials (real cPanel/Plesk authentication,
// the IMAP IDLE capability probe). This is deliberately not durable storage:
// nothing here ever touches disk, and every entry is bound to one session ID
// and discarded once that session ends. The encryption key is derived from
// the session ID itself plus a random per-process salt (never persisted, so
// it cannot be reconstructed from the session cookie alone) via HKDF,
// following the AES-256-GCM envelope shape `backup-contract.ts` already uses
// elsewhere in this project — but without that module's `keyReference`
// (there is no external key to name; the key never leaves this process) or
// `plaintextSha256` (redundant once GCM's own auth tag verifies integrity).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes as nodeRandomBytes } from 'node:crypto';

import { WebSecurityError } from './session-manager.ts';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HKDF_SALT_BYTES = 32;
const HKDF_INFO = 'gulogulo-session-credential-v1';
const HKDF_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const MAX_CREDENTIAL_BYTES = 1024;

interface CredentialEntry {
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
  readonly expiresAt: number;
}

export interface SessionCredentialStoreOptions {
  clock?: () => number | Date;
  randomBytesFn?: (size: number) => Buffer;
}

function securityError(message: string, code = 'WEB_SECURITY_ERROR'): WebSecurityError {
  return new WebSecurityError(message, code);
}

function readClock(clock: () => number | Date): number {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0) throw securityError('clock must return a valid time', 'INVALID_CLOCK');
  return Math.trunc(time);
}

function assertSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw securityError('session identifier is invalid', 'SESSION_INVALID');
  }
  return sessionId;
}

export function createSessionCredentialStore(options: SessionCredentialStoreOptions = {}) {
  const { clock = () => Date.now(), randomBytesFn = nodeRandomBytes } = options;
  const salt = randomBytesFn(HKDF_SALT_BYTES);
  if (!Buffer.isBuffer(salt) || salt.length !== HKDF_SALT_BYTES) {
    throw securityError('randomBytesFn must return 32 bytes', 'INVALID_RANDOM_SOURCE');
  }
  const entries = new Map<string, CredentialEntry>();

  function deriveKey(sessionId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', sessionId, salt, HKDF_INFO, HKDF_KEY_BYTES));
  }

  function sweep(now: number): void {
    for (const [sessionId, entry] of entries.entries()) if (now >= entry.expiresAt) entries.delete(sessionId);
  }

  function set(sessionId: unknown, credential: string, expiresAt: number): void {
    const canonicalSessionId = assertSessionId(sessionId);
    if (typeof credential !== 'string' || credential.length === 0 || Buffer.byteLength(credential, 'utf8') > MAX_CREDENTIAL_BYTES) {
      throw securityError('credential is invalid', 'INVALID_CREDENTIAL');
    }
    const now = readClock(clock);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw securityError('expiresAt is invalid', 'INVALID_TTL');
    sweep(now);
    const key = deriveKey(canonicalSessionId);
    const iv = randomBytesFn(GCM_IV_BYTES);
    if (!Buffer.isBuffer(iv) || iv.length !== GCM_IV_BYTES) throw securityError('randomBytesFn must return 12 bytes', 'INVALID_RANDOM_SOURCE');
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(canonicalSessionId));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(credential, 'utf8')), cipher.final()]);
    entries.set(canonicalSessionId, { iv, authTag: cipher.getAuthTag(), ciphertext, expiresAt });
  }

  function get(sessionId: unknown): string | null {
    const canonicalSessionId = assertSessionId(sessionId);
    const now = readClock(clock);
    sweep(now);
    const entry = entries.get(canonicalSessionId);
    if (entry === undefined) return null;
    const key = deriveKey(canonicalSessionId);
    try {
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, entry.iv);
      decipher.setAAD(Buffer.from(canonicalSessionId));
      decipher.setAuthTag(entry.authTag);
      const plaintext = Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch {
      entries.delete(canonicalSessionId);
      return null;
    }
  }

  function remove(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) && entries.delete(sessionId);
  }

  return Object.freeze({
    set, get, delete: remove,
    get size() { return entries.size; },
  });
}

export type SessionCredentialStore = ReturnType<typeof createSessionCredentialStore>;
