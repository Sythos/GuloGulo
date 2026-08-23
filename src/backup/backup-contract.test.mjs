// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBackupLinkUsable,
  createArchiveManifest,
  createBackupLink,
  createDrRehearsalRecord,
  createProviderBackupScope,
  createRecoveryObjectives,
  createRestorePlan,
  createUserBackupScope,
  decryptArchiveMetadata,
  encryptArchiveMetadata,
  revokeBackupLink,
  sha256Hex,
  validateRestorePlan,
  verifyArchiveManifest,
} from './backup-contract.mjs';

const session = Object.freeze({
  tenantId: 'acme',
  userId: 'alice',
  role: 'user',
  sessionId: 'must-never-be-copied',
  accessToken: 'must-never-be-copied',
});
const key = Buffer.alloc(32, 7);
const manifestEntries = [
  { resource: 'mail', path: 'mail/INBOX/0001.eml', bytes: 10, sha256: sha256Hex('hello mail') },
  { resource: 'ics', path: 'calendar/home.ics', bytes: 11, sha256: sha256Hex('hello event') },
];

function createScope() {
  return createUserBackupScope({
    session,
    resources: ['mail', 'folders', 'ics', 'vcard', 'preferences'],
    issuedAt: '2026-08-22T10:00:00Z',
  });
}

test('user scope is self-scoped and excludes session secrets', () => {
  const scope = createScope();
  assert.equal(scope.tenantId, 'acme');
  assert.equal(scope.userId, 'alice');
  assert.deepEqual(scope.resources, ['mail', 'folders', 'ics', 'vcard', 'preferences']);
  assert.equal(Object.hasOwn(scope, 'sessionId'), false);
  assert.equal(Object.hasOwn(scope, 'accessToken'), false);
  assert.throws(
    () => createUserBackupScope({ session, targetUserId: 'bob' }),
    (error) => error.code === 'USER_SCOPE_DENIED',
  );
});

test('archive manifest has member checksums and rejects unsafe paths', () => {
  const manifest = createArchiveManifest({ scope: createScope(), entries: manifestEntries, archiveId: 'archive-001' });
  assert.equal(manifest.manifestSha256.length, 64);
  assert.equal(verifyArchiveManifest(manifest, {
    'mail/INBOX/0001.eml': 'hello mail',
    'calendar/home.ics': 'hello event',
  }).complete, true);
  assert.throws(
    () => createArchiveManifest({ scope: createScope(), entries: [{ ...manifestEntries[0], path: '../escape.eml' }] }),
    (error) => error.code === 'INVALID_ARCHIVE_PATH',
  );
  assert.throws(
    () => verifyArchiveManifest(manifest, { 'mail/INBOX/0001.eml': 'tampered', 'calendar/home.ics': 'hello event' }),
    (error) => error.code === 'INTEGRITY_FAILED',
  );
});

test('archive metadata is encrypted and authenticated without serializing the key', () => {
  const metadata = Object.freeze({ archiveId: 'archive-001', tenantId: 'acme', userId: 'alice', resources: ['mail'] });
  const envelope = encryptArchiveMetadata(metadata, {
    key,
    keyReference: 'kms/gulogulo/backup-key-v1',
    random: () => Buffer.alloc(12, 3),
  });
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.equal(Object.hasOwn(envelope, 'key'), false);
  assert.deepEqual(decryptArchiveMetadata(envelope, { key }), metadata);
  assert.throws(
    () => decryptArchiveMetadata({ ...envelope, ciphertext: `${envelope.ciphertext}x` }, { key }),
    (error) => error.code === 'INTEGRITY_FAILED',
  );
  assert.throws(
    () => encryptArchiveMetadata({ accessToken: 'not allowed' }, { key, keyReference: 'kms/key' }),
    (error) => error.code === 'SESSION_SECRET_FORBIDDEN',
  );
});

