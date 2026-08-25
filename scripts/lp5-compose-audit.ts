// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

const root = resolve(process.cwd());
const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');
const manifest = JSON.parse(await readFile(resolve(root, 'release/lp5-local-operations-capacity.json'), 'utf8')) as JsonRecord;

function fail(message: string): never {
  throw new Error(`LP5 static audit failed: ${message}`);
}

function equal(actual: unknown, expected: unknown, description: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function requireText(haystack: string, marker: string, description = marker): void {
  if (!haystack.includes(marker)) fail(`missing ${description}: ${marker}`);
}

equal(manifest.milestone, 'LP5', 'manifest milestone');
equal(manifest.proofType, 'local_synthetic_operations_capacity', 'manifest proof type');
equal(manifest.networkPolicy, 'offline_dependencies', 'manifest network policy');
equal(manifest.internalNetwork, true, 'manifest internal network');
equal(manifest.enableIpv6, true, 'manifest IPv6 flag');
equal(manifest.ipFamilies, ['ipv4', 'ipv6'], 'manifest IP families');
equal(manifest.syntheticDataOnly, true, 'manifest synthetic-data flag');
equal(manifest.hostNetwork, false, 'manifest host-network flag');
equal(manifest.hostPortsPublished, false, 'manifest host-port flag');
equal(manifest.dockerSocketMounted, false, 'manifest Docker-socket flag');
equal(manifest.targetPlatforms, ['linux/amd64', 'linux/arm64'], 'manifest platforms');

const capacity = manifest.capacity as JsonRecord;
if (capacity.claim !== 'bounded_local_proof_only') fail('manifest must not claim production capacity');
const budget = capacity.amd64Budget as JsonRecord;
for (const name of ['startupMs', 'readinessMs', 'webP95Ms', 'davP95Ms', 'queueP95Ms', 'idleNotifyP95Ms', 'httpErrorRate', 'activeIdleConnections', 'memoryMiB', 'cpuMillis', 'pids']) {
  if (typeof budget[name] !== 'number' || !Number.isFinite(budget[name]) || (budget[name] as number) < 0) fail(`invalid explicit amd64 budget ${name}`);
}
if (budget.activeIdleConnections !== 8) fail('LP5 amd64 IDLE connection budget must be explicit and stable');

const servicesStart = compose.indexOf('\nservices:');
const volumesStart = compose.indexOf('\nvolumes:', servicesStart);
if (servicesStart < 0 || volumesStart < 0) fail('Compose services or volumes section is missing');
const services = compose.slice(servicesStart, volumesStart);
const lp5Start = services.search(/^  gulogulo-lp5-web:$/mu);
if (lp5Start < 0) fail('LP5 web service section is missing');
const lp5 = services.slice(lp5Start);

for (const marker of [
  'gulogulo-lp5-web:',
  'gulogulo-lp5-proof-check:',
  'gulogulo-lp5-maintenance:',
  'profiles: ["lp5"]',
  'profiles: ["lp5-check"]',
  'com.sythos.gulogulo.milestone: LP5',
  'com.sythos.gulogulo.network-policy: offline_dependencies',
  'pids_limit:',
  'limits:',
  'cpus:',
  'memory:',
]) requireText(lp5, marker);

for (const marker of ['lp5-runtime:', 'internal: true', 'enable_ipv6: true', '172.29.5.0/24', 'fd42:4755:756c:7035::/64']) {
  requireText(compose, marker, `LP5 network marker ${marker}`);
}
if (/\n\s+ports:/mu.test(lp5)) fail('LP5 services must not publish host ports');
if (/docker\.sock|network_mode:\s*host|privileged:\s*true/mu.test(lp5)) fail('LP5 topology contains a Docker socket, host network, or privileged service');

for (const path of [...(manifest.typedModules as string[]), ...(manifest.typedTests as string[]), ...(manifest.scripts as string[])]) {
  const source = await readFile(resolve(root, path), 'utf8');
  requireText(source, 'SPDX-License-Identifier: MIT', `${path} SPDX marker`);
  if (/^\s*\/\/\s*@ts-nocheck/mu.test(source)) fail(`${path} disables TypeScript checking`);
}

console.log(JSON.stringify({
  milestone: manifest.milestone,
  proofType: manifest.proofType,
  targetPlatforms: manifest.targetPlatforms,
  amd64Budget: budget,
  architectureValidation: manifest.architectureValidation,
  status: manifest.status,
}, null, 2));
