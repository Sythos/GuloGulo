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
 *
 * `createZipArchive` below is also shared infrastructure (used today by
 * `packaging/plesk/build-plesk-package.ts`, which needs a real ZIP container
 * with `meta.xml` at its root rather than a tarball): it is a minimal,
 * dependency-free ZIP writer built on `node:zlib`'s `deflateRawSync`/`crc32`
 * (both available in the Node >=26 this project already requires - no new
 * npm dependency needed just to produce a ZIP).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

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
 * `.tar.gz`/`.zip` package currently sitting in `outputDirectory` (not just
 * the package a given build script just produced - every prior package left
 * over from earlier runs too). Reuses each package's own `<archive>.sha256`
 * sidecar (written by `writeChecksumFile`) when present instead of re-hashing
 * the archive; falls back to computing it if the sidecar is missing. Lines
 * are sorted by filename, one per archive, so re-running a build that
 * replaces an existing archive updates its line in place rather than
 * duplicating it.
 */
export async function updateChecksumsAggregate(outputDirectory: string): Promise<string> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const archiveNames = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.tar.gz') || entry.name.endsWith('.zip')))
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

interface ZipFileEntry {
  archivePath: string;
  content: Buffer;
}

async function collectFilesRecursively(root: string, currentDir: string, out: ZipFileEntry[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  // Sort for deterministic archive contents regardless of filesystem order.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFilesRecursively(root, absolutePath, out);
    } else if (entry.isFile()) {
      const content = await readFile(absolutePath);
      const archivePath = relative(root, absolutePath).split('\\').join('/');
      out.push({ archivePath, content });
    }
    // Symlinks and other special files are not expected in staged packaging
    // output and are intentionally skipped.
  }
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

// Regular file, permission bits 0644, stored in a ZIP central directory
// entry's "external file attributes" the way Unix-aware tools (and Plesk's
// own extractor) expect: (unix mode << 16).
const ZIP_UNIX_FILE_EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;

/**
 * Creates a real ZIP archive (local file headers + central directory + end
 * of central directory record - the format Plesk's extension installer
 * requires) from every file under `sourceRoot`, with archive-relative paths
 * matching each file's path relative to `sourceRoot`. Deflates each entry
 * with `zlib.deflateRawSync`, falling back to "stored" (uncompressed) if
 * deflating did not actually shrink the file. No external `zip` binary and
 * no npm dependency - pure `node:zlib` + `node:buffer`.
 */
export async function createZipArchive(options: {
  sourceRoot: string;
  archivePath: string;
  log: (message: string) => void;
}): Promise<string> {
  const { sourceRoot, archivePath, log } = options;

  log(`Collecting files under ${sourceRoot} for the ZIP archive...`);
  const files: ZipFileEntry[] = [];
  await collectFilesRecursively(sourceRoot, sourceRoot, files);

  const { dosTime, dosDate } = toDosDateTime(new Date());
  const UTF8_NAMES_FLAG = 0x0800;

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.archivePath, 'utf8');
    const crc = crc32(file.content) >>> 0;
    const deflated = deflateRawSync(file.content);
    const useDeflate = deflated.length < file.content.length;
    const method = useDeflate ? 8 : 0;
    const storedContent = useDeflate ? deflated : file.content;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(UTF8_NAMES_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(storedContent.length, 18);
    localHeader.writeUInt32LE(file.content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuffer, storedContent);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix host, version 20
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(UTF8_NAMES_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(storedContent.length, 20);
    centralHeader.writeUInt32LE(file.content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(ZIP_UNIX_FILE_EXTERNAL_ATTRS, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + storedContent.length;
  }

  const centralDirectorySize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const centralDirectoryOffset = offset;

  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4); // disk number
  endOfCentralDirectory.writeUInt16LE(0, 6); // disk with central directory
  endOfCentralDirectory.writeUInt16LE(files.length, 8);
  endOfCentralDirectory.writeUInt16LE(files.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20); // comment length

  const archiveBuffer = Buffer.concat([...localChunks, ...centralChunks, endOfCentralDirectory]);

  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archiveBuffer);

  const archiveStats = await stat(archivePath);
  log('Package build complete.');
  log(`  archive: ${archivePath}`);
  log(`  size:    ${humanFileSize(archiveStats.size)} (${archiveStats.size} bytes)`);
  log(`  entries: ${files.length}`);

  return archivePath;
}
