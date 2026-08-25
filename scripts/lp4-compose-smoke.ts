// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { inspect } from 'node:util';

type JsonRecord = Record<string, any>;

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^0-9]/gu, '') || 'local';
const project = `gulogulo-lp4-${runId}`;
const network = `gulogulo-lp4-network-${runId}`;
const volumePrefix = `gulogulo-lp4-${runId}`;
const composeBase = ['compose', '--project-name', project, '--file', 'compose.yaml', '--env-file', '.env.example'];
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GULOGULO_VOLUME_PREFIX: volumePrefix,
  GULOGULO_LP4_VOLUMES_EXTERNAL: 'false',
  GULOGULO_LP4_NETWORK: network,
  LP4_LOGIN_EMAIL: `lp4-${randomUUID()}@example.test`,
  LP4_LOGIN_PASSWORD: randomBytes(32).toString('base64url'),
  LP4_TENANT_ID: 'acme',
  LP4_TENANT_DOMAIN: 'example.test',
  LP4_USER_ID: 'alice',
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
      lastState = `${details.State.Status}/${details.State.Health?.Status || 'no-health'}`;
      if (details.State.Status === 'running' && details.State.Health?.Status === 'healthy') return container;
      if (details.State.Status === 'exited' && details.State.ExitCode !== 0) throw new Error(`${service} exited with code ${details.State.ExitCode}`);
    }
    await sleep(2_000);
  }
  throw new Error(`${service} did not become healthy: ${lastState}`);
}

function assertSafeContainer(container: JsonRecord, service: string): void {
  const hostConfig = container.HostConfig || {};
  if (hostConfig.NetworkMode === 'host') throw new Error(`${service} uses host networking.`);
  if (hostConfig.Privileged === true) throw new Error(`${service} is privileged.`);
  const bindings = Object.values(hostConfig.PortBindings || {}).flat().filter(Boolean);
  if (bindings.length > 0) throw new Error(`${service} publishes host ports.`);
  for (const mount of container.Mounts || []) {
    if (/docker\.sock/iu.test(`${mount.Source || ''} ${mount.Destination || ''}`)) throw new Error(`${service} mounts the Docker socket.`);
  }
}

function assertDualStack(container: JsonRecord, service: string): void {
  const networks = Object.values(container.NetworkSettings?.Networks || {}) as JsonRecord[];
  if (!networks.some((state) => state.IPAddress && state.GlobalIPv6Address)) throw new Error(`${service} is not dual stack.`);
}

function assertVolume(container: JsonRecord, suffix: string, destination: string): void {
  const expectedName = `${volumePrefix}-${suffix}`;
  const found = (container.Mounts || []).some((mount: JsonRecord) => mount.Type === 'volume' && mount.Name === expectedName && mount.Destination === destination);
  if (!found) throw new Error(`LP4 web does not mount ${expectedName} at ${destination}.`);
}

function runProof(): void {
  compose(['--profile', 'lp4', '--profile', 'lp4-check', 'run', '--rm', '--no-deps', 'gulogulo-lp4-proof-check']);
}

let started = false;
try {
  compose(['--profile', 'lp4', '--profile', 'lp4-check', 'config', '--quiet']);
  compose(['--profile', 'lp4', '--profile', 'lp4-check', 'build', '--pull']);
  compose(['--profile', 'lp4', 'up', '--detach', '--remove-orphans']);
  started = true;
  const webContainer = await waitForHealthy('gulogulo-lp4-web');
  runProof();

  const networkDetails = JSON.parse(execute(['network', 'inspect', network], { capture: true }).stdout)[0] as JsonRecord;
  if (networkDetails.Internal !== true || networkDetails.EnableIPv6 !== true) throw new Error('LP4 network is not internal dual stack.');
  const beforeRestart = inspectContainer(webContainer);
  assertSafeContainer(beforeRestart, 'gulogulo-lp4-web');
  assertDualStack(beforeRestart, 'gulogulo-lp4-web');
  assertVolume(beforeRestart, 'lp4-runtime-state', '/var/lib/gulogulo/runtime');
  assertVolume(beforeRestart, 'lp4-dav-data', '/var/lib/gulogulo/dav');

  compose(['--profile', 'lp4', 'restart', 'gulogulo-lp4-web']);
  const restartedContainer = await waitForHealthy('gulogulo-lp4-web');
  const afterRestart = inspectContainer(restartedContainer);
  assertSafeContainer(afterRestart, 'gulogulo-lp4-web');
  assertVolume(afterRestart, 'lp4-dav-data', '/var/lib/gulogulo/dav');
  runProof();

  console.log(JSON.stringify({
    milestone: 'LP4',
    project,
    network,
    networkInternal: true,
    networkIpv6: true,
    staticWebAndApiEntry: true,
    syntheticSessionLogin: true,
    davTenantScope: true,
    discovery: true,
    restartContinuity: true,
    hostPortsPublished: false,
    dockerSocketMounted: false,
    credentialsCommitted: false,
    status: 'pass',
  }, null, 2));
} catch (error) {
  compose(['logs', '--no-color', '--tail', '160', 'gulogulo-lp4-web'], { allowFailure: true });
  throw new Error(`${(error as Error).message}\n${inspect(error, { depth: 2 })}`);
} finally {
  if (started) compose(['--profile', 'lp4', '--profile', 'lp4-check', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
}
