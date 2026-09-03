// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/**
 * A real, filesystem-backed implementation of the storage side of
 * `backup-contract.ts`. `backup-contract.ts` builds manifests, encrypted
 * metadata envelopes, and restore plans purely in memory; it never touches a
 * disk. This module is where the bytes actually land.
 *
 * `BackupStorageAdapter` is the generic seam: this file provides the local
 * `filesystem-local` implementation, but nothing here is filesystem-specific
 * in the *interface*, so a future remote adapter (rsync to another host, an
 * S3-compatible object store) can implement the same interface without
 * `backup-contract.ts` — or any caller typed against `BackupStorageAdapter` —
 * changing at all.
 *
 * IMPORTANT — a local-path adapter is a fast-recovery convenience, not
 * disaster recovery. Writing backups to a directory on the same host/disk as
 * the live data protects against accidental deletion within the retention
 * window; it does NOT protect against a failed disk, a lost host, or
 * anything else that takes the whole machine down with it. When `basePath`
 * and `liveDataPath` resolve to the same filesystem device, this adapter
 * logs an explicit one-time warning on first use — see `checkSameDevice()`
 * below — but never blocks the operation: an operator may have a legitimate
 * reason (e.g. a second physical disk mounted under the same host that
 * `liveDataPath` was not told about). See `doc/lifecycle-backup-dr.md` for
 * the full local-backup-vs-disaster-recovery distinction.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { sha256Hex } from './backup-contract.ts';
import type { BackupManifest, EncryptedArchiveMetadata } from './backup-contract.ts';

/** Identifies this concrete adapter among future `BackupStorageAdapter` implementations (e.g. a future `'rsync-remote'` or `'s3-compatible'`). */
export const FILESYSTEM_BACKUP_ADAPTER_KIND = 'filesystem-local' as const;

const MANIFEST_FILE = 'manifest.json';
const METADATA_FILE = 'metadata.json';
const CONTENT_DIRECTORY = 'content';
const TENANT_SCOPE_SEGMENT = '_tenant';

/** Minimal structured-logging surface, matching `IntegrationLogger` in `src/integrations/types.ts` without importing it (keeps `src/core/` free of a `src/integrations/` dependency). */
export interface BackupAdapterLogger {
  readonly warn?: (event: string, details?: Record<string, unknown>) => void;
  readonly info?: (event: string, details?: Record<string, unknown>) => void;
}

export interface StoredArchiveLocation {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly archiveId: string;
}

export interface StoredArchiveEntryContent {
  readonly path: string;
  readonly content: Uint8Array | string;
}

export interface WriteArchiveInput {
  readonly manifest: BackupManifest;
  readonly entries: readonly StoredArchiveEntryContent[];
  readonly encryptedMetadata?: EncryptedArchiveMetadata;
}

export interface WriteArchiveResult {
  readonly archiveDir: string;
  readonly manifestPath: string;
  readonly entryPaths: readonly string[];
  readonly encryptedMetadataPath: string | null;
}

/**
 * Generic storage backend for the manifests/archives/encrypted metadata that
 * `backup-contract.ts` already builds in memory. Every future backend
 * (remote rsync target, S3-compatible object storage, ...) implements this
 * same shape so callers never depend on which one is configured.
 */
export interface BackupStorageAdapter {
  readonly kind: string;
  /** Where this instance actually writes, exposed for logging/diagnostics/tests — never used by callers to bypass the adapter and touch the filesystem directly. */
  readonly basePath: string;
  writeArchive(input: WriteArchiveInput): Promise<WriteArchiveResult>;
  readManifest(location: StoredArchiveLocation): Promise<BackupManifest>;
  readEntry(location: StoredArchiveLocation & { readonly path: string }): Promise<Buffer>;
  readEncryptedMetadata(location: StoredArchiveLocation): Promise<EncryptedArchiveMetadata | null>;
  deleteArchive(location: StoredArchiveLocation): Promise<{ readonly deleted: boolean }>;
  /** Removes every archive stored for one tenant/user pair — used by account-purge wiring for the `'backups'` resource in `AccountResourceType` (see `account-lifecycle-wiring.ts`). */
  deleteAccountArchives(input: { readonly tenantId: string; readonly userId: string }): Promise<{ readonly deletedArchiveIds: readonly string[] }>;
  listArchives(input: { readonly tenantId: string; readonly userId?: string | null }): Promise<readonly string[]>;
}

