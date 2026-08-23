// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalProofTopology } from './local-proof-topology.mjs';

const VALID_TOPOLOGY = {
  spdxLicenseIdentifier: 'MIT',
  spdxFileCopyrightText: '2026 Sythos (https://www.sythos.net)',
  author: 'Sythos (https://www.sythos.net)',
  schemaVersion: 1,
  milestone: 'LP1',
  proofType: 'local',
  networkPolicy: 'offline_runtime',
  networkName: 'gulogulo-local-proof',
  internalNetwork: true,
  syntheticDataOnly: true,
  publicDnsRequired: false,
  publicAcmeEnabled: false,
  hostNetwork: false,
  dockerSocketMounted: false,
  externalVolumesMode: 'named_external_capable',
  ipFamilies: ['ipv4', 'ipv6'],
  hostBindings: ['127.0.0.1:18080->8080/tcp', '[::1]:18080->8080/tcp'],
  localNames: ['gulogulo.test', 'webmail.localhost', 'calendar.localhost', 'contacts.localhost'],
  services: [
    { name: 'gulogulo-proof', role: 'application', health: 'GET /health/ready' },
    { name: 'local-ca', role: 'disposable certificate authority', health: 'ca.crt and gulogulo.test.crt exist' },
    { name: 'local-dns', role: 'reserved-name resolver', health: 'dnsmasq configuration check' },
  ],
  volumes: ['lp1-ca-data', 'lp1-runtime-state', 'lp1-mail-data', 'lp1-dav-data', 'lp1-backup-data', 'lp1-proof-state'],
  caArtifacts: ['ca.crt', 'gulogulo.test.crt', 'gulogulo.test.key'],
  requiredLabels: ['com.sythos.gulogulo.milestone', 'com.sythos.gulogulo.proof', 'com.sythos.gulogulo.network-policy'],
  status: 'frozen',
};

test('LP1 accepts the frozen internal dual-stack topology and loopback bindings', () => {
  const topology = createLocalProofTopology(VALID_TOPOLOGY);

  assert.equal(topology.networkPolicy, 'offline_runtime');
  assert.equal(topology.internalNetwork, true);
  assert.equal(topology.hostBindings[0], '127.0.0.1:18080->8080/tcp');
  assert.equal(topology.hostBindings[1], '[::1]:18080->8080/tcp');
  assert(Object.isFrozen(topology));
  assert(Object.isFrozen(topology.services[0]));
});

test('LP1 rejects public network, host network, and Docker socket claims', () => {
  assert.throws(
    () => createLocalProofTopology({ ...VALID_TOPOLOGY, internalNetwork: false }),
    (error) => error.code === 'LP1_NETWORK_INVALID',
  );
  assert.throws(
    () => createLocalProofTopology({ ...VALID_TOPOLOGY, hostNetwork: true }),
    (error) => error.code === 'LP1_HOST_NETWORK_INVALID',
  );
  assert.throws(
    () => createLocalProofTopology({ ...VALID_TOPOLOGY, dockerSocketMounted: true }),
    (error) => error.code === 'LP1_SOCKET_INVALID',
  );
});

test('LP1 rejects public host bindings and incomplete volumes', () => {
  assert.throws(
    () => createLocalProofTopology({ ...VALID_TOPOLOGY, hostBindings: ['0.0.0.0:18080->8080/tcp', '[::1]:18080->8080/tcp'] }),
    (error) => error.code === 'LP1_HOST_BINDING_INVALID',
  );
  assert.throws(
    () => createLocalProofTopology({ ...VALID_TOPOLOGY, volumes: VALID_TOPOLOGY.volumes.slice(1) }),
    (error) => error.code === 'LP1_VOLUMES_INVALID',
  );
});
