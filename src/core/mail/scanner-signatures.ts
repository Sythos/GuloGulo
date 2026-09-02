// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile as readFileFromDisk } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, normalize, relative, resolve } from 'node:path';

export const SCANNER_SIGNATURE_SCHEMA_VERSION = 1 as const;
export const SCANNER_SIGNATURE_ROOT = '/var/lib/gulogulo/scanner-signatures' as const;
export const DEFAULT_SCANNER_SIGNATURE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const SCANNER_KINDS = Object.freeze(['rspamd', 'clamav'] as const);
export type ScannerKind = typeof SCANNER_KINDS[number];

export const SCANNER_SIGNATURE_STATES = Object.freeze(['ready', 'missing', 'invalid', 'stale'] as const);
export type ScannerSignatureState = typeof SCANNER_SIGNATURE_STATES[number];

const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const SAFE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

type UnknownRecord = Record<string, unknown>;

export interface ScannerSignaturePointer {
  readonly schemaVersion: typeof SCANNER_SIGNATURE_SCHEMA_VERSION;
  readonly scanner: ScannerKind;
  readonly generation: string;
  readonly directory: string;
}

export interface ScannerSignatureFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ScannerSignatureManifest {
  readonly schemaVersion: typeof SCANNER_SIGNATURE_SCHEMA_VERSION;
  readonly scanner: ScannerKind;
  readonly generation: string;
  readonly publishedAt: string;
  readonly source: string;
  readonly contentDigest: string;
  readonly files: readonly ScannerSignatureFile[];
  readonly status: 'ready';
}

export interface ScannerSignatureStatus {
  readonly schemaVersion: typeof SCANNER_SIGNATURE_SCHEMA_VERSION;
  readonly scanner: ScannerKind;
  readonly status: ScannerSignatureState;
  readonly generation?: string;
  readonly publishedAt?: string;
  readonly source?: string;
  readonly contentDigest?: string;
  readonly fileCount?: number;
  readonly ageSeconds?: number;
  readonly reason?: 'missing' | 'invalid' | 'stale';
}

export interface ScannerSignatureReadFileSystem {
  readFile: (path: string, options: 'utf8') => Promise<string>;
}

const defaultFileSystem: ScannerSignatureReadFileSystem = Object.freeze({
  readFile: async (path: string, options: 'utf8'): Promise<string> => readFileFromDisk(path, options),
});

function record(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as UnknownRecord : null;
}

function safeTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && (value === parsed.toISOString() || value === parsed.toISOString().replace('.000Z', 'Z'));
}

function safeGeneration(value: unknown): value is string {
  return typeof value === 'string' && SAFE_GENERATION.test(value);
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !SAFE_RELATIVE_PATH.test(value) || value.includes('\\')) return false;
  const normalized = normalize(value).replaceAll('\\', '/');
  return normalized === value && !value.startsWith('/') && !value.split('/').includes('..');
}

function invalidStatus(scanner: ScannerKind, reason: 'missing' | 'invalid' | 'stale'): ScannerSignatureStatus {
  return Object.freeze({
    schemaVersion: SCANNER_SIGNATURE_SCHEMA_VERSION,
    scanner,
    status: reason,
    reason,
  });
}

