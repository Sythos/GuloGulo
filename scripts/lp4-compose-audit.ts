// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type JsonRecord = Record<string, any>;

const root = resolve(process.cwd());
const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');
const manifest = JSON.parse(await readFile(resolve(root, 'release/lp4-local-web.json'), 'utf8')) as JsonRecord;

function fail(message: string): never {
  throw new Error(`LP4 static audit failed: ${message}`);
}

function requireText(haystack: string, marker: string, description = marker): void {
  if (!haystack.includes(marker)) fail(`missing ${description}: ${marker}`);
}

function equal(actual: unknown, expected: unknown, description: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const servicesStart = compose.indexOf('\nservices:');
const volumesStart = compose.indexOf('\nvolumes:', servicesStart);
if (servicesStart < 0 || volumesStart < 0) fail('Compose services or volumes section is missing');
const servicesSection = compose.slice(servicesStart, volumesStart);
const lp4Start = servicesSection.search(/^  gulogulo-lp4-web:$/mu);
if (lp4Start < 0) fail('LP4 service section is missing');
const lp4Section = servicesSection.slice(lp4Start);

for (const marker of [
  'gulogulo-lp4-web:',
  'gulogulo-lp4-proof-check:',
  'profiles: ["lp4"]',
  'profiles: ["lp4-check"]',
  'lp4-runtime:',
  'lp4-runtime-state:/var/lib/gulogulo/runtime',
  'lp4-dav-data:/var/lib/gulogulo/dav',
  'LP4_LOGIN_EMAIL: ${LP4_LOGIN_EMAIL}',
  'LP4_LOGIN_PASSWORD: ${LP4_LOGIN_PASSWORD}',
  'com.sythos.gulogulo.milestone: LP4',
  'com.sythos.gulogulo.network-policy: offline_dependencies',
]) requireText(lp4Section, marker);

for (const marker of ['internal: true', 'enable_ipv6: true', '172.29.4.0/24', 'fd42:4755:756c:7034::/64']) requireText(compose, marker, `LP4 network marker ${marker}`);
for (const marker of ['lp4-runtime-state:', 'lp4-dav-data:', 'external: ${GULOGULO_LP4_VOLUMES_EXTERNAL:-false}']) requireText(compose, marker, `LP4 volume marker ${marker}`);
if (/\n\s+ports:/mu.test(lp4Section)) fail('LP4 services must not publish host ports');
if (/docker\.sock|network_mode:\s*host|privileged:\s*true/mu.test(lp4Section)) fail('LP4 topology contains a Docker socket, host network, or privileged service');
if (/LP4_LOGIN_(?:EMAIL|PASSWORD):\s*\$\{[^}]+:-/mu.test(lp4Section)) fail('LP4 Compose contains a default login credential');

equal(manifest.milestone, 'LP4', 'manifest milestone');
equal(manifest.proofType, 'local_synthetic_web_dav', 'manifest proof type');
equal(manifest.networkPolicy, 'offline_dependencies', 'manifest network policy');
equal(manifest.internalNetwork, true, 'manifest internal network');
equal(manifest.enableIpv6, true, 'manifest IPv6 flag');
equal(manifest.ipFamilies, ['ipv4', 'ipv6'], 'manifest IP families');
equal(manifest.syntheticDataOnly, true, 'manifest synthetic data flag');
equal(manifest.hostPortsPublished, false, 'manifest host port flag');
equal(manifest.dockerSocketMounted, false, 'manifest Docker socket flag');
equal(manifest.credentialsCommitted, false, 'manifest committed credential flag');
equal(manifest.credentialsGeneratedAtRuntime, true, 'manifest runtime credential flag');
equal(manifest.dav.tenantBoundEtags, true, 'manifest ETag scope');
equal(manifest.dav.tenantBoundSyncTokens, true, 'manifest sync-token scope');
equal(manifest.dav.masterContentAccess, false, 'manifest master content boundary');
equal(manifest.discovery.tenantBound, true, 'manifest discovery scope');
equal(manifest.discovery.httpsDestinationsOnly, true, 'manifest HTTPS discovery boundary');
equal(manifest.targetPlatforms, ['linux/amd64', 'linux/arm64'], 'manifest target platforms');

for (const path of [...manifest.typedModules, ...manifest.typedTests]) {
  const source = await readFile(resolve(root, path), 'utf8');
  requireText(source, 'SPDX-License-Identifier: MIT', `${path} SPDX marker`);
  if (/^\s*\/\/\s*@ts-nocheck/mu.test(source)) fail(`${path} disables TypeScript checking`);
}

for (const folder of ['src/dav/caldav', 'src/dav/carddav', 'src/dav/discovery']) {
  for (const file of await readdir(resolve(root, folder))) {
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(resolve(root, folder, file), 'utf8');
    if (!/compatibility bridge/iu.test(source)) fail(`${folder}/${file} is not a compatibility bridge`);
    const bridgeLines = source.split(/\r?\n/u).map((line) => line.trim());
    const bridgeOnly = bridgeLines.every((line) => (
      line === ''
      || line.startsWith('//')
      || /^import[^\S\r\n]+['"][^'"]+['"];?$/u.test(line)
      || /^export[^\S\r\n]+\*[^\S\r\n]+from[^\S\r\n]+['"][^'"]+['"];?$/u.test(line)
    ));
    if (!bridgeOnly) {
      fail(`${folder}/${file} contains behavior beyond import/export bridge code`);
    }
  }
}

for (const path of ['scripts/lp4-web-runtime.ts', 'scripts/lp4-proof-check.ts', 'scripts/lp4-compose-smoke.ts']) {
  const source = await readFile(resolve(root, path), 'utf8');
  if (/LP4_LOGIN_(?:EMAIL|PASSWORD)\s*\|\|\s*['"][^'"]+/u.test(source)) fail(`${path} contains a default credential`);
  if (source.includes('docker.sock')) fail(`${path} references the Docker socket`);
}
const webRuntime = await readFile(resolve(root, 'scripts/lp4-web-runtime.ts'), 'utf8');
requireText(webRuntime, 'randomUUID()', 'LP4 continuity staging-file uniqueness');

const webHtml = await readFile(resolve(root, 'web/index.html'), 'utf8');
for (const marker of ['id="login-shell"', 'gulo-gulo-calendar-mail.png', 'data-view="mail"', 'data-view="calendar"', 'data-view="contacts"']) requireText(webHtml, marker, `web shell marker ${marker}`);
const server = await readFile(resolve(root, 'src/runtime/server.ts'), 'utf8');
for (const marker of ['/api/session/login', '/api/calendar/events', '/api/contacts', '/api/discovery', '/assets/gulo-gulo-calendar-mail.png']) requireText(server, marker, `API/static route ${marker}`);

console.log(JSON.stringify({
  milestone: manifest.milestone,
  proofType: manifest.proofType,
  typedModules: manifest.typedModules,
  typedTests: manifest.typedTests,
  internalNetwork: manifest.internalNetwork,
  ipFamilies: manifest.ipFamilies,
  tenantBoundEtags: manifest.dav.tenantBoundEtags,
  tenantBoundSyncTokens: manifest.dav.tenantBoundSyncTokens,
  hostPortsPublished: manifest.hostPortsPublished,
  dockerSocketMounted: manifest.dockerSocketMounted,
  credentialsCommitted: manifest.credentialsCommitted,
  liveDockerEvidence: manifest.liveDockerEvidence,
  status: manifest.status,
}, null, 2));
