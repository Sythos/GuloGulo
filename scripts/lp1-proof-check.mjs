// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile, rename, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { Resolver } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
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

// Docker service discovery can expose both address families when IPv6 is
// enabled. The disposable dnsmasq proof service deliberately binds IPv4 only,
// so select an IPv4 endpoint explicitly instead of relying on resolver order.
const dnsAddress = (await lookup(dnsService, { family: 4 })).address;
const resolver = new Resolver();
resolver.setServers([`${dnsAddress}:${dnsPort}`]);
let answers;
let lastDnsError;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    answers = await resolver.resolve4('gulogulo.test');
    break;
  } catch (error) {
    lastDnsError = error;
    if (attempt < 5) await delay(attempt * 250);
  }
}
if (!answers) {
  throw new Error(`LP1 local DNS query failed for gulogulo.test via ${dnsAddress}:${dnsPort}`, {
    cause: lastDnsError,
  });
}
requireCondition(answers.length > 0 && answers.every((address) => address === '127.0.0.1'), 'reserved DNS names escaped the loopback-only answer policy');

const response = await fetch(`http://${applicationService}:8080/health/ready`, {
  signal: AbortSignal.timeout(5000),
});
requireCondition(response.ok, `the application readiness endpoint returned HTTP ${response.status}`);
const readiness = await response.json();
requireCondition(readiness.status === 'ready', 'the application readiness payload is not ready');

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
  dnsAnswers: answers,
  readiness: readiness.status,
  networkPolicy: marker.networkPolicy,
  syntheticDataOnly: marker.syntheticDataOnly,
}, null, 2));
