#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Switches a standalone Gulo Gulo install between the Node.js and Bun
# runtimes. There is nothing to recompile or convert: dist/server/ is the
# same compiled JS for either runtime, this only records which interpreter
# to use and tells you what to change. Unlike the cPanel/Plesk target, this
# target never owns a systemd unit (install.sh only ever stages
# gulogulo.service.example, never installs it) - if you copied that example
# to /etc/systemd/system yourself, you must edit its ExecStart= and restart
# the service yourself; this script cannot find or touch a unit it does not
# manage.
#
# Usage: ./switch-runtime.sh <node|bun> [--non-interactive]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[switch-runtime] %s\n' "$1"; }
fail() { printf '[switch-runtime] ERROR: %s\n' "$1" >&2; exit 1; }

RUNTIME=""
for arg in "$@"; do
  case "$arg" in
    node|bun) RUNTIME="$arg" ;;
    --non-interactive) ;;
    *) fail "Unknown argument: $arg" ;;
  esac
done

[ -n "$RUNTIME" ] || fail "Usage: $0 <node|bun> [--non-interactive]"
command -v "$RUNTIME" >/dev/null 2>&1 || fail "$RUNTIME was not found in PATH. Install it first, then re-run this script."

if [ "$RUNTIME" = node ]; then
  RUNTIME_MAJOR="$("$RUNTIME" -p 'process.versions.node.split(".")[0]')"
  if [ "$RUNTIME_MAJOR" -lt 26 ]; then
    fail "Node.js >= 26 is required (found $(node -v))."
  fi
else
  log "Bun found: $(bun --version). No minimum version is enforced yet - only the version exercised by this project's own CI (see .github/workflows/bun-compat.yml) is verified; running Bun in production is VERIFY BEFORE USE."
fi

RUNTIME_BIN="$(command -v "$RUNTIME")"
cd "$SCRIPT_DIR"
printf '%s\n' "$RUNTIME" > .runtime

log "Runtime switched to $RUNTIME. Recorded in .runtime; the next upgrade.sh run will keep using it."
log "Start (or restart) the service with:"
log "  $RUNTIME_BIN --env-file=.env dist/server/src/runtime/index.js"
log "If you copied gulogulo.service.example to /etc/systemd/system/gulogulo.service"
log "yourself, edit its ExecStart= to the line above, then:"
log "  systemctl daemon-reload && systemctl restart gulogulo"
