// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Builds the ADR-002 "cpanel" distribution package.
 *
 * TEMPORARY REVERSION TO TAR.GZ: this target's real, OS-native `.rpm`
 * pipeline (packaging/cpanel/gulogulo.spec, `createRpmPackage()` in
 * packaging/shared/stage-application.ts) is fully implemented and is NOT
 * being removed - it is simply not invoked by this script right now.
 * Publishing an unsigned package through a host's package manager (`dnf
 * install ./gulogulo-*.rpm`) is a materially worse trust signal than an
 * unsigned tar.gz: a package manager install implies the artifact went
 * through a normal, curated distribution channel, while a plain archive the
 * operator downloads and extracts themselves communicates "verify this
 * yourself" far more clearly. Until a code-signing key/certificate exists
 * for RPM (and DEB, see build-plesk-package.ts) packages, this target ships
 * a tar.gz instead, same as the standalone target. To re-enable the RPM
 * output once a signing key exists: restore the `createRpmPackage()` call
 * this script used before this reversion (see git history), which already
 * stages the source tarball, runs `rpmbuild -bb` against gulogulo.spec, and
 * produces the standard NVRA-named `.rpm` - none of that code was touched.
 *
 * What this script does, end to end, while reverted to tar.gz:
 *   1. Builds the web/server bundles (unless GULOGULO_SKIP_BUILD=1).
 *   2. Stages the common application tree via
 *      packaging/shared/stage-application.ts's stageCommonApplicationFiles()
 *      (dist/, web/, assets/, migrations, package.json/-lock/LICENSE/
 *      .env.example, VERSION) - the same staging every target shares. The
 *      RPM-specific staging (spec file, %pre/%post scriptlets via
 *      gulogulo.spec) is skipped entirely; that spec file is untouched on
 *      disk and still builds correctly with `rpmbuild -bb` if invoked
 *      directly or once createRpmPackage() is restored above.
 *   3. Stages this target's own operator scripts (install.sh, upgrade.sh,
 *      uninstall.sh, run-migrations.mjs) plus the shared, parameterized
 *      systemd unit template (packaging/shared/gulogulo-deb.service.template
 *      - reused here rather than the RPM target's own pre-rendered
 *      packaging/shared/gulogulo-rpm.service, since a tar.gz install
 *      location is operator-chosen at extraction time, not fixed the way an
 *      RPM's is) and the Apache reverse-proxy / WHM AppConfig example docs.
 *      packaging/cpanel/scripts/install.sh installs and enables this unit
 *      itself - see that script's own comments for exactly which
 *      gulogulo.spec scriptlet each step translates.
 *   4. Packs that tree into `gulogulo-<version>_cpanel_.tar.gz` via the same
 *      `createTarball()` helper the standalone target uses (note the
 *      underscore-wrapped "cpanel" - this filename format was requested
 *      explicitly for this temporary reversion; it deliberately does not
 *      match the standalone target's own `gulogulo-<version>-standalone`
 *      naming convention).
 *   5. Writes a `.sha256` sidecar and updates the aggregated
 *      `packaging/dist/checksums.txt`, same as the other two targets.
 */

import { chmod, cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupStagingParent,
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
  // TEMPORARY tar.gz naming while the signed-RPM pipeline is on hold - see
  // the top-of-file comment. Deliberately not the
  // `gulogulo-<version>-standalone` shape the standalone target uses, nor
  // the NVRA shape `rpmbuild` itself would produce.
  const archiveBaseName = `gulogulo-${version}_cpanel_`;

  const stagingParent = await mkdtemp(join(tmpdir(), 'gulogulo-cpanel-'));
  const stagingRoot = join(stagingParent, archiveBaseName);
  await mkdir(stagingRoot, { recursive: true });

  try {
    await stageCommonApplicationFiles({ repoRoot, stagingRoot, version, log });

    log('Staging operator scripts (install.sh, upgrade.sh, uninstall.sh, run-migrations.mjs)...');
    for (const scriptName of ['install.sh', 'upgrade.sh', 'uninstall.sh']) {
      await cp(join(cpanelScriptsDirectory, scriptName), join(stagingRoot, scriptName));
    }
    await cp(join(standaloneScriptsDirectory, 'run-migrations.mjs'), join(stagingRoot, 'run-migrations.mjs'));

    for (const executable of ['install.sh', 'upgrade.sh', 'uninstall.sh', 'run-migrations.mjs']) {
      await chmod(join(stagingRoot, executable), 0o755);
    }

    log('Staging the shared, parameterized systemd unit template (packaging/shared/gulogulo-deb.service.template)...');
    await cp(
      join(sharedDirectory, 'gulogulo-deb.service.template'),
      join(stagingRoot, 'gulogulo.service.template'),
    );

    log('Staging the purge timer units (packaging/shared/gulogulo-purge.service, gulogulo-purge.timer)...');
    await cp(join(sharedDirectory, 'gulogulo-purge.service'), join(stagingRoot, 'gulogulo-purge.service'));
    await cp(join(sharedDirectory, 'gulogulo-purge.timer'), join(stagingRoot, 'gulogulo-purge.timer'));

    log('Staging the Apache reverse proxy and optional WHM AppConfig example docs...');
    await cp(
      join(cpanelScriptsDirectory, 'gulogulo-proxy.conf.example'),
      join(stagingRoot, 'gulogulo-proxy.conf.example'),
    );
    await cp(
      join(cpanelScriptsDirectory, 'gulogulo-appconfig.conf.example'),
      join(stagingRoot, 'gulogulo-appconfig.conf.example'),
    );

    const archivePath = await createTarball({ stagingParent, archiveBaseName, outputDirectory, version, log });

    const checksum = await writeChecksumFile(archivePath);
    log(`  sha256:  ${checksum}`);
    await updateChecksumsAggregate(outputDirectory);
  } finally {
    await cleanupStagingParent(stagingParent);
  }
}

await main();
