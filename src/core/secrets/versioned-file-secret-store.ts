// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  SecretLease,
  SecretStoreError,
  assertSecretReference,
  assertSecretVersion,
  readCorrelationId,
  readMinimumValidity,
  secretErrorCode,
} from './secret-store.ts';
import type {
  RotatableSecretStore,
  SecretAuditAction,
  SecretAuditSink,
  SecretGetOptions,
  SecretMetadata,
  SecretMutationResult,
  SecretRollbackOptions,
  SecretRotateOptions,
  SecretStatus,
} from './secret-store.ts';

const STATE_SCHEMA_VERSION = 1 as const;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_SECRET_BYTES_LIMIT = 1024 * 1024;
const TRANSIENT_FILE_CODES = new Set(['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT']);

interface VersionMetadataFile {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly reference: string;
  readonly version: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface ActiveStateFile {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly reference: string;
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly rollbackUntil: string | null;
  readonly updatedAt: string;
}

export interface VersionedFileSecretStoreOptions {
  readonly rootDirectory: string;
  readonly references: Readonly<Record<string, string>>;
  readonly audit?: SecretAuditSink;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly createVersion?: () => string;
  readonly readRetryAttempts?: number;
  readonly lockRetryAttempts?: number;
  readonly retryBaseMs?: number;
  readonly lockStaleMs?: number;
  readonly defaultTtlMs?: number;
  readonly maximumTtlMs?: number;
  readonly rollbackWindowMs?: number;
  readonly maximumSecretBytes?: number;
  readonly retainedVersions?: number;
}

interface NormalizedOptions {
  readonly rootDirectory: string;
  readonly references: ReadonlyMap<string, string>;
  readonly allowlist: ReadonlySet<string>;
  readonly audit?: SecretAuditSink;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly createVersion: () => string;
  readonly readRetryAttempts: number;
  readonly lockRetryAttempts: number;
  readonly retryBaseMs: number;
  readonly lockStaleMs: number;
  readonly defaultTtlMs: number;
  readonly maximumTtlMs: number;
  readonly rollbackWindowMs: number;
  readonly maximumSecretBytes: number;
  readonly retainedVersions: number;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new SecretStoreError('INVALID_INPUT');
  }
  return value as number;
}

function normalizeOptions(options: VersionedFileSecretStoreOptions): NormalizedOptions {
  if (typeof options !== 'object' || options === null || typeof options.rootDirectory !== 'string' || !isAbsolute(options.rootDirectory)) {
    throw new SecretStoreError('INVALID_INPUT');
  }
  const referenceEntries = Object.entries(options.references ?? {});
  if (referenceEntries.length === 0) throw new SecretStoreError('INVALID_INPUT');
  const storageKeys = new Set<string>();
  const references = new Map<string, string>();
  for (const [reference, storageKey] of referenceEntries) {
    if (typeof storageKey !== 'string' || !STORAGE_KEY_PATTERN.test(storageKey) || storageKeys.has(storageKey)) {
      throw new SecretStoreError('INVALID_INPUT');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(reference)) throw new SecretStoreError('INVALID_REFERENCE');
    storageKeys.add(storageKey);
    references.set(reference, storageKey);
  }
  const maximumTtlMs = boundedInteger(options.maximumTtlMs, 90 * 86_400_000, 60_000, 366 * 86_400_000);
  const defaultTtlMs = boundedInteger(options.defaultTtlMs, 30 * 86_400_000, 60_000, maximumTtlMs);
  return {
    rootDirectory: resolve(options.rootDirectory),
    references,
    allowlist: new Set(references.keys()),
    audit: options.audit,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))),
    createVersion: options.createVersion ?? (() => `${Date.now().toString(36)}-${randomUUID()}`),
    readRetryAttempts: boundedInteger(options.readRetryAttempts, 2, 0, 5),
    lockRetryAttempts: boundedInteger(options.lockRetryAttempts, 5, 0, 20),
    retryBaseMs: boundedInteger(options.retryBaseMs, 25, 1, 1_000),
    lockStaleMs: boundedInteger(options.lockStaleMs, 30_000, 1_000, 300_000),
    defaultTtlMs,
    maximumTtlMs,
    rollbackWindowMs: boundedInteger(options.rollbackWindowMs, 7 * 86_400_000, 60_000, 30 * 86_400_000),
    maximumSecretBytes: boundedInteger(options.maximumSecretBytes, 64 * 1024, 1, MAX_SECRET_BYTES_LIMIT),
    retainedVersions: boundedInteger(options.retainedVersions, 5, 2, 50),
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return 'UNKNOWN';
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function freezeStatus(status: SecretStatus): SecretStatus {
  return Object.freeze(status);
}

