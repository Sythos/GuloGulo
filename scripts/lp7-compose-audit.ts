// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

const root = resolve(process.cwd());
const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');
const manifest = JSON.parse(await readFile(resolve(root, 'release/lp7-local-upgrade.json'), 'utf8')) as JsonRecord;

function fail(message: string): never {
  throw new Error(`LP7 static audit failed: ${message}`);
}

function equal(actual: unknown, expected: unknown, description: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function requireText(haystack: string, marker: string, description = marker): void {
  if (!haystack.includes(marker)) fail(`missing ${description}: ${marker}`);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(`${field} must be an array of strings`);
  }
  return value as string[];
}

equal(manifest.milestone, 'LP7', 'manifest milestone');
equal(manifest.proofType, 'local_synthetic_docker_replacement_blue_green', 'manifest proof type');
equal(manifest.networkPolicy, 'offline_dependencies', 'manifest network policy');
equal(manifest.networkName, 'gulogulo-lp7-runtime', 'manifest network name');
equal(manifest.internalNetwork, true, 'manifest internal network');
equal(manifest.enableIpv6, true, 'manifest IPv6 flag');
equal(manifest.ipFamilies, ['ipv4', 'ipv6'], 'manifest IP families');
equal(manifest.syntheticDataOnly, true, 'manifest synthetic-data flag');
equal(manifest.publicDnsRequired, false, 'manifest public DNS flag');
equal(manifest.publicAcmeEnabled, false, 'manifest public ACME flag');
equal(manifest.externalDeliveryEnabled, false, 'manifest external-delivery flag');
equal(manifest.hostNetwork, false, 'manifest host-network flag');
equal(manifest.hostPortsPublished, false, 'manifest host-port flag');
equal(manifest.dockerSocketMounted, false, 'manifest Docker-socket flag');
equal(manifest.externalPersistentVolumes, true, 'manifest external-volume flag');
equal(manifest.targetPlatforms, ['linux/amd64', 'linux/arm64'], 'manifest target platforms');

const architecture = manifest.architectureValidation as JsonRecord;
equal(architecture.defaultWorkflowMode, 'amd64', 'default architecture workflow mode');
equal(architecture.composeProofPlatform, 'linux/amd64', 'Compose proof platform');
equal(architecture.functionalProofPlatform, 'linux/amd64', 'functional proof platform');
equal(architecture.finalWorkflowMode, 'multiarch', 'final architecture workflow mode');
equal(architecture.finalModePlatforms, ['linux/amd64', 'linux/arm64'], 'final architecture platforms');
equal(architecture.arm64RequiredBeforeMergeOrRelease, true, 'final ARM64 requirement');
equal(architecture.multiarchFunctionalProof, false, 'multiarch functional-proof policy');
equal(architecture.multiarchEvidence, 'artifact_and_provenance_only', 'multiarch evidence policy');

const upgrade = manifest.upgrade as JsonRecord;
equal(upgrade.strategy, 'docker_replacement_and_blue_green', 'upgrade strategy');
equal(upgrade.readinessGatedCutover, true, 'readiness-gated cutover');
equal(upgrade.connectionDrainRequired, true, 'connection drain requirement');
equal(upgrade.rollbackSupported, true, 'rollback support');
equal(upgrade.rollbackKeepsBlueServing, true, 'rollback blue-serving guarantee');
equal(upgrade.noDestructiveSchemaCleanup, true, 'non-destructive migration guard');
equal(upgrade.finalizeRequiresObservationAndRestoreCheck, true, 'finalization guard');
equal(upgrade.migrationPhases, ['expand', 'backfill', 'switch', 'contract'], 'migration phases');
equal(upgrade.imapIdleReconnectRequired, true, 'IMAP IDLE reconnect requirement');
equal(upgrade.smtpQueueHandoffRequired, true, 'SMTP queue handoff requirement');
equal(upgrade.externalStateReferences, [
  'external-postgresql',
  'external-ldap',
  'mail-data',
  'dav-data',
  'backup-data',
  'persistent-mail-queue',
], 'external state references');
const kubernetes = upgrade.kubernetes as JsonRecord;
equal(kubernetes.stableService, 'gulogulo-web', 'Kubernetes stable Service');
equal(kubernetes.readinessGated, true, 'Kubernetes readiness gate');
equal(kubernetes.maxUnavailable, 0, 'Kubernetes maxUnavailable');
equal(kubernetes.maxSurge, 1, 'Kubernetes maxSurge');
equal(kubernetes.podDisruptionBudgetMinAvailable, 1, 'Kubernetes PDB minimum');
equal(kubernetes.drainHooks, true, 'Kubernetes drain hooks');
equal(kubernetes.rollback, true, 'Kubernetes rollback policy');

const servicesStart = compose.indexOf('\nservices:');
const volumesStart = compose.indexOf('\nvolumes:', servicesStart);
if (servicesStart < 0 || volumesStart < 0) fail('Compose services or volumes section is missing');
const services = compose.slice(servicesStart, volumesStart);
const lp7Start = services.search(/^  gulogulo-lp7-blue:$/mu);
if (lp7Start < 0) fail('LP7 blue service section is missing');
const lp7 = services.slice(lp7Start);

