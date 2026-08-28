// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ProjectedSecretFileStore,
  SecretStoreError,
  VersionedFileSecretStore,
  createSecretResolver,
} from './index.ts';
import type { SecretAuditEvent } from './index.ts';

const FIRST_SECRET = 'first-value-that-must-never-leak';
const SECOND_SECRET = 'second-value-that-must-never-leak';

async function temporaryDirectory(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gulogulo-secret-store-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof SecretStoreError && error.code === code;
}

test('rotates and resolves allowlisted secrets without serializing secret values', async (t) => {
  const directory = await temporaryDirectory(t);
  const audit: SecretAuditEvent[] = [];
  const versions = ['v1', 'v2'];
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { 'ldap-bind': 'ldap-bind' },
    createVersion: () => versions.shift() ?? 'unexpected',
    now: () => new Date('2026-08-28T10:00:00.000Z'),
    audit: (event) => { audit.push(event); },
  });

  const mutation = await store.rotate('ldap-bind', FIRST_SECRET, {
    expectedVersion: null,
    correlationId: 'rotation-1',
  });
  assert.deepEqual(mutation, {
    reference: 'ldap-bind',
    source: 'versioned-file',
    action: 'rotated',
    activeVersion: 'v1',
    previousVersion: null,
    occurredAt: '2026-08-28T10:00:00.000Z',
    expiresAt: '2026-09-27T10:00:00.000Z',
    rollbackUntil: null,
  });
  assert.equal(JSON.stringify(mutation).includes(FIRST_SECRET), false);

  const lease = await store.get('ldap-bind', { correlationId: 'read-1' });
  assert.equal(lease.reveal(), FIRST_SECRET);
  assert.equal(JSON.stringify(lease).includes(FIRST_SECRET), false);
  assert.deepEqual(lease.metadata, {
    reference: 'ldap-bind',
    version: 'v1',
    source: 'versioned-file',
    createdAt: '2026-08-28T10:00:00.000Z',
    expiresAt: '2026-09-27T10:00:00.000Z',
  });
  lease.dispose();
  assert.throws(() => lease.reveal(), expectCode('SECRET_UNAVAILABLE'));

  const serializedAudit = JSON.stringify(audit);
  assert.equal(serializedAudit.includes(FIRST_SECRET), false);
  assert.deepEqual(audit.map((event) => [event.action, event.result, event.version]), [
    ['secret.rotate', 'success', 'v1'],
    ['secret.read', 'success', 'v1'],
  ]);
});

test('enforces exact allowlisting and rejects path traversal before file access', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { 'postgres-dsn': 'postgres-dsn' },
  });

  await assert.rejects(store.get('ldap-bind'), expectCode('REFERENCE_NOT_ALLOWLISTED'));
  await assert.rejects(store.get('../postgres-dsn'), expectCode('INVALID_REFERENCE'));
  assert.throws(() => new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { 'postgres-dsn': '../outside' },
  }), expectCode('INVALID_INPUT'));
});

test('uses compare-and-swap rotation and preserves the active version on conflict', async (t) => {
  const directory = await temporaryDirectory(t);
  const versions = ['v1', 'v2'];
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { token: 'token' },
    createVersion: () => versions.shift() ?? 'unexpected',
    now: () => new Date('2026-08-28T11:00:00.000Z'),
  });
  await store.rotate('token', FIRST_SECRET, { expectedVersion: null });

  await assert.rejects(
    store.rotate('token', SECOND_SECRET, { expectedVersion: 'stale-version' }),
    expectCode('VERSION_CONFLICT'),
  );
  await assert.rejects(
    store.rotate('token', FIRST_SECRET, { expectedVersion: 'v1' }),
    expectCode('UNCHANGED_SECRET'),
  );
  assert.equal((await store.get('token')).reveal(), FIRST_SECRET);
  assert.equal((await store.status('token')).activeVersion, 'v1');
});