function freezeMutation(result: SecretMutationResult): SecretMutationResult {
  return Object.freeze(result);
}

function parseVersionMetadata(serialized: string, reference: string, version: string): VersionMetadataFile {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    throw new SecretStoreError('SECRET_STATE_INVALID');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new SecretStoreError('SECRET_STATE_INVALID');
  const record = decoded as Record<string, unknown>;
  if (record.schemaVersion !== STATE_SCHEMA_VERSION || record.reference !== reference || record.version !== version
      || !isCanonicalTimestamp(record.createdAt) || !isCanonicalTimestamp(record.expiresAt)) {
    throw new SecretStoreError('SECRET_STATE_INVALID');
  }
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    reference,
    version,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
}

function parseState(serialized: string, reference: string): ActiveStateFile {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    throw new SecretStoreError('SECRET_STATE_INVALID');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new SecretStoreError('SECRET_STATE_INVALID');
  const record = decoded as Record<string, unknown>;
  if (record.schemaVersion !== STATE_SCHEMA_VERSION || record.reference !== reference
      || typeof record.activeVersion !== 'string' || !isCanonicalTimestamp(record.updatedAt)
      || (record.previousVersion !== null && typeof record.previousVersion !== 'string')
      || (record.rollbackUntil !== null && !isCanonicalTimestamp(record.rollbackUntil))) {
    throw new SecretStoreError('SECRET_STATE_INVALID');
  }
  const activeVersion = assertSecretVersion(record.activeVersion);
  const previousVersion = record.previousVersion === null ? null : assertSecretVersion(record.previousVersion);
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    reference,
    activeVersion,
    previousVersion,
    rollbackUntil: record.rollbackUntil as string | null,
    updatedAt: record.updatedAt,
  });
}

