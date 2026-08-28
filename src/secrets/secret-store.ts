// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

export const SECRET_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
export const SECRET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const SECRET_CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type SecretSource = 'versioned-file' | 'docker-secret-file' | 'kubernetes-secret-file';
export type SecretStatusState = 'ready' | 'expired' | 'unavailable';
export type SecretAuditAction = 'secret.read' | 'secret.rotate' | 'secret.rollback';
export type SecretAuditResult = 'success' | 'denied' | 'failed';

export interface SecretMetadata {
  readonly reference: string;
  readonly version: string;
  readonly source: SecretSource;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface SecretStatus {
  readonly reference: string;
  readonly source: SecretSource;
  readonly state: SecretStatusState;
  readonly rotation: 'managed' | 'external';
  readonly activeVersion: string | null;
  readonly previousVersion: string | null;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  readonly rollbackUntil: string | null;
  readonly reason?: SecretErrorCode;
}

export interface SecretMutationResult {
  readonly reference: string;
  readonly source: SecretSource;
  readonly action: 'rotated' | 'rolled_back';
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly rollbackUntil: string | null;
}

export interface SecretAuditEvent {
  readonly schemaVersion: 1;
  readonly action: SecretAuditAction;
  readonly result: SecretAuditResult;
  readonly occurredAt: string;
  readonly reference: string;
  readonly source: SecretSource;
  readonly correlationId: string | null;
  readonly version: string | null;
  readonly reason: SecretErrorCode | null;
}

export type SecretAuditSink = (event: SecretAuditEvent) => void | Promise<void>;

export interface SecretGetOptions {
  readonly minValidityMs?: number;
  readonly correlationId?: string;
}

export interface SecretRotateOptions {
  readonly expectedVersion: string | null;
  readonly expiresAt?: string;
  readonly correlationId?: string;
}

export interface SecretRollbackOptions {
  readonly expectedCurrentVersion: string;
  readonly targetVersion: string;
  readonly correlationId?: string;
}

export interface SecretStore {
  readonly source: SecretSource;
  readonly rotation: 'managed' | 'external';
  get(reference: string, options?: SecretGetOptions): Promise<SecretLease>;
  status(reference: string): Promise<SecretStatus>;
}

export interface RotatableSecretStore extends SecretStore {
  readonly rotation: 'managed';
  rotate(reference: string, candidate: string, options: SecretRotateOptions): Promise<SecretMutationResult>;
  rollback(reference: string, options: SecretRollbackOptions): Promise<SecretMutationResult>;
}

export const SECRET_ERROR_CODES = Object.freeze([
  'INVALID_REFERENCE',
  'REFERENCE_NOT_ALLOWLISTED',
  'INVALID_INPUT',
  'INVALID_VERSION',
  'INVALID_EXPIRY',
  'INVALID_CORRELATION_ID',
  'SECRET_NOT_FOUND',
  'SECRET_UNAVAILABLE',
  'SECRET_EXPIRED',
  'SECRET_EXPIRING',
  'SECRET_TOO_LARGE',
  'SECRET_FILE_UNSAFE',
  'SECRET_STATE_INVALID',
  'VERSION_CONFLICT',
  'VERSION_NOT_FOUND',
  'UNCHANGED_SECRET',
  'ROLLBACK_NOT_AVAILABLE',
  'ROLLBACK_WINDOW_EXPIRED',
  'ROTATION_LOCK_TIMEOUT',
  'AUDIT_UNAVAILABLE',
] as const);

export type SecretErrorCode = typeof SECRET_ERROR_CODES[number];

export class SecretStoreError extends Error {
  readonly code: SecretErrorCode;

  constructor(code: SecretErrorCode) {
    super(`Secret store operation failed: ${code}`);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

/**
 * A non-serializable secret lease. The value is held in a private field so
 * ordinary object inspection and JSON serialization expose metadata only.
 */
export class SecretLease {
  readonly metadata: SecretMetadata;
  #value: string | null;

  constructor(value: string, metadata: SecretMetadata) {
    this.#value = value;
    this.metadata = Object.freeze({ ...metadata });
    Object.freeze(this);
  }

  reveal(): string {
    if (this.#value === null) throw new SecretStoreError('SECRET_UNAVAILABLE');
    return this.#value;
  }

  dispose(): void {
    this.#value = null;
  }

  toJSON(): { readonly metadata: SecretMetadata } {
    return Object.freeze({ metadata: this.metadata });
  }
}

export function assertSecretReference(reference: unknown, allowlist: ReadonlySet<string>): string {
  if (typeof reference !== 'string' || !SECRET_REFERENCE_PATTERN.test(reference)) {
    throw new SecretStoreError('INVALID_REFERENCE');
  }
  if (!allowlist.has(reference)) throw new SecretStoreError('REFERENCE_NOT_ALLOWLISTED');
  return reference;
}

export function assertSecretVersion(version: unknown): string {
  if (typeof version !== 'string' || !SECRET_VERSION_PATTERN.test(version)) {
    throw new SecretStoreError('INVALID_VERSION');
  }
  return version;
}

export function readCorrelationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SECRET_CORRELATION_ID_PATTERN.test(value)) {
    throw new SecretStoreError('INVALID_CORRELATION_ID');
  }
  return value;
}

export function readMinimumValidity(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 86_400_000) {
    throw new SecretStoreError('INVALID_INPUT');
  }
  return value as number;
}

export function createSecretResolver(store: SecretStore): (reference: string) => Promise<string | undefined> {
  return async (reference: string): Promise<string | undefined> => {
    const lease = await store.get(reference);
    try {
      return lease.reveal();
    } finally {
      lease.dispose();
    }
  };
}

export function secretErrorCode(error: unknown): SecretErrorCode {
  return error instanceof SecretStoreError ? error.code : 'SECRET_UNAVAILABLE';
}
