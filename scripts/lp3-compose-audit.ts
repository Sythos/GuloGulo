// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');

async function parseHeaderJson(path) {
  const source = await readFile(path, 'utf8');
  return JSON.parse(source.replace(/^(?:\s*\/\/[^\r\n]*(?:\r?\n|$))+/, '').trim());
}

const manifest = await parseHeaderJson(resolve(root, 'release/lp3-local-mail.json'));
const packageData = await parseHeaderJson(resolve(root, 'package.json'));
const tsconfigServer = await parseHeaderJson(resolve(root, 'tsconfig.server.json'));

function fail(message) {
  throw new Error(`LP3 Compose audit failed: ${message}`);
}

function requireText(haystack, marker, description = marker) {
  if (!haystack.includes(marker)) fail(`missing ${description}: ${marker}`);
}

function requirePattern(haystack, pattern, description) {
  if (!pattern.test(haystack)) fail(`missing ${description}`);
}

function equal(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const servicesStart = compose.indexOf('\nservices:');
const volumesStart = compose.indexOf('\nvolumes:', servicesStart);
const networksStart = compose.indexOf('\nnetworks:', volumesStart);
if (servicesStart < 0 || volumesStart < 0 || networksStart < 0) {
  fail('Compose services, volumes, or networks section is missing');
}
const servicesSection = compose.slice(servicesStart, volumesStart);
const lp3Start = servicesSection.search(/^  lp3-tls:$/m);
if (lp3Start < 0) fail('LP3 service section is missing');
const lp3Section = servicesSection.slice(lp3Start);

for (const service of [
  'lp3-postfix:',
  'lp3-dovecot:',
  'lp3-rspamd:',
  'lp3-clamav:',
  'gulogulo-lp3-proof-check:',
  'gulogulo-lp3-proof-node:',
]) {
  requirePattern(lp3Section, new RegExp(`^  ${service}$`, 'm'), `LP3 service ${service}`);
}

for (const marker of [
  'profiles: ["lp3"]',
  'profiles: ["lp3-check"]',
  'lp3-runtime:',
  'condition: service_healthy',
  'com.sythos.gulogulo.milestone: LP3',
  'com.sythos.gulogulo.proof: local_synthetic_mail',
  'com.sythos.gulogulo.network-policy: offline_dependencies',
]) {
  requireText(lp3Section, marker);
}

for (const marker of ['internal: true', 'enable_ipv6: true', 'fd42:4755:756c:7033::/64']) {
  requireText(compose, marker, `LP3 network marker ${marker}`);
}

for (const marker of [
  'GULOGULO_MAIL_CATCH_ALL:',
  'GULOGULO_MAIL_USER_FORWARDING:',
  'GULOGULO_MAIL_SCAN_FAILURE_MODE:',
  'GULOGULO_MAIL_IMAP_IDLE:',
  'GULOGULO_MAIL_LMTP_SOCKET:',
  'GULOGULO_MAIL_QUEUE_MAX_ATTEMPTS:',
  'GULOGULO_MAIL_QUEUE_RETRY_BASE_MS:',
]) {
  requireText(compose, marker);
}

for (const marker of [
  'lp3-mail-data:',
  'lp3-tls-data:',
  'lp3-postfix-spool:',
  'lp3-queue-data:',
  'lp3-postfix-state:',
  'lp3-dovecot-state:',
  'lp3-rspamd-data:',
  'lp3-clamav-data:',
  'lp3-scanner-signatures:',
  'external: ${GULOGULO_LP3_VOLUMES_EXTERNAL:-false}',
]) {
  requireText(compose, marker, `LP3 volume marker ${marker}`);
}

if (/\n\s+ports:/m.test(lp3Section)) fail('LP3 services must not publish host ports');
if (/docker\.sock|network_mode:\s*host|privileged:\s*true/m.test(lp3Section)) {
  fail('LP3 topology contains a Docker socket, host network, or privileged service');
}
if (/GULOGULO_MAIL_CATCH_ALL:\s*\$\{[^}]*:-true\}|GULOGULO_MAIL_USER_FORWARDING:\s*\$\{[^}]*:-true\}/u.test(compose)) {
  fail('LP3 defaults enable catch-all or automatic forwarding');
}

const lp3ServiceNames = ['lp3-tls', 'lp3-dovecot', 'lp3-postfix', 'lp3-rspamd', 'lp3-clamav', 'gulogulo-lp3-proof-check', 'gulogulo-lp3-proof-node'];
function lp3ServiceSection(service: string): string {
  const start = lp3Section.indexOf(`  ${service}:`);
  const nextStarts = lp3ServiceNames
    .filter((candidate) => candidate !== service)
    .map((candidate) => lp3Section.indexOf(`\n  ${candidate}:`, start + 1))
    .filter((index) => index >= 0);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : lp3Section.length;
  return lp3Section.slice(start, end);
}

