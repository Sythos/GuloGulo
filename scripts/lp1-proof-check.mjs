// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile, rename, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { Resolver } from 'node:dns/promises';
import { join, resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';

const caDir = resolve(process.env.LP1_CA_DIR || '/run/gulogulo-ca');
const stateDir = resolve(process.env.LP1_PROOF_STATE_DIR || '/var/lib/gulogulo/lp1');
const dnsService = process.env.LP1_DNS_SERVER || 'local-dns';
const dnsPort = Number(process.env.LP1_DNS_PORT || 5353);
const applicationService = process.env.LP1_APPLICATION_SERVER || 'gulogulo-proof';
const markerPath = join(stateDir, 'restart-marker.json');

function fail(message) {
  const error = new Error(message);
  error.code = 'LP1_PROOF_CHECK_FAILED';
  throw error;
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

async function readRequired(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    throw new Error(`LP1 ${label} is unavailable: ${error.message}`, { cause: error });
  }
}

const caBytes = await readRequired(join(caDir, 'ca.crt'), 'CA certificate');
const leafBytes = await readRequired(join(caDir, 'gulogulo.test.crt'), 'leaf certificate');
const leafKeyBytes = await readRequired(join(caDir, 'gulogulo.test.key'), 'leaf key');
const caCertificate = new X509Certificate(caBytes);
const leafCertificate = new X509Certificate(leafBytes);

requireCondition(caCertificate.ca === true, 'the local CA certificate is not marked as a CA');
requireCondition(leafCertificate.ca === false, 'the application certificate must not be a CA');
requireCondition(leafCertificate.checkHost('gulogulo.test') === 'gulogulo.test', 'the leaf certificate lacks the gulogulo.test SAN');
requireCondition(leafCertificate.verify(caCertificate.publicKey), 'the leaf certificate is not signed by the local CA');
requireCondition(leafKeyBytes.length > 0, 'the leaf private key is empty');
requireCondition(process.env.NODE_EXTRA_CA_CERTS === join(caDir, 'ca.crt'), 'the test client did not install the local CA trust path');
createSecureContext({ ca: caBytes });

// Docker service discovery exposes both address families when the proof
// network has IPv6 enabled. Query the disposable dnsmasq service over every
// advertised endpoint and keep the loopback answer policy explicit.
const dnsAddresses = (await lookup(dnsService, { all: true })).map(({ address }) => address);
requireCondition(dnsAddresses.some((address) => !address.includes(':')), 'the local DNS service has no IPv4 endpoint');
requireCondition(dnsAddresses.some((address) => address.includes(':')), 'the local DNS service has no IPv6 endpoint');

const dnsAnswers = { ipv4: new Set(), ipv6: new Set() };
const dnsErrors = [];
for (const dnsAddress of dnsAddresses) {
  const dnsServer = dnsAddress.includes(':') ? `[${dnsAddress}]:${dnsPort}` : `${dnsAddress}:${dnsPort}`;
  const resolver = new Resolver();
  resolver.setServers([dnsServer]);
  try {
    for (const address of await resolver.resolve4('gulogulo.test')) dnsAnswers.ipv4.add(address);
  } catch (error) {
    dnsErrors.push(`${dnsServer}/A: ${error.message}`);
  }
  try {
    for (const address of await resolver.resolve6('gulogulo.test')) dnsAnswers.ipv6.add(address);
  } catch (error) {
    dnsErrors.push(`${dnsServer}/AAAA: ${error.message}`);
  }
}

const ipv4Answers = [...dnsAnswers.ipv4];
const ipv6Answers = [...dnsAnswers.ipv6];
if (ipv4Answers.length === 0 || ipv6Answers.length === 0) {
  throw new Error(`LP1 local DNS dual-stack query failed: ${dnsErrors.join('; ')}`);
}
requireCondition(ipv4Answers.every((address) => address === '127.0.0.1'), 'reserved IPv4 DNS names escaped the loopback-only answer policy');
requireCondition(ipv6Answers.every((address) => address === '::1'), 'reserved IPv6 DNS names escaped the loopback-only answer policy');

const applicationAddresses = (await lookup(applicationService, { all: true })).map(({ address, family }) => ({ address, family }));
requireCondition(applicationAddresses.some(({ family }) => family === 4), 'the application service has no IPv4 endpoint');
requireCondition(applicationAddresses.some(({ family }) => family === 6), 'the application service has no IPv6 endpoint');

let readiness;
for (const { address, family } of applicationAddresses) {
  const host = family === 6 ? `[${address}]` : address;
  const response = await fetch(`http://${host}:8080/health/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  requireCondition(response.ok, `the application readiness endpoint returned HTTP ${response.status}`);
  const currentReadiness = await response.json();
  requireCondition(currentReadiness.status === 'ready', 'the application readiness payload is not ready');
  readiness = currentReadiness;
}

let previous = null;
try {
  previous = JSON.parse(await readFile(markerPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (previous) {
  requireCondition(previous.milestone === 'LP1', 'the persisted restart marker belongs to another milestone');
  requireCondition(previous.checkCount >= 1, 'the persisted restart marker is malformed');
}

const marker = {
  schemaVersion: 1,
  milestone: 'LP1',
  checkCount: (previous?.checkCount || 0) + 1,
  restartObserved: Boolean(previous),
  networkPolicy: 'offline_runtime',
  syntheticDataOnly: true,
  localNames: ['gulogulo.test', 'webmail.localhost', 'calendar.localhost', 'contacts.localhost'],
};
const temporaryMarker = `${markerPath}.tmp`;
await writeFile(temporaryMarker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryMarker, markerPath);

console.log(JSON.stringify({
  milestone: marker.milestone,
  checkCount: marker.checkCount,
  restartObserved: marker.restartObserved,
  caSubject: caCertificate.subject,
  leafSubject: leafCertificate.subject,
  ipFamilies: ['ipv4', 'ipv6'],
  dnsAnswers: { ipv4: ipv4Answers, ipv6: ipv6Answers },
  applicationAddresses,
  readiness: readiness.status,
  networkPolicy: marker.networkPolicy,
  syntheticDataOnly: marker.syntheticDataOnly,
}, null, 2));
