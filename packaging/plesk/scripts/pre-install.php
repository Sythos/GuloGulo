<?php
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)
//
// Plesk extension lifecycle hook, run by Plesk itself (as root, per the
// Plesk extension mechanism) before the extension's files are activated -
// see https://docs.plesk.com/en-US/obsidian/extensions-guide/ for the
// pre-install.php contract: a non-zero exit code aborts the installation
// with this script's stderr output shown to the operator. This mirrors the
// precondition checks at the top of packaging/cpanel/scripts/install.sh,
// PHP-side: verify Node.js >= 26 and a Linux host before anything is
// unpacked/configured. No files are written and nothing is started here.

function fail(string $message): void
{
    fwrite(STDERR, "[gulogulo pre-install] ERROR: {$message}\n");
    exit(1);
}

if (PHP_OS_FAMILY !== 'Linux') {
    fail('this extension requires a Linux Plesk host (found: ' . PHP_OS_FAMILY . ').');
}

$nodeVersionOutput = shell_exec('node --version 2>&1');
if ($nodeVersionOutput === null || trim($nodeVersionOutput) === '') {
    fail('Node.js was not found in PATH. Install Node.js >= 26 before installing this extension.');
}

$nodeVersionOutput = trim($nodeVersionOutput);
if (!preg_match('/^v(\d+)\./', $nodeVersionOutput, $matches)) {
    fail("could not parse the Node.js version from '{$nodeVersionOutput}'.");
}

$nodeMajorVersion = (int) $matches[1];
if ($nodeMajorVersion < 26) {
    fail("Node.js >= 26 is required, found {$nodeVersionOutput}.");
}

fwrite(STDOUT, "[gulogulo pre-install] OK: Linux host, Node.js {$nodeVersionOutput}.\n");
exit(0);
