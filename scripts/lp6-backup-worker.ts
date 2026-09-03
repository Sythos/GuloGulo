// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createArchiveManifest,
  createRecoveryObjectives,
  createUserBackupScope,
  encryptArchiveMetadata,
  sha256Hex,
  verifyArchiveManifest,
} from '../src/core/backup/backup-contract.ts';

type SyntheticSource = {
  readonly schemaVersion: number;
  readonly tenantId: string;
  readonly userId: string;
  readonly entries: Readonly<Record<string, string>>;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`LP6 backup worker requires ${name}.`);
  return value;
}

function recoveryKey(): Buffer {
  const key = Buffer.from(requiredEnvironment('LP6_TEST_KEY_B64'), 'base64url');
  if (key.byteLength !== 32) throw new Error('LP6 backup worker requires a 32-byte LP6_TEST_KEY_B64.');
  return key;
}

const sourceDirectory = requiredEnvironment('LP6_SOURCE_DIR');
const backupDirectory = requiredEnvironment('LP6_BACKUP_DIR');
const source = JSON.parse(await readFile(resolve(sourceDirectory, 'synthetic-source.json'), 'utf8')) as SyntheticSource;
if (source.schemaVersion !== 1 || source.tenantId !== 'acme' || source.userId !== 'alice') {
  throw new Error('LP6 source fixture is not the declared synthetic tenant/user scope.');
}

await mkdir(backupDirectory, { recursive: true });
const manifestPath = resolve(backupDirectory, 'archive-manifest.json');
const envelopePath = resolve(backupDirectory, 'metadata-envelope.json');
try {
  const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
  const verification = verifyArchiveManifest(existing, source.entries);
  if (!verification.complete) throw new Error('existing LP6 archive is incomplete');
  console.log(JSON.stringify({ milestone: 'LP6', archiveId: existing.archiveId, idempotent: true, status: 'verified' }, null, 2));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  const scope = createUserBackupScope({
    session: { tenantId: source.tenantId, userId: source.userId, role: 'user' },
    resources: ['mail', 'ics', 'vcard'],
    issuedAt: '2026-08-26T00:00:00.000Z',
  });
  const resourceByPath = Object.freeze({
    'mail/INBOX/0001.eml': 'mail',
    'calendar/home.ics': 'ics',
    'contacts/alice.vcf': 'vcard',
  } as const);
  const manifest = createArchiveManifest({
    scope,
    archiveId: 'lp6-synthetic-archive-001',
    createdAt: '2026-08-26T00:00:00.000Z',
    entries: Object.entries(source.entries).map(([path, content]) => ({
      resource: resourceByPath[path as keyof typeof resourceByPath],
      path,
      bytes: Buffer.byteLength(content),
      sha256: sha256Hex(content),
      mediaType: 'application/octet-stream',
    })),
  });
  const verification = verifyArchiveManifest(manifest, source.entries);
  if (!verification.complete) throw new Error('new LP6 archive verification did not complete.', { cause: error });
  const objectives = createRecoveryObjectives({ rpoMinutes: 15, rtoMinutes: 60, retentionDays: 28 });
  const envelope = encryptArchiveMetadata({
    archiveId: manifest.archiveId,
    tenantId: manifest.tenantId,
    userId: manifest.userId,
    manifestSha256: manifest.manifestSha256,
    recoveryObjectives: objectives,
    syntheticDataOnly: true,
  }, {
    key: recoveryKey(),
    keyReference: process.env.LP6_KEY_REFERENCE || 'kms/local-synthetic/lp6-v1',
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    milestone: 'LP6',
    archiveId: manifest.archiveId,
    manifestSha256: manifest.manifestSha256,
    encryptedMetadata: true,
    idempotent: false,
    status: 'created',
  }, null, 2));
}
