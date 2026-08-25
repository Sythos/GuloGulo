// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { AttachmentPolicyError, isPrivateOrReservedAddress, resolveAndValidateAttachmentUrl, sanitizeAttachmentFilename, validateAttachmentMetadata, validateAttachmentUrl } from './attachment-policy.ts';

const hasCode = (code: string) => (error: unknown) => error instanceof AttachmentPolicyError && error.code === code;

test('rejects private, metadata, credential-bearing, and non-HTTPS attachment URLs', () => {
  for (const value of ['http://127.0.0.1/file', 'https://10.0.0.2/file', 'https://[::1]/file', 'https://metadata.google.internal/file', 'https://user:pass@example.test/file']) assert.throws(() => validateAttachmentUrl(value), AttachmentPolicyError);
  assert.equal(validateAttachmentUrl('https://cdn.example.test/file.pdf').redirect, 'error');
});

test('re-checks DNS answers to prevent DNS-to-private SSRF', async () => {
  await assert.rejects(resolveAndValidateAttachmentUrl('https://cdn.example.test/file.pdf', { lookup: async () => [{ address: '192.168.1.10' }] }), hasCode('PRIVATE_ADDRESS_BLOCKED'));
  const safe = await resolveAndValidateAttachmentUrl('https://cdn.example.test/file.pdf', { lookup: async () => [{ address: '203.0.114.5' }] });
  assert.deepEqual(safe.addresses, ['203.0.114.5']);
});

test('attachment metadata remains download-only and filenames are sanitized', () => {
  assert.equal(sanitizeAttachmentFilename('../secret\\report:.pdf'), '_secret_report_.pdf');
  const metadata = validateAttachmentMetadata({ filename: '../report.pdf', contentType: 'application/pdf', sizeBytes: 100 });
  assert.equal(metadata.disposition, 'attachment');
  assert.equal(metadata.render, 'download');
  assert.throws(() => validateAttachmentMetadata({ filename: 'run.sh', contentType: 'application/x-sh', sizeBytes: 1 }), hasCode('EXECUTABLE_CONTENT_BLOCKED'));
  assert.equal(isPrivateOrReservedAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedAddress('169.254.169.254'), true);
});