function compareSecrets(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class VersionedFileSecretStore implements RotatableSecretStore {
  readonly source = 'versioned-file' as const;
  readonly rotation = 'managed' as const;
  readonly #options: NormalizedOptions;

  constructor(options: VersionedFileSecretStoreOptions) {
    this.#options = normalizeOptions(options);
  }

  #paths(reference: string): {
    readonly directory: string;
    readonly versions: string;
    readonly state: string;
    readonly lock: string;
  } {
    const validated = assertSecretReference(reference, this.#options.allowlist);
    const storageKey = this.#options.references.get(validated);
    if (storageKey === undefined) throw new SecretStoreError('REFERENCE_NOT_ALLOWLISTED');
    const directory = join(this.#options.rootDirectory, storageKey);
    return {
      directory,
      versions: join(directory, 'versions'),
      state: join(directory, 'active.json'),
      lock: join(directory, '.rotation.lock'),
    };
  }

  async #retry<Result>(operation: () => Promise<Result>): Promise<Result> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#options.readRetryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!TRANSIENT_FILE_CODES.has(errorCode(error)) || attempt === this.#options.readRetryAttempts) break;
        await this.#options.sleep(Math.min(1_000, this.#options.retryBaseMs * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async #audit(
    action: SecretAuditAction,
    result: 'success' | 'denied' | 'failed',
    reference: string,
    correlationId: string | null,
    version: string | null,
    reason: ReturnType<typeof secretErrorCode> | null,
  ): Promise<void> {
    if (this.#options.audit === undefined) return;
    try {
      await this.#options.audit(Object.freeze({
        schemaVersion: 1 as const,
        action,
        result,
        occurredAt: this.#options.now().toISOString(),
        reference,
        source: this.source,
        correlationId,
        version,
        reason,
      }));
    } catch {
      throw new SecretStoreError('AUDIT_UNAVAILABLE');
    }
  }

  async #readState(reference: string): Promise<ActiveStateFile | null> {
    const { state } = this.#paths(reference);
    try {
      return parseState(await this.#retry(() => readFile(state, 'utf8')), reference);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async #readMetadata(reference: string, version: string): Promise<VersionMetadataFile> {
    const { versions } = this.#paths(reference);
    try {
      const serialized = await this.#retry(() => readFile(join(versions, `${assertSecretVersion(version)}.json`), 'utf8'));
      return parseVersionMetadata(serialized, reference, version);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new SecretStoreError('VERSION_NOT_FOUND');
      throw error;
    }
  }

  async #readValue(reference: string, version: string): Promise<string> {
    const { versions } = this.#paths(reference);
    const path = join(versions, `${assertSecretVersion(version)}.secret`);
    try {
      const fileStat = await this.#retry(() => stat(path));
      if (!fileStat.isFile()) throw new SecretStoreError('SECRET_FILE_UNSAFE');
      if (fileStat.size <= 0) throw new SecretStoreError('SECRET_UNAVAILABLE');
      if (fileStat.size > this.#options.maximumSecretBytes) throw new SecretStoreError('SECRET_TOO_LARGE');
      const buffer = await this.#retry(() => readFile(path));
      if (buffer.byteLength > this.#options.maximumSecretBytes) throw new SecretStoreError('SECRET_TOO_LARGE');
      const value = buffer.toString('utf8');
      buffer.fill(0);
      if (value.length === 0 || value.includes('\0')) throw new SecretStoreError('SECRET_UNAVAILABLE');
      return value;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new SecretStoreError('SECRET_NOT_FOUND');
      throw error;
    }
  }

  async #writeAtomic(path: string, contents: string, mode: number): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async #writeExclusive(path: string, contents: string, mode: number): Promise<void> {
    let file;
    try {
      file = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new SecretStoreError('VERSION_CONFLICT');
      throw error;
    }
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async #acquireLock(reference: string): Promise<() => Promise<void>> {
    const paths = this.#paths(reference);
    await mkdir(paths.versions, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt <= this.#options.lockRetryAttempts; attempt += 1) {
      const lockToken = `${this.#options.now().toISOString()} ${randomUUID()}\n`;
      try {
        const lockFile = await open(paths.lock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        try {
          await lockFile.writeFile(lockToken, 'utf8');
          await lockFile.sync();
        } finally {
          await lockFile.close();
        }
        return async () => {
          try {
            if (await readFile(paths.lock, 'utf8') === lockToken) await unlink(paths.lock);
          } catch {
            // A missing or replaced lock belongs to no longer-running or other work.
          }
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        try {
          const lockStat = await stat(paths.lock);
          if (this.#options.now().getTime() - lockStat.mtimeMs > this.#options.lockStaleMs) {
            await unlink(paths.lock);
            continue;
          }
        } catch (lockError) {
          if (errorCode(lockError) === 'ENOENT') continue;
          throw lockError;
        }
        if (attempt === this.#options.lockRetryAttempts) throw new SecretStoreError('ROTATION_LOCK_TIMEOUT');
        await this.#options.sleep(Math.min(1_000, this.#options.retryBaseMs * (2 ** attempt)));
      }
    }
    throw new SecretStoreError('ROTATION_LOCK_TIMEOUT');
  }

  #expiry(expiresAt: string | undefined): string {
    const nowMs = this.#options.now().getTime();
    const expiryMs = expiresAt === undefined ? nowMs + this.#options.defaultTtlMs : new Date(expiresAt).getTime();
    if (!Number.isFinite(expiryMs) || expiryMs <= nowMs || expiryMs - nowMs > this.#options.maximumTtlMs) {
      throw new SecretStoreError('INVALID_EXPIRY');
    }
    return new Date(expiryMs).toISOString();
  }

  async #prune(reference: string, activeVersion: string, previousVersion: string | null): Promise<void> {
    const { versions } = this.#paths(reference);
    const entries = await readdir(versions, { withFileTypes: true });
    const metadataFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    const records: VersionMetadataFile[] = [];
    for (const entry of metadataFiles) {
      const version = entry.name.slice(0, -'.json'.length);
      try {
        records.push(await this.#readMetadata(reference, version));
      } catch {
        // Invalid files are not selected or removed automatically.
      }
    }
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const retained = new Set(records.slice(0, this.#options.retainedVersions).map((record) => record.version));
    retained.add(activeVersion);
    if (previousVersion !== null) retained.add(previousVersion);
    for (const record of records) {
      if (retained.has(record.version)) continue;
      await unlink(join(versions, `${record.version}.secret`)).catch(() => {});
      await unlink(join(versions, `${record.version}.json`)).catch(() => {});
    }
  }

  async get(reference: string, options: SecretGetOptions = {}): Promise<SecretLease> {
    const validatedReference = assertSecretReference(reference, this.#options.allowlist);
    const correlationId = readCorrelationId(options.correlationId);
    try {
      const minimumValidity = readMinimumValidity(options.minValidityMs);
      const state = await this.#readState(validatedReference);
      if (state === null) throw new SecretStoreError('SECRET_NOT_FOUND');
      const metadata = await this.#readMetadata(validatedReference, state.activeVersion);
      const remainingMs = new Date(metadata.expiresAt).getTime() - this.#options.now().getTime();
      if (remainingMs <= 0) throw new SecretStoreError('SECRET_EXPIRED');
      if (remainingMs < minimumValidity) throw new SecretStoreError('SECRET_EXPIRING');
      const value = await this.#readValue(validatedReference, state.activeVersion);
      await this.#audit('secret.read', 'success', validatedReference, correlationId, state.activeVersion, null);
      const leaseMetadata: SecretMetadata = {
        reference: validatedReference,
        version: state.activeVersion,
        source: this.source,
        createdAt: metadata.createdAt,
        expiresAt: metadata.expiresAt,
      };
      return new SecretLease(value, leaseMetadata);
    } catch (error) {
      const code = secretErrorCode(error);
      await this.#audit('secret.read', code === 'REFERENCE_NOT_ALLOWLISTED' || code === 'INVALID_REFERENCE' ? 'denied' : 'failed', validatedReference, correlationId, null, code);
      throw error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_UNAVAILABLE');
    }
  }

  async status(reference: string): Promise<SecretStatus> {
    const validatedReference = assertSecretReference(reference, this.#options.allowlist);
    try {
      const state = await this.#readState(validatedReference);
      if (state === null) {
        return freezeStatus({
          reference: validatedReference,
          source: this.source,
          state: 'unavailable',
          rotation: this.rotation,
          activeVersion: null,
          previousVersion: null,
          createdAt: null,
          expiresAt: null,
          rollbackUntil: null,
          reason: 'SECRET_NOT_FOUND',
        });
      }
      const metadata = await this.#readMetadata(validatedReference, state.activeVersion);
      await this.#readValue(validatedReference, state.activeVersion);
      const expired = new Date(metadata.expiresAt).getTime() <= this.#options.now().getTime();
      return freezeStatus({
        reference: validatedReference,
        source: this.source,
        state: expired ? 'expired' : 'ready',
        rotation: this.rotation,
        activeVersion: state.activeVersion,
        previousVersion: state.previousVersion,
        createdAt: metadata.createdAt,
        expiresAt: metadata.expiresAt,
        rollbackUntil: state.rollbackUntil,
        ...(expired ? { reason: 'SECRET_EXPIRED' as const } : {}),
      });
    } catch (error) {
      if (error instanceof SecretStoreError && error.code === 'REFERENCE_NOT_ALLOWLISTED') throw error;
      return freezeStatus({
        reference: validatedReference,
        source: this.source,
        state: 'unavailable',
        rotation: this.rotation,
        activeVersion: null,
        previousVersion: null,
        createdAt: null,
        expiresAt: null,
        rollbackUntil: null,
        reason: secretErrorCode(error),
      });
    }
  }

  async rotate(reference: string, candidate: string, options: SecretRotateOptions): Promise<SecretMutationResult> {
    const validatedReference = assertSecretReference(reference, this.#options.allowlist);
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) throw new SecretStoreError('INVALID_INPUT');
    if (Buffer.byteLength(candidate, 'utf8') > this.#options.maximumSecretBytes) throw new SecretStoreError('SECRET_TOO_LARGE');
    if (typeof options !== 'object' || options === null || !('expectedVersion' in options)) throw new SecretStoreError('INVALID_INPUT');
    const expectedVersion = options.expectedVersion === null ? null : assertSecretVersion(options.expectedVersion);
    const correlationId = readCorrelationId(options.correlationId);
    const expiresAt = this.#expiry(options.expiresAt);
    const release = await this.#acquireLock(validatedReference);
    try {
      const current = await this.#readState(validatedReference);
      if ((current?.activeVersion ?? null) !== expectedVersion) throw new SecretStoreError('VERSION_CONFLICT');
      if (current !== null) {
        const currentValue = await this.#readValue(validatedReference, current.activeVersion);
        if (compareSecrets(currentValue, candidate)) throw new SecretStoreError('UNCHANGED_SECRET');
      }
      const now = this.#options.now();
      const occurredAt = now.toISOString();
      const version = assertSecretVersion(this.#options.createVersion());
      if (current?.activeVersion === version) throw new SecretStoreError('VERSION_CONFLICT');
      const paths = this.#paths(validatedReference);
      await mkdir(paths.versions, { recursive: true, mode: 0o700 });
      const metadata: VersionMetadataFile = Object.freeze({
        schemaVersion: STATE_SCHEMA_VERSION,
        reference: validatedReference,
        version,
        createdAt: occurredAt,
        expiresAt,
      });
      await this.#writeExclusive(join(paths.versions, `${version}.secret`), candidate, 0o600);
      try {
        await this.#writeExclusive(join(paths.versions, `${version}.json`), `${JSON.stringify(metadata)}\n`, 0o600);
      } catch (error) {
        await unlink(join(paths.versions, `${version}.secret`)).catch(() => {});
        throw error;
      }
      const previousVersion = current?.activeVersion ?? null;
      const rollbackUntil = previousVersion === null
        ? null
        : new Date(now.getTime() + this.#options.rollbackWindowMs).toISOString();
      const state: ActiveStateFile = Object.freeze({
        schemaVersion: STATE_SCHEMA_VERSION,
        reference: validatedReference,
        activeVersion: version,
        previousVersion,
        rollbackUntil,
        updatedAt: occurredAt,
      });
      await this.#writeAtomic(paths.state, `${JSON.stringify(state)}\n`, 0o600);
      await this.#audit('secret.rotate', 'success', validatedReference, correlationId, version, null);
      await this.#prune(validatedReference, version, previousVersion).catch(() => {});
      return freezeMutation({
        reference: validatedReference,
        source: this.source,
        action: 'rotated',
        activeVersion: version,
        previousVersion,
        occurredAt,
        expiresAt,
        rollbackUntil,
      });
    } catch (error) {
      const code = secretErrorCode(error);
      await this.#audit('secret.rotate', code === 'VERSION_CONFLICT' || code === 'UNCHANGED_SECRET' ? 'denied' : 'failed', validatedReference, correlationId, null, code);
      throw error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_UNAVAILABLE');
    } finally {
      await release();
    }
  }

  async rollback(reference: string, options: SecretRollbackOptions): Promise<SecretMutationResult> {
    const validatedReference = assertSecretReference(reference, this.#options.allowlist);
    if (typeof options !== 'object' || options === null) throw new SecretStoreError('INVALID_INPUT');
    const expectedCurrentVersion = assertSecretVersion(options.expectedCurrentVersion);
    const targetVersion = assertSecretVersion(options.targetVersion);
    const correlationId = readCorrelationId(options.correlationId);
    const release = await this.#acquireLock(validatedReference);
    try {
      const state = await this.#readState(validatedReference);
      if (state === null || state.activeVersion !== expectedCurrentVersion) throw new SecretStoreError('VERSION_CONFLICT');
      if (state.previousVersion !== targetVersion || state.rollbackUntil === null) throw new SecretStoreError('ROLLBACK_NOT_AVAILABLE');
      const now = this.#options.now();
      if (new Date(state.rollbackUntil).getTime() < now.getTime()) throw new SecretStoreError('ROLLBACK_WINDOW_EXPIRED');
      const targetMetadata = await this.#readMetadata(validatedReference, targetVersion);
      if (new Date(targetMetadata.expiresAt).getTime() <= now.getTime()) throw new SecretStoreError('SECRET_EXPIRED');
      await this.#readValue(validatedReference, targetVersion);
      const occurredAt = now.toISOString();
      const rollbackUntil = new Date(now.getTime() + this.#options.rollbackWindowMs).toISOString();
      const nextState: ActiveStateFile = Object.freeze({
        schemaVersion: STATE_SCHEMA_VERSION,
        reference: validatedReference,
        activeVersion: targetVersion,
        previousVersion: state.activeVersion,
        rollbackUntil,
        updatedAt: occurredAt,
      });
      await this.#writeAtomic(this.#paths(validatedReference).state, `${JSON.stringify(nextState)}\n`, 0o600);
      await this.#audit('secret.rollback', 'success', validatedReference, correlationId, targetVersion, null);
      return freezeMutation({
        reference: validatedReference,
        source: this.source,
        action: 'rolled_back',
        activeVersion: targetVersion,
        previousVersion: state.activeVersion,
        occurredAt,
        expiresAt: targetMetadata.expiresAt,
        rollbackUntil,
      });
    } catch (error) {
      const code = secretErrorCode(error);
      await this.#audit('secret.rollback', code === 'VERSION_CONFLICT' || code.startsWith('ROLLBACK_') ? 'denied' : 'failed', validatedReference, correlationId, null, code);
      throw error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_UNAVAILABLE');
    } finally {
      await release();
    }
  }
}