for (const marker of [
  'gulogulo-lp7-blue:',
  'gulogulo-lp7-green:',
  'gulogulo-lp7-proof-check:',
  'profiles: ["lp7"]',
  'profiles: ["lp7-check"]',
  'platform: ${GULOGULO_LP7_COMPOSE_PLATFORM:-linux/amd64}',
  'com.sythos.gulogulo.milestone: LP7',
  'com.sythos.gulogulo.network-policy: offline_dependencies',
  'com.sythos.gulogulo.upgrade-track: blue',
  'com.sythos.gulogulo.upgrade-track: green',
  'com.sythos.gulogulo.upgrade-track: checker',
  'depends_on:',
  'condition: service_healthy',
  'lp7-runtime:',
  'lp7-runtime-state:/var/lib/gulogulo/runtime',
  'lp7-mail-data:/var/lib/gulogulo/mail',
  'lp7-dav-data:/var/lib/gulogulo/dav',
  'lp7-queue-data:/var/lib/gulogulo/queue',
  'lp7-backup-data:/var/lib/gulogulo/backups',
  'lp7-proof-state:/var/lib/gulogulo/lp7',
]) requireText(lp7, marker);

const blueStart = lp7.search(/^  gulogulo-lp7-blue:$/mu);
const greenStart = lp7.search(/^  gulogulo-lp7-green:$/mu);
const checkerStart = lp7.search(/^  gulogulo-lp7-proof-check:$/mu);
if (blueStart < 0 || greenStart < 0 || checkerStart < 0 || !(blueStart < greenStart && greenStart < checkerStart)) {
  fail('LP7 service ordering or boundaries are invalid');
}
const blue = lp7.slice(blueStart, greenStart);
const green = lp7.slice(greenStart, checkerStart);
const checker = lp7.slice(checkerStart);
for (const [name, section] of [['blue', blue], ['green', green], ['checker', checker]] as const) {
  if (/\n\s+ports:/mu.test(section)) fail(`LP7 ${name} service publishes a host port`);
  if (/docker\.sock|network_mode:\s*host|privileged:\s*true/mu.test(section)) {
    fail(`LP7 ${name} service contains a Docker socket, host network, or privileged execution`);
  }
}
for (const [name, section] of [['blue', blue], ['green', green]] as const) {
  for (const marker of [
    'expose:',
    '"8080"',
    'lp7-runtime-state:/var/lib/gulogulo/runtime',
    'lp7-mail-data:/var/lib/gulogulo/mail',
    'lp7-dav-data:/var/lib/gulogulo/dav',
    'lp7-queue-data:/var/lib/gulogulo/queue',
    'lp7-backup-data:/var/lib/gulogulo/backups',
    'networks:',
    'lp7-runtime:',
    'healthcheck:',
  ]) requireText(section, marker, `LP7 ${name} marker ${marker}`);
}
for (const marker of ['gulogulo-lp7-blue:', 'gulogulo-lp7-green:', 'LP7_BLUE_BASE_URL:', 'LP7_GREEN_BASE_URL:', 'LP7_BLUE_DIGEST:', 'LP7_GREEN_DIGEST:']) {
  requireText(checker, marker, `LP7 checker marker ${marker}`);
}
requireText(checker, 'user: "10001:10001"', 'LP7 checker unprivileged UID');
const checkerSource = await readFile(resolve(root, 'scripts/lp7-proof-check.ts'), 'utf8');
requireText(checkerSource, 'saved.signature === continuitySignature', 'LP7 continuity signature comparison');
if (checkerSource.includes('JSON.stringify(saved.signature)')) fail('LP7 checker double-serializes the saved continuity signature');
const webRuntimeSource = await readFile(resolve(root, 'scripts/lp4-web-runtime.ts'), 'utf8');
requireText(webRuntimeSource, 'randomUUID()', 'LP7 shared-volume continuity staging-file uniqueness');
for (const marker of ['gulogulo-lp7-blue:', 'gulogulo-lp7-green:']) {
  requireText(checker, marker, `LP7 checker dependency ${marker}`);
}

for (const marker of [
  'lp7-runtime:',
  'internal: true',
  'enable_ipv6: true',
  '172.29.7.0/24',
  'fd42:4755:756c:7037::/64',
]) requireText(compose, marker, `LP7 network marker ${marker}`);

for (const marker of [
  'lp7-runtime-state:',
  'lp7-mail-data:',
  'lp7-dav-data:',
  'lp7-queue-data:',
  'lp7-backup-data:',
  'lp7-proof-state:',
  'external: ${GULOGULO_LP7_VOLUMES_EXTERNAL:-false}',
]) requireText(compose, marker, `LP7 volume marker ${marker}`);

const scripts = stringArray(manifest.scripts, 'manifest.scripts');
for (const path of scripts) {
  const source = await readFile(resolve(root, path), 'utf8');
  requireText(source, 'SPDX-License-Identifier: MIT', `${path} SPDX marker`);
  requireText(source, 'Author: Sythos (https://www.sythos.net)', `${path} author marker`);
  if (/^\s*\/\/\s*@ts-nocheck/mu.test(source)) fail(`${path} disables TypeScript checking`);
}

const serviceEntries = manifest.services;
if (!Array.isArray(serviceEntries) || serviceEntries.some((entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
  fail('manifest.services must be an array of objects');
}
const serviceNames = (serviceEntries as JsonRecord[]).map((entry) => entry.name).filter((name): name is string => typeof name === 'string');
for (const name of ['gulogulo-lp7-blue', 'gulogulo-lp7-green', 'gulogulo-lp7-proof-check']) {
  if (!serviceNames.includes(name)) fail(`manifest service is missing: ${name}`);
}

console.log(JSON.stringify({
  milestone: manifest.milestone,
  proofType: manifest.proofType,
  services: serviceNames,
  volumes: stringArray(manifest.volumes, 'manifest.volumes'),
  upgrade,
  architectureValidation: architecture,
  status: manifest.status,
}, null, 2));
