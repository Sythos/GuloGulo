// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { spawnSync } from 'node:child_process';

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^0-9]/g, '') || 'local';
const project = `gulogulo-lp2-${runId}`;
const network = `gulogulo-lp2-network-${runId}`;
const volumePrefix = `gulogulo-lp2-${runId}`;
const composeBase = ['compose', '--project-name', project, '--file', 'compose.yaml', '--env-file', '.env.example'];
const environment = {
  ...process.env,
  GULOGULO_VOLUME_PREFIX: volumePrefix,
  GULOGULO_LP2_VOLUMES_EXTERNAL: 'false',
  GULOGULO_LP2_NETWORK: network,
  LP2_LDAP_ROOT_PASSWORD: 'lp2-synthetic-root',
  LP2_POSTGRES_PASSWORD: 'lp2-synthetic-postgres',
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

function assertNoHostPorts(container, service) {
  const bindings = Object.values(container.HostConfig?.PortBindings || {}).flat().filter(Boolean);
  if (bindings.length > 0) {
    throw new Error(`${service} unexpectedly publishes host ports: ${JSON.stringify(bindings)}`);
  }
}

function assertDualStackAddress(container, service) {
  const networks = Object.values(container.NetworkSettings?.Networks || {});
  if (!networks.some((networkState) => networkState.IPAddress && networkState.GlobalIPv6Address)) {
    throw new Error(`${service} does not have both an IPv4 and an IPv6 address on the LP2 network.`);
  }
}

let started = false;
try {
  compose(['--profile', 'lp2', '--profile', 'lp2-check', 'config', '--quiet']);
  compose(['--profile', 'lp2', '--profile', 'lp2-check', 'build', '--pull']);
  compose(['--profile', 'lp2', 'up', '--detach', '--remove-orphans']);
  started = true;

  const ca = await waitForHealthy('lp2-ca');
  const ldap = await waitForHealthy('lp2-ldap');
  const postgres = await waitForHealthy('lp2-postgres');
  compose(['--profile', 'lp2', '--profile', 'lp2-check', 'run', '--rm', '--no-deps', 'gulogulo-lp2-proof-check']);

  const networkDetails = JSON.parse(execute(['network', 'inspect', network], { capture: true }).stdout)[0];
  if (networkDetails.Internal !== true) throw new Error('LP2 dependency network is not marked internal.');
  if (networkDetails.EnableIPv6 !== true) throw new Error('LP2 dependency network does not enable IPv6.');

  const containers = [
    ['lp2-ca', ca],
    ['lp2-ldap', ldap],
    ['lp2-postgres', postgres],
  ];
  for (const [service, container] of containers) {
    const details = inspectContainer(container);
    assertSafeContainer(details, service);
    assertDualStackAddress(details, service);
  }
  assertNoHostPorts(inspectContainer(ldap), 'lp2-ldap');
  assertNoHostPorts(inspectContainer(postgres), 'lp2-postgres');

  console.log(JSON.stringify({
    milestone: 'LP2',
    project,
    network,
    networkInternal: networkDetails.Internal,
    networkIpv6: networkDetails.EnableIPv6,
    dualStackServices: true,
    ldapHealthy: true,
    postgresHealthy: true,
    ldapTlsAndFixture: true,
    postgresTlsAndFixture: true,
    hostPortsPublished: false,
    publicDnsRequired: false,
    dockerSocketMounted: false,
    status: 'pass',
  }, null, 2));
} catch (error) {
  compose(['logs', '--no-color', '--tail', '120', 'lp2-ca', 'lp2-ldap', 'lp2-postgres'], { allowFailure: true });
  throw error;
} finally {
  if (started) compose(['--profile', 'lp2', '--profile', 'lp2-check', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
}
