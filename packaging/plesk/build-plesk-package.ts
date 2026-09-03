// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Builds the ADR-002 "plesk" distribution package: a real Debian `.deb`
 * package for an operator installing Gulo Gulo on a Debian/Ubuntu server
 * (Plesk's own Node.js hosting support targets a subscription's own web
 * app, not a dedicated cross-subscription system service, so - same as the
 * cPanel target - this installs a real systemd service plus an example
 * nginx reverse proxy instead of using Plesk's own hosting mechanism).
 *
 * This target previously shipped as a Plesk "extension" ZIP (meta.xml +
 * plib/scripts/ PHP lifecycle hooks, installed via `plesk bin extension
 * -i`). That mechanism has been deliberately retired in favor of a real,
 * OS-native `.deb` package: `apt install ./gulogulo-<version>.deb` (or
 * `dpkg -i`) is a mechanism every Debian/Ubuntu operator already knows,
 * verifiable/reproducible in CI on a stock `debian:trixie` container,
 * and not tied to Plesk being installed on the host at all - identity via
 * the Plesk REST API (src/platform/plesk/) and data via the same
 * PostgreSQL integration as the other targets are unaffected; only the
 * installation mechanics changed. See INSTALL.md and
 * .github/workflows/package-plesk.yml for the reasoning and verification
 * status.
 *
 * Package layout, following standard Debian binary package conventions
 * (see https://www.debian.org/doc/debian-policy/ch-controlfields.html and
 * `man deb`):
 *
 *   DEBIAN/
 *     control                     <- from packaging/plesk/debian/DEBIAN/control,
 *                                     with @VERSION@ substituted
 *     postinst                    <- npm ci, migrations, system user,
 *                                     systemd install/enable/start
 *     prerm                       <- systemd stop/disable (on real removal
 *                                     only, not on upgrade)
 *     postrm                      <- cleanup of runtime-generated files not
 *                                     tracked by dpkg (node_modules/, the
 *                                     rendered systemd unit, and - purge
 *                                     only - .env)
 *   opt/gulogulo/                 <- stageCommonApplicationFiles() output
 *                                     (dist/, web/, migrations,
 *                                     package.json, ...) plus the systemd
 *                                     unit template, run-migrations.mjs,
 *                                     and the nginx proxy example - i.e.
 *                                     everything postinst needs at install
 *                                     time, staged the same way the cPanel
 *                                     install directory is, just rooted at
 *                                     /opt/gulogulo instead of an
 *                                     operator-chosen extraction directory.
 *
 * Common staging logic (building web/server, staging the compiled
 * server/web output, migrations, package manifest) is shared with the
 * standalone and cPanel targets via packaging/shared/stage-application.ts;
 * only the Debian-specific package wrapper is built here. The actual `.deb`
 * is produced by `dpkg-deb --build` (that module's createDebPackage()),
 * which ships natively on Debian/Ubuntu - no npm dependency, no extra
 * install step, unlike what building an RPM would require.
 *
 * By default this script runs `npm run build:web` and `npm run build:server`
 * itself so it is safe to invoke on its own. Set GULOGULO_SKIP_BUILD=1 to
 * reuse build output a caller already produced (CI does this to avoid
 * building twice).
 */

import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupStagingParent,
  createDebPackage,
  readPackageMetadata,
  requireWebAndServerBuildOutput,
  runNpmScript,
  stageCommonApplicationFiles,
  updateChecksumsAggregate,
  writeChecksumFile,
} from '../shared/stage-application.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..', '..');
const pleskScriptsDirectory = join(scriptDirectory, 'scripts');
const debianControlDirectory = join(scriptDirectory, 'debian', 'DEBIAN');
const sharedDirectory = join(repoRoot, 'packaging', 'shared');
const standaloneScriptsDirectory = join(repoRoot, 'packaging', 'standalone', 'scripts');
const outputDirectory = join(repoRoot, 'packaging', 'dist');

// Standard Debian binary package architecture qualifier: this package
// carries no compiled/native code (see DEBIAN/control's long description
// and INSTALL.md for the dependency audit backing this), so it is
// installable on any architecture Debian supports.
const DEB_ARCHITECTURE = 'all';

function log(message: string): void {
  console.log(`[package-plesk] ${message}`);
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
  // Standard Debian archive filename convention: <package>_<version>_<arch>.deb
  // (underscores, architecture suffix) - deliberately different from the
  // `gulogulo-<version>-<target>` naming the standalone tarball target uses
  // (and from the NVRA naming rpmbuild itself produces for the cPanel
  // target), since this filename is what dpkg/apt tooling (and any future
  // apt repository hosting this package) expects.
  const archiveFileName = `gulogulo_${version}_${DEB_ARCHITECTURE}.deb`;

  const stagingParent = await mkdtemp(join(tmpdir(), 'gulogulo-plesk-'));
  const packageRoot = join(stagingParent, 'gulogulo');
  const debianDirectory = join(packageRoot, 'DEBIAN');
  const appDirectory = join(packageRoot, 'opt', 'gulogulo');

  try {
    await mkdir(debianDirectory, { recursive: true });
    await mkdir(appDirectory, { recursive: true });

    log('Rendering DEBIAN/control (substituting @VERSION@)...');
    const controlTemplate = await readFile(join(debianControlDirectory, 'control'), 'utf8');
    const renderedControl = controlTemplate.replaceAll('@VERSION@', version);
    await writeFile(join(debianDirectory, 'control'), renderedControl, 'utf8');

    log('Staging Debian maintainer scripts (postinst, prerm, postrm)...');
    for (const scriptName of ['postinst', 'prerm', 'postrm']) {
      const destination = join(debianDirectory, scriptName);
      await cp(join(debianControlDirectory, scriptName), destination);
      await chmod(destination, 0o755);
    }

    await stageCommonApplicationFiles({ repoRoot, stagingRoot: appDirectory, version, log });

    log('Staging the systemd unit template (packaging/shared/gulogulo-deb.service.template)...');
    await cp(
      join(sharedDirectory, 'gulogulo-deb.service.template'),
      join(appDirectory, 'gulogulo.service.template'),
    );

    log('Staging the nginx reverse proxy example...');
    await cp(
      join(pleskScriptsDirectory, 'gulogulo-proxy.conf.example'),
      join(appDirectory, 'gulogulo-proxy.conf.example'),
    );

    log('Staging run-migrations.mjs (shared with the standalone/cPanel targets)...');
    await cp(join(standaloneScriptsDirectory, 'run-migrations.mjs'), join(appDirectory, 'run-migrations.mjs'));

    await chmod(join(appDirectory, 'run-migrations.mjs'), 0o755);

    const archivePath = join(outputDirectory, archiveFileName);
    await createDebPackage({ packageRoot, archivePath, version, log });

    const checksum = await writeChecksumFile(archivePath);
    log(`  sha256:  ${checksum}`);
    await updateChecksumsAggregate(outputDirectory);
  } finally {
    await cleanupStagingParent(stagingParent);
  }
}

await main();
