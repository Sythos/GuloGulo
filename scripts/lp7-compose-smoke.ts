// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { isIP } from 'node:net';
import { inspect } from 'node:util';

type JsonRecord = Record<string, unknown>;

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^0-9]/gu, '') || 'local';
const project = `gulogulo-lp7-${runId}`;
const network = `gulogulo-lp7-network-${runId}`;
const volumePrefix = `gulogulo-lp7-${runId}`;
const blueVersion = '0.0.0-blue';
const greenVersion = '0.0.0-green';
const blueDigest = 'sha256:lp7-blue';
const greenDigest = 'sha256:lp7-green';
const composeBase = ['compose', '--project-name', project, '--file', 'compose.yaml', '--env-file', '.env.example'];
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GULOGULO_VOLUME_PREFIX: volumePrefix,
  GULOGULO_LP7_VOLUMES_EXTERNAL: 'false',
  GULOGULO_LP7_NETWORK: network,
  GULOGULO_LP7_COMPOSE_PLATFORM: 'linux/amd64',
  GULOGULO_LP7_BLUE_VERSION: blueVersion,
  GULOGULO_LP7_GREEN_VERSION: greenVersion,
  GULOGULO_LP7_BLUE_DIGEST: blueDigest,
  GULOGULO_LP7_GREEN_DIGEST: greenDigest,
  LP7_LOGIN_EMAIL: `lp7-${randomUUID()}@example.test`,
  LP7_LOGIN_PASSWORD: randomBytes(32).toString('base64url'),
  LP7_TENANT_ID: 'acme',
  LP7_TENANT_DOMAIN: 'example.test',
  LP7_USER_ID: 'alice',
};

