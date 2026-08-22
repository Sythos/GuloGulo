// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeEmailHtml } from './email-content.mjs';

test('sanitizes active email HTML and preserves safe semantic content', () => {
  const result = sanitizeEmailHtml('<p onclick="alert(1)">Hello <strong>world</strong></p><script>alert(2)</script><a href="https://example.test" target="_blank">Read</a>');
  assert.match(result.html, /<p>Hello <strong>world<\/strong><\/p>/u);
  assert.match(result.html, /href="https:\/\/example\.test\/"/u);
  assert.match(result.html, /rel="noopener noreferrer nofollow"/u);
  assert.doesNotMatch(result.html, /onclick|script|alert/u);
  assert.equal(result.text, 'Hello world\nRead');
  assert.deepEqual(result.metadata.blockedElements, ['script']);
  assert.deepEqual(result.metadata.blockedAttributes, ['onclick']);
});

test('blocks remote images by default and permits only explicit CID images', () => {
  const result = sanitizeEmailHtml('<img src="https://tracker.example/pixel" alt="Tracking pixel"><img src="cid:local-image" alt="Logo">');
  assert.match(result.html, /data-gulogulo-remote-image-blocked="true"/u);
  assert.match(result.html, /src="cid:local-image"/u);
  assert.equal(result.metadata.remoteImagesBlocked, 1);
  assert.equal(result.metadata.blockedResources[0].kind, 'image');
});

test('rejects unsafe links and limits rendering size', () => {
  const result = sanitizeEmailHtml('<a href="java&#x73;cript:alert(1)">unsafe</a><a href="http://example.test">insecure</a>');
  assert.doesNotMatch(result.html, /javascript|http:\/\/example/u);
  assert.equal(result.metadata.blockedResources.length, 2);
  assert.throws(() => sanitizeEmailHtml('x'.repeat(20), { maxInputBytes: 10 }), (error) => error.code === 'CONTENT_TOO_LARGE');
});
