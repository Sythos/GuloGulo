// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  SecretLease,
  SecretStoreError,
  assertSecretReference,
  readCorrelationId,
  readMinimumValidity,
  secretErrorCode,
} from './secret-store.ts';
import type {
  SecretAuditSink,
  SecretGetOptions,
  SecretMetadata,
  SecretSource,
  SecretStatus,
  SecretStore,
} from './secret-store.ts';

const RELATIVE_FILE_PATTERN = /^(?!\.)(?!.*(?:^|[\\/])\.\.?([\\/]|$))[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*$/u;
const MAX_SECRET_BYTES_LIMIT = 1024 * 1024;

export interface ProjectedSecretFileStoreOptions {
  readonly source: Extract<SecretSource, 'docker-secret-file' | 'kubernetes-secret-file'>;
  readonly rootDirectory: string;
  readonly references: Readonly<Record<string, string>>;
  readonly audit?: SecretAuditSink;
  readonly now?: () => Date;
  readonly maximumSecretBytes?: number;
}

export class ProjectedSecretFileStore implements SecretStore {
  readonly source: Extract<SecretSource, 'docker-secret-file' | 'kubernetes-secret-file'>;
  readonly rotation = 'external' as const;
  readonly #rootDirectory: string;
  readonly #references: ReadonlyMap<string, string>;
  readonly #allowlist: ReadonlySet<string>;
  readonly #audit?: SecretAuditSink;
  readonly #now: () => Date;
  readonly #maximumSecretBytes: number;

  constructor(options: ProjectedSecretFileStoreOptions) {
    if (typeof options !== 'object' || options === null
        || (options.source !== 'docker-secret-file' && options.source !== 'kubernetes-secret-file')
        || typeof options.rootDirectory !== 'string' || !isAbsolute(options.rootDirectory)) {
      throw new SecretStoreError('INVALID_INPUT');
    }
    const entries = Object.entries(options.references ?? {});
    if (entries.length === 0) throw new SecretStoreError('INVALID_INPUT');
    const references = new Map<string, string>();
    const files = new Set<string>();
    for (const [reference, file] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(reference)) throw new SecretStoreError('INVALID_REFERENCE');
      if (typeof file !== 'string' || !RELATIVE_FILE_PATTERN.test(file) || files.has(file)) throw new SecretStoreError('INVALID_INPUT');
      files.add(file);
      references.set(reference, file);
    }
    const maximumSecretBytes = options.maximumSecretBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(maximumSecretBytes) || maximumSecretBytes < 1 || maximumSecretBytes > MAX_SECRET_BYTES_LIMIT) {
      throw new SecretStoreError('INVALID_INPUT');
    }
    this.source = options.source;
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#references = references;
    this.#allowlist = new Set(references.keys());
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
    this.#maximumSecretBytes = maximumSecretBytes;
  }

  async #target(reference: string): Promise<string> {
    const validatedReference = assertSecretReference(reference, this.#allowlist);
    const configuredFile = this.#references.get(validatedReference);
    if (configuredFile === undefined) throw new SecretStoreError('REFERENCE_NOT_ALLOWLISTED');
    let realRoot: string;
    let realTarget: string;
    try {
      [realRoot, realTarget] = await Promise.all([
        realpath(this.#rootDirectory),
        realpath(resolve(this.#rootDirectory, configuredFile)),
      ]);
    } catch {
      throw new SecretStoreError('SECRET_NOT_FOUND');
    }
    const relativeTarget = relative(realRoot, realTarget);
    if (relativeTarget === '' || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
      throw new SecretStoreError('SECRET_FILE_UNSAFE');
    }
    return realTarget;
  }

  async #read(reference: string): Promise<{ value: string; createdAt: string }> {
    const target = await this.#target(reference);
    let fileStat;
    try {
      fileStat = await stat(target);
    } catch {
      throw new SecretStoreError('SECRET_NOT_FOUND');
    }
    if (!fileStat.isFile() || (fileStat.mode & 0o022) !== 0) throw new SecretStoreError('SECRET_FILE_UNSAFE');
    if (fileStat.size <= 0) throw new SecretStoreError('SECRET_UNAVAILABLE');
    if (fileStat.size > this.#maximumSecretBytes) throw new SecretStoreError('SECRET_TOO_LARGE');
    let buffer: Buffer;
    try {
      buffer = await readFile(target);
    } catch {
      throw new SecretStoreError('SECRET_UNAVAILABLE');
    }
    if (buffer.byteLength > this.#maximumSecretBytes) {
      buffer.fill(0);
      throw new SecretStoreError('SECRET_TOO_LARGE');
    }
    const value = buffer.toString('utf8');
    buffer.fill(0);
    if (value.length === 0 || value.includes('\0')) throw new SecretStoreError('SECRET_UNAVAILABLE');
    return { value, createdAt: fileStat.mtime.toISOString() };
  }

  async #emit(
    action: 'secret.read',
    result: 'success' | 'denied' | 'failed',
    reference: string,
    correlationId: string | null,
    reason: ReturnType<typeof secretErrorCode> | null,
  ): Promise<void> {
    if (this.#audit === undefined) return;
    try {
      await this.#audit(Object.freeze({
        schemaVersion: 1 as const,
        action,
        result,
        occurredAt: this.#now().toISOString(),
        reference,
        source: this.source,
        correlationId,
        version: 'projected',
        reason,
      }));
    } catch {
      throw new SecretStoreError('AUDIT_UNAVAILABLE');
    }
  }

  async get(reference: string, options: SecretGetOptions = {}): Promise<SecretLease> {
    const validatedReference = assertSecretReference(reference, this.#allowlist);
    const correlationId = readCorrelationId(options.correlationId);
    try {
      if (readMinimumValidity(options.minValidityMs) !== 0) throw new SecretStoreError('SECRET_EXPIRING');
      const { value, createdAt } = await this.#read(validatedReference);
      await this.#emit('secret.read', 'success', validatedReference, correlationId, null);
      const metadata: SecretMetadata = Object.freeze({
        reference: validatedReference,
        version: 'projected',
        source: this.source,
        createdAt,
        expiresAt: null,
      });
      return new SecretLease(value, metadata);
    } catch (error) {
      const code = secretErrorCode(error);
      await this.#emit('secret.read', code === 'REFERENCE_NOT_ALLOWLISTED' || code === 'INVALID_REFERENCE' ? 'denied' : 'failed', validatedReference, correlationId, code);
      throw error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_UNAVAILABLE');
    }
  }

  async status(reference: string): Promise<SecretStatus> {
    const validatedReference = assertSecretReference(reference, this.#allowlist);
    try {
      const { createdAt } = await this.#read(validatedReference);
      return Object.freeze({
        reference: validatedReference,
        source: this.source,
        state: 'ready',
        rotation: this.rotation,
        activeVersion: 'projected',
        previousVersion: null,
        createdAt,
        expiresAt: null,
        rollbackUntil: null,
      });
    } catch (error) {
      return Object.freeze({
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
}
