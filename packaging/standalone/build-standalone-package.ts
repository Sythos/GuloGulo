// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Builds the ADR-002 "standalone" distribution archive: a generic tarball an
 * operator installs on their own server/VPS without Docker or any container
 * runtime. This script stages the already-built web and server output plus
 * everything the packaged `install.sh`/`upgrade.sh` scripts need, then
 * compresses the staging directory into
 * `packaging/dist/gulogulo-<version>-standalone.tar.gz`.
 *
 * By default this script runs `npm run build:web` and `npm run build:server`
 * itself so it is safe to invoke on its own. Set GULOGULO_SKIP_BUILD=1 to
 * reuse build output a caller already produced (CI does this to avoid
 * building twice).
 *
 * Common staging/compression logic (compiled server, web assets, static
 * assets, migrations, package manifest/lockfile/license/env example, and the
 * tar.gz compression step) lives in `packaging/shared/stage-application.ts`
 * and is shared with the `cpanel` target's build script; only the
 * target-specific operator scripts are staged here.
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
const packagingScriptsDirectory = join(scriptDirectory, 'scripts');
const sharedDirectory = join(repoRoot, 'packaging', 'shared');
const outputDirectory = join(repoRoot, 'packaging', 'dist');

function log(message: string): void {
  console.log(`[package-standalone] ${message}`);
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
  const archiveBaseName = `gulogulo-${version}-standalone`;

  const stagingParent = await mkdtemp(join(tmpdir(), 'gulogulo-standalone-'));
  const stagingRoot = join(stagingParent, archiveBaseName);
  await mkdir(stagingRoot, { recursive: true });

  try {
    await stageCommonApplicationFiles({ repoRoot, stagingRoot, version, log });

    log('Staging operator scripts (install.sh, upgrade.sh, uninstall.sh, run-migrations.mjs)...');
    for (const scriptName of ['install.sh', 'upgrade.sh', 'uninstall.sh', 'run-migrations.mjs', 'gulogulo.service.example']) {
      await cp(join(packagingScriptsDirectory, scriptName), join(stagingRoot, scriptName));
    }

    for (const executable of ['install.sh', 'upgrade.sh', 'uninstall.sh', 'run-migrations.mjs']) {
      await chmod(join(stagingRoot, executable), 0o755);
    }

    // Same treatment as gulogulo.service.example above: staged as a
    // `.example` file, never installed automatically by install.sh. This
    // target has no fixed install location (the operator extracts the
    // tarball wherever they like) and install.sh never touches systemd or
    // requires root, so - like the main service - the purge timer is left
    // for the operator to copy, review, and enable manually.
    log('Staging the purge timer as an example unit (packaging/shared/gulogulo-purge.service, gulogulo-purge.timer)...');
    await cp(join(sharedDirectory, 'gulogulo-purge.service'), join(stagingRoot, 'gulogulo-purge.service.example'));
    await cp(join(sharedDirectory, 'gulogulo-purge.timer'), join(stagingRoot, 'gulogulo-purge.timer.example'));

    const archivePath = await createTarball({ stagingParent, archiveBaseName, outputDirectory, version, log });

    const checksum = await writeChecksumFile(archivePath);
    log(`  sha256:  ${checksum}`);
    await updateChecksumsAggregate(outputDirectory);
  } finally {
    await cleanupStagingParent(stagingParent);
  }
}

await main();
