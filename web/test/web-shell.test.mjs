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
const csrfToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
assert.equal(app.normaliseTimeZone('UTC'), 'UTC');
assert.equal(app.normaliseTimeZone('not/a-timezone'), undefined);
assert.match(app.formatMessageTime({ date: '2026-08-22T18:00:00Z', senderTimeZone: 'UTC' }, 'Europe/Rome'), /\(/);
assert.equal(app.formatMessageTime({ date: 'not-a-date' }, 'UTC'), 'Unknown date');
assert.deepEqual(
  app.parseRealtimeMetadata('{"eventType":"calendar.changed","resourceId":"event-1","body":"must-not-reach-browser"}'),
  { eventType: 'calendar.changed', resourceId: 'event-1' },
);
assert.equal(app.parseRealtimeMetadata('{"body":"not metadata"}'), undefined);
assert.equal(
  app.readAuthenticatedSession({ authenticated: false, user: { email: 'alice@gulogulo.test' }, csrfToken }),
  undefined,
);
assert.equal(
  app.readAuthenticatedSession({ user: { email: 'alice@gulogulo.test' }, csrfToken })?.user.email,
  'alice@gulogulo.test',
);
assert.equal(app.readAuthenticatedSession({ user: { email: 'alice@gulogulo.test' }, csrfToken: 'not-a-token' }), undefined);

const authenticationElements = {
  '#login-shell': { hidden: false },
  '#app-shell': { hidden: true },
  '#skip-link': { href: '#login-form', textContent: 'Skip to sign in' },
};
const authenticationDocument = {
  body: { dataset: {} },
  querySelector: (selector) => authenticationElements[selector] ?? null,
};
assert.equal(app.renderAuthenticationView(authenticationDocument, true), 'signed-in');
assert.equal(authenticationElements['#login-shell'].hidden, true);
assert.equal(authenticationElements['#app-shell'].hidden, false);
assert.equal(authenticationElements['#skip-link'].href, '#main-content');
assert.equal(authenticationDocument.body.dataset.authState, 'signed-in');
assert.equal(app.renderAuthenticationView(authenticationDocument, false), 'signed-out');
assert.equal(authenticationElements['#login-shell'].hidden, false);
assert.equal(authenticationElements['#app-shell'].hidden, true);
assert.equal(authenticationElements['#skip-link'].href, '#login-form');

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

const loginCalls = [];
const csrfMeta = { content: '' };
const loginApi = app.createApiClient({
  fetchFn: async (url, options) => {
    loginCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      json: async () => ({ user: { email: 'alice@gulogulo.test' }, csrfToken }),
    };
  },
  documentRef: { querySelector: (selector) => selector === 'meta[name="csrf-token"]' ? csrfMeta : null },
  config: { apiBase: '/api' },
});
await loginApi.request('/session/login', {
  method: 'POST',
  body: { email: 'alice@gulogulo.test', password: 'synthetic-secret', rememberMe: false },
});
assert.equal(loginCalls[0].url, '/api/session/login');
assert.equal(loginCalls[0].options.credentials, 'include');
assert.equal(loginCalls[0].options.headers.has('x-csrf-token'), false);
assert.deepEqual(JSON.parse(loginCalls[0].options.body), {
  email: 'alice@gulogulo.test',
  password: 'synthetic-secret',
  rememberMe: false,
});
assert.equal(csrfMeta.content, csrfToken);

const rejectedToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
await assert.rejects(
  () => app.createApiClient({
    fetchFn: async () => ({
      ok: false,
      status: 401,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      json: async () => ({ message: 'Unauthorized', csrfToken: rejectedToken }),
    }),
    documentRef: { querySelector: () => csrfMeta },
    config: { apiBase: '/api' },
  }).request('/session/login', { method: 'POST', body: {} }),
  (error) => error.status === 401,
);
assert.equal(csrfMeta.content, csrfToken, 'failed responses must not replace the active CSRF token');

const config = app.buildWebConfig({
  body: {
    dataset: {
      apiBase: '/api',
      eventsPath: '/api/events',
      calendarPath: '/calendar/events',
      contactsPath: '/contacts',
      caldavDiscoveryPath: '/discovery/caldav',
      carddavDiscoveryPath: '/discovery/carddav',
    },
  },
});
assert.equal(config.calendarPath, '/calendar/events');
assert.equal(config.contactsPath, '/contacts');
assert.equal(config.caldavDiscoveryPath, '/discovery/caldav');
assert.equal(config.carddavDiscoveryPath, '/discovery/carddav');

class FakeEventSource {
  static instances = [];

  constructor(path, options) {
    this.path = path;
    this.options = options;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  close() {
    this.closed = true;
  }

  emit(name, data) {
    this.listeners.get(name)?.({ data });
  }
}

let calendarMetadata;
const eventStream = app.createEventStream({
  windowRef: { EventSource: FakeEventSource },
  path: '/api/events',
  onCalendar: (metadata) => { calendarMetadata = metadata; },
});
FakeEventSource.instances[0].emit('calendar.changed', '{"eventType":"calendar.changed","resourceId":"cal-1","html":"not allowed"}');
assert.deepEqual(calendarMetadata, { eventType: 'calendar.changed', resourceId: 'cal-1' });
eventStream.close();
assert.equal(FakeEventSource.instances[0].closed, true);

const html = await readFile(resolve(webDirectory, 'index.html'), 'utf8');
const css = await readFile(resolve(webDirectory, 'styles.css'), 'utf8');
assert.match(html, /Content-Security-Policy/);
assert.match(html, /id="login-form"/);
assert.match(html, /name="email"/);
assert.match(html, /name="password"/);
assert.match(html, /name="rememberMe"/);
assert.match(html, /src="\.\.\/assets\/gulo-gulo-calendar-mail\.png"/);
assert.match(html, /width="128"[\s\S]*height="128"/);
assert.ok(html.indexOf('id="login-form"') < html.indexOf('class="login-art"'), 'the login form must remain first in DOM order');
assert.match(html, /id="app-shell" hidden/);
assert.match(html, /aria-live="polite"/);
assert.match(html, /type="module"/);
assert.match(html, /data-view="calendar"/);
assert.match(html, /data-view="contacts"/);
assert.match(html, /data-calendar-path="\/calendar\/events"/);
assert.match(html, /data-contacts-path="\/contacts"/);
assert.match(html, /Automatic CalDAV discovery has not been checked/);
assert.match(html, /Automatic CardDAV discovery has not been checked/);
assert.match(html, /data-config-state="not-connected"/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /focus-visible/);
assert.match(css, /grid-template-areas: "art panel"/);
assert.match(css, /width: 128px/);
assert.match(css, /height: 128px/);
assert.match(css, /service-status-card/);
assert.match(css, /module-list-item/);

console.log('web-shell.test.mjs: all assertions passed');
