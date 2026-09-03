<?php
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)
//
// Plesk extension lifecycle hook, run by Plesk itself (as root) right after
// the extension's files are unpacked into its plib/ directory. Same
// high-level steps as packaging/cpanel/scripts/install.sh, just driven from
// PHP instead of bash, and with no interactive prompts: this script always
// runs with root privileges by construction of the Plesk extension
// mechanism, so there is no non-interactive/--yes distinction to make the
// way install.sh has one. It still follows the same caution as every other
// packaging target in this project: it installs and starts a real systemd
// service, but it NEVER touches Plesk's actual nginx/Apache configuration -
// it only writes a reviewable example file, because editing a domain's live
// web server config without explicit operator review is too risky to do
// automatically (see gulogulo-proxy.conf.example for why, and how to apply
// it manually).
//
// Layout this script expects (produced by build-plesk-package.ts):
//   plib/scripts/post-install.php   <- this file (__DIR__)
//   plib/app/                       <- the staged application (dist/, web/,
//                                      migrations, package.json, .env.example,
//                                      run-migrations.mjs, the systemd unit
//                                      template, this proxy example, ...)

$appDir = dirname(__DIR__) . '/app';

function log_line(string $message): void
{
    fwrite(STDOUT, "[gulogulo post-install] {$message}\n");
}

function fail(string $message): void
{
    fwrite(STDERR, "[gulogulo post-install] ERROR: {$message}\n");
    exit(1);
}

/**
 * Runs a shell command from $appDir, streaming its combined output and
 * returning its exit code. Every command this script runs is a fixed,
 * hardcoded string (no operator-controlled input is ever interpolated into
 * a shell command), so there is no injection surface here.
 */
function run(string $appDir, string $command): int
{
    $fullCommand = 'cd ' . escapeshellarg($appDir) . ' && ' . $command . ' 2>&1';
    $output = [];
    $exitCode = 0;
    exec($fullCommand, $output, $exitCode);
    foreach ($output as $line) {
        fwrite(STDOUT, "  {$line}\n");
    }
    return $exitCode;
}

if (!is_dir($appDir)) {
    fail("expected staged application directory at {$appDir}, not found.");
}

// --- Configuration -------------------------------------------------------

$envPath = $appDir . '/.env';
$envExamplePath = $appDir . '/.env.example';
if (!file_exists($envPath)) {
    if (!file_exists($envExamplePath) || !copy($envExamplePath, $envPath)) {
        fail("could not create {$envPath} from .env.example.");
    }
    log_line('.env created from .env.example - review and edit it before the service is used.');
    log_line('In particular set the PostgreSQL POSTGRES_* variables for the existing database this install will use.');
} else {
    log_line('.env already exists; leaving it untouched.');
}

$port = '8080';
$envContents = file_get_contents($envPath);
if ($envContents !== false && preg_match('/^PORT=(\S*)$/m', $envContents, $matches) && $matches[1] !== '') {
    $port = $matches[1];
}

// --- Application dependencies and database migrations --------------------

log_line('Installing production dependencies (npm ci --omit=dev)...');
if (run($appDir, 'npm ci --omit=dev --no-audit --no-fund') !== 0) {
    fail('npm ci --omit=dev failed; see output above.');
}

log_line('Applying database migrations (skipped automatically while Postgres is disabled)...');
if (run($appDir, 'node --env-file=.env run-migrations.mjs') !== 0) {
    fail('database migrations failed; see output above.');
}

// --- systemd service -------------------------------------------------------

$serviceUser = getenv('GULOGULO_SERVICE_USER') ?: 'gulogulo';
$serviceGroup = getenv('GULOGULO_SERVICE_GROUP') ?: $serviceUser;
$readWritePath = getenv('GULOGULO_SERVICE_READ_WRITE_PATH') ?: '/var/lib/gulogulo';
$unitPath = '/etc/systemd/system/gulogulo.service';
$templatePath = $appDir . '/gulogulo.service.template';

$nodeBin = trim((string) shell_exec('command -v node'));
if ($nodeBin === '') {
    fail('Node.js binary not found in PATH (pre-install.php should have caught this already).');
}

$template = file_get_contents($templatePath);
if ($template === false) {
    fail("systemd unit template not found at {$templatePath}.");
}

$renderedUnit = strtr($template, [
    '@INSTALL_DIR@' => $appDir,
    '@SERVICE_USER@' => $serviceUser,
    '@SERVICE_GROUP@' => $serviceGroup,
    '@NODE_BIN@' => $nodeBin,
    '@READ_WRITE_PATH@' => $readWritePath,
]);

exec('id ' . escapeshellarg($serviceUser) . ' >/dev/null 2>&1', $idOutput, $idExitCode);
if ($idExitCode !== 0) {
    exec('useradd --system --no-create-home --shell /usr/sbin/nologin ' . escapeshellarg($serviceUser) . ' 2>&1', $useraddOutput, $useraddExitCode);
    if ($useraddExitCode !== 0) {
        fail('failed to create system user ' . $serviceUser . ': ' . implode(' ', $useraddOutput));
    }
    log_line("Created system user '{$serviceUser}'.");
} else {
    log_line("System user '{$serviceUser}' already exists.");
}

if (file_put_contents($unitPath, $renderedUnit) === false) {
    fail("could not write systemd unit to {$unitPath}.");
}
chmod($unitPath, 0644);

exec('systemctl daemon-reload 2>&1', $reloadOutput, $reloadExitCode);
if ($reloadExitCode !== 0) {
    fail('systemctl daemon-reload failed: ' . implode(' ', $reloadOutput));
}

exec('systemctl enable --now gulogulo 2>&1', $enableOutput, $enableExitCode);
if ($enableExitCode !== 0) {
    fail('systemctl enable --now gulogulo failed: ' . implode(' ', $enableOutput));
}
log_line("systemd service installed, enabled, and started ({$unitPath}).");

// --- nginx reverse proxy (never touches the real domain config) ----------

$proxyExamplePath = $appDir . '/gulogulo-proxy.conf.example';
if (file_exists($proxyExamplePath) && $port !== '8080') {
    $proxyContents = file_get_contents($proxyExamplePath);
    if ($proxyContents !== false) {
        $rewritten = str_replace('127.0.0.1:8080', "127.0.0.1:{$port}", $proxyContents);
        file_put_contents($proxyExamplePath, $rewritten);
        log_line("Rewrote the upstream port in gulogulo-proxy.conf.example to match PORT={$port} from .env.");
    }
}
log_line("nginx reverse proxy example: {$proxyExamplePath}");
log_line('This file is never applied automatically - see the instructions inside it');
log_line('(Plesk > Websites & Domains > <domain> > Apache & nginx Settings > "Additional nginx directives").');

log_line('Install complete.');
exit(0);
