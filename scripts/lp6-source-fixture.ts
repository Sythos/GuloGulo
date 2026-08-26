// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourceDirectory = process.env.LP6_SOURCE_DIR;
if (!sourceDirectory) throw new Error('LP6 source fixture requires LP6_SOURCE_DIR.');

const fixture = Object.freeze({
  schemaVersion: 1,
  tenantId: 'acme',
  userId: 'alice',
  entries: Object.freeze({
    'mail/INBOX/0001.eml': 'From: alice@example.test\nSubject: LP6 synthetic backup\n\nSynthetic only.\n',
    'calendar/home.ics': 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n',
    'contacts/alice.vcf': 'BEGIN:VCARD\nVERSION:4.0\nFN:Alice\nEND:VCARD\n',
  }),
});

await mkdir(sourceDirectory, { recursive: true });
await writeFile(resolve(sourceDirectory, 'synthetic-source.json'), `${JSON.stringify(fixture)}\n`, 'utf8');
console.log(JSON.stringify({ milestone: 'LP6', fixture: 'synthetic-source', status: 'written' }, null, 2));
