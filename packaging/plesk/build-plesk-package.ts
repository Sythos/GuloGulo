// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Builds the ADR-002 "plesk" distribution archive: a Plesk extension ZIP for
 * an operator installing Gulo Gulo on a Plesk server. Reuses identity via
 * the Plesk REST API (src/platform/plesk/) and data via the same PostgreSQL
 * integration as the standalone/cPanel targets; like cPanel, the packaging
 * difference is entirely in how the service is installed and started - see
 * packaging/plesk/scripts/post-install.php for why: Plesk's own Node.js
 * hosting support targets a subscription's own web app, not a dedicated
 * cross-subscription system service, so this target installs a real
 * systemd service plus an example nginx reverse proxy instead, the same
 * infrastructural approach as the cPanel target.
 *
 * Unlike the standalone/cPanel targets (a tarball extracted anywhere by the
 * operator), Plesk's extension mechanism requires a real ZIP archive with
 * `meta.xml` at its root and lifecycle scripts under `plib/scripts/` - see
 * https://docs.plesk.com/en-US/obsidian/extensions-guide/ (referenced by
 * this project's prior research; not independently re-verified here).
 * Package layout:
 *
 *   meta.xml                       <- from packaging/plesk/meta.xml, with
 *                                      @VERSION@ substituted
 *   plib/
 *     scripts/
 *       pre-install.php            <- Node.js/Linux precondition checks
 *       post-install.php           <- npm ci, migrations, systemd install
 *       pre-uninstall.php          <- systemd stop/disable, file cleanup
 *     app/                         <- stageCommonApplicationFiles() output
 *                                      (dist/, web/, migrations,
 *                                      package.json, ...) plus the systemd
 *                                      unit template, run-migrations.mjs,
 *                                      and the nginx proxy example - i.e.
 *                                      everything post-install.php needs at
 *                                      install time, staged the same way
 *                                      the cPanel install directory is.
 *
 * Common staging logic (building web/server, staging the compiled
 * server/web output, migrations, package manifest) is shared with the
 * standalone and cPanel targets via packaging/shared/stage-application.ts;
 * only the Plesk-specific extension wrapper is built here. ZIP creation
 * uses the same module's dependency-free createZipArchive() (node:zlib
 * deflate/crc32) rather than an npm zip library or an external `zip`
 * binary, since neither is otherwise needed by this project.
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
  createZipArchive,
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
const cpanelScriptsDirectory = join(repoRoot, 'packaging', 'cpanel', 'scripts');
const standaloneScriptsDirectory = join(repoRoot, 'packaging', 'standalone', 'scripts');
const outputDirectory = join(repoRoot, 'packaging', 'dist');

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
  const archiveBaseName = `gulogulo-${version}-plesk`;

  const stagingParent = await mkdtemp(join(tmpdir(), 'gulogulo-plesk-'));
  // Unlike the tarball targets, the ZIP's own contents (meta.xml, plib/...)
  // must sit directly at the archive root - there is no top-level
  // "gulogulo-<version>" directory the way createTarball's archiveBaseName
  // provides for the tarball targets.
  const stagingRoot = join(stagingParent, 'extension');
  const appDirectory = join(stagingRoot, 'plib', 'app');
  const scriptsOutDirectory = join(stagingRoot, 'plib', 'scripts');

  try {
    await mkdir(appDirectory, { recursive: true });
    await mkdir(scriptsOutDirectory, { recursive: true });

    log('Rendering meta.xml (substituting @VERSION@)...');
    const metaTemplate = await readFile(join(scriptDirectory, 'meta.xml'), 'utf8');
    const renderedMeta = metaTemplate.replaceAll('@VERSION@', version);
    await writeFile(join(stagingRoot, 'meta.xml'), renderedMeta, 'utf8');

    log('Staging Plesk lifecycle scripts (pre-install.php, post-install.php, pre-uninstall.php)...');
    for (const scriptName of ['pre-install.php', 'post-install.php', 'pre-uninstall.php']) {
      await cp(join(pleskScriptsDirectory, scriptName), join(scriptsOutDirectory, scriptName));
    }

    await stageCommonApplicationFiles({ repoRoot, stagingRoot: appDirectory, version, log });

    log('Staging the systemd unit template (shared with the cPanel target)...');
    await cp(
      join(cpanelScriptsDirectory, 'gulogulo.service.template'),
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

    const archivePath = join(outputDirectory, `${archiveBaseName}.zip`);
    await createZipArchive({ sourceRoot: stagingRoot, archivePath, log });
    log(`  version: ${version}`);

    const checksum = await writeChecksumFile(archivePath);
    log(`  sha256:  ${checksum}`);
    await updateChecksumsAggregate(outputDirectory);
  } finally {
    await cleanupStagingParent(stagingParent);
  }
}

await main();
