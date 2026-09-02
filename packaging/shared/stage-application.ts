// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Shared staging/packaging helpers used by both distribution targets
 * (`packaging/standalone/build-standalone-package.ts` and
 * `packaging/cpanel/build-cpanel-package.ts`). Everything here is
 * target-agnostic: building the web/server bundles, staging the parts of the
 * repository every tarball ships (compiled server, web assets, static
 * assets, database migrations, package manifest/lockfile/license/env
 * example), and compressing a staging directory into the final
 * `.tar.gz`. Target-specific bits (which operator scripts to copy in, which
 * systemd unit, which reverse-proxy config) stay in each target's own build
 * script.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function humanFileSize(bytes: number): string {
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

export function runNpmScript(repoRoot: string, scriptName: string, log: (message: string) => void): void {
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

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function requireBuildOutput(path: string, hint: string): Promise<void> {
  if (!(await fileExists(path))) {
    throw new Error(`Expected build output at ${path} (${hint}). Run the build before packaging.`);
  }
}

export async function readPackageMetadata(repoRoot: string): Promise<{ version: string }> {
  const raw = await readFile(join(repoRoot, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json is missing a valid "version" field.');
  }
  return { version: parsed.version };
}

export async function stageFile(
  repoRoot: string,
  relativeSource: string,
  relativeDestination: string,
  stagingRoot: string,
): Promise<void> {
  const source = join(repoRoot, relativeSource);
  const destination = join(stagingRoot, relativeDestination);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: false });
}

/**
 * Ensures the compiled web/server build output exists (does NOT run the
 * build itself — callers decide whether to build or reuse existing output,
 * e.g. via a `*_SKIP_BUILD` env var).
 */
export async function requireWebAndServerBuildOutput(repoRoot: string): Promise<void> {
  await requireBuildOutput(join(repoRoot, 'dist/server/src/runtime/index.js'), 'npm run build:server');
  await requireBuildOutput(join(repoRoot, 'web/dist/app.js'), 'npm run build:web');
}

/**
 * Stages everything common to every distribution target: the compiled
 * server, the web shell, static assets, database migrations, and the
 * package manifest/lockfile/license/env example. Writes a `VERSION` file
 * too. Target-specific operator scripts (install.sh, systemd units, reverse
 * proxy configs, ...) are staged separately by each build script.
 */
export async function stageCommonApplicationFiles(options: {
  repoRoot: string;
  stagingRoot: string;
  version: string;
  log: (message: string) => void;
}): Promise<void> {
  const { repoRoot, stagingRoot, version, log } = options;

  log('Staging compiled server output (dist/server/)...');
  await stageFile(repoRoot, 'dist/server', 'dist/server', stagingRoot);

  log('Staging web assets (web/)...');
  await stageFile(repoRoot, 'web/index.html', 'web/index.html', stagingRoot);
  await stageFile(repoRoot, 'web/styles.css', 'web/styles.css', stagingRoot);
  await stageFile(repoRoot, 'web/manifest.json', 'web/manifest.json', stagingRoot);
  await stageFile(repoRoot, 'web/dist', 'web/dist', stagingRoot);

  log('Staging static assets (assets/)...');
  await stageFile(repoRoot, 'assets', 'assets', stagingRoot);

  log('Staging database migrations (src/core/db/migrations/)...');
  await stageFile(repoRoot, 'src/core/db/migrations', 'src/core/db/migrations', stagingRoot);

  log('Staging package manifest, lockfile, license, and configuration guide...');
  await stageFile(repoRoot, 'package.json', 'package.json', stagingRoot);
  await stageFile(repoRoot, 'package-lock.json', 'package-lock.json', stagingRoot);
  await stageFile(repoRoot, 'LICENSE', 'LICENSE', stagingRoot);
  await stageFile(repoRoot, '.env.example', '.env.example', stagingRoot);

  await writeFile(join(stagingRoot, 'VERSION'), `${version}\n`, 'utf8');
}

/**
 * Compresses `stagingRoot` (named `archiveBaseName`, living directly inside
 * `stagingParent`) into `<outputDirectory>/<archiveBaseName>.tar.gz`, logs a
 * short summary, and returns the archive path.
 */
export async function createTarball(options: {
  stagingParent: string;
  archiveBaseName: string;
  outputDirectory: string;
  version: string;
  log: (message: string) => void;
}): Promise<string> {
  const { stagingParent, archiveBaseName, outputDirectory, version, log } = options;

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

  return archivePath;
}

export async function cleanupStagingParent(stagingParent: string): Promise<void> {
  await rm(stagingParent, { recursive: true, force: true });
}
