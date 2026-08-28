// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createLocalProofTopology } from '../src/release/local-proof-topology.ts';

const composePath = resolve(process.cwd(), 'compose.yaml');
const dnsEntrypointPath = resolve(process.cwd(), 'docker/lp1-network/entrypoint-dns.sh');
const manifestPath = resolve(process.cwd(), 'release/local-proof-topology.json');
const compose = await readFile(composePath, 'utf8');
const dnsEntrypoint = await readFile(dnsEntrypointPath, 'utf8');
const topologySource = `${compose}\n${dnsEntrypoint}`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const topology = createLocalProofTopology(manifest);

const checkerStart = compose.indexOf('\n  gulogulo-proof-check:');
const checkerEnd = compose.indexOf('\n  # LP2 is', checkerStart);
if (checkerStart < 0 || checkerEnd < 0) {
  throw new Error('LP1 proof-check service boundary is missing.');
}
const checkerService = compose.slice(checkerStart, checkerEnd);

const requiredMarkers = [
  'gulogulo-proof:',
  'local-ca:',
  'local-dns:',
  'gulogulo-proof-check:',
  'profiles: ["proof"]',
  'internal: true',
  '127.0.0.1:${GULOGULO_PROOF_HTTP_PORT:-18080}:8080',
  '[::1]:${GULOGULO_PROOF_HTTP_PORT:-18080}:8080',
  'enable_ipv6: true',
  '--listen-address=::',
  '--address=/gulogulo.test/::1',
  'lp1-ca-data:',
  'lp1-runtime-state:',
  'lp1-mail-data:',
  'lp1-dav-data:',
  'lp1-backup-data:',
  'lp1-proof-state:',
  'com.sythos.gulogulo.milestone',
  'com.sythos.gulogulo.network-policy',
];

for (const marker of requiredMarkers) {
  if (!topologySource.includes(marker)) {
    throw new Error(`LP1 Compose marker is missing: ${marker}`);
  }
}

if (/docker\.sock|network_mode:\s*host|privileged:\s*true/.test(compose)) {
  throw new Error('LP1 Compose topology contains a forbidden Docker socket, host network, or privileged marker.');
}

if (!checkerService.includes('./scripts:/app/scripts:ro')) {
  throw new Error('LP1 proof-check must mount checkout-owned helpers read-only; production image contents remain runtime-only.');
}

console.log(JSON.stringify({
  milestone: topology.milestone,
  proofType: topology.proofType,
  networkPolicy: topology.networkPolicy,
  networkName: topology.networkName,
  internalNetwork: topology.internalNetwork,
  ipFamilies: topology.ipFamilies,
  localNames: topology.localNames,
  services: topology.services.map(({ name, role }) => ({ name, role })),
  hostBindings: topology.hostBindings,
  volumes: topology.volumes,
  publicDnsRequired: topology.publicDnsRequired,
  publicAcmeEnabled: topology.publicAcmeEnabled,
  dockerSocketMounted: topology.dockerSocketMounted,
  status: topology.status,
}, null, 2));