function canonicalContentDescriptor(files: readonly ScannerSignatureFile[]): string {
  return files
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\u0000${file.sha256}\n`)
    .join('');
}

/** Compute the manifest digest from file metadata, never from raw signature content. */
export function computeScannerSignatureContentDigest(files: readonly ScannerSignatureFile[]): string {
  return `sha256:${createHash('sha256').update(canonicalContentDescriptor(files), 'utf8').digest('hex')}`;
}

/** Parse the atomically replaced active pointer without accepting filesystem paths. */
export function parseScannerSignaturePointer(value: unknown, scanner: ScannerKind): ScannerSignaturePointer | null {
  const input = record(value);
  if (!input || input.schemaVersion !== SCANNER_SIGNATURE_SCHEMA_VERSION || input.scanner !== scanner || !safeGeneration(input.generation)) return null;
  const directory = `versions/${input.generation}`;
  return input.directory === directory ? Object.freeze({
    schemaVersion: SCANNER_SIGNATURE_SCHEMA_VERSION,
    scanner,
    generation: input.generation,
    directory,
  }) : null;
}

/** Parse one scanner manifest; raw signature content is never accepted here. */
export function parseScannerSignatureManifest(value: unknown, scanner: ScannerKind, generation: string): ScannerSignatureManifest | null {
  const input = record(value);
  if (!input || input.schemaVersion !== SCANNER_SIGNATURE_SCHEMA_VERSION || input.scanner !== scanner || input.generation !== generation) return null;
  if (!safeTimestamp(input.publishedAt) || typeof input.source !== 'string' || !SAFE_SOURCE.test(input.source)) return null;
  if (typeof input.contentDigest !== 'string' || !input.contentDigest.startsWith('sha256:') || !SHA256.test(input.contentDigest.slice(7)) || input.status !== 'ready') return null;
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 1000) return null;

  const files: ScannerSignatureFile[] = [];
  const paths = new Set<string>();
  for (const entry of input.files) {
    const file = record(entry);
    const size = file?.size;
    if (!file || !safeRelativePath(file.path) || paths.has(file.path) || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256) || !Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > 10 * 1024 * 1024 * 1024) return null;
    paths.add(file.path);
    files.push(Object.freeze({ path: file.path, sha256: file.sha256, size: size as number }));
  }
  const expectedDigest = computeScannerSignatureContentDigest(files);
  if (input.contentDigest !== expectedDigest) return null;
  return Object.freeze({
    schemaVersion: SCANNER_SIGNATURE_SCHEMA_VERSION,
    scanner,
    generation,
    publishedAt: input.publishedAt,
    source: input.source,
    contentDigest: input.contentDigest,
    files: Object.freeze(files),
    status: 'ready',
  });
}

/**
 * Build a metadata-only status from already validated records. The content
 * digest is checked by the scanner process before a message is accepted.
 */
export function createScannerSignatureStatus({
  pointer,
  manifest,
  now = new Date(),
  maxAgeSeconds = DEFAULT_SCANNER_SIGNATURE_MAX_AGE_SECONDS,
}: {
  pointer: ScannerSignaturePointer;
  manifest: ScannerSignatureManifest;
  now?: Date;
  maxAgeSeconds?: number;
}): ScannerSignatureStatus {
  if (pointer.scanner !== manifest.scanner || pointer.generation !== manifest.generation) return invalidStatus(pointer.scanner, 'invalid');
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 1) return invalidStatus(pointer.scanner, 'invalid');
  const ageSeconds = Math.floor((now.getTime() - new Date(manifest.publishedAt).getTime()) / 1000);
  const base = {
    schemaVersion: SCANNER_SIGNATURE_SCHEMA_VERSION,
    scanner: manifest.scanner,
    generation: manifest.generation,
    publishedAt: manifest.publishedAt,
    source: manifest.source,
    contentDigest: manifest.contentDigest,
    fileCount: manifest.files.length,
    ageSeconds: Math.max(0, ageSeconds),
  };
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return Object.freeze({ ...base, status: 'stale' as const, reason: 'stale' as const });
  return Object.freeze({ ...base, status: 'ready' as const });
}

/** Return a safe absolute path for a manifest-listed file under one generation. */
export function resolveScannerSignaturePath(root: string, pointer: ScannerSignaturePointer, relativePath: string): string {
  if (!safeRelativePath(relativePath)) throw new Error('Scanner signature path is invalid.');
  const generationRoot = resolve(root, pointer.scanner, pointer.directory);
  const candidate = resolve(generationRoot, relativePath);
  const rel = relative(generationRoot, candidate).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..') || rel.includes('\\') || rel.split('/').includes('..')) throw new Error('Scanner signature path escapes its generation.');
  return candidate;
}

/** Read only active metadata; missing and malformed external updates fail closed. */
export async function readScannerSignatureStatus(
  root: string = SCANNER_SIGNATURE_ROOT,
  scanner: ScannerKind,
  options: { now?: Date; maxAgeSeconds?: number; fileSystem?: ScannerSignatureReadFileSystem } = {},
): Promise<ScannerSignatureStatus> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const pointerPath = join(root, scanner, 'active.json');
  try {
    const pointer = parseScannerSignaturePointer(JSON.parse(await fileSystem.readFile(pointerPath, 'utf8')) as unknown, scanner);
    if (!pointer) return invalidStatus(scanner, 'invalid');
    const manifestPath = join(root, scanner, pointer.directory, 'manifest.json');
    const manifest = parseScannerSignatureManifest(JSON.parse(await fileSystem.readFile(manifestPath, 'utf8')) as unknown, scanner, pointer.generation);
    if (!manifest) return invalidStatus(scanner, 'invalid');
    return createScannerSignatureStatus({ pointer, manifest, now: options.now, maxAgeSeconds: options.maxAgeSeconds });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return invalidStatus(scanner, 'missing');
    return invalidStatus(scanner, 'invalid');
  }
}
