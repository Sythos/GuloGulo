// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Builds the ADR-002 "cpanel" distribution package: a real `.rpm` for a
 * cPanel/WHM server. cPanel & WHM only runs on RHEL-family Linux
 * (AlmaLinux/CloudLinux/RHEL), so this target now builds and verifies
 * against that family (see packaging/cpanel/gulogulo.spec and
 * .github/workflows/package-cpanel.yml) instead of shipping a generic
 * tar.gz built on Ubuntu the way this script used to. Reuses identity via
 * UAPI (src/platform/cpanel/) and data via the same PostgreSQL integration
 * as the other targets; the packaging difference is entirely in how the
 * service is installed and started - see gulogulo.spec's %post for why:
 * cPanel's Application Manager is Passenger-based and is not a fit for a
 * standalone-port `app.listen()` Node process, so this target installs a
 * real systemd service plus an example Apache reverse proxy instead.
 *
 * What this script does, end to end:
 *   1. Builds the web/server bundles (unless GULOGULO_SKIP_BUILD=1).
 *   2. Stages a source tree via packaging/shared/stage-application.ts's
 *      stageCommonApplicationFiles() (dist/, web/, assets/, migrations,
 *      package.json/-lock/LICENSE/.env.example, VERSION) under `app/`,
 *      plus `run-migrations.mjs` (shared with the standalone target),
 *      the fixed-path systemd unit under `systemd/`, and the Apache
 *      reverse-proxy / WHM AppConfig example docs under `doc/`.
 *   3. Packs that tree into a source tarball
 *      (`gulogulo-<version>-cpanel-src.tar.gz`) via the same
 *      `createTarball()` helper the standalone target uses for its final
 *      archive - here it is only an intermediate input for rpmbuild.
 *   4. Runs `rpmbuild -bb` against `gulogulo.spec` (via
 *      `createRpmPackage()`), which requires an RHEL-family host with
 *      `rpm-build` installed - it will fail with a clear error on
 *      Windows/Ubuntu/Debian, which is expected; the AlmaLinux 9 CI
 *      container is where this is actually exercised.
 *   5. Writes a `.sha256` sidecar and updates the aggregated
 *      `packaging/dist/checksums.txt`, same as the other two targets.
 *
 * Unlike the retired tar.gz target, the RPM's install location is fixed by
 * packaging convention (/opt/gulogulo, %{_unitdir}/gulogulo.service,
 * /var/lib/gulogulo, a dedicated "gulogulo" system user) rather than chosen
 * by the operator at extraction time - see gulogulo.spec's top-of-file
 * comment for the full rationale.
 */

import { chmod, cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupStagingParent,
  createRpmPackage,
  createTarball,
  readPackageMetadata,
  requireWebAndServerBuildOutput,
  runNpmScript,
  stageCommonApplicationFiles,
  updateChecksumsAggregate,
  writeChecksumFile,
} from '../shared/stage-application.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..', '..');
const cpanelScriptsDirectory = join(scriptDirectory, 'scripts');
const standaloneScriptsDirectory = join(repoRoot, 'packaging', 'standalone', 'scripts');
const sharedDirectory = join(repoRoot, 'packaging', 'shared');
const specPath = join(scriptDirectory, 'gulogulo.spec');
const outputDirectory = join(repoRoot, 'packaging', 'dist');

function log(message: string): void {
  console.log(`[package-cpanel] ${message}`);
}

async function main(): Promise<void> {
  if (process.env.GULOGULO_SKIP_BUILD === '1') {
    log('GULOGULO_SKIP_BUILD=1: reusing existing dist/ and web/dist/ build output.');
  } else {
    runNpmScript(repoRoot, 'build:web', log);
    runNpmScript(repoRoot, 'build:server', log);
  }

  await requireWebAndServerBuildOutput(repoRoot);

  const { version } = await readPackageMetadata(repoRoot);
  // Matches gulogulo.spec's `%setup -q -n %{name}-%{version}-cpanel-src`
  // and `Source0: %{name}-%{version}-cpanel-src.tar.gz` - keep both in
  // sync if this naming ever changes.
  const sourceBaseName = `gulogulo-${version}-cpanel-src`;

  const stagingParent = await mkdtemp(join(tmpdir(), 'gulogulo-cpanel-'));
  const stagingRoot = join(stagingParent, sourceBaseName);
  const appDirectory = join(stagingRoot, 'app');
  const systemdDirectory = join(stagingRoot, 'systemd');
  const docDirectory = join(stagingRoot, 'doc');

  try {
    await mkdir(appDirectory, { recursive: true });
    await mkdir(systemdDirectory, { recursive: true });
    await mkdir(docDirectory, { recursive: true });

    await stageCommonApplicationFiles({ repoRoot, stagingRoot: appDirectory, version, log });

    log('Staging run-migrations.mjs (shared with the standalone target)...');
    await cp(join(standaloneScriptsDirectory, 'run-migrations.mjs'), join(appDirectory, 'run-migrations.mjs'));
    await chmod(join(appDirectory, 'run-migrations.mjs'), 0o755);

    log('Staging the systemd unit (fixed paths - an RPM install location needs no runtime templating)...');
    await cp(join(sharedDirectory, 'gulogulo-rpm.service'), join(systemdDirectory, 'gulogulo-rpm.service'));

    log('Staging the Apache reverse proxy and optional WHM AppConfig example docs...');
    await cp(
      join(cpanelScriptsDirectory, 'gulogulo-proxy.conf.example'),
      join(docDirectory, 'gulogulo-proxy.conf.example'),
    );
    await cp(
      join(cpanelScriptsDirectory, 'gulogulo-appconfig.conf.example'),
      join(docDirectory, 'gulogulo-appconfig.conf.example'),
    );

    log('Packing the RPM source tarball (rpmbuild %setup input, not the final package)...');
    const sourceTarballPath = await createTarball({
      stagingParent,
      archiveBaseName: sourceBaseName,
      outputDirectory: stagingParent,
      version,
      log,
    });

    log('Building the RPM (rpmbuild -bb - requires an RHEL-family host with rpm-build installed)...');
    const archivePath = await createRpmPackage({
      specPath,
      sourceTarballPath,
      sourceTarballName: `${sourceBaseName}.tar.gz`,
      defines: { gulogulo_version: version },
      outputDirectory,
      version,
      log,
    });

    const checksum = await writeChecksumFile(archivePath);
    log(`  sha256:  ${checksum}`);
    await updateChecksumsAggregate(outputDirectory);
  } finally {
    await cleanupStagingParent(stagingParent);
  }
}

await main();
