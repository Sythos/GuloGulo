// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createArchiveManifest,
  createUserBackupScope,
  decryptArchiveMetadata,
  encryptArchiveMetadata,
  sha256Hex,
} from './backup-contract.ts';
import { FILESYSTEM_BACKUP_ADAPTER_KIND, createFilesystemBackupAdapter } from './filesystem-backup-adapter.ts';

const session = Object.freeze({ tenantId: 'acme', userId: 'alice', role: 'user' as const });
const key = Buffer.alloc(32, 9);

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function sampleManifest(archiveId: string) {
  const scope = createUserBackupScope({ session, issuedAt: '2026-08-22T10:00:00Z' });
  const entries = [
    { resource: 'mail' as const, path: 'mail/INBOX/0001.eml', bytes: Buffer.byteLength('hello mail'), sha256: sha256Hex('hello mail') },
    { resource: 'ics' as const, path: 'calendar/home.ics', bytes: Buffer.byteLength('hello event'), sha256: sha256Hex('hello event') },
  ];
  return { manifest: createArchiveManifest({ scope, entries, archiveId, createdAt: '2026-08-22T10:05:00Z' }), entries };
}

test('writeArchive really writes manifest and entry bytes to disk, and readManifest/readEntry read them back', async (t) => {
  const basePath = await tempDir('gulogulo-backup-write-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const adapter = createFilesystemBackupAdapter({ basePath });
  assert.equal(adapter.kind, FILESYSTEM_BACKUP_ADAPTER_KIND);
  assert.equal(adapter.basePath, basePath);

  const { manifest } = sampleManifest('archive-001');
  const result = await adapter.writeArchive({
    manifest,
    entries: [
      { path: 'mail/INBOX/0001.eml', content: 'hello mail' },
      { path: 'calendar/home.ics', content: 'hello event' },
    ],
  });

  // Prove this is real disk I/O, not an in-memory fake: read the files back
  // with plain node:fs, independent of the adapter under test.
  const manifestOnDisk = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifestOnDisk.archiveId, 'archive-001');
  assert.equal(result.entryPaths.length, 2);
  for (const entryPath of result.entryPaths) {
    const stats = await stat(entryPath);
    assert.equal(stats.isFile(), true);
  }

  const readBackManifest = await adapter.readManifest({ tenantId: 'acme', userId: 'alice', archiveId: 'archive-001' });
  assert.deepEqual(readBackManifest, manifest);

  const mailBytes = await adapter.readEntry({ tenantId: 'acme', userId: 'alice', archiveId: 'archive-001', path: 'mail/INBOX/0001.eml' });
  assert.equal(mailBytes.toString('utf8'), 'hello mail');
});

test('writeArchive rejects entry content that does not match the manifest checksum', async (t) => {
  const basePath = await tempDir('gulogulo-backup-checksum-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const adapter = createFilesystemBackupAdapter({ basePath });
  const { manifest } = sampleManifest('archive-002');

  await assert.rejects(
    () => adapter.writeArchive({ manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'tampered' }, { path: 'calendar/home.ics', content: 'hello event' }] }),
    /does not match its manifest checksum/,
  );
});

test('writeArchive refuses to write outside the archive directory even if a path escapes containment', async (t) => {
  const basePath = await tempDir('gulogulo-backup-traversal-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const adapter = createFilesystemBackupAdapter({ basePath });
  const { manifest } = sampleManifest('archive-003');
  // backup-contract.ts's own path pattern already forbids traversal segments
  // at manifest-creation time; this test bypasses the contract to prove the
  // adapter also enforces containment on its own, independent of the caller.
  const escaping = { ...manifest, entries: [{ ...manifest.entries[0], path: '../escape.eml' }] };

  await assert.rejects(
    () => adapter.writeArchive({ manifest: escaping as typeof manifest, entries: [{ path: '../escape.eml', content: 'hello mail' }] }),
    /is not declared in the manifest|escapes its storage directory/,
  );
});

test('encrypted metadata round-trips through disk storage and decrypts back to the original value', async (t) => {
  const basePath = await tempDir('gulogulo-backup-metadata-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const adapter = createFilesystemBackupAdapter({ basePath });
  const { manifest } = sampleManifest('archive-004');
  const metadata = { archiveId: 'archive-004', tenantId: 'acme', userId: 'alice' };
  const envelope = encryptArchiveMetadata(metadata, { key, keyReference: 'kms/acme' });

  await adapter.writeArchive({
    manifest,
    entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }],
    encryptedMetadata: envelope,
  });

  const storedEnvelope = await adapter.readEncryptedMetadata({ tenantId: 'acme', userId: 'alice', archiveId: 'archive-004' });
  assert.ok(storedEnvelope);
  assert.deepEqual(decryptArchiveMetadata(storedEnvelope!, { key }), metadata);
});

