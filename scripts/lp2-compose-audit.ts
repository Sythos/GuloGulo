// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const composePath = resolve(process.cwd(), 'compose.yaml');
const manifestPath = resolve(process.cwd(), 'release/lp2-local-services.json');
const compose = await readFile(composePath, 'utf8');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const lp2Start = compose.indexOf('  lp2-ca:');
const volumesStart = compose.indexOf('\nvolumes:', lp2Start);
if (lp2Start < 0 || volumesStart < 0) {
  throw new Error('LP2 Compose service section is missing.');
}
const lp2Section = compose.slice(lp2Start, volumesStart);

const requiredMarkers = [
  'lp2-ca:',
  'lp2-ldap:',
  'lp2-postgres:',
  'gulogulo-lp2-proof-check:',
  'profiles: ["lp2"]',
  'profiles: ["lp2-check"]',
  'ldaps://lp2-ldap:636',
  'lp2-tls-data:/run/gulogulo-lp2-tls:ro',
  'lp2-ldap-data:/var/lib/ldap',
  'lp2-postgres-data:/var/lib/postgresql/lp2-data',
  'lp2-runtime:',
  'internal: true',
  'enable_ipv6: true',
  'fd42:4755:756c:7032::/64',
  'condition: service_healthy',
  'com.sythos.gulogulo.milestone: LP2',
  'com.sythos.gulogulo.proof: local_synthetic',
  'com.sythos.gulogulo.network-policy: offline_dependencies',
  'com.sythos.gulogulo.tls: ldaps',
  'com.sythos.gulogulo.tls: postgres-verify-full',
];

for (const marker of requiredMarkers) {
  if (!lp2Section.includes(marker) && !compose.includes(marker)) {
    throw new Error(`LP2 Compose marker is missing: ${marker}`);
  }
}

if (/\n\s+ports:/m.test(lp2Section)) {
  throw new Error('LP2 synthetic dependency services must not publish host ports.');
}
if (/docker\.sock|network_mode:\s*host|privileged:\s*true/.test(lp2Section)) {
  throw new Error('LP2 Compose topology contains a forbidden Docker socket, host network, or privileged marker.');
}

const expectedManifest = {
  milestone: 'LP2',
  proofType: 'local_synthetic',
  networkPolicy: 'offline_dependencies',
  internalNetwork: true,
  enableIpv6: true,
  ipFamilies: ['ipv4', 'ipv6'],
  syntheticDataOnly: true,
  publicDnsRequired: false,
  publicAcmeEnabled: false,
  hostNetwork: false,
  dockerSocketMounted: false,
  hostPortsPublished: false,
};
for (const [key, expected] of Object.entries(expectedManifest)) {
  const actual = manifest[key];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`LP2 manifest mismatch for ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

for (const service of ['lp2-ca', 'lp2-ldap', 'lp2-postgres', 'gulogulo-lp2-proof-check']) {
  if (!manifest.services.some((entry) => entry.name === service)) {
    throw new Error(`LP2 manifest service is missing: ${service}`);
  }
}

console.log(JSON.stringify({
  milestone: manifest.milestone,
  proofType: manifest.proofType,
  networkPolicy: manifest.networkPolicy,
  networkName: manifest.networkName,
  internalNetwork: manifest.internalNetwork,
  enableIpv6: manifest.enableIpv6,
  ipFamilies: manifest.ipFamilies,
  tlsMode: manifest.tls.mode,
  services: manifest.services.map(({ name, role }) => ({ name, role })),
  hostPortsPublished: manifest.hostPortsPublished,
  syntheticDataOnly: manifest.syntheticDataOnly,
  publicDnsRequired: manifest.publicDnsRequired,
  publicAcmeEnabled: manifest.publicAcmeEnabled,
  status: manifest.status,
}, null, 2));
