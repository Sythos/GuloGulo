// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Builds the ADR-002 "cpanel" distribution archive: a tarball for an
 * operator installing Gulo Gulo on a cPanel/WHM server. Reuses identity via
 * UAPI (src/platform/cpanel/) and data via the same PostgreSQL integration
 * as the standalone target; the packaging difference is entirely in how the
 * service is installed and started (see packaging/cpanel/scripts/install.sh
 * for why: cPanel's Application Manager is Passenger-based and is not a fit
 * for a standalone-port `app.listen()` Node process, so this target installs
 * a real systemd service plus an example Apache reverse proxy instead).
 *
 * Stages the already-built web and server output plus everything the
 * packaged install.sh/upgrade.sh/uninstall.sh scripts need, then compresses
 * the staging directory into
 * `packaging/dist/gulogulo-<version>-cpanel.tar.gz`.
 *
 * By default this script runs `npm run build:web` and `npm run build:server`
 * itself so it is safe to invoke on its own. Set GULOGULO_SKIP_BUILD=1 to
 * reuse build output a caller already produced (CI does this to avoid
 * building twice).
 *
 * Common staging/compression logic is shared with
 * packaging/standalone/build-standalone-package.ts via
 * packaging/shared/stage-application.ts; only the cPanel-specific operator
 * scripts are staged here.
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
  const archiveBaseName = `gulogulo-${version}-cpanel`;

  const stagingParent = await mkdtemp(join(tmpdir(), 'gulogulo-cpanel-'));
  const stagingRoot = join(stagingParent, archiveBaseName);
  await mkdir(stagingRoot, { recursive: true });

  try {
    await stageCommonApplicationFiles({ repoRoot, stagingRoot, version, log });

    log('Staging cPanel/WHM operator scripts (install.sh, upgrade.sh, uninstall.sh)...');
    for (const scriptName of [
      'install.sh',
      'upgrade.sh',
      'uninstall.sh',
      'gulogulo.service.template',
      'gulogulo-proxy.conf.example',
      'gulogulo-appconfig.conf.example',
    ]) {
      await cp(join(cpanelScriptsDirectory, scriptName), join(stagingRoot, scriptName));
    }

    log('Staging run-migrations.mjs (shared with the standalone target)...');
    await cp(join(standaloneScriptsDirectory, 'run-migrations.mjs'), join(stagingRoot, 'run-migrations.mjs'));

    for (const executable of ['install.sh', 'upgrade.sh', 'uninstall.sh', 'run-migrations.mjs']) {
      await chmod(join(stagingRoot, executable), 0o755);
    }

    const archivePath = await createTarball({ stagingParent, archiveBaseName, outputDirectory, version, log });

    const checksum = await writeChecksumFile(archivePath);
    log(`  sha256:  ${checksum}`);
    await updateChecksumsAggregate(outputDirectory);
  } finally {
    await cleanupStagingParent(stagingParent);
  }
}

await main();