export interface FilesystemBackupAdapterOptions {
  /** Directory this adapter writes to. Created (recursively) on first use if missing. */
  readonly basePath: string;
  /**
   * Path to the application's live data directory (e.g. the configured
   * mailbox root), used only for the same-device warning below. Omit to
   * skip the check entirely — for example when the caller has no live-data
   * path to compare against.
   */
  readonly liveDataPath?: string;
  readonly logger?: BackupAdapterLogger;
  /** Injectable for tests: defaults to `node:fs`'s `statSync`. Only `.dev` is read from the result. */
  readonly statSyncFn?: (path: string) => { readonly dev: number };
}

const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function pathSegment(value: string, name: string): string {
  if (typeof value !== 'string' || !PATH_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${name} is not a safe filesystem path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonEmptyPath(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty path`);
  return value;
}

/**
 * Resolves `relativePath` under `baseDir` and asserts the result did not
 * escape `baseDir`. `backup-contract.ts`'s own `entries[].path` validation
 * already forbids `..` segments and leading slashes, but this adapter
 * enforces containment independently — defense in depth for anything that
 * calls this module directly without going through the contract first.
 */
function resolveWithinDirectory(baseDir: string, relativePath: string): string {
  const resolvedBase = resolve(baseDir);
  const target = resolve(resolvedBase, relativePath);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + sep)) {
    throw new Error(`path escapes its storage directory: ${relativePath}`);
  }
  return target;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

/**
 * Creates a real, disk-backed `BackupStorageAdapter`. Every method performs
 * actual filesystem I/O (via `node:fs/promises`) — this is not a mock or a
 * validation-only stub.
 */
export function createFilesystemBackupAdapter(options: FilesystemBackupAdapterOptions): BackupStorageAdapter {
  const basePath = requireNonEmptyPath(options.basePath, 'basePath');
  const liveDataPath = options.liveDataPath;
  const logger = options.logger;
  const statFn = options.statSyncFn ?? statSync;
  let sameDeviceChecked = false;

  function warn(event: string, details: Record<string, unknown>): void {
    if (logger?.warn) {
      logger.warn(event, details);
      return;
    }
    console.warn(`[gulogulo-backup] ${event}`, details);
  }

  /**
   * "Al primo utilizzo" — runs once per adapter instance (latched by
   * `sameDeviceChecked`), not on every write. Compares `fs.statSync(...).dev`
   * for `basePath` and `liveDataPath`; on Linux this is the actual block
   * device id, so equal values reliably mean "same filesystem". On other
   * platforms (including the Windows machine this was authored on) `.dev` is
   * still populated but its meaning as a physical-device identifier is
   * weaker — treat a mismatch there as inconclusive, not as proof of
   * separation. Never throws: a stat failure (missing path, permissions)
   * just skips the check silently rather than blocking backup writes.
   */
  function checkSameDevice(): void {
    if (sameDeviceChecked || !liveDataPath) return;
    sameDeviceChecked = true;
    try {
      const backupDevice = statFn(basePath).dev;
      const liveDevice = statFn(liveDataPath).dev;
      if (backupDevice === liveDevice) {
        warn('backup.same_filesystem_as_live_data', {
          basePath,
          liveDataPath,
          message: 'This local filesystem backup target shares a device with the live data directory. It is useful for fast recovery within the retention window, but it is NOT disaster recovery — it will not survive a failed disk or a lost host. Configure an external/remote storage adapter for real disaster recovery once one is available; see doc/lifecycle-backup-dr.md.',
        });
      }
    } catch {
      // basePath or liveDataPath could not be stat'd yet (e.g. not created,
      // no permission). Do not block the backup operation and do not warn
      // on inconclusive information.
    }
  }

  async function ensureReady(): Promise<void> {
    await mkdir(basePath, { recursive: true });
    checkSameDevice();
  }

  function archiveDirectory(tenantId: string, userId: string | null, archiveId: string): string {
    return join(
      basePath,
      pathSegment(tenantId, 'tenantId'),
      pathSegment(userId ?? TENANT_SCOPE_SEGMENT, 'userId'),
      pathSegment(archiveId, 'archiveId'),
    );
  }

  function accountDirectory(tenantId: string, userId: string): string {
    return join(basePath, pathSegment(tenantId, 'tenantId'), pathSegment(userId, 'userId'));
  }

  async function writeArchive(input: WriteArchiveInput): Promise<WriteArchiveResult> {
    await ensureReady();
    const { manifest, entries, encryptedMetadata } = input;
    const dir = archiveDirectory(manifest.tenantId, manifest.userId, manifest.archiveId);
    await mkdir(dir, { recursive: true });

    const manifestPath = join(dir, MANIFEST_FILE);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const contentDir = join(dir, CONTENT_DIRECTORY);
    const declaredByPath = new Map(manifest.entries.map((memberEntry) => [memberEntry.path, memberEntry]));
    const entryPaths: string[] = [];
    for (const entryContent of entries) {
      const declared = declaredByPath.get(entryContent.path);
      if (!declared) throw new Error(`entry ${entryContent.path} is not declared in the manifest`);
      const target = resolveWithinDirectory(contentDir, entryContent.path);
      const buffer = typeof entryContent.content === 'string' ? Buffer.from(entryContent.content, 'utf8') : Buffer.from(entryContent.content);
      const digest = sha256Hex(buffer);
      if (digest !== declared.sha256) throw new Error(`entry ${entryContent.path} content does not match its manifest checksum`);
      if (buffer.byteLength !== declared.bytes) throw new Error(`entry ${entryContent.path} content size does not match its manifest size`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buffer);
      entryPaths.push(target);
    }

    let encryptedMetadataPath: string | null = null;
    if (encryptedMetadata) {
      encryptedMetadataPath = join(dir, METADATA_FILE);
      await writeFile(encryptedMetadataPath, JSON.stringify(encryptedMetadata), 'utf8');
    }

    return Object.freeze({ archiveDir: dir, manifestPath, entryPaths: Object.freeze(entryPaths), encryptedMetadataPath });
  }

  async function readManifest(location: StoredArchiveLocation): Promise<BackupManifest> {
    const dir = archiveDirectory(location.tenantId, location.userId, location.archiveId);
    const raw = await readFile(join(dir, MANIFEST_FILE), 'utf8');
    return JSON.parse(raw) as BackupManifest;
  }

  async function readEntry(location: StoredArchiveLocation & { readonly path: string }): Promise<Buffer> {
    const dir = archiveDirectory(location.tenantId, location.userId, location.archiveId);
    const target = resolveWithinDirectory(join(dir, CONTENT_DIRECTORY), location.path);
    return readFile(target);
  }

  async function readEncryptedMetadata(location: StoredArchiveLocation): Promise<EncryptedArchiveMetadata | null> {
    const dir = archiveDirectory(location.tenantId, location.userId, location.archiveId);
    try {
      const raw = await readFile(join(dir, METADATA_FILE), 'utf8');
      return JSON.parse(raw) as EncryptedArchiveMetadata;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function deleteArchive(location: StoredArchiveLocation): Promise<{ readonly deleted: boolean }> {
    const dir = archiveDirectory(location.tenantId, location.userId, location.archiveId);
    const existed = await pathExists(join(dir, MANIFEST_FILE));
    await rm(dir, { recursive: true, force: true });
    return Object.freeze({ deleted: existed });
  }

  async function deleteAccountArchives(input: { readonly tenantId: string; readonly userId: string }): Promise<{ readonly deletedArchiveIds: readonly string[] }> {
    const dir = accountDirectory(input.tenantId, input.userId);
    let deletedArchiveIds: string[];
    try {
      deletedArchiveIds = await readdir(dir);
    } catch {
      deletedArchiveIds = [];
    }
    await rm(dir, { recursive: true, force: true });
    return Object.freeze({ deletedArchiveIds: Object.freeze(deletedArchiveIds) });
  }

  async function listArchives(input: { readonly tenantId: string; readonly userId?: string | null }): Promise<readonly string[]> {
    const dir = join(basePath, pathSegment(input.tenantId, 'tenantId'), pathSegment(input.userId ?? TENANT_SCOPE_SEGMENT, 'userId'));
    try {
      return Object.freeze(await readdir(dir));
    } catch {
      return Object.freeze([]);
    }
  }

  return Object.freeze({
    kind: FILESYSTEM_BACKUP_ADAPTER_KIND,
    basePath,
    writeArchive,
    readManifest,
    readEntry,
    readEncryptedMetadata,
    deleteArchive,
    deleteAccountArchives,
    listArchives,
  });
}