test('never overwrites an immutable version when a version identifier collides', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { token: 'token' },
    createVersion: () => 'v1',
  });
  await store.rotate('token', FIRST_SECRET, { expectedVersion: null });
  await assert.rejects(
    store.rotate('token', SECOND_SECRET, { expectedVersion: 'v1' }),
    expectCode('VERSION_CONFLICT'),
  );
  assert.equal((await store.get('token')).reveal(), FIRST_SECRET);
});

test('fails closed for expired and insufficient-validity secrets', async (t) => {
  const directory = await temporaryDirectory(t);
  let now = new Date('2026-08-28T12:00:00.000Z');
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { token: 'token' },
    createVersion: () => 'v1',
    now: () => now,
  });
  await store.rotate('token', FIRST_SECRET, {
    expectedVersion: null,
    expiresAt: '2026-08-28T12:05:00.000Z',
  });

  await assert.rejects(store.get('token', { minValidityMs: 5 * 60_000 + 1 }), expectCode('SECRET_EXPIRING'));
  now = new Date('2026-08-28T12:05:00.000Z');
  await assert.rejects(store.get('token'), expectCode('SECRET_EXPIRED'));
  assert.deepEqual(await store.status('token'), {
    reference: 'token',
    source: 'versioned-file',
    state: 'expired',
    rotation: 'managed',
    activeVersion: 'v1',
    previousVersion: null,
    createdAt: '2026-08-28T12:00:00.000Z',
    expiresAt: '2026-08-28T12:05:00.000Z',
    rollbackUntil: null,
    reason: 'SECRET_EXPIRED',
  });
});

test('supports a bounded metadata-only rollback to the immediately previous version', async (t) => {
  const directory = await temporaryDirectory(t);
  let now = new Date('2026-08-28T13:00:00.000Z');
  const versions = ['v1', 'v2'];
  const audit: SecretAuditEvent[] = [];
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { token: 'token' },
    createVersion: () => versions.shift() ?? 'unexpected',
    now: () => now,
    rollbackWindowMs: 60_000,
    audit: (event) => { audit.push(event); },
  });
  await store.rotate('token', FIRST_SECRET, { expectedVersion: null });
  now = new Date('2026-08-28T13:01:00.000Z');
  await store.rotate('token', SECOND_SECRET, { expectedVersion: 'v1' });

  now = new Date('2026-08-28T13:01:30.000Z');
  const rollback = await store.rollback('token', {
    expectedCurrentVersion: 'v2',
    targetVersion: 'v1',
    correlationId: 'rollback-1',
  });
  assert.equal(rollback.activeVersion, 'v1');
  assert.equal(rollback.previousVersion, 'v2');
  assert.equal(JSON.stringify(rollback).includes(FIRST_SECRET), false);
  assert.equal((await store.get('token')).reveal(), FIRST_SECRET);
  assert.equal(JSON.stringify(audit).includes(FIRST_SECRET), false);
  assert.equal(JSON.stringify(audit).includes(SECOND_SECRET), false);
});

test('rejects rollback outside its window without changing the active secret', async (t) => {
  const directory = await temporaryDirectory(t);
  let now = new Date('2026-08-28T14:00:00.000Z');
  const versions = ['v1', 'v2'];
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { token: 'token' },
    createVersion: () => versions.shift() ?? 'unexpected',
    now: () => now,
    rollbackWindowMs: 60_000,
  });
  await store.rotate('token', FIRST_SECRET, { expectedVersion: null });
  now = new Date('2026-08-28T14:01:00.000Z');
  await store.rotate('token', SECOND_SECRET, { expectedVersion: 'v1' });
  now = new Date('2026-08-28T14:02:00.001Z');

  await assert.rejects(store.rollback('token', {
    expectedCurrentVersion: 'v2',
    targetVersion: 'v1',
  }), expectCode('ROLLBACK_WINDOW_EXPIRED'));
  assert.equal((await store.get('token')).reveal(), SECOND_SECRET);
});

