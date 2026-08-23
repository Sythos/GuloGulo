// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { spawnSync } from 'node:child_process';

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^0-9]/g, '') || 'local';
const project = `gulogulo-lp1-${runId}`;
const network = `gulogulo-lp1-network-${runId}`;
const volumePrefix = `gulogulo-lp1-${runId}`;
const composeBase = ['compose', '--project-name', project, '--file', 'compose.yaml', '--env-file', '.env.example'];
const environment = {
  ...process.env,
  GULOGULO_VOLUME_PREFIX: volumePrefix,
  GULOGULO_LP1_VOLUMES_EXTERNAL: 'false',
  GULOGULO_PROOF_NETWORK: network,
  GULOGULO_PROOF_HTTP_PORT: process.env.GULOGULO_PROOF_HTTP_PORT || '18080',
  LP1_DNS_PORT: '5353',
};

function execute(args, { capture = false, allowFailure = false } = {}) {
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

function compose(args, options) {
  return execute([...composeBase, ...args], options);
}

function serviceContainer(service) {
  const result = compose(['ps', '-q', service], { capture: true });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)[0] || '';
}

function inspectContainer(container) {
  const result = execute(['inspect', container], { capture: true });
  return JSON.parse(result.stdout)[0];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealthy(service, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'not-created';
  while (Date.now() < deadline) {
    const container = serviceContainer(service);
    if (container) {
      const details = inspectContainer(container);
      lastState = `${details.State.Status}/${details.State.Health?.Status || 'no-health'}`;
      if (details.State.Status === 'running' && details.State.Health?.Status === 'healthy') return container;
      if (details.State.Status === 'exited' && details.State.ExitCode !== 0) {
        throw new Error(`${service} exited with code ${details.State.ExitCode}`);
      }
    }
    await sleep(2000);
  }
  throw new Error(`${service} did not become healthy: ${lastState}`);
}

function assertSafeContainer(container, service) {
  const hostConfig = container.HostConfig || {};
  if (hostConfig.NetworkMode === 'host') throw new Error(`${service} uses host networking.`);
  if (hostConfig.Privileged === true) throw new Error(`${service} is privileged.`);
  for (const mount of container.Mounts || []) {
    if (/docker\.sock/i.test(`${mount.Source || ''} ${mount.Destination || ''}`)) {
      throw new Error(`${service} mounts the Docker socket.`);
    }
  }
}

let started = false;
try {
  compose(['--profile', 'proof', 'config', '--quiet']);
  compose(['--profile', 'proof', '--profile', 'proof-check', 'build', '--pull']);
  compose(['--profile', 'proof', 'up', '--detach', '--remove-orphans']);
  started = true;

  const application = await waitForHealthy('gulogulo-proof');
  await waitForHealthy('local-ca');
  await waitForHealthy('local-dns');

  compose(['--profile', 'proof', '--profile', 'proof-check', 'run', '--rm', '--no-deps', 'gulogulo-proof-check']);
  compose(['restart', 'gulogulo-proof']);
  await waitForHealthy('gulogulo-proof');
  compose(['--profile', 'proof', '--profile', 'proof-check', 'run', '--rm', '--no-deps', 'gulogulo-proof-check']);

  const networkDetails = JSON.parse(execute(['network', 'inspect', network], { capture: true }).stdout)[0];
  if (networkDetails.Internal !== true) throw new Error('LP1 runtime network is not marked internal.');
  for (const service of ['gulogulo-proof', 'local-ca', 'local-dns']) {
    assertSafeContainer(inspectContainer(serviceContainer(service)), service);
  }
  const applicationDetails = inspectContainer(application);
  // Docker Engine versions do not all populate NetworkSettings.Ports for an
  // explicitly loopback-bound Compose service. HostConfig.PortBindings is the
  // declared binding contract and remains available in that case; keep both
  // values in the failure message so a future engine change cannot hide a
  // publication regression.
  const configuredBindings = applicationDetails.HostConfig?.PortBindings?.['8080/tcp'] || [];
  const publishedBindings = applicationDetails.NetworkSettings?.Ports?.['8080/tcp'] || [];
  const bindings = configuredBindings.length > 0 ? configuredBindings : publishedBindings;
  const loopbackBindings = new Map(bindings.map((binding) => [binding.HostIp, binding.HostPort]));
  const ipv6LoopbackAliases = new Set(['::1', '0:0:0:0:0:0:0:1']);
  if (bindings.length !== 2 || loopbackBindings.get('127.0.0.1') !== environment.GULOGULO_PROOF_HTTP_PORT ||
      ![...ipv6LoopbackAliases].some((address) => loopbackBindings.get(address) === environment.GULOGULO_PROOF_HTTP_PORT)) {
    throw new Error(`LP1 application must expose exactly IPv4 and IPv6 loopback bindings; configured=${JSON.stringify(configuredBindings)} published=${JSON.stringify(publishedBindings)}`);
  }

  console.log(JSON.stringify({
    milestone: 'LP1',
    project,
    network,
    networkInternal: networkDetails.Internal,
    restartAndVolumeContinuity: true,
    localCaHealth: true,
    localDnsHealth: true,
    applicationHealth: true,
    hostBindingPolicy: 'dual_stack_loopback_only',
    dockerSocketMounted: false,
  }, null, 2));
} catch (error) {
  compose(['logs', '--no-color', '--tail', '120', 'gulogulo-proof', 'local-ca', 'local-dns'], { allowFailure: true });
  throw error;
} finally {
  if (started) compose(['--profile', 'proof', '--profile', 'proof-check', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
}
