// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { inspect } from 'node:util';

type JsonRecord = Record<string, any>;

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^0-9]/gu, '') || 'local';
const project = `gulogulo-lp5-${runId}`;
const network = `gulogulo-lp5-network-${runId}`;
const volumePrefix = `gulogulo-lp5-${runId}`;
const composeBase = ['compose', '--project-name', project, '--file', 'compose.yaml', '--env-file', '.env.example'];
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GULOGULO_VOLUME_PREFIX: volumePrefix,
  GULOGULO_LP5_VOLUMES_EXTERNAL: 'false',
  GULOGULO_LP5_NETWORK: network,
  LP5_LOGIN_EMAIL: `lp5-${randomUUID()}@example.test`,
  LP5_LOGIN_PASSWORD: randomBytes(32).toString('base64url'),
  LP5_TENANT_ID: 'acme',
  LP5_TENANT_DOMAIN: 'example.test',
  LP5_USER_ID: 'alice',
};

function execute(args: string[], { capture = false, allowFailure = false } = {}): SpawnSyncReturns<string> {
  const result = spawnSync('docker', args, {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Docker command failed (${result.status}): docker ${args.join(' ')}`);
  }
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

async function waitForHealthy(service: string, timeoutMs = 180_000): Promise<{ container: string; elapsedMs: number }> {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  let lastState = 'not-created';
  while (Date.now() < deadline) {
    const container = serviceContainer(service);
    if (container) {
      const details = inspectContainer(container);
      lastState = `${details.State.Status}/${details.State.Health?.Status || 'no-health'}`;
      if (details.State.Status === 'running' && details.State.Health?.Status === 'healthy') {
        return { container, elapsedMs: performance.now() - started };
      }
      if (details.State.Status === 'exited' && details.State.ExitCode !== 0) {
        throw new Error(`${service} exited with code ${details.State.ExitCode}`);
      }
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

function assertPatchMounts(container: JsonRecord): void {
  const patch = (container.Mounts || []).find((mount: JsonRecord) => mount.Destination === '/var/lib/gulogulo/patch');
  if (!patch || patch.RW !== false) throw new Error('LP5 application patch state must be mounted read-only.');
}

function runProof(startupMs: number, readinessMs: number, memoryMiB: number, cpuMillis: number, pids: number): void {
  compose([
    '--profile', 'lp5', '--profile', 'lp5-check', 'run', '--rm', '--no-deps',
    '-e', `LP5_STARTUP_MS=${Math.max(0, Math.round(startupMs))}`,
    '-e', `LP5_READINESS_MS=${Math.max(0, Math.round(readinessMs))}`,
    '-e', `LP5_MEMORY_MIB=${Math.max(0, Math.round(memoryMiB))}`,
    '-e', `LP5_CPU_MILLIS=${Math.max(0, Math.round(cpuMillis))}`,
    '-e', `LP5_PIDS=${Math.max(0, Math.round(pids))}`,
    '-e', 'LP5_QUEUE_P95_MS=1',
    '-e', 'LP5_IDLE_NOTIFY_P95_MS=1',
    '-e', 'LP5_ACTIVE_IDLE_CONNECTIONS=8',
    'gulogulo-lp5-proof-check',
  ]);
}

let started = false;
try {
  compose(['--profile', 'lp5', '--profile', 'lp5-check', 'config', '--quiet']);
  compose(['--profile', 'lp5', '--profile', 'lp5-check', 'build', '--pull', 'gulogulo-lp5-web', 'gulogulo-lp5-proof-check', 'gulogulo-lp5-maintenance']);
  const startupStarted = performance.now();
  compose(['--profile', 'lp5', 'up', '--detach', '--remove-orphans']);
  started = true;
  const healthy = await waitForHealthy('gulogulo-lp5-web');
  const startupMs = performance.now() - startupStarted;
  const webContainer = inspectContainer(healthy.container);
  assertSafeContainer(webContainer, 'gulogulo-lp5-web');
  assertDualStack(webContainer, 'gulogulo-lp5-web');
  assertPatchMounts(webContainer);

  const networkDetails = JSON.parse(execute(['network', 'inspect', network], { capture: true }).stdout)[0] as JsonRecord;
  if (networkDetails.Internal !== true || networkDetails.EnableIPv6 !== true) throw new Error('LP5 network is not internal dual stack.');
  const memoryMiB = Number(webContainer.HostConfig?.Memory || 0) / (1024 * 1024);
  const cpuMillis = Number(webContainer.HostConfig?.NanoCpus || 0) / 1_000_000;
  const pids = Number(webContainer.HostConfig?.PidsLimit || 0);
  if (!(memoryMiB > 0) || !(pids > 0)) throw new Error('LP5 resource limits were not applied to the web container.');

  compose(['--profile', 'lp5', '--profile', 'lp5-check', 'run', '--rm', '--no-deps', 'gulogulo-lp5-maintenance']);
  runProof(startupMs, healthy.elapsedMs, memoryMiB, cpuMillis, pids);

  compose(['--profile', 'lp5', 'restart', 'gulogulo-lp5-web']);
  const restarted = await waitForHealthy('gulogulo-lp5-web');
  const restartedContainer = inspectContainer(restarted.container);
  assertSafeContainer(restartedContainer, 'gulogulo-lp5-web');
  assertDualStack(restartedContainer, 'gulogulo-lp5-web');
  runProof(startupMs, restarted.elapsedMs, memoryMiB, cpuMillis, pids);

  console.log(JSON.stringify({
    milestone: 'LP5',
    project,
    network,
    networkInternal: true,
    networkIpv6: true,
    startupMs: Number(startupMs.toFixed(3)),
    readinessMs: Number(restarted.elapsedMs.toFixed(3)),
    memoryMiB: Number(memoryMiB.toFixed(3)),
    cpuMillis: Number(cpuMillis.toFixed(3)),
    pids,
    restartContinuity: true,
    hostPortsPublished: false,
    dockerSocketMounted: false,
    status: 'pass',
  }, null, 2));
} catch (error) {
  compose(['logs', '--no-color', '--tail', '200', 'gulogulo-lp5-web', 'gulogulo-lp5-proof-check'], { allowFailure: true });
  throw new Error(`${(error as Error).message}\n${inspect(error, { depth: 2 })}`);
} finally {
  if (started) compose(['--profile', 'lp5', '--profile', 'lp5-check', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
}
