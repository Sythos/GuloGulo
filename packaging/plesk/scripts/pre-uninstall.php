<?php
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)
//
// Plesk extension lifecycle hook, run by Plesk itself (as root) before the
// extension is removed. Stops/disables the systemd service and clears the
// bulky generated application files (node_modules/, dist/, web/dist/) the
// same way packaging/cpanel/scripts/uninstall.sh does for its own install
// directory. It never touches external data (PostgreSQL database, mailbox
// storage) - none of that lives under the extension's plib/ tree - and it
// never deletes .env by default.
//
// IMPORTANT, Plesk-specific caveat with no cPanel/standalone equivalent:
// once this script returns successfully, Plesk deletes the extension's
// entire plib/ directory itself (including plib/app/, and therefore .env
// inside it) as part of removing the extension package. This has not been
// verified against a real Plesk host (no test instance was available for
// this task) and should be confirmed before relying on it - if Plesk does
// NOT delete plib/app/.env on its own, this script's default "leave .env in
// place" behavior below would actually leave it behind, which is the safer
// of the two possible outcomes either way. If Plesk DOES always delete it
// regardless of what this script does, back up .env yourself before
// uninstalling if you want to keep it - this script cannot prevent that.

$appDir = dirname(__DIR__) . '/app';

function log_line(string $message): void
{
    fwrite(STDOUT, "[gulogulo pre-uninstall] {$message}\n");
}

log_line("Removing the Gulo Gulo Plesk install in: {$appDir}");
log_line('This never deletes external data (PostgreSQL database, mailbox storage)');
log_line('and never touches nginx/Apache configuration or Plesk domain settings.');

// --- systemd service -------------------------------------------------------

exec('systemctl list-unit-files gulogulo.service >/dev/null 2>&1', $listOutput, $listExitCode);
if ($listExitCode === 0) {
    exec('systemctl disable --now gulogulo 2>&1', $disableOutput, $disableExitCode);
    if ($disableExitCode === 0) {
        log_line('Service stopped and disabled.');
    } else {
        log_line('WARNING: systemctl disable --now gulogulo failed: ' . implode(' ', $disableOutput));
    }

    $unitPath = '/etc/systemd/system/gulogulo.service';
    if (file_exists($unitPath) && @unlink($unitPath)) {
        exec('systemctl daemon-reload 2>&1');
        log_line('Unit file removed.');
    }
} else {
    log_line('No gulogulo systemd unit found - nothing to stop/disable.');
}

// --- generated application files (never .env, never external data) ------

function remove_path(string $path): void
{
    if (!file_exists($path) && !is_link($path)) {
        return;
    }
    exec('rm -rf ' . escapeshellarg($path) . ' 2>&1', $output, $exitCode);
    if ($exitCode !== 0) {
        log_line('WARNING: failed to remove ' . $path . ': ' . implode(' ', $output));
    }
}

foreach (['node_modules', 'dist', 'web/dist'] as $relativePath) {
    remove_path($appDir . '/' . $relativePath);
}
log_line('Generated build/dependency directories removed (node_modules/, dist/, web/dist/).');
log_line('Remaining application files (including .env, if present) are left in place -');
log_line('Plesk removes the rest of the extension directory itself once this script exits 0.');

// --- .env: only removed on an explicit, deliberate opt-in ------------------

$envPath = $appDir . '/.env';
if (file_exists($envPath)) {
    if (getenv('GULOGULO_PLESK_PURGE_ENV') === '1') {
        @unlink($envPath);
        log_line('.env removed (GULOGULO_PLESK_PURGE_ENV=1 was set).');
    } else {
        log_line("NOTE: {$envPath} was left in place. Back it up now if you want to keep its");
        log_line('contents (POSTGRES_* connection details, etc.) - Plesk may remove it together');
        log_line('with the rest of the extension directory once this script returns. Set');
        log_line('GULOGULO_PLESK_PURGE_ENV=1 in the environment before uninstalling to have this');
        log_line('script delete it explicitly instead.');
    }
}

log_line('External PostgreSQL database and mailbox storage were not touched and');
log_line('must be removed separately if that is what you want.');
log_line('Reminder (never done automatically by this script):');
log_line('  - remove the nginx directives you added from gulogulo-proxy.conf.example');
log_line('    (Plesk > Websites & Domains > <domain> > Apache & nginx Settings).');

exit(0);