test('backup links expire and can be revoked', () => {
  const created = createBackupLink({
    archiveId: 'archive-001',
    scope: createScope(),
    baseUrl: 'https://backup.example.test/download',
    issuedAt: '2026-08-22T10:00:00Z',
    ttlMs: 60_000,
    token: 'opaque-token-that-is-long-enough-for-tests',
  });
  assert.match(created.record.href, /^https:\/\/backup\.example\.test\/download\/backup\//u);
  assert.equal(assertBackupLinkUsable(created.record, { token: created.token, now: '2026-08-22T10:00:30Z' }), true);
  assert.throws(
    () => assertBackupLinkUsable(created.record, { token: created.token, now: '2026-08-22T10:01:00Z' }),
    (error) => error.code === 'LINK_EXPIRED',
  );
  const revoked = revokeBackupLink(created.record, { revokedAt: '2026-08-22T10:00:10Z' });
  assert.throws(
    () => assertBackupLinkUsable(revoked, { token: created.token, now: '2026-08-22T10:00:20Z' }),
    (error) => error.code === 'LINK_REVOKED',
  );
});

test('provider scope moves encrypted tenant data without sessions or plaintext access', () => {
  const scope = createProviderBackupScope({
    providerId: 'provider-a',
    tenantId: 'acme',
    encryptionKeyReference: 'kms/gulogulo/tenant-acme',
    issuedAt: '2026-08-22T10:00:00Z',
    expiresAt: '2026-08-23T10:00:00Z',
  });
  assert.equal(scope.userId, null);
  assert.equal(scope.encryptedContentOnly, true);
  assert.equal(scope.plaintextAccess, false);
  assert.equal(scope.sessionAccess, false);
  assert.equal(Object.hasOwn(scope, 'sessionId'), false);
  assert.throws(
    () => createProviderBackupScope({ providerId: 'provider-a', tenantId: 'acme', encryptionKeyReference: 'kms/key', expiresAt: '2026-08-21T10:00:00Z' }),
    (error) => error.code === 'INVALID_TIMESTAMP',
  );
});

test('restore plan validates scope, integrity, and user overwrite policy', () => {
  const scope = createScope();
  const manifest = createArchiveManifest({ scope, entries: manifestEntries, archiveId: 'archive-001' });
  const plan = createRestorePlan({ manifest, scope, target: { tenantId: 'acme', userId: 'alice', role: 'user' }, requestedResources: ['mail', 'ics'] });
  const result = validateRestorePlan(plan, {
    manifest,
    scope,
    target: { tenantId: 'acme', userId: 'alice', role: 'user' },
    contentByPath: { 'mail/INBOX/0001.eml': 'hello mail', 'calendar/home.ics': 'hello event' },
  });
  assert.equal(result.status, 'validated');
  assert.throws(
    () => createRestorePlan({ manifest, scope, target: { tenantId: 'acme', userId: 'bob', role: 'user' } }),
    (error) => error.code === 'USER_SCOPE_DENIED',
  );
  assert.throws(
    () => validateRestorePlan({ ...plan, overwrite: true }, {
      manifest,
      scope,
      target: { tenantId: 'acme', userId: 'alice', role: 'user' },
      contentByPath: { 'mail/INBOX/0001.eml': 'hello mail', 'calendar/home.ics': 'hello event' },
    }),
    (error) => error.code === 'RESTORE_POLICY_DENIED',
  );
});

test('DR objectives and rehearsal record enforce RPO/RTO and privacy evidence', () => {
  const objectives = createRecoveryObjectives({ rpoMinutes: 15, rtoMinutes: 60, retentionDays: 28 });
  const record = createDrRehearsalRecord({
    tenantId: 'acme',
    archiveId: 'archive-001',
    objectives,
    startedAt: '2026-08-22T10:00:00Z',
    endedAt: '2026-08-22T10:20:00Z',
    outcome: 'passed',
    observedRpoMinutes: 10,
    observedRtoMinutes: 20,
    integrityVerified: true,
    privacyVerified: true,
    evidenceSha256: sha256Hex('rehearsal-evidence'),
  });
  assert.equal(record.durationMinutes, 20);
  assert.throws(
    () => createRecoveryObjectives({ rpoMinutes: 60, rtoMinutes: 15 }),
    (error) => error.code === 'INVALID_RECOVERY_OBJECTIVES',
  );
  assert.throws(
    () => createDrRehearsalRecord({
      tenantId: 'acme',
      archiveId: 'archive-001',
      objectives,
      startedAt: '2026-08-22T10:00:00Z',
      endedAt: '2026-08-22T10:20:00Z',
      outcome: 'passed',
      observedRpoMinutes: 20,
      observedRtoMinutes: 20,
      integrityVerified: true,
      privacyVerified: true,
    }),
    (error) => error.code === 'INVALID_REHEARSAL',
  );
});
