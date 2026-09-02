// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createClamAvScanner,
  createRspamdScanner,
  mailScannerStatuses,
  normalizeClamAvVerdict,
  normalizeRspamdVerdict,
} from './mail-scanners.ts';

test('Rspamd verdicts are normalized to bounded, immutable safe metadata', () => {
  const symbols = Array.from({ length: 140 }, (_, index) => `SYMBOL_${index}`);
  const verdict = normalizeRspamdVerdict({ status: 'ok', score: -1.25, symbols: [...symbols, 'not-safe!'] });

  assert.equal(verdict.action, 'accept');
  assert.equal(verdict.score, -1.25);
  assert.equal(verdict.symbols.length, 128);
  assert.equal(Object.isFrozen(verdict), true);
  assert.equal(Object.isFrozen(verdict.symbols), true);
  assert.deepEqual(mailScannerStatuses.rspamdActions, [
    'accept',
    'no_action',
    'soft_reject',
    'reject',
    'quarantine',
    'unavailable',
  ]);
});

test('malformed scanner verdicts fail closed at normalization boundary', () => {
  assert.throws(() => normalizeRspamdVerdict(null), (error: unknown) => (error as { code?: string }).code === 'INVALID_VERDICT');
  assert.throws(() => normalizeRspamdVerdict({ action: 'made-up' }), (error: unknown) => (error as { code?: string }).code === 'INVALID_VERDICT');
  assert.throws(() => normalizeRspamdVerdict({ action: 'accept', score: Number.NaN }), (error: unknown) => (error as { code?: string }).code === 'INVALID_VERDICT');

  assert.deepEqual(normalizeClamAvVerdict('clean'), { status: 'clean', signature: null });
  assert.deepEqual(normalizeClamAvVerdict({ status: 'infected', signature: 'Eicar.Test' }), { status: 'infected', signature: 'Eicar.Test' });
  assert.deepEqual(normalizeClamAvVerdict({ status: 'infected', signature: 'body secret' }), { status: 'infected', signature: null });
  assert.throws(() => normalizeClamAvVerdict({ status: 'unknown' }), (error: unknown) => (error as { code?: string }).code === 'INVALID_VERDICT');
  assert.deepEqual(mailScannerStatuses.clamAvStatuses, ['clean', 'infected', 'unavailable']);
});

test('Rspamd adapter strips message content and returns unavailable on failure', async () => {
  let received: unknown;
  const warnings: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const scanner = createRspamdScanner({
    scan: async (metadata) => {
      received = metadata;
      throw new Error('scanner connection refused');
    },
    logger: { warn: (event, details) => warnings.push({ event, details }) },
  });

  const verdict = await scanner.scan({
    sender: 'sender@example.test',
    recipients: ['alice@example.test'],
    sizeBytes: 123,
    messageRef: 'opaque-handle',
    ...( { body: 'private message', subject: 'private subject', password: 'secret' } as unknown as Record<string, unknown>),
  });

  assert.deepEqual(verdict, { action: 'unavailable', score: null, symbols: [] });
  assert.deepEqual(Object.keys(received as object).sort(), ['messageRef', 'recipients', 'sender', 'sizeBytes']);
  assert.equal(Object.hasOwn(received as object, 'body'), false);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(warnings[0]?.event, 'mail_rspamd_unavailable');
  assert.deepEqual(warnings[0]?.details, { error: { name: 'Error' } });
});

test('missing or malformed ClamAV adapters are explicit unavailable states', async () => {
  const missing = createClamAvScanner();
  assert.deepEqual(await missing.scan(), { status: 'unavailable', signature: null });

  const malformed = createClamAvScanner({ scan: async () => ({ status: 'not-a-clamav-state' }) });
  assert.deepEqual(await malformed.scan({ sender: 'sender@example.test' }), { status: 'unavailable', signature: null });
});
