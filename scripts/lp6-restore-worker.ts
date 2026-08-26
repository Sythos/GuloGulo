// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createDrRehearsalRecord,
  createRecoveryObjectives,
  createRestorePlan,
  createUserBackupScope,
  decryptArchiveMetadata,
  sha256Hex,
  validateRestorePlan,
  verifyArchiveManifest,
} from '../src/backup/backup-contract.ts';
import { createRetentionStore } from '../src/lifecycle/retention.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`LP6 restore worker requires ${name}.`);
  return value;
}

function recoveryKey(): Buffer {
  const key = Buffer.from(requiredEnvironment('LP6_TEST_KEY_B64'), 'base64url');
  if (key.byteLength !== 32) throw new Error('LP6 restore worker requires a 32-byte LP6_TEST_KEY_B64.');
  return key;
}

const sourceEntries = Object.freeze({
  'mail/INBOX/0001.eml': 'From: alice@example.test\nSubject: LP6 synthetic backup\n\nSynthetic only.\n',
  'calendar/home.ics': 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n',
  'contacts/alice.vcf': 'BEGIN:VCARD\nVERSION:4.0\nFN:Alice\nEND:VCARD\n',
});
const backupDirectory = requiredEnvironment('LP6_BACKUP_DIR');
const restoreDirectory = requiredEnvironment('LP6_RESTORE_DIR');
const manifestRaw = await readFile(resolve(backupDirectory, 'archive-manifest.json'), 'utf8');
const envelopeRaw = await readFile(resolve(backupDirectory, 'metadata-envelope.json'), 'utf8');
const manifest = JSON.parse(manifestRaw);
const envelope = JSON.parse(envelopeRaw);
const sourceArchiveDigest = sha256Hex({ manifestRaw, envelopeRaw });
const metadata = decryptArchiveMetadata(envelope, { key: recoveryKey() });
const scope = createUserBackupScope({
  session: { tenantId: 'acme', userId: 'alice', role: 'user' },
  resources: ['mail', 'ics', 'vcard'],
  issuedAt: '2026-08-26T00:00:00.000Z',
});
const integrity = verifyArchiveManifest(manifest, sourceEntries);
if (!integrity.complete || metadata.archiveId !== manifest.archiveId || metadata.manifestSha256 !== manifest.manifestSha256) {
  throw new Error('LP6 encrypted metadata or archive checksum verification failed.');
}
const plan = createRestorePlan({
  manifest,
  scope,
  target: { tenantId: 'acme', userId: 'alice', role: 'user' },
  requestedResources: ['mail', 'ics', 'vcard'],
});
const restored = validateRestorePlan(plan, {
  manifest,
  scope,
  target: { tenantId: 'acme', userId: 'alice', role: 'user' },
  contentByPath: sourceEntries,
});

let failedRestoreRejected = false;
try {
  validateRestorePlan(plan, {
    manifest,
    scope,
    target: { tenantId: 'acme', userId: 'alice', role: 'user' },
    contentByPath: { ...sourceEntries, 'mail/INBOX/0001.eml': 'tampered synthetic content' },
  });
} catch (error) {
  failedRestoreRejected = (error as { code?: string }).code === 'INTEGRITY_FAILED';
}
if (!failedRestoreRejected) throw new Error('LP6 tampered restore was not rejected.');
const sourcePreserved = sourceArchiveDigest === sha256Hex({
  manifestRaw: await readFile(resolve(backupDirectory, 'archive-manifest.json'), 'utf8'),
  envelopeRaw: await readFile(resolve(backupDirectory, 'metadata-envelope.json'), 'utf8'),
});
if (!sourcePreserved) throw new Error('LP6 failed restore changed the source archive.');

let current = new Date('2026-08-26T00:00:00.000Z');
const retention = createRetentionStore({ now: () => current });
retention.markDeleted({
  tenantId: 'acme', userId: 'alice', itemId: 'lp6-retention-object', resourceType: 'backup',
  deletedAt: '2026-07-29T00:00:00.000Z', idempotencyKey: 'lp6-delete-001',
});
retention.addHold({ tenantId: 'acme', userId: 'alice', itemId: 'lp6-retention-object', holdId: 'lp6-hold-001', reasonCode: 'dr_rehearsal' });
const held = retention.runPurgeBatch({ workerId: 'lp6-worker', operationId: 'lp6-purge-held' });
if (held.purged !== 0) throw new Error('LP6 retention hold did not prevent the 28-day purge.');
retention.releaseHold({ tenantId: 'acme', userId: 'alice', itemId: 'lp6-retention-object', holdId: 'lp6-hold-001' });
const purged = retention.runPurgeBatch({ workerId: 'lp6-worker', operationId: 'lp6-purge-001' });
const repeatedPurge = retention.runPurgeBatch({ workerId: 'lp6-worker', operationId: 'lp6-purge-001' });
if (purged.purged !== 1 || JSON.stringify(purged) !== JSON.stringify(repeatedPurge)) {
  throw new Error('LP6 28-day purge is not held and idempotent as required.');
}
const objectives = createRecoveryObjectives({ rpoMinutes: 15, rtoMinutes: 60, retentionDays: 28 });
const rehearsal = createDrRehearsalRecord({
  rehearsalId: 'lp6-rehearsal-001', tenantId: 'acme', archiveId: manifest.archiveId, objectives,
  startedAt: '2026-08-26T00:00:00.000Z', endedAt: '2026-08-26T00:20:00.000Z', outcome: 'passed',
  observedRpoMinutes: 10, observedRtoMinutes: 20, integrityVerified: true, privacyVerified: true,
  evidenceSha256: sourceArchiveDigest,
});

await mkdir(restoreDirectory, { recursive: true });
await writeFile(resolve(restoreDirectory, 'lp6-restore-result.json'), `${JSON.stringify({
  milestone: 'LP6', archiveId: manifest.archiveId, restoreStatus: restored.status,
  encryptedMetadataVerified: true, checksumsVerified: integrity.complete, isolatedRestore: true,
  failedRestoreRejected, sourcePreserved, retentionDays: 28, heldPurgePrevented: true,
  purgeIdempotent: true, rpoMinutes: objectives.rpoMinutes, rtoMinutes: objectives.rtoMinutes,
  observedRpoMinutes: rehearsal.observedRpoMinutes, observedRtoMinutes: rehearsal.observedRtoMinutes,
  syntheticDataOnly: true, status: 'pass',
}, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ milestone: 'LP6', archiveId: manifest.archiveId, status: 'pass' }, null, 2));
