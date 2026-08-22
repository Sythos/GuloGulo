/*
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
*/

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

await import(`${pathToFileURL(resolve(webDirectory, 'build.mjs')).href}?test=${Date.now()}`);
await access(resolve(webDirectory, 'dist/app.js'));

const app = await import(`${pathToFileURL(resolve(webDirectory, 'dist/app.js')).href}?test=${Date.now()}`);
assert.equal(app.normaliseTimeZone('UTC'), 'UTC');
assert.equal(app.normaliseTimeZone('not/a-timezone'), undefined);
assert.match(app.formatMessageTime({ date: '2026-08-22T18:00:00Z', senderTimeZone: 'UTC' }, 'Europe/Rome'), /\(/);
assert.equal(app.formatMessageTime({ date: 'not-a-date' }, 'UTC'), 'Unknown date');

const calls = [];
const fakeFetch = async (url, options) => {
  calls.push({ url, options });
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: true }),
  };
};
const fakeDocument = {
  querySelector: () => ({ content: 'csrf-test-token' }),
};
const api = app.createApiClient({ fetchFn: fakeFetch, documentRef: fakeDocument, config: { apiBase: '/api' } });
await api.request('/mail/send', { method: 'POST', body: { subject: 'hello' } });
assert.equal(calls[0].url, '/api/mail/send');
assert.equal(calls[0].options.credentials, 'include');
assert.equal(calls[0].options.headers.get('x-csrf-token'), 'csrf-test-token');
assert.deepEqual(JSON.parse(calls[0].options.body), { subject: 'hello' });

const html = await readFile(resolve(webDirectory, 'index.html'), 'utf8');
const css = await readFile(resolve(webDirectory, 'styles.css'), 'utf8');
assert.match(html, /Content-Security-Policy/);
assert.match(html, /aria-live="polite"/);
assert.match(html, /type="module"/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /focus-visible/);

console.log('web-shell.test.mjs: all assertions passed');