function execute(args: string[], { capture = false, allowFailure = false } = {}): SpawnSyncReturns<string> {
  const result = spawnSync('docker', args, {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`Docker command failed (${result.status}): docker ${args.join(' ')}`);
  return result;
}

function compose(args: string[], options?: { capture?: boolean; allowFailure?: boolean }): SpawnSyncReturns<string> {
  return execute([...composeBase, ...args], options);
}

function serviceContainer(service: string): string {
  return compose(['ps', '-q', service], { capture: true }).stdout.trim().split(/\r?\n/gu).filter(Boolean)[0] || '';
}

function inspectContainer(container: string): JsonRecord {
  return JSON.parse(execute(['inspect', container], { capture: true }).stdout)[0] as JsonRecord;
}

function asRecord(value: unknown, description: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} is not an object.`);
  return value as JsonRecord;
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((entry): entry is JsonRecord => entry !== null && typeof entry === 'object' && !Array.isArray(entry)) : [];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealthy(service: string, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'not-created';
  while (Date.now() < deadline) {
    const container = serviceContainer(service);
    if (container) {
      const details = inspectContainer(container);
      const state = asRecord(details.State, `${service} state`);
      const health = state.Health === undefined ? {} : asRecord(state.Health, `${service} health`);
      lastState = `${state.Status || 'unknown'}/${health.Status || 'no-health'}`;
      if (state.Status === 'running' && health.Status === 'healthy') return container;
      if (state.Status === 'exited' && state.ExitCode !== 0) throw new Error(`${service} exited with code ${state.ExitCode}`);
    }
    await sleep(2_000);
  }
  throw new Error(`${service} did not become healthy: ${lastState}`);
}

function assertSafeContainer(container: JsonRecord, service: string): void {
  const hostConfig = asRecord(container.HostConfig, `${service} HostConfig`);
  if (hostConfig.NetworkMode === 'host') throw new Error(`${service} uses host networking.`);
  if (hostConfig.Privileged === true) throw new Error(`${service} is privileged.`);
  const bindings = asRecord(hostConfig.PortBindings || {}, `${service} port bindings`);
  if (Object.values(bindings).some((entry) => Array.isArray(entry) && entry.length > 0)) throw new Error(`${service} publishes host ports.`);
  for (const mount of asArray(container.Mounts)) {
    if (/docker\.sock/iu.test(`${mount.Source || ''} ${mount.Destination || ''}`)) throw new Error(`${service} mounts the Docker socket.`);
  }
}

function assertSharedVolumes(container: JsonRecord, service: string): void {
  const mounts = asArray(container.Mounts);
  const expected = [
    ['lp7-runtime-state', '/var/lib/gulogulo/runtime'],
    ['lp7-mail-data', '/var/lib/gulogulo/mail'],
    ['lp7-dav-data', '/var/lib/gulogulo/dav'],
    ['lp7-queue-data', '/var/lib/gulogulo/queue'],
    ['lp7-backup-data', '/var/lib/gulogulo/backups'],
  ] as const;
  for (const [suffix, destination] of expected) {
    const expectedName = `${volumePrefix}-${suffix}`;
    if (!mounts.some((mount) => mount.Type === 'volume' && mount.Name === expectedName && mount.Destination === destination)) {
      throw new Error(`${service} does not mount ${expectedName} at ${destination}.`);
    }
  }
}

function assertInternalDualStackNetwork(networkDetails: JsonRecord): void {
  if (networkDetails.Internal !== true || networkDetails.EnableIPv6 !== true) throw new Error('LP7 network is not internal with IPv6 enabled.');
  const ipam = asRecord(networkDetails.IPAM, 'LP7 network IPAM');
  const configurations = asArray(ipam.Config);
  const addressFamilies = configurations
    .map((configuration) => configuration.Subnet)
    .filter((subnet): subnet is string => typeof subnet === 'string')
    .map((subnet) => isIP(subnet.split('/', 1)[0]));
  if (!addressFamilies.includes(4) || !addressFamilies.includes(6)) throw new Error('LP7 network IPAM does not provide both IPv4 and IPv6 subnets.');
}

function runProof(phase: 'baseline' | 'cutover' | 'rollback'): void {
  compose([
    '--profile', 'lp7', '--profile', 'lp7-check', 'run', '--rm', '--no-deps',
    '-e', `LP7_PHASE=${phase}`, 'gulogulo-lp7-proof-check',
  ]);
}

let started = false;
try {
  compose(['--profile', 'lp7', '--profile', 'lp7-check', 'config', '--quiet']);
  compose(['--profile', 'lp7', '--profile', 'lp7-check', 'build', '--pull']);
  compose(['--profile', 'lp7', 'up', '--detach', '--remove-orphans']);
  started = true;

  const blueContainer = await waitForHealthy('gulogulo-lp7-blue');
  const greenContainer = await waitForHealthy('gulogulo-lp7-green');
  const networkDetails = JSON.parse(execute(['network', 'inspect', network], { capture: true }).stdout)[0] as JsonRecord;
  assertInternalDualStackNetwork(networkDetails);
  const blueDetails = inspectContainer(blueContainer);
  const greenDetails = inspectContainer(greenContainer);
  assertSafeContainer(blueDetails, 'gulogulo-lp7-blue');
  assertSafeContainer(greenDetails, 'gulogulo-lp7-green');
  assertSharedVolumes(blueDetails, 'gulogulo-lp7-blue');
  assertSharedVolumes(greenDetails, 'gulogulo-lp7-green');

  runProof('baseline');
  compose(['--profile', 'lp7', 'stop', 'gulogulo-lp7-blue']);
  const cutoverAt = new Date().toISOString();
  runProof('cutover');

  compose(['--profile', 'lp7', 'stop', 'gulogulo-lp7-green']);
  compose(['--profile', 'lp7', 'up', '--detach', 'gulogulo-lp7-blue']);
  const restartedBlue = await waitForHealthy('gulogulo-lp7-blue');
  const rollbackAt = new Date().toISOString();
  const restartedDetails = inspectContainer(restartedBlue);
  assertSafeContainer(restartedDetails, 'gulogulo-lp7-blue');
  assertSharedVolumes(restartedDetails, 'gulogulo-lp7-blue');
  runProof('rollback');

  console.log(JSON.stringify({
    milestone: 'LP7',
    project,
    network,
    networkInternal: true,
    networkIpv4: true,
    networkIpv6: true,
    blueGreenReady: true,
    readinessGatedCutover: true,
    cutoverAt,
    rollbackAt,
    syntheticTrafficPreserved: true,
    davContinuity: true,
    queueStatePreserved: true,
    mailStatePreserved: true,
    backupStatePreserved: true,
    rollbackSafe: true,
    hostPortsPublished: false,
    dockerSocketMounted: false,
    composeProofPlatform: 'linux/amd64',
    multiarchFunctionalProof: false,
    status: 'pass',
  }, null, 2));
} catch (error) {
  compose(['--profile', 'lp7', '--profile', 'lp7-check', 'logs', '--no-color', '--tail', '160', 'gulogulo-lp7-blue', 'gulogulo-lp7-green', 'gulogulo-lp7-proof-check'], { allowFailure: true });
  throw new Error(`${(error as Error).message}\n${inspect(error, { depth: 2 })}`);
} finally {
  if (started) compose(['--profile', 'lp7', '--profile', 'lp7-check', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
}
