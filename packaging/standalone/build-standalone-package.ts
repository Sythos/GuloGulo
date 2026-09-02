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
 */

import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..', '..');
const packagingScriptsDirectory = join(scriptDirectory, 'scripts');
const outputDirectory = join(repoRoot, 'packaging', 'dist');

function log(message: string): void {
  console.log(`[package-standalone] ${message}`);
}

function runNpmScript(scriptName: string): void {
  log(`Running "npm run ${scriptName}"...`);
  const result = spawnSync('npm', ['run', scriptName], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw new Error(`Failed to start "npm run ${scriptName}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"npm run ${scriptName}" exited with status ${result.status ?? 'unknown'}.`);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function requireBuildOutput(path: string, hint: string): Promise<void> {
  if (!(await fileExists(path))) {
    throw new Error(`Expected build output at ${path} (${hint}). Run the build before packaging.`);
  }
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function readPackageMetadata(): Promise<{ version: string }> {
  const raw = await readFile(join(repoRoot, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json is missing a valid "version" field.');
  }
  return { version: parsed.version };
}

async function stageFile(relativeSource: string, relativeDestination: string, stagingRoot: string): Promise<void> {
  const source = join(repoRoot, relativeSource);
  const destination = join(stagingRoot, relativeDestination);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: false });
}

async function main(): Promise<void> {
  if (process.env.GULOGULO_SKIP_BUILD === '1') {
    log('GULOGULO_SKIP_BUILD=1: reusing existing dist/ and web/dist/ build output.');
  } else {
    runNpmScript('build:web');
    runNpmScript('build:server');
  }

  await requireBuildOutput(join(repoRoot, 'dist/server/src/runtime/index.js'), 'npm run build:server');
  await requireBuildOutput(join(repoRoot, 'web/dist/app.js'), 'npm run build:web');

  const { version } = await readPackageMetadata();
  const archiveBaseName = `gulogulo-${version}-standalone`;

  const stagingParent = await mkdtemp(join(tmpdir(), 'gulogulo-standalone-'));
  const stagingRoot = join(stagingParent, archiveBaseName);
  await mkdir(stagingRoot, { recursive: true });

  try {
    log('Staging compiled server output (dist/server/)...');
    await stageFile('dist/server', 'dist/server', stagingRoot);

    log('Staging web assets (web/)...');
    await stageFile('web/index.html', 'web/index.html', stagingRoot);
    await stageFile('web/styles.css', 'web/styles.css', stagingRoot);
    await stageFile('web/manifest.json', 'web/manifest.json', stagingRoot);
    await stageFile('web/dist', 'web/dist', stagingRoot);

    log('Staging static assets (assets/)...');
    await stageFile('assets', 'assets', stagingRoot);

    log('Staging database migrations (src/core/db/migrations/)...');
    await stageFile('src/core/db/migrations', 'src/core/db/migrations', stagingRoot);

    log('Staging package manifest, lockfile, license, and configuration guide...');
    await stageFile('package.json', 'package.json', stagingRoot);
    await stageFile('package-lock.json', 'package-lock.json', stagingRoot);
    await stageFile('LICENSE', 'LICENSE', stagingRoot);
    await stageFile('.env.example', '.env.example', stagingRoot);

    await writeFile(join(stagingRoot, 'VERSION'), `${version}\n`, 'utf8');

    log('Staging operator scripts (install.sh, upgrade.sh, uninstall.sh, run-migrations.mjs)...');
    for (const scriptName of ['install.sh', 'upgrade.sh', 'uninstall.sh', 'run-migrations.mjs', 'gulogulo.service.example']) {
      await cp(join(packagingScriptsDirectory, scriptName), join(stagingRoot, scriptName));
    }

    for (const executable of ['install.sh', 'upgrade.sh', 'uninstall.sh', 'run-migrations.mjs']) {
      await chmod(join(stagingRoot, executable), 0o755);
    }

    await mkdir(outputDirectory, { recursive: true });
    const archivePath = join(outputDirectory, `${archiveBaseName}.tar.gz`);

    log(`Compressing staging directory into ${archivePath}...`);
    const tarResult = spawnSync('tar', ['--force-local', '-czf', archivePath, '-C', stagingParent, archiveBaseName], {
      stdio: 'inherit',
    });
    if (tarResult.error) {
      throw new Error(`Failed to start "tar": ${tarResult.error.message}. Install GNU tar or bsdtar and retry.`);
    }
    if (tarResult.status !== 0) {
      throw new Error(`"tar" exited with status ${tarResult.status ?? 'unknown'}.`);
    }

    const archiveStats = await stat(archivePath);
    log('Package build complete.');
    log(`  archive: ${archivePath}`);
    log(`  size:    ${humanFileSize(archiveStats.size)} (${archiveStats.size} bytes)`);
    log(`  version: ${version}`);
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

await main();