for (const service of ['lp3-rspamd', 'lp3-clamav', 'gulogulo-lp3-proof-check', 'gulogulo-lp3-proof-node']) {
  const section = lp3ServiceSection(service);
  requireText(section, 'GULOGULO_SCANNER_SIGNATURE_ROOT:', `${service} signature root`);
  requireText(section, 'lp3-scanner-signatures:/var/lib/gulogulo/scanner-signatures:ro', `${service} read-only signature mount`);
}
const typedProofSection = lp3ServiceSection('gulogulo-lp3-proof-node');
requireText(typedProofSection, 'LP3_TLS_DIR: /run/gulogulo-lp3-tls', 'typed LP3 proof TLS directory');
requireText(typedProofSection, 'lp3-tls-data:/run/gulogulo-lp3-tls:ro', 'typed LP3 proof read-only TLS trust mount');

for (const imagePath of ['docker/lp3-tls/Dockerfile', 'docker/lp3-postfix/Dockerfile', 'docker/lp3-dovecot/Dockerfile', 'docker/lp3-rspamd/Dockerfile', 'docker/lp3-clamav/Dockerfile', 'docker/lp3-proof/Dockerfile']) {
  let image;
  try {
    image = await readFile(resolve(root, imagePath), 'utf8');
  } catch {
    fail(`LP3 image Dockerfile is missing: ${imagePath}`);
  }
  requirePattern(image, /FROM\s+ubuntu:26\.04\b/u, `${imagePath} Ubuntu 26.04 base`);
  requireText(image, 'apt-get update', `${imagePath} apt update`);
  requireText(image, 'apt-get upgrade -y', `${imagePath} apt upgrade`);
  requireText(image, 'ARG TARGETARCH', `${imagePath} multi-architecture argument`);
}

const tlsEntrypoint = await readFile(resolve(root, 'docker/lp3-tls/entrypoint-tls.sh'), 'utf8');
requireText(tlsEntrypoint, 'chmod 0755 "${tls_dir}"', 'LP3 shared TLS directory readability');
requireText(tlsEntrypoint, 'basicConstraints=critical,CA:TRUE', 'LP3 synthetic CA basic constraints');
requireText(tlsEntrypoint, 'keyUsage=critical,keyCertSign,cRLSign', 'LP3 synthetic CA key usage');

equal(manifest.milestone, 'LP3', 'manifest milestone');
equal(manifest.proofType, 'local_synthetic_mail', 'manifest proof type');
equal(manifest.networkPolicy, 'offline_dependencies', 'manifest network policy');
equal(manifest.networkName, 'gulogulo-lp3-runtime', 'manifest network name');
equal(manifest.internalNetwork, true, 'manifest internal network');
equal(manifest.enableIpv6, true, 'manifest IPv6 flag');
equal(manifest.ipFamilies, ['ipv4', 'ipv6'], 'manifest IP families');
equal(manifest.syntheticDataOnly, true, 'manifest synthetic-data flag');
equal(manifest.publicDnsRequired, false, 'manifest public DNS flag');
equal(manifest.publicAcmeEnabled, false, 'manifest public ACME flag');
equal(manifest.externalDeliveryEnabled, false, 'manifest external delivery flag');
equal(manifest.hostNetwork, false, 'manifest host network flag');
equal(manifest.dockerSocketMounted, false, 'manifest Docker socket flag');
equal(manifest.hostPortsPublished, false, 'manifest host port flag');
equal(manifest.policy.catchAll, false, 'manifest catch-all policy');
equal(manifest.policy.automaticForwarding, false, 'manifest forwarding policy');
equal(manifest.policy.aliasResolution, 'explicit_active_users_only', 'manifest alias policy');
equal(manifest.policy.scanFailureMode, 'fail_closed', 'manifest scanner failure policy');
equal(manifest.policy.trashRetentionDays, 28, 'manifest trash retention');
equal(manifest.policy.maxQueueAttempts, 5, 'manifest queue retry limit');
equal(manifest.policy.queueRetry, 'exponential', 'manifest queue retry mode');
equal(manifest.policy.queueView, 'metadata_only', 'manifest queue view');
equal(manifest.protocols.smtpInbound.unauthenticatedExternalRelay, false, 'manifest inbound relay policy');
equal(manifest.protocols.smtpInbound.unknownInternalRecipient, 'reject', 'manifest unknown-recipient policy');
equal(manifest.protocols.smtpSubmission.authenticationRequired, true, 'manifest submission authentication policy');
equal(manifest.protocols.smtpSubmission.unauthenticatedRelay, false, 'manifest submission relay policy');
equal(manifest.protocols.imap.idle, true, 'manifest IMAP IDLE policy');
equal(manifest.protocols.imap.reconnect, 'required', 'manifest IMAP reconnect policy');
equal(manifest.protocols.lmtp.quotaReservationBeforeAck, true, 'manifest LMTP quota order');
equal(manifest.protocols.lmtp.temporaryFailureQueue, true, 'manifest LMTP retry policy');
equal(manifest.protocols.sieve.redirect, false, 'manifest Sieve redirect policy');
equal(manifest.protocols.sieve.automaticForwarding, false, 'manifest Sieve forwarding policy');
equal(manifest.scanners.rspamd.required, true, 'manifest Rspamd requirement');
equal(manifest.scanners.rspamd.unavailableVerdict, 'deferred', 'manifest Rspamd unavailable verdict');
equal(manifest.scanners.rspamd.signatureVolume, 'lp3-scanner-signatures', 'manifest Rspamd signature volume');
equal(manifest.scanners.rspamd.signatureLayout, 'active_pointer_v1', 'manifest Rspamd signature layout');
equal(manifest.scanners.rspamd.signatureMount, 'read_only', 'manifest Rspamd signature mount');
equal(manifest.scanners.rspamd.hostUpdater, true, 'manifest Rspamd host updater');
equal(manifest.scanners.clamav.required, true, 'manifest ClamAV requirement');
equal(manifest.scanners.clamav.unavailableVerdict, 'deferred', 'manifest ClamAV unavailable verdict');
equal(manifest.scanners.clamav.infectedVerdict, 'quarantined', 'manifest ClamAV infected verdict');
equal(manifest.scanners.clamav.signatureVolume, 'lp3-scanner-signatures', 'manifest ClamAV signature volume');
equal(manifest.scanners.clamav.signatureLayout, 'active_pointer_v1', 'manifest ClamAV signature layout');
equal(manifest.scanners.clamav.signatureMount, 'read_only', 'manifest ClamAV signature mount');
equal(manifest.scanners.clamav.hostUpdater, true, 'manifest ClamAV host updater');
equal(manifest.signatureUpdateBoundary.externalHostUpdater, true, 'manifest external signature updater');
equal(manifest.signatureUpdateBoundary.containerReadersReadOnly, true, 'manifest read-only signature readers');
equal(manifest.signatureUpdateBoundary.activation, 'atomic_active_pointer_replace', 'manifest signature activation');
equal(manifest.signatureUpdateBoundary.rollback, 'retain_previous_versioned_directories', 'manifest signature rollback');
equal(manifest.signatureUpdateBoundary.sharedAcrossScanners, true, 'manifest shared scanner signature volume');
equal(manifest.targetPlatforms, ['linux/amd64', 'linux/arm64'], 'manifest target platforms');

