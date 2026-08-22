// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { detectBrowserTimeZone, formatLocalTimestamp, formatMessageTimestamp, normalizeTimeZone, resolveViewerTimeZone } from './timezone.mjs';

test('detects and resolves a deterministic browser or manual time zone', () => {
  const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Rome' }) }) };
  assert.equal(detectBrowserTimeZone({ intl }), 'Europe/Rome');
  assert.deepEqual(resolveViewerTimeZone({ browserTimeZone: 'Europe/Rome' }), { timeZone: 'Europe/Rome', source: 'browser' });
  assert.deepEqual(resolveViewerTimeZone({ manualOverride: 'America/New_York', browserTimeZone: 'Europe/Rome' }), { timeZone: 'America/New_York', source: 'manual' });
  assert.throws(() => normalizeTimeZone('Not/AZone'), (error) => error.code === 'INVALID_TIMEZONE');
});
test('formats an email timestamp and adds a local equivalent when zones differ', () => {
  const timestamp = '2026-08-22T12:00:00.000Z';
  const local = formatLocalTimestamp(timestamp, { timeZone: 'Europe/Rome', locale: 'en-GB' });
  assert.match(local, /22 Aug 2026/u);
  assert.match(local, /14:00:00/u);
  const result = formatMessageTimestamp(timestamp, { senderTimeZone: 'America/New_York', viewerTimeZone: 'Europe/Rome', locale: 'en-GB' });
  assert.equal(result.differentTimeZone, true);
  assert.match(result.display, /\(22 Aug 2026, 14:00:00\)/u);
  assert.equal(formatMessageTimestamp(timestamp, { senderTimeZone: 'Europe/Rome', viewerTimeZone: 'Europe/Rome' }).display, formatLocalTimestamp(timestamp, { timeZone: 'Europe/Rome' }));
});
