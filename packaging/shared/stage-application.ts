// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/*
 * Shared staging/packaging helpers used by all three distribution targets
 * (`packaging/standalone/build-standalone-package.ts`,
 * `packaging/cpanel/build-cpanel-package.ts`, and
 * `packaging/plesk/build-plesk-package.ts`). Everything here is
 * target-agnostic: building the web/server bundles, staging the parts of the
 * repository every package ships (compiled server, web assets, static
 * assets, database migrations, package manifest/lockfile/license/env
 * example), and compressing a staging directory into the final archive.
 * Target-specific bits (which operator scripts to copy in, which systemd
 * unit, which reverse-proxy config, which archive format) stay in each
 * target's own build script.
 *
 * `createDebPackage` and `createRpmPackage` below are also shared
 * infrastructure, and both are fully implemented and unit-independent of
 * this reversion. `createDebPackage` (produces a real `.deb`) shells out to
 * `dpkg-deb --build`, the same way `createTarball` shells out to `tar` -
 * `dpkg-deb` is not an npm dependency, it ships natively on Debian/Ubuntu
 * (and is expected to be present in the `debian:trixie` container that
 * target's CI job runs in). `createRpmPackage` shells out to `rpmbuild -bb`
 * the same way, which is RHEL-family-only (see the function's own doc
 * comment for why that target's CI job would run in an `almalinux:9`
 * container).
 *
 * TEMPORARILY UNUSED: as of this comment, neither
 * `packaging/cpanel/build-cpanel-package.ts` nor
 * `packaging/plesk/build-plesk-package.ts` calls `createRpmPackage`/
 * `createDebPackage` - both targets build a plain `createTarball()` archive
 * instead, same as standalone, until a code-signing key exists for RPM/DEB
 * packages (see the top-of-file comment in each of those two build scripts
 * for the full rationale). Neither function was removed or altered; restore
 * either build script's call to re-enable the native package output.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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

/**
 * Computes the SHA256 of `archivePath` by streaming it (never loading the
 * whole file into memory), writes a `<archivePath>.sha256` sidecar file in
 * the standard `sha256sum`-compatible format (`<hash>  <filename>\n`, two
 * spaces, filename only - no directory component), and returns the hex
 * digest. Callers use the returned digest to log it alongside the rest of a
 * build's summary.
 */
export async function writeChecksumFile(archivePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveDigest, reject) => {
    const stream = createReadStream(archivePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveDigest());
  });
  const digest = hash.digest('hex');

  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${digest}  ${basename(archivePath)}\n`, 'utf8');

  return digest;
}

/**
 * Rebuilds `<outputDirectory>/checksums.txt`, one `sha256sum`-format line per
 * `.tar.gz`/`.deb`/`.rpm` package currently sitting in `outputDirectory` (not
 * just the package a given build script just produced - every prior package
 * left over from earlier runs too). Reuses each package's own
 * `<archive>.sha256` sidecar (written by `writeChecksumFile`) when present
 * instead of re-hashing the archive; falls back to computing it if the
 * sidecar is missing. Lines are sorted by filename, one per archive, so
 * re-running a build that replaces an existing archive updates its line in
 * place rather than duplicating it.
 */
export async function updateChecksumsAggregate(outputDirectory: string): Promise<string> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const archiveNames = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.tar.gz') || entry.name.endsWith('.deb') || entry.name.endsWith('.rpm')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const lines: string[] = [];
  for (const archiveName of archiveNames) {
    const archivePath = join(outputDirectory, archiveName);
    const checksumPath = `${archivePath}.sha256`;

    let digest: string | undefined;
    if (await fileExists(checksumPath)) {
      const sidecar = await readFile(checksumPath, 'utf8');
      const match = /^([0-9a-f]{64}) {2}/.exec(sidecar);
      digest = match?.[1];
    }
    digest ??= await writeChecksumFile(archivePath);

    lines.push(`${digest}  ${archiveName}\n`);
  }

  const checksumsPath = join(outputDirectory, 'checksums.txt');
  await writeFile(checksumsPath, lines.join(''), 'utf8');

  return checksumsPath;
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

/**
 * Builds a real `.deb` binary package from a fully staged package root (a
 * directory containing `DEBIAN/control` plus the payload laid out exactly as
 * it should land on the target filesystem, e.g. `opt/gulogulo/...`) by
 * shelling out to `dpkg-deb --build`, the tool every Debian/Ubuntu host
 * already ships (part of `dpkg`, not a separate install). `--root-owner-group`
 * makes every file in the resulting archive owned by root:root regardless of
 * the uid/gid the build actually ran as, which matters here since CI builds
 * as a non-root container user.
 *
 * Unlike `createTarball`, `dpkg-deb` names its own internal contents from
 * `packageRoot` directly (there is no separate "staging parent" wrapper
 * directory) - the caller passes the exact output filename it wants via
 * `archivePath`.
 */
export async function createDebPackage(options: {
  packageRoot: string;
  archivePath: string;
  version: string;
  log: (message: string) => void;
}): Promise<string> {
  const { packageRoot, archivePath, version, log } = options;

  await mkdir(dirname(archivePath), { recursive: true });

  log(`Building .deb package from ${packageRoot} into ${archivePath}...`);
  const dpkgResult = spawnSync('dpkg-deb', ['--build', '--root-owner-group', packageRoot, archivePath], {
    stdio: 'inherit',
  });
  if (dpkgResult.error) {
    throw new Error(
      `Failed to start "dpkg-deb": ${dpkgResult.error.message}. This build step requires a Debian/Ubuntu ` +
        'host (or container) with dpkg-dev installed - e.g. the debian:trixie CI container this target runs in.',
    );
  }
  if (dpkgResult.status !== 0) {
    throw new Error(`"dpkg-deb --build" exited with status ${dpkgResult.status ?? 'unknown'}.`);
  }

  const archiveStats = await stat(archivePath);
  log('Package build complete.');
  log(`  archive: ${archivePath}`);
  log(`  size:    ${humanFileSize(archiveStats.size)} (${archiveStats.size} bytes)`);
  log(`  version: ${version}`);

  return archivePath;
}

async function findRpmFilesRecursively(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findRpmFilesRecursively(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.rpm')) {
      found.push(entryPath);
    }
  }
  return found;
}

/**
 * Builds a real `.rpm` binary package by shelling out to `rpmbuild -bb`, the
 * tool every RHEL-family host (RHEL/AlmaLinux/CloudLinux/Fedora) already
 * ships as part of the `rpm-build` package - not an npm dependency, and not
 * available at all on the Ubuntu/Debian hosts the other two targets build
 * on, which is why this is only ever exercised inside the AlmaLinux 9
 * container `.github/workflows/package-cpanel.yml` runs in (or a real
 * RHEL-family host); it fails with a clear, actionable error everywhere
 * else, e.g. on a developer's Windows/Ubuntu machine.
 *
 * Unlike `createDebPackage` (which builds directly from a fully laid-out
 * package root), `rpmbuild` works from a `%{_topdir}` tree (`BUILD/`,
 * `RPMS/`, `SOURCES/`, `SPECS/`, `SRPMS/`) plus a `.spec` file and a source
 * tarball referenced by that spec's `Source0:` - this function sets all of
 * that up in a throwaway temp directory, runs `rpmbuild -bb`, and moves the
 * single resulting `.rpm` (there is exactly one for this noarch,
 * no-debuginfo package) into `outputDirectory`, keeping the filename
 * `rpmbuild` itself produced (standard `<name>-<version>-<release>.<arch>.rpm`
 * NVRA convention - RPM tooling and operators expect that shape, so it is
 * deliberately not renamed to the `gulogulo-<version>-<target>` convention
 * the tarball targets use).
 */
export async function createRpmPackage(options: {
  specPath: string;
  sourceTarballPath: string;
  sourceTarballName: string;
  defines: Record<string, string>;
  outputDirectory: string;
  version: string;
  log: (message: string) => void;
}): Promise<string> {
  const { specPath, sourceTarballPath, sourceTarballName, defines, outputDirectory, version, log } = options;

  const topDir = await mkdtemp(join(tmpdir(), 'gulogulo-rpmbuild-'));
  try {
    for (const subdirectory of ['BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS']) {
      await mkdir(join(topDir, subdirectory), { recursive: true });
    }

    await cp(sourceTarballPath, join(topDir, 'SOURCES', sourceTarballName));
    const specDestination = join(topDir, 'SPECS', basename(specPath));
    await cp(specPath, specDestination);

    const defineArgs = Object.entries(defines).flatMap(([key, value]) => ['--define', `${key} ${value}`]);

    log(`Running "rpmbuild -bb" for ${specDestination}...`);
    const rpmbuildResult = spawnSync(
      'rpmbuild',
      ['--define', `_topdir ${topDir}`, ...defineArgs, '-bb', specDestination],
      { stdio: 'inherit' },
    );
    if (rpmbuildResult.error) {
      throw new Error(
        `Failed to start "rpmbuild": ${rpmbuildResult.error.message}. This build step requires an RHEL-family ` +
          'host (or container) with the rpm-build package installed - e.g. the almalinux:9 CI container this ' +
          'target runs in. It is expected to fail on Windows and on the Ubuntu/Debian hosts the other packaging ' +
          'targets build on.',
      );
    }
    if (rpmbuildResult.status !== 0) {
      throw new Error(`"rpmbuild -bb" exited with status ${rpmbuildResult.status ?? 'unknown'}.`);
    }

    const builtRpms = await findRpmFilesRecursively(join(topDir, 'RPMS'));
    if (builtRpms.length === 0) {
      throw new Error(`"rpmbuild -bb" reported success but produced no .rpm file under ${join(topDir, 'RPMS')}.`);
    }
    if (builtRpms.length > 1) {
      throw new Error(`"rpmbuild -bb" produced more than one .rpm file (expected exactly one): ${builtRpms.join(', ')}`);
    }

    await mkdir(outputDirectory, { recursive: true });
    const archivePath = join(outputDirectory, basename(builtRpms[0]));
    await cp(builtRpms[0], archivePath);

    const archiveStats = await stat(archivePath);
    log('Package build complete.');
    log(`  archive: ${archivePath}`);
    log(`  size:    ${humanFileSize(archiveStats.size)} (${archiveStats.size} bytes)`);
    log(`  version: ${version}`);

    return archivePath;
  } finally {
    await rm(topDir, { recursive: true, force: true });
  }
}
