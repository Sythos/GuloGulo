// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WELL_KNOWN_PATHS,
  createDiscoveryContract,
  getWellKnownResource,
  resolveDiscoveryService,
} from './index.ts';

function createContract(overrides: any = {}) {
  return createDiscoveryContract({
    tenantId: 'acme',
    domain: 'example.test',
    services: {
      imap: { host: 'mail.example.test', port: 993, tls: true, username: '{email}' },
      smtp: { host: 'mail.example.test', port: 587, tls: 'starttls', username: '{email}' },
      pop3s: { enabled: false },
      caldav: { host: 'dav.example.test', port: 443, tls: true, path: '/dav/calendar/' },
      carddav: { host: 'dav.example.test', port: 443, tls: true, path: '/dav/contacts/' },
    },
    ...overrides,
  });
}

test('builds tenant-bound discovery with only enabled services and safe fields', () => {
  const contract = createContract();
  const response = getWellKnownResource(contract, WELL_KNOWN_PATHS.discovery, { tenantId: 'acme' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType, 'application/json; charset=utf-8');
  const document = JSON.parse(response.body);
  assert.deepEqual(Object.keys(document.services), ['imap', 'smtp', 'caldav', 'carddav']);
  assert.equal(document.services.imap.host, 'mail.example.test');
  assert.equal(document.services.imap.port, 993);
  assert.equal(document.services.imap.tls, true);
  assert.equal(document.services.smtp.tlsMode, 'starttls');
  assert.equal(document.services.imap.username, '{email}');
  assert.equal('tenantId' in document, false);
  assert.equal(response.body.includes('password'), false);
});

test('publishes standard DAV well-known redirects without cross-tenant data', () => {
  const contract = createContract();
  const caldav = getWellKnownResource(contract, '/.well-known/caldav', { tenantId: 'acme' });
  const carddav = getWellKnownResource(contract, '/.well-known/carddav', { tenantId: 'acme' });
  assert.equal(caldav.statusCode, 308);
  assert.equal(caldav.headers.location, 'https://dav.example.test/dav/calendar/');
  assert.equal(carddav.headers.location, 'https://dav.example.test/dav/contacts/');
  assert.equal(caldav.body, '');
});

test('renders deterministic mail autoconfig with TLS, ports, and username placeholders', () => {
  const contract = createContract();
  const response = getWellKnownResource(contract, WELL_KNOWN_PATHS.autoconfig, { tenantId: 'acme' });
  assert.equal(response.contentType, 'application/xml; charset=utf-8');
  assert.match(response.body, /<incomingServer type="imap">/u);
  assert.match(response.body, /<hostname>mail\.example\.test<\/hostname>/u);
  assert.match(response.body, /<port>993<\/port>/u);
  assert.match(response.body, /<socketType>SSL<\/socketType>/u);
  assert.match(response.body, /<socketType>STARTTLS<\/socketType>/u);
  assert.match(response.body, /<username>\{email\}<\/username>/u);
  assert.equal(response.body.includes('<password>'), false);
});

test('supports explicit safe manual overrides while preserving service fields', () => {
  const contract = createContract();
  const endpoint = resolveDiscoveryService(contract, 'imap', {
    manualOverride: { host: 'imap-alt.example.test', port: 1993, tls: 'implicit', username: 'alice@example.test' },
  });
  assert.equal(endpoint.source, 'manual');
  assert.equal(endpoint.host, 'imap-alt.example.test');
  assert.equal(endpoint.port, 1993);
  assert.equal(endpoint.tls, true);
  assert.equal(endpoint.tlsMode, 'implicit');
  assert.equal(endpoint.username, 'alice@example.test');
});

test('keeps POP3S absent unless explicitly enabled', () => {
  const disabled = createContract();
  assert.throws(() => resolveDiscoveryService(disabled, 'pop3s'), (error: any) => error.code === 'SERVICE_DISABLED');
  const enabled = createContract({ services: {
    pop3s: { enabled: true, host: 'mail.example.test', port: 995, tls: true },
  } });
  const response = getWellKnownResource(enabled, WELL_KNOWN_PATHS.discovery, { tenantId: 'acme' });
  assert.equal(JSON.parse(response.body).services.pop3s.port, 995);
});

test('defaults POP3S to disabled when the tenant does not opt in', () => {
  const contract = createDiscoveryContract({ tenantId: 'acme', domain: 'example.test' });
  assert.equal(contract.services.pop3s.enabled, false);
  const document = JSON.parse(getWellKnownResource(contract, WELL_KNOWN_PATHS.discovery, { tenantId: 'acme' }).body);
  assert.equal('pop3s' in document.services, false);
});

test('fails closed for cross-tenant and unsafe well-known requests', () => {
  const contract = createContract();
  assert.throws(() => getWellKnownResource(contract, WELL_KNOWN_PATHS.discovery, { tenantId: 'other' }), (error: any) => error.code === 'TENANT_MISMATCH');
  for (const path of ['/.well-known/../discovery.json', '/.well-known/gulogulo/discovery.json?tenant=other', '/.well-known\\gulogulo\\discovery.json', '/.well-known/gulogulo/%64iscovery.json', '/.well-known/unknown']) {
    assert.throws(() => getWellKnownResource(contract, path, { tenantId: 'acme' }), /Discovery error:/u);
  }
});

test('rejects malformed or unsafe discovery endpoints before publication', () => {
  const cases = [
    { services: { imap: { host: 'http://mail.example.test' } } },
    { services: { imap: { host: '127.0.0.1' } } },
    { services: { smtp: { host: 'mail.internal' } } },
    { services: { caldav: { host: 'dav.example.test', tls: false } } },
    { services: { imap: { host: 'mail.example.test', port: '993' } } },
    { services: { imap: { host: 'mail.example.test', username: 'alice\nsecret' } } },
    { services: { imap: { host: 'mail.example.test', tls: false, tlsMode: 'starttls' } } },
    { services: { caldav: { host: 'dav.example.test', path: '/../private' } } },
    { origin: 'http://example.test' },
    { origin: 'https://other.example.test' },
  ];
  for (const options of cases) {
    assert.throws(() => createContract(options), /Discovery error:/u);
  }
});

test('rejects attempts to re-enable a disabled service through a manual override', () => {
  assert.throws(() => createContract({ manualOverrides: { pop3s: { enabled: true, host: 'mail.example.test' } } }), (error: any) => error.code === 'SERVICE_DISABLED');
});