test('bounds rotation lock retries and does not overwrite an active lock', async (t) => {
  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, 'token', 'versions'), { recursive: true });
  const lockPath = join(directory, 'token', '.rotation.lock');
  const lockTimestamp = new Date('2026-08-28T15:00:00.000Z');
  await writeFile(lockPath, `${lockTimestamp.toISOString()}\n`, { mode: 0o600 });
  await utimes(lockPath, lockTimestamp, lockTimestamp);
  let sleeps = 0;
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { token: 'token' },
    now: () => new Date('2026-08-28T15:00:01.000Z'),
    lockStaleMs: 60_000,
    lockRetryAttempts: 2,
    retryBaseMs: 1,
    sleep: async () => { sleeps += 1; },
  });

  await assert.rejects(store.rotate('token', FIRST_SECRET, { expectedVersion: null }), expectCode('ROTATION_LOCK_TIMEOUT'));
  assert.equal(sleeps, 2);
  assert.equal((await store.status('token')).state, 'unavailable');
});

test('fails closed when the audit sink is unavailable and never returns a secret', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { token: 'token' },
    createVersion: () => 'v1',
    audit: () => { throw new Error(`audit failed ${FIRST_SECRET}`); },
  });

  await assert.rejects(store.rotate('token', FIRST_SECRET, { expectedVersion: null }), expectCode('AUDIT_UNAVAILABLE'));
  await assert.rejects(store.get('token'), expectCode('AUDIT_UNAVAILABLE'));
});

test('adapts Docker and Kubernetes projected secret files as read-only external rotation sources', async (t) => {
  const directory = await temporaryDirectory(t);
  const dockerDirectory = join(directory, 'docker');
  await mkdir(dockerDirectory, { recursive: true });
  const secretPath = join(dockerDirectory, 'ldap-bind');
  await writeFile(secretPath, FIRST_SECRET, { mode: 0o400 });
  await chmod(secretPath, 0o400);
  const audit: SecretAuditEvent[] = [];
  const store = new ProjectedSecretFileStore({
    source: 'docker-secret-file',
    rootDirectory: dockerDirectory,
    references: { 'ldap-bind': 'ldap-bind' },
    audit: (event) => { audit.push(event); },
    now: () => new Date('2026-08-28T16:00:00.000Z'),
  });

  const lease = await store.get('ldap-bind');
  assert.equal(lease.reveal(), FIRST_SECRET);
  assert.equal(JSON.stringify(lease).includes(FIRST_SECRET), false);
  assert.deepEqual(await store.status('ldap-bind'), {
    reference: 'ldap-bind',
    source: 'docker-secret-file',
    state: 'ready',
    rotation: 'external',
    activeVersion: 'projected',
    previousVersion: null,
    createdAt: lease.metadata.createdAt,
    expiresAt: null,
    rollbackUntil: null,
  });
  await assert.rejects(store.get('ldap-bind', { minValidityMs: 1 }), expectCode('SECRET_EXPIRING'));
  await assert.rejects(store.get('../ldap-bind'), expectCode('INVALID_REFERENCE'));
  assert.equal(JSON.stringify(audit).includes(FIRST_SECRET), false);
});

test('rejects projected files that resolve outside the configured root', async (t) => {
  const directory = await temporaryDirectory(t);
  assert.throws(() => new ProjectedSecretFileStore({
    source: 'kubernetes-secret-file',
    rootDirectory: directory,
    references: { token: '../outside' },
  }), expectCode('INVALID_INPUT'));
});

test('provides a narrow compatibility resolver for existing integration adapters', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new VersionedFileSecretStore({
    rootDirectory: directory,
    references: { 'postgres-dsn': 'postgres-dsn' },
    createVersion: () => 'v1',
  });
  await store.rotate('postgres-dsn', FIRST_SECRET, { expectedVersion: null });
  const resolveSecret = createSecretResolver(store);
  assert.equal(await resolveSecret('postgres-dsn'), FIRST_SECRET);
});
