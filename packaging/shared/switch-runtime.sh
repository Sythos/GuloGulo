#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Switches an installed Gulo Gulo service between the Node.js and Bun
# runtimes. Shared by the cPanel and Plesk targets, which both render the
# same gulogulo.service.template (see install.sh/upgrade.sh in each). There
# is nothing to recompile or convert: dist/server/ is the same compiled JS
# for either runtime, this script only changes which interpreter executes
# it and re-renders/restarts the systemd unit accordingly.
#
# Usage: ./switch-runtime.sh <node|bun> [install-dir] [--non-interactive]
# install-dir defaults to this script's own directory (run it from inside
# an installed instance, same as upgrade.sh/uninstall.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${GULOGULO_SERVICE_USER:-gulogulo}"
SERVICE_GROUP="${GULOGULO_SERVICE_GROUP:-$SERVICE_USER}"
READ_WRITE_PATH="${GULOGULO_SERVICE_READ_WRITE_PATH:-/var/lib/gulogulo}"
UNIT_PATH=/etc/systemd/system/gulogulo.service

log() { printf '[switch-runtime] %s\n' "$1"; }
fail() { printf '[switch-runtime] ERROR: %s\n' "$1" >&2; exit 1; }

RUNTIME=""
INSTALL_DIR="$SCRIPT_DIR"
for arg in "$@"; do
  case "$arg" in
    node|bun) RUNTIME="$arg" ;;
    --non-interactive) ;;
    *) INSTALL_DIR="${arg%/}" ;;
  esac
done

[ -n "$RUNTIME" ] || fail "Usage: $0 <node|bun> [install-dir] [--non-interactive]"
[ -d "$INSTALL_DIR" ] || fail "install directory not found: $INSTALL_DIR"
[ -f "$INSTALL_DIR/gulogulo.service.template" ] || fail "$INSTALL_DIR does not look like a Gulo Gulo cPanel/Plesk install (gulogulo.service.template not found)."

if [ "$(id -u)" -ne 0 ]; then
  fail "this script must run as root (it re-renders and restarts a systemd unit)."
fi

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
CURRENT_RUNTIME="node"
[ -f "$INSTALL_DIR/.runtime" ] && CURRENT_RUNTIME="$(cat "$INSTALL_DIR/.runtime")"

if [ "$CURRENT_RUNTIME" = "$RUNTIME" ]; then
  log "Already running under $RUNTIME ($RUNTIME_BIN); re-rendering and restarting anyway in case the binary path changed."
fi

printf '%s\n' "$RUNTIME" > "$INSTALL_DIR/.runtime"

log "Re-rendering the systemd unit for $RUNTIME ($RUNTIME_BIN)..."
sed \
  -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@SERVICE_GROUP@#$SERVICE_GROUP#g" \
  -e "s#@RUNTIME_BIN@#$RUNTIME_BIN#g" \
  -e "s#@READ_WRITE_PATH@#$READ_WRITE_PATH#g" \
  "$INSTALL_DIR/gulogulo.service.template" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

systemctl daemon-reload
if systemctl is-enabled gulogulo >/dev/null 2>&1; then
  log "Restarting gulogulo under $RUNTIME..."
  systemctl restart gulogulo
  log "Service restarted under $RUNTIME."
else
  log "gulogulo.service is not enabled; not starting it automatically. Run 'systemctl enable --now gulogulo' when ready."
fi

log "Runtime switched to $RUNTIME. Recorded in $INSTALL_DIR/.runtime; the next upgrade.sh run will keep using it."
