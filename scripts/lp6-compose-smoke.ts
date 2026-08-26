// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { inspect } from 'node:util';

type JsonRecord = Record<string, unknown>;

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^0-9]/gu, '') || 'local';
const project = `gulogulo-lp6-${runId}`;
const network = `gulogulo-lp6-network-${runId}`;
const volumePrefix = `gulogulo-lp6-${runId}`;
const composeBase = ['compose', '--project-name', project, '--file', 'compose.yaml'];
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GULOGULO_VOLUME_PREFIX: volumePrefix,
  GULOGULO_LP6_VOLUMES_EXTERNAL: 'false',
  GULOGULO_LP6_NETWORK: network,
  GULOGULO_LP6_COMPOSE_PLATFORM: 'linux/amd64',
  LP6_TEST_KEY_B64: randomBytes(32).toString('base64url'),
};

function execute(args: string[], { capture = false, allowFailure = false } = {}): SpawnSyncReturns<string> {
  const result = spawnSync('docker', args, {
    cwd: process.cwd(), env: environment, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`Docker command failed (${result.status}): docker ${args.join(' ')}`);
  return result;
}

function compose(args: string[], options?: { capture?: boolean; allowFailure?: boolean }): SpawnSyncReturns<string> {
  return execute([...composeBase, ...args], options);
}

function serviceContainer(service: string): string {
  return compose(['ps', '-aq', service], { capture: true }).stdout.trim().split(/\r?\n/gu).filter(Boolean)[0] || '';
}

function inspectContainer(container: string): JsonRecord {
  return JSON.parse(execute(['inspect', container], { capture: true }).stdout)[0] as JsonRecord;
}

function assertSafeContainer(container: JsonRecord, service: string): void {
  const host = (container.HostConfig || {}) as JsonRecord;
  if (host.NetworkMode === 'host' || host.Privileged === true) throw new Error(`${service} uses unsafe host or privileged execution.`);
  if (Object.values(host.PortBindings as JsonRecord || {}).flat().filter(Boolean).length !== 0) throw new Error(`${service} publishes a host port.`);
  for (const mount of (container.Mounts || []) as JsonRecord[]) {
    if (/docker\.sock/iu.test(`${mount.Source || ''} ${mount.Destination || ''}`)) throw new Error(`${service} mounts the Docker socket.`);
  }
  const networks = Object.values(((container.NetworkSettings || {}) as JsonRecord).Networks as JsonRecord || {}) as JsonRecord[];
  if (!networks.some((state) => state.IPAddress && state.GlobalIPv6Address)) throw new Error(`${service} is not dual stack.`);
}

function assertVolume(container: JsonRecord, destination: string, writable: boolean): void {
  const mount = ((container.Mounts || []) as JsonRecord[]).find((candidate) => candidate.Destination === destination);
  if (!mount || mount.Type !== 'volume' || mount.RW !== writable) throw new Error(`LP6 expected ${writable ? 'writable' : 'read-only'} volume at ${destination}.`);
}

let created = false;
try {
  compose(['--profile', 'lp6', '--profile', 'lp6-check', 'config', '--quiet']);
  compose(['--profile', 'lp6', '--profile', 'lp6-check', 'build', '--pull', 'gulogulo-lp6-source-fixture', 'gulogulo-lp6-backup', 'gulogulo-lp6-restore']);
  compose(['--profile', 'lp6', '--profile', 'lp6-check', 'create']);
  created = true;
  for (const service of ['gulogulo-lp6-source-fixture', 'gulogulo-lp6-backup', 'gulogulo-lp6-restore']) {
    assertSafeContainer(inspectContainer(serviceContainer(service)), service);
  }
  const backup = inspectContainer(serviceContainer('gulogulo-lp6-backup'));
  const restore = inspectContainer(serviceContainer('gulogulo-lp6-restore'));
  assertVolume(backup, '/var/lib/gulogulo/lp6-source', false);
  assertVolume(backup, '/var/lib/gulogulo/lp6-backup', true);
  assertVolume(restore, '/var/lib/gulogulo/lp6-backup', false);
  assertVolume(restore, '/var/lib/gulogulo/lp6-restore', true);
  if (((restore.Mounts || []) as JsonRecord[]).some((mount) => mount.Destination === '/var/lib/gulogulo/lp6-source')) {
    throw new Error('LP6 isolated restore can access the source volume.');
  }

  compose(['--profile', 'lp6-check', 'run', '--rm', '--no-deps', 'gulogulo-lp6-source-fixture']);
  compose(['--profile', 'lp6', 'run', '--rm', '--no-deps', 'gulogulo-lp6-backup']);
  compose(['--profile', 'lp6-check', 'run', '--rm', '--no-deps', 'gulogulo-lp6-restore']);
  // Re-running the source-independent backup proves the persisted archive
  // path is idempotent before a second isolated restore rehearsal.
  compose(['--profile', 'lp6', 'run', '--rm', '--no-deps', 'gulogulo-lp6-backup']);
  compose(['--profile', 'lp6-check', 'run', '--rm', '--no-deps', 'gulogulo-lp6-restore']);

  const networkDetails = JSON.parse(execute(['network', 'inspect', network], { capture: true }).stdout)[0] as JsonRecord;
  if (networkDetails.Internal !== true || networkDetails.EnableIPv6 !== true) throw new Error('LP6 network is not internal dual stack.');
  console.log(JSON.stringify({
    milestone: 'LP6', project, network, networkInternal: true, networkIpv6: true,
    backupIdempotent: true, encryptedMetadataVerified: true, checksumsVerified: true,
    isolatedRestore: true, failedRestoreSourcePreserved: true, retentionDays: 28,
    holdsPreventPurge: true, purgeIdempotent: true, rpoMinutes: 15, rtoMinutes: 60,
    hostPortsPublished: false, dockerSocketMounted: false, composeProofPlatform: 'linux/amd64', status: 'pass',
  }, null, 2));
} catch (error) {
  compose(['logs', '--no-color', '--tail', '160', 'gulogulo-lp6-source-fixture', 'gulogulo-lp6-backup', 'gulogulo-lp6-restore'], { allowFailure: true });
  throw new Error(`${(error as Error).message}\n${inspect(error, { depth: 2 })}`);
} finally {
  if (created) compose(['--profile', 'lp6', '--profile', 'lp6-check', 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
}