for (const service of ['lp3-tls', 'lp3-postfix', 'lp3-dovecot', 'lp3-rspamd', 'lp3-clamav', 'gulogulo-lp3-proof-check', 'gulogulo-lp3-proof-node']) {
  if (!manifest.services.some((entry) => entry.name === service)) fail(`manifest service is missing: ${service}`);
}
for (const volume of ['lp3-tls-data', 'lp3-mail-data', 'lp3-postfix-spool', 'lp3-queue-data', 'lp3-postfix-state', 'lp3-dovecot-state', 'lp3-rspamd-data', 'lp3-clamav-data', 'lp3-scanner-signatures']) {
  if (!manifest.volumes.includes(volume)) fail(`manifest volume is missing: ${volume}`);
}

const mailSourceNames = ['mail-policy', 'mail-scanners', 'mail-queue', 'imap-idle', 'mail-core'];
for (const name of mailSourceNames) {
  const source = resolve(root, `src/mail/${name}.ts`);
  try {
    await readFile(source, 'utf8');
  } catch {
    fail(`typed LP3 source is missing for ${name}`);
  }
  const sourceText = await readFile(source, 'utf8');
  if (!sourceText.includes('SPDX-License-Identifier: MIT') || !sourceText.includes('Author: Sythos (https://www.sythos.net)')) {
    fail(`typed LP3 source is missing MIT/SPDX metadata: ${name}.ts`);
  }
}
for (const file of await readdir(resolve(root, 'src/mail'))) {
  if (!file.endsWith('.mjs')) continue;
  const source = await readFile(resolve(root, 'src/mail', file), 'utf8');
  if (!/compatibility bridge|temporary compatibility bridge/iu.test(source)) {
    fail(`LP3 left substantive JavaScript mail source behind: src/mail/${file}`);
  }
}
try {
  await readFile(resolve(root, 'src/mail/mail-core.test.ts'), 'utf8');
} catch {
  fail('typed LP3 contract test is missing: src/mail/mail-core.test.ts');
}
if (tsconfigServer.include?.some((entry) => entry === 'src/mail/**/*.ts') !== true) {
  fail('tsconfig.server.json does not include src/mail/**/*.ts');
}
for (const scriptName of ['typecheck:server', 'test:lp3', 'test:lp3:docker']) {
  if (typeof packageData.scripts?.[scriptName] !== 'string') fail(`package script is missing: ${scriptName}`);
}

console.log(JSON.stringify({
  milestone: manifest.milestone,
  proofType: manifest.proofType,
  networkName: manifest.networkName,
  internalNetwork: manifest.internalNetwork,
  ipFamilies: manifest.ipFamilies,
  services: manifest.services.map(({ name, role }) => ({ name, role })),
  typedMailModules: mailSourceNames,
  catchAll: manifest.policy.catchAll,
  automaticForwarding: manifest.policy.automaticForwarding,
  scannerFailureMode: manifest.policy.scanFailureMode,
  trashRetentionDays: manifest.policy.trashRetentionDays,
  hostPortsPublished: manifest.hostPortsPublished,
  dockerSocketMounted: manifest.dockerSocketMounted,
  status: manifest.status,
}, null, 2));
