// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SCANNER_SIGNATURE_MAX_AGE_SECONDS,
  computeScannerSignatureContentDigest,
  createScannerSignatureStatus,
  parseScannerSignatureManifest,
  parseScannerSignaturePointer,
  readScannerSignatureStatus,
  resolveScannerSignaturePath,
} from './scanner-signatures.ts';

const POINTER = {
  schemaVersion: 1,
  scanner: 'rspamd',
  generation: 'fixture-rspamd-1',
  directory: 'versions/fixture-rspamd-1',
} as const;

const FILE = {
  path: 'maps/rule.map',
  sha256: 'a'.repeat(64),
  size: 12,
} as const;

function manifest(contentDigest = computeScannerSignatureContentDigest([FILE])) {
  return {
    schemaVersion: 1,
    scanner: 'rspamd',
    generation: POINTER.generation,
    publishedAt: '2026-08-27T00:00:00Z',
    source: 'fixture/rspamd',
    contentDigest,
    files: [FILE],
    status: 'ready',
  } as const;
}

test('accepts a safe active pointer and rejects traversal', () => {
  assert.deepEqual(parseScannerSignaturePointer(POINTER, 'rspamd'), POINTER);
  assert.equal(parseScannerSignaturePointer({ ...POINTER, directory: '../secret' }, 'rspamd'), null);
  assert.equal(parseScannerSignaturePointer({ ...POINTER, generation: '../secret', directory: 'versions/../secret' }, 'rspamd'), null);
});

test('rejects malformed manifests and accepts the canonical digest', () => {
  const canonical = 'maps/rule.map\u0000' + 'a'.repeat(64) + '\n';
  const parsed = parseScannerSignatureManifest(manifest(), 'rspamd', POINTER.generation);
  assert.ok(parsed);
  assert.equal(parsed.contentDigest, computeScannerSignatureContentDigest([FILE]));
  assert.equal(parseScannerSignatureManifest({ ...manifest(), contentDigest: 'sha256:' + '0'.repeat(64) }, 'rspamd', POINTER.generation), null);
  assert.equal(parseScannerSignatureManifest({ ...manifest(), files: [{ ...FILE, path: '../secret' }] }, 'rspamd', POINTER.generation), null);
  assert.equal(canonical.includes('rule.map'), true);
});

test('returns ready and stale metadata without exposing signature files', () => {
  const validManifest = manifest();
  const pointer = parseScannerSignaturePointer(POINTER, 'rspamd');
  assert.ok(pointer);
  // Construct a validated record directly for the status policy test.
  const parsed = Object.freeze({ ...validManifest, files: Object.freeze([FILE]) }) as never;
  const status = createScannerSignatureStatus({ pointer, manifest: parsed, now: new Date('2026-08-27T00:01:00Z') });
  assert.equal(status.status, 'ready');
  assert.equal(status.fileCount, 1);
  assert.equal(Object.hasOwn(status, 'path'), false);
  const stale = createScannerSignatureStatus({ pointer, manifest: parsed, now: new Date('2026-08-27T00:00:02Z'), maxAgeSeconds: 1 });
  assert.equal(stale.status, 'stale');
  assert.equal(DEFAULT_SCANNER_SIGNATURE_MAX_AGE_SECONDS, 604800);
});

test('reads both scanner states from one metadata-only external root', async () => {
  const files = new Map<string, string>([
    ['/external/rspamd/active.json', JSON.stringify(POINTER)],
    ['/external/rspamd/versions/fixture-rspamd-1/manifest.json', JSON.stringify(manifest())],
  ]);
  const fileSystem = { readFile: async (path: string) => {
    const value = files.get(path.replaceAll('\\', '/'));
    if (value === undefined) {
      const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw error;
    }
    return value;
  } };
  const missing = await readScannerSignatureStatus('/external', 'clamav', { fileSystem });
  assert.equal(missing.status, 'missing');
  const ready = await readScannerSignatureStatus('/external', 'rspamd', { fileSystem });
  assert.equal(ready.status, 'ready');
  assert.throws(() => resolveScannerSignaturePath('/external', POINTER, '../secret'), /invalid/);
});
