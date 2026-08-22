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
assert.deepEqual(
  app.parseRealtimeMetadata('{"eventType":"calendar.changed","resourceId":"event-1","body":"must-not-reach-browser"}'),
  { eventType: 'calendar.changed', resourceId: 'event-1' },
);
assert.equal(app.parseRealtimeMetadata('{"body":"not metadata"}'), undefined);

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
assert.match(css, /service-status-card/);
assert.match(css, /module-list-item/);

console.log('web-shell.test.mjs: all assertions passed');
