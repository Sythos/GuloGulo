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
} from './backup-contract.ts';

const session = Object.freeze({ tenantId: 'acme', userId: 'alice', role: 'user' as const, sessionId: 'never-persist', accessToken: 'never-persist' });
const key = Buffer.alloc(32, 7);
const members = Object.freeze([
  { resource: 'mail' as const, path: 'mail/INBOX/0001.eml', bytes: 10, sha256: sha256Hex('hello mail') },
  { resource: 'ics' as const, path: 'calendar/home.ics', bytes: 11, sha256: sha256Hex('hello event') },
]);
const hasCode = (code: string) => (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
function userScope() { return createUserBackupScope({ session, issuedAt: '2026-08-22T10:00:00Z' }); }
function manifest() { return createArchiveManifest({ scope: userScope(), entries: members, archiveId: 'archive-001' }); }
function content() { return { 'mail/INBOX/0001.eml': 'hello mail', 'calendar/home.ics': 'hello event' }; }

test('LP6 user backup scope is self-scoped and never persists request credentials', () => {
  const scope = userScope();
  assert.deepEqual(scope.resources, ['mail', 'folders', 'ics', 'vcard', 'preferences']);
  assert.equal(Object.hasOwn(scope, 'sessionId'), false);
  assert.equal(Object.hasOwn(scope, 'accessToken'), false);
  assert.throws(() => createUserBackupScope({ session, targetUserId: 'bob' }), hasCode('USER_SCOPE_DENIED'));
});

test('LP6 provider scope moves tenant ciphertext only and requires a bounded authority', () => {
  const scope = createProviderBackupScope({ providerId: 'provider-a', tenantId: 'acme', encryptionKeyReference: 'kms/acme', issuedAt: '2026-08-22T10:00:00Z', expiresAt: '2026-08-23T10:00:00Z' });
  assert.deepEqual({ userId: scope.userId, encrypted: scope.encryptedContentOnly, plaintext: scope.plaintextAccess, sessions: scope.sessionAccess }, { userId: null, encrypted: true, plaintext: false, sessions: false });
  assert.throws(() => createProviderBackupScope({ providerId: 'provider-a', tenantId: 'acme', encryptionKeyReference: 'kms/acme', expiresAt: '2026-08-21T10:00:00Z' }), hasCode('INVALID_TIMESTAMP'));
});

test('LP6 manifests bind all members to checksums and fail closed on traversal or tampering', () => {
  const archive = manifest();
  assert.equal(verifyArchiveManifest(archive, content()).complete, true);
  assert.throws(() => createArchiveManifest({ scope: userScope(), entries: [{ ...members[0], path: '../escape.eml' }] }), hasCode('INVALID_ARCHIVE_PATH'));
  assert.throws(() => verifyArchiveManifest(archive, { ...content(), 'mail/INBOX/0001.eml': 'tampered' }), hasCode('INTEGRITY_FAILED'));
});

test('LP6 metadata encryption authenticates encrypted metadata without serializing a key', () => {
  const metadata = { archiveId: 'archive-001', tenantId: 'acme', userId: 'alice', resources: ['mail'] };
  const envelope = encryptArchiveMetadata(metadata, { key, keyReference: 'kms/acme', random: () => Buffer.alloc(12, 3) });
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.equal(Object.hasOwn(envelope, 'key'), false);
  assert.deepEqual(decryptArchiveMetadata(envelope, { key }), metadata);
  assert.throws(() => decryptArchiveMetadata({ ...envelope, ciphertext: `${envelope.ciphertext}x` }, { key }), hasCode('INTEGRITY_FAILED'));
  assert.throws(() => encryptArchiveMetadata({ accessToken: 'forbidden' }, { key, keyReference: 'kms/acme' }), hasCode('SESSION_SECRET_FORBIDDEN'));
});

test('LP6 download links have short expiry, opaque-token comparison, and revocation', () => {
  const created = createBackupLink({ archiveId: 'archive-001', scope: userScope(), baseUrl: 'https://backup.example.test/download', issuedAt: '2026-08-22T10:00:00Z', ttlMs: 60_000, token: 'opaque-token-that-is-long-enough-for-tests' });
  assert.match(created.record.href, /^https:\/\/backup\.example\.test\/download\/backup\//u);
  assert.equal(assertBackupLinkUsable(created.record, { token: created.token, now: '2026-08-22T10:00:30Z' }), true);
  assert.throws(() => assertBackupLinkUsable(created.record, { token: created.token, now: '2026-08-22T10:01:00Z' }), hasCode('LINK_EXPIRED'));
  assert.throws(() => assertBackupLinkUsable(revokeBackupLink(created.record, { revokedAt: '2026-08-22T10:00:10Z' }), { token: created.token, now: '2026-08-22T10:00:20Z' }), hasCode('LINK_REVOKED'));
});

test('LP6 restore validates archive scope and protects users from overwrite', () => {
  const scope = userScope(); const archive = manifest(); const actor = { tenantId: 'acme', userId: 'alice', role: 'user' as const };
  const plan = createRestorePlan({ manifest: archive, scope, target: actor, requestedResources: ['mail', 'ics'] });
  assert.equal(validateRestorePlan(plan, { manifest: archive, scope, target: actor, contentByPath: content() }).status, 'validated');
  assert.throws(() => createRestorePlan({ manifest: archive, scope, target: { ...actor, userId: 'bob' } }), hasCode('USER_SCOPE_DENIED'));
  assert.throws(() => validateRestorePlan({ ...plan, overwrite: true }, { manifest: archive, scope, target: actor, contentByPath: content() }), hasCode('RESTORE_POLICY_DENIED'));
});

test('LP6 recovery objectives and rehearsal records only mark measured, private recovery passed', () => {
  const objectives = createRecoveryObjectives({ rpoMinutes: 15, rtoMinutes: 60, retentionDays: 28 });
  const record = createDrRehearsalRecord({ tenantId: 'acme', archiveId: 'archive-001', objectives, startedAt: '2026-08-22T10:00:00Z', endedAt: '2026-08-22T10:20:00Z', outcome: 'passed', observedRpoMinutes: 10, observedRtoMinutes: 20, integrityVerified: true, privacyVerified: true, evidenceSha256: sha256Hex('rehearsal-evidence') });
  assert.equal(record.durationMinutes, 20);
  assert.throws(() => createRecoveryObjectives({ rpoMinutes: 60, rtoMinutes: 15 }), hasCode('INVALID_RECOVERY_OBJECTIVES'));
  assert.throws(() => createDrRehearsalRecord({ tenantId: 'acme', archiveId: 'archive-001', objectives, startedAt: '2026-08-22T10:00:00Z', endedAt: '2026-08-22T10:20:00Z', outcome: 'passed', observedRpoMinutes: 20, observedRtoMinutes: 20, integrityVerified: true, privacyVerified: true }), hasCode('INVALID_REHEARSAL'));
});
