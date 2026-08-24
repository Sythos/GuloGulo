// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^0-9]/g, '') || 'local';
const project = `gulogulo-lp3-${runId}`;
const network = `gulogulo-lp3-network-${runId}`;
const volumePrefix = `gulogulo-lp3-${runId}`;
const composeBase = ['compose', '--project-name', project, '--file', 'compose.yaml', '--env-file', '.env.example'];
const environment = {
  ...process.env,
  GULOGULO_VOLUME_PREFIX: volumePrefix,
  GULOGULO_LP3_VOLUMES_EXTERNAL: 'false',
  GULOGULO_LP3_NETWORK: network,
  GULOGULO_MAIL_CATCH_ALL: 'false',
  GULOGULO_MAIL_USER_FORWARDING: 'false',
  GULOGULO_MAIL_SCAN_FAILURE_MODE: 'fail_closed',
  GULOGULO_MAIL_IMAP_IDLE: 'true',
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
  return compose(['ps', '-q', service], { capture: true }).stdout.trim().split(/\r?\n/u).filter(Boolean)[0] || '';
}

function inspectContainer(container) {
  const result = execute(['inspect', container], { capture: true });
  return JSON.parse(result.stdout)[0];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealthy(service, timeoutMs = 180_000) {
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
    await sleep(2_000);
  }
  throw new Error(`${service} did not become healthy: ${lastState}`);
}

function assertSafeContainer(container, service) {
  const hostConfig = container.HostConfig || {};
  if (hostConfig.NetworkMode === 'host') throw new Error(`${service} uses host networking.`);
  if (hostConfig.Privileged === true) throw new Error(`${service} is privileged.`);
  for (const mount of container.Mounts || []) {
    if (/docker\.sock/iu.test(`${mount.Source || ''} ${mount.Destination || ''}`)) {
      throw new Error(`${service} mounts the Docker socket.`);
    }
  }
}

function assertNoHostPorts(container, service) {
  const bindings = Object.values(container.HostConfig?.PortBindings || {}).flat().filter(Boolean);
  if (bindings.length > 0) throw new Error(`${service} unexpectedly publishes host ports: ${JSON.stringify(bindings)}`);
}

function assertDualStackAddress(container, service) {
  const networks = Object.values(container.NetworkSettings?.Networks || {});
  if (!networks.some((networkState) => networkState.IPAddress && networkState.GlobalIPv6Address)) {
    throw new Error(`${service} does not have both an IPv4 and an IPv6 address on the LP3 network.`);
  }
}

function assertVolumeSuffix(container, service, suffix) {
  const matching = (container.Mounts || []).some((mount) => mount.Type === 'volume' && String(mount.Source || '').endsWith(suffix));
  if (!matching) throw new Error(`${service} does not mount the expected persistent volume ${suffix}.`);
}

function runProofClient() {
  compose(['--profile', 'lp3', '--profile', 'lp3-check', 'run', '--rm', '--no-deps', 'gulogulo-lp3-proof-check']);
}

function runTypedNodeProof() {
  // The dedicated proof image checks vendor-shaped protocol fixtures. The
  // application image additionally runs the compiled TypeScript mail
  // contracts on the same internal network, so CI cannot pass with only a
  // Python/JavaScript test double and an unbuilt server boundary.
  compose(['--profile', 'lp3', 'run', '--rm', '--no-deps', '--network', network, 'gulogulo', 'node', 'scripts/lp3-proof-smoke.mjs']);
}

let started = false;
try {
  compose(['--profile', 'lp3', '--profile', 'lp3-check', 'config', '--quiet']);
  compose(['--profile', 'lp3', '--profile', 'lp3-check', 'build', '--pull']);
  compose(['--profile', 'lp3', 'up', '--detach', '--remove-orphans']);
  started = true;

  const containers = [];
  for (const service of ['lp3-tls', 'lp3-postfix', 'lp3-dovecot', 'lp3-rspamd', 'lp3-clamav']) {
    containers.push([service, await waitForHealthy(service)]);
  }
  runProofClient();
  runTypedNodeProof();

  const networkDetails = JSON.parse(execute(['network', 'inspect', network], { capture: true }).stdout)[0];
  if (networkDetails.Internal !== true) throw new Error('LP3 mail network is not marked internal.');
  if (networkDetails.EnableIPv6 !== true) throw new Error('LP3 mail network does not enable IPv6.');

  for (const [service, container] of containers) {
    const details = inspectContainer(container);
    assertSafeContainer(details, service);
    assertNoHostPorts(details, service);
    assertDualStackAddress(details, service);
  }
  assertVolumeSuffix(inspectContainer(containers.find(([service]) => service === 'lp3-postfix')[1]), 'lp3-postfix', 'lp3-queue-data');
  assertVolumeSuffix(inspectContainer(containers.find(([service]) => service === 'lp3-dovecot')[1]), 'lp3-dovecot', 'lp3-mail-data');
  assertVolumeSuffix(inspectContainer(containers.find(([service]) => service === 'lp3-tls')[1]), 'lp3-tls', 'lp3-tls-data');

  // A restart must leave the mailbox and queue volumes attached and the mail
  // contracts reachable. The second proof run catches a lost socket/config
  // or a service that only works during its first boot.
  compose(['--profile', 'lp3', 'restart', 'lp3-postfix', 'lp3-dovecot']);
  await waitForHealthy('lp3-postfix');
  await waitForHealthy('lp3-dovecot');
  runProofClient();
  runTypedNodeProof();

  console.log(JSON.stringify({
    milestone: 'LP3',
    project,
    network,
    networkInternal: networkDetails.Internal,
    networkIpv6: networkDetails.EnableIPv6,
    dualStackServices: containers.map(([service]) => service),
    smtpRelayDenied: true,
    aliasAndNegativeRecipientCases: true,
    imapIdleReconnects: 2,
    lmtpAndQuotaContract: true,
    scannerFailureMode: 'fail_closed',
    queueRetryBounceContract: true,
    trashRetentionDays: 28,
    restartContinuity: true,
    hostPortsPublished: false,
    publicDnsRequired: false,
    externalDeliveryEnabled: false,
    dockerSocketMounted: false,
    status: 'pass',
  }, null, 2));
} catch (error) {
  compose(['logs', '--no-color', '--tail', '160', 'lp3-tls', 'lp3-postfix', 'lp3-dovecot', 'lp3-rspamd', 'lp3-clamav'], { allowFailure: true });
  throw new Error(`${error.message}\n${inspect(error, { depth: 2 })}`);
} finally {
  if (started) compose(['--profile', 'lp3', '--profile', 'lp3-check', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
}
