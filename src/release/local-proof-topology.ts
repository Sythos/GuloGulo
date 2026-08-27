// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

/**
 * LP1 Compose topology contract.
 *
 * This validates the topology metadata without contacting Docker. The runtime
 * smoke script performs the second, live check against a disposable project.
 */

const LOCAL_NAMES = Object.freeze([
  'gulogulo.test',
  'webmail.localhost',
  'calendar.localhost',
  'contacts.localhost',
]);

const REQUIRED_SERVICES = Object.freeze([
  'gulogulo-proof',
  'local-ca',
  'local-dns',
]);

const REQUIRED_VOLUMES = Object.freeze([
  'lp1-ca-data',
  'lp1-runtime-state',
  'lp1-mail-data',
  'lp1-dav-data',
  'lp1-backup-data',
  'lp1-proof-state',
]);

function topologyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw topologyError('LP1_TOPOLOGY_INVALID', `${label} must be a plain object.`);
  }
}

function assertExact(value, expected, code, label) {
  if (value !== expected) {
    throw topologyError(code, `${label} must be ${expected}.`);
  }
}

function assertExactList(value, expected, code, label) {
  if (!Array.isArray(value) || value.length !== expected.length ||
      value.some((entry, index) => entry !== expected[index])) {
    throw topologyError(code, `${label} does not match the frozen LP1 inventory.`);
  }
}

function assertSafeName(value, code, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(value) || /\.\.|[\\/]/.test(value)) {
    throw topologyError(code, `${label} contains an unsafe name.`);
  }
}

/**
 * Validate and freeze the LP1 topology manifest.
 */
export function createLocalProofTopology(input) {
  assertPlainObject(input, 'topology');
  assertExact(input.schemaVersion, 1, 'LP1_SCHEMA_INVALID', 'schemaVersion');
  assertExact(input.milestone, 'LP1', 'LP1_MILESTONE_INVALID', 'milestone');
  assertExact(input.proofType, 'local', 'LP1_PROOF_TYPE_INVALID', 'proofType');
  assertExact(input.networkPolicy, 'offline_runtime', 'LP1_NETWORK_POLICY_INVALID', 'networkPolicy');
  assertExact(input.internalNetwork, true, 'LP1_NETWORK_INVALID', 'internalNetwork');
  assertExact(input.syntheticDataOnly, true, 'LP1_DATA_POLICY_INVALID', 'syntheticDataOnly');
  assertExact(input.publicDnsRequired, false, 'LP1_EXTERNAL_BOUNDARY_INVALID', 'publicDnsRequired');
  assertExact(input.publicAcmeEnabled, false, 'LP1_EXTERNAL_BOUNDARY_INVALID', 'publicAcmeEnabled');
  assertExact(input.hostNetwork, false, 'LP1_HOST_NETWORK_INVALID', 'hostNetwork');
  assertExact(input.dockerSocketMounted, false, 'LP1_SOCKET_INVALID', 'dockerSocketMounted');
  assertExact(input.externalVolumesMode, 'named_external_capable', 'LP1_VOLUME_POLICY_INVALID', 'externalVolumesMode');
  assertExactList(input.ipFamilies, ['ipv4', 'ipv6'], 'LP1_IP_FAMILIES_INVALID', 'ipFamilies');
  assertExact(input.status, 'frozen', 'LP1_STATUS_INVALID', 'status');

  assertSafeName(input.networkName, 'LP1_NETWORK_NAME_INVALID', 'networkName');
  assertExactList(input.localNames, LOCAL_NAMES, 'LP1_LOCAL_NAMES_INVALID', 'localNames');
  assertExactList(input.volumes, REQUIRED_VOLUMES, 'LP1_VOLUMES_INVALID', 'volumes');
  assertExactList(input.caArtifacts, ['ca.crt', 'gulogulo.test.crt', 'gulogulo.test.key'], 'LP1_CA_ARTIFACTS_INVALID', 'caArtifacts');
  assertExactList(input.requiredLabels, [
    'com.sythos.gulogulo.milestone',
    'com.sythos.gulogulo.proof',
    'com.sythos.gulogulo.network-policy',
  ], 'LP1_LABELS_INVALID', 'requiredLabels');

  if (!Array.isArray(input.hostBindings) || input.hostBindings.length !== 2 ||
      !/^127\.0\.0\.1:[0-9]+->8080\/tcp$/.test(input.hostBindings[0]) ||
      !/^\[::1\]:[0-9]+->8080\/tcp$/.test(input.hostBindings[1])) {
    throw topologyError('LP1_HOST_BINDING_INVALID', 'LP1 must publish the application on IPv4 and IPv6 loopback only.');
  }

  if (!Array.isArray(input.services) || input.services.length !== REQUIRED_SERVICES.length ||
      input.services.some((service, index) => service?.name !== REQUIRED_SERVICES[index])) {
    throw topologyError('LP1_SERVICES_INVALID', 'LP1 services do not match the frozen topology inventory.');
  }
  for (const service of input.services) {
    assertPlainObject(service, 'service');
    assertSafeName(service.name, 'LP1_SERVICE_NAME_INVALID', 'service.name');
    if (typeof service.role !== 'string' || service.role.length === 0 || typeof service.health !== 'string' || service.health.length === 0) {
      throw topologyError('LP1_SERVICE_METADATA_INVALID', 'Every LP1 service requires a role and health description.');
    }
  }

  assertExact(input.spdxLicenseIdentifier, 'MIT', 'LP1_LICENSE_INVALID', 'spdxLicenseIdentifier');
  assertExact(input.spdxFileCopyrightText, '2026 Sythos (https://www.sythos.net)', 'LP1_METADATA_INVALID', 'spdxFileCopyrightText');
  assertExact(input.author, 'Sythos (https://www.sythos.net)', 'LP1_METADATA_INVALID', 'author');

  return Object.freeze({
    ...input,
    hostBindings: Object.freeze([...input.hostBindings]),
    localNames: Object.freeze([...input.localNames]),
    services: Object.freeze(input.services.map((service) => Object.freeze({ ...service }))),
    volumes: Object.freeze([...input.volumes]),
    caArtifacts: Object.freeze([...input.caArtifacts]),
    requiredLabels: Object.freeze([...input.requiredLabels]),
  });
}

export { LOCAL_NAMES, REQUIRED_SERVICES, REQUIRED_VOLUMES };
