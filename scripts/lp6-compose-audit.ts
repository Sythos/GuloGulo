// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

const root = resolve(process.cwd());
const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');
const manifest = JSON.parse(await readFile(resolve(root, 'release/lp6-local-backup-dr.json'), 'utf8')) as JsonRecord;

function fail(message: string): never {
  throw new Error(`LP6 static audit failed: ${message}`);
}

function equal(actual: unknown, expected: unknown, description: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function requireText(haystack: string, marker: string, description = marker): void {
  if (!haystack.includes(marker)) fail(`missing ${description}: ${marker}`);
}

equal(manifest.milestone, 'LP6', 'manifest milestone');
equal(manifest.proofType, 'local_synthetic_backup_restore_retention_dr', 'manifest proof type');
equal(manifest.networkPolicy, 'offline_dependencies', 'manifest network policy');
equal(manifest.internalNetwork, true, 'manifest internal network');
equal(manifest.enableIpv6, true, 'manifest IPv6 flag');
equal(manifest.ipFamilies, ['ipv4', 'ipv6'], 'manifest IP families');
equal(manifest.syntheticDataOnly, true, 'manifest synthetic-data flag');
equal(manifest.hostNetwork, false, 'manifest host-network flag');
equal(manifest.hostPortsPublished, false, 'manifest host-port flag');
equal(manifest.dockerSocketMounted, false, 'manifest Docker-socket flag');
equal(manifest.targetPlatforms, ['linux/amd64', 'linux/arm64'], 'manifest target platforms');

const recovery = manifest.recovery as JsonRecord;
equal(recovery.retentionDays, 28, 'retention period');
equal(recovery.rpoMinutes, 15, 'RPO');
equal(recovery.rtoMinutes, 60, 'RTO');
equal(recovery.failedRestorePreservesSource, true, 'failed restore preservation');
equal(recovery.holdsPreventPurge, true, 'hold policy');
equal(recovery.idempotentPurge, true, 'purge idempotency');
const architecture = manifest.architectureValidation as JsonRecord;
equal(architecture.defaultWorkflowMode, 'amd64', 'default architecture mode');
equal(architecture.composeProofPlatform, 'linux/amd64', 'Compose proof platform');
equal(architecture.finalWorkflowMode, 'multiarch', 'final architecture mode');
equal(architecture.finalModePlatforms, ['linux/arm64'], 'final architecture platforms');
equal(architecture.arm64RequiredBeforeMergeOrRelease, true, 'final arm64 gate');

const servicesStart = compose.indexOf('\nservices:');
const volumesStart = compose.indexOf('\nvolumes:', servicesStart);
if (servicesStart < 0 || volumesStart < 0) fail('Compose services or volumes section is missing');
const services = compose.slice(servicesStart, volumesStart);
const lp6Start = services.search(/^  gulogulo-lp6-source-fixture:$/mu);
if (lp6Start < 0) fail('LP6 service section is missing');
const lp6 = services.slice(lp6Start);
const sourceFixtureEnd = lp6.indexOf('\n  gulogulo-lp6-backup:');
if (sourceFixtureEnd < 0) fail('LP6 source fixture service boundary is missing');
const sourceFixture = lp6.slice(0, sourceFixtureEnd);
for (const marker of [
  'gulogulo-lp6-source-fixture:', 'gulogulo-lp6-backup:', 'gulogulo-lp6-restore:',
  'profiles: ["lp6"]', 'profiles: ["lp6-check"]',
  'platform: ${GULOGULO_LP6_COMPOSE_PLATFORM:-linux/amd64}',
  'lp6-source-data:/var/lib/gulogulo/lp6-source:ro',
  'lp6-backup-data:/var/lib/gulogulo/lp6-backup:ro',
  'lp6-restore-data:/var/lib/gulogulo/lp6-restore',
  'com.sythos.gulogulo.milestone: LP6',
  'com.sythos.gulogulo.network-policy: offline_dependencies',
]) requireText(lp6, marker);
requireText(sourceFixture, 'LP6_SOURCE_DIR: /var/lib/gulogulo/lp6-source', 'LP6 source fixture source directory');
if (/\n\s+ports:/mu.test(lp6)) fail('LP6 services must not publish host ports');
if (/docker\.sock|network_mode:\s*host|privileged:\s*true/mu.test(lp6)) fail('LP6 topology contains a Docker socket, host network, or privileged service');

for (const marker of ['lp6-source-data:', 'lp6-backup-data:', 'lp6-restore-data:', 'external: ${GULOGULO_LP6_VOLUMES_EXTERNAL:-false}', 'lp6-runtime:', '172.29.6.0/24', 'fd42:4755:756c:7036::/64']) {
  requireText(compose, marker, `LP6 Compose marker ${marker}`);
}
for (const path of [
  ...(manifest.canonicalTypedModules as string[]),
  ...(manifest.scripts as string[]),
]) {
  const source = await readFile(resolve(root, path), 'utf8');
  requireText(source, 'SPDX-License-Identifier: MIT', `${path} SPDX marker`);
  if (/^\s*\/\/\s*@ts-nocheck/mu.test(source)) fail(`${path} disables TypeScript checking`);
}

console.log(JSON.stringify({
  milestone: manifest.milestone,
  proofType: manifest.proofType,
  volumes: manifest.volumes,
  recovery,
  architectureValidation: architecture,
  status: manifest.status,
}, null, 2));