test('readEncryptedMetadata returns null when no envelope was written', async (t) => {
  const basePath = await tempDir('gulogulo-backup-no-metadata-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const adapter = createFilesystemBackupAdapter({ basePath });
  const { manifest } = sampleManifest('archive-005');
  await adapter.writeArchive({ manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });

  assert.equal(await adapter.readEncryptedMetadata({ tenantId: 'acme', userId: 'alice', archiveId: 'archive-005' }), null);
});

test('deleteArchive removes the archive directory from disk and reports whether it existed', async (t) => {
  const basePath = await tempDir('gulogulo-backup-delete-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const adapter = createFilesystemBackupAdapter({ basePath });
  const { manifest } = sampleManifest('archive-006');
  const written = await adapter.writeArchive({ manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });

  const first = await adapter.deleteArchive({ tenantId: 'acme', userId: 'alice', archiveId: 'archive-006' });
  assert.equal(first.deleted, true);
  await assert.rejects(() => stat(written.archiveDir));

  const second = await adapter.deleteArchive({ tenantId: 'acme', userId: 'alice', archiveId: 'archive-006' });
  assert.equal(second.deleted, false);
});

test('deleteAccountArchives removes every archive for one tenant/user pair', async (t) => {
  const basePath = await tempDir('gulogulo-backup-account-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const adapter = createFilesystemBackupAdapter({ basePath });
  const first = sampleManifest('archive-007');
  const second = sampleManifest('archive-008');
  await adapter.writeArchive({ manifest: first.manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });
  await adapter.writeArchive({ manifest: second.manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });

  assert.deepEqual([...(await adapter.listArchives({ tenantId: 'acme', userId: 'alice' }))].sort(), ['archive-007', 'archive-008']);

  const result = await adapter.deleteAccountArchives({ tenantId: 'acme', userId: 'alice' });
  assert.deepEqual([...result.deletedArchiveIds].sort(), ['archive-007', 'archive-008']);
  assert.deepEqual(await adapter.listArchives({ tenantId: 'acme', userId: 'alice' }), []);
});

test('warns exactly once, via the injected logger, when the backup path and live data path share a device', async (t) => {
  const basePath = await tempDir('gulogulo-backup-samedev-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const warnings: { event: string; details?: Record<string, unknown> }[] = [];
  const adapter = createFilesystemBackupAdapter({
    basePath,
    liveDataPath: basePath, // deliberately the same path: guarantees the same device on every OS
    logger: { warn: (event, details) => warnings.push({ event, details }) },
  });
  const { manifest } = sampleManifest('archive-009');

  await adapter.writeArchive({ manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });
  const second = sampleManifest('archive-010');
  await adapter.writeArchive({ manifest: second.manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });

  assert.equal(warnings.length, 1, 'the same-device warning must fire once per adapter instance, not once per write');
  assert.equal(warnings[0].event, 'backup.same_filesystem_as_live_data');
  assert.equal(warnings[0].details?.basePath, basePath);
});

test('does not warn when an injected stat function reports different devices', async (t) => {
  const basePath = await tempDir('gulogulo-backup-diffdev-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const warnings: unknown[] = [];
  const adapter = createFilesystemBackupAdapter({
    basePath,
    liveDataPath: '/var/lib/gulogulo/mail',
    logger: { warn: (...args) => warnings.push(args) },
    statSyncFn: (path) => ({ dev: path === basePath ? 1 : 2 }),
  });
  const { manifest } = sampleManifest('archive-011');
  await adapter.writeArchive({ manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });

  assert.equal(warnings.length, 0);
});

test('does not warn and does not block when liveDataPath is not configured', async (t) => {
  const basePath = await tempDir('gulogulo-backup-nolive-');
  t.after(() => rm(basePath, { recursive: true, force: true }));
  const warnings: unknown[] = [];
  const adapter = createFilesystemBackupAdapter({ basePath, logger: { warn: (...args) => warnings.push(args) } });
  const { manifest } = sampleManifest('archive-012');
  await adapter.writeArchive({ manifest, entries: [{ path: 'mail/INBOX/0001.eml', content: 'hello mail' }, { path: 'calendar/home.ics', content: 'hello event' }] });

  assert.equal(warnings.length, 0);
});
