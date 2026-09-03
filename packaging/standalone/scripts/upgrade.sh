#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Upgrades an existing standalone Gulo Gulo install in place from a new
# gulogulo-<version>-standalone.tar.gz. Backs up the current install
# directory first, then copies in the new application files while
# preserving .env and anything else not shipped by the package (external
# data such as the PostgreSQL database, LDAP directory, and mailbox storage
# all live outside the install directory and are never touched here).
# Migrations run automatically; restarting the service is left to the
# operator's own process manager (systemd/pm2/etc.), never forced here.
#
# Usage: ./upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive]
# --non-interactive only suppresses interactive hints; it does not change
# what this script does, since upgrade.sh never prompts.

set -euo pipefail

log() { printf '[upgrade] %s\n' "$1"; }
fail() { printf '[upgrade] ERROR: %s\n' "$1" >&2; exit 1; }

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --non-interactive) ;;
    *) ARGS+=("$arg") ;;
  esac
done

if [ "${#ARGS[@]}" -ne 2 ]; then
  fail "Usage: $0 <new-tarball.tar.gz> <install-dir> [--non-interactive]"
fi

NEW_TARBALL="${ARGS[0]}"
INSTALL_DIR="${ARGS[1]%/}"

[ -f "$NEW_TARBALL" ] || fail "tarball not found: $NEW_TARBALL"
[ -d "$INSTALL_DIR" ] || fail "install directory not found: $INSTALL_DIR"
command -v node >/dev/null 2>&1 || fail "Node.js is required but was not found in PATH."
command -v tar >/dev/null 2>&1 || fail "tar is required but was not found in PATH."

TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_PATH="${INSTALL_DIR}.backup-${TIMESTAMP}.tar.gz"

log "Backing up current install to $BACKUP_PATH"
tar --force-local -czf "$BACKUP_PATH" -C "$(dirname "$INSTALL_DIR")" "$(basename "$INSTALL_DIR")"

EXTRACT_DIR="$(mktemp -d)"
trap 'rm -rf "$EXTRACT_DIR"' EXIT

log "Extracting new package to $EXTRACT_DIR"
tar --force-local -xzf "$NEW_TARBALL" -C "$EXTRACT_DIR" --strip-components=1

log "Copying application files, preserving .env, .runtime, and any other local files"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude '.env' --exclude '.runtime' --exclude 'node_modules' "$EXTRACT_DIR"/ "$INSTALL_DIR"/
else
  # No rsync available: replace only the directories/files the package ships.
  for entry in dist web assets src package.json package-lock.json LICENSE VERSION \
               .env.example install.sh upgrade.sh uninstall.sh run-migrations.mjs \
               gulogulo.service.example switch-runtime.sh switch-to-node.sh switch-to-bun.sh; do
    [ -e "$EXTRACT_DIR/$entry" ] || continue
    rm -rf "${INSTALL_DIR:?}/${entry}"
    cp -r "$EXTRACT_DIR/$entry" "$INSTALL_DIR/$entry"
  done
fi
chmod +x "$INSTALL_DIR"/install.sh "$INSTALL_DIR"/upgrade.sh "$INSTALL_DIR"/uninstall.sh "$INSTALL_DIR"/run-migrations.mjs \
  "$INSTALL_DIR"/switch-runtime.sh "$INSTALL_DIR"/switch-to-node.sh "$INSTALL_DIR"/switch-to-bun.sh

cd "$INSTALL_DIR"
log "Installing production dependencies (npm ci --omit=dev)..."
npm ci --omit=dev --no-audit --no-fund

log "Applying database migrations..."
node --env-file=.env "$INSTALL_DIR/run-migrations.mjs"

RUNTIME="node"
[ -f "$INSTALL_DIR/.runtime" ] && RUNTIME="$(cat "$INSTALL_DIR/.runtime")"

log "Upgrade files staged in $INSTALL_DIR."
log "Restart the service to run the new version under $RUNTIME (unchanged from before this upgrade;"
log "run ./switch-to-node.sh or ./switch-to-bun.sh first if you want to change it), e.g.:"
log "  systemctl restart gulogulo   # if managed by systemd"
log "  pm2 restart gulogulo         # if managed by pm2"
log "This script never restarts the process itself."
log "Previous install backed up at: $BACKUP_PATH"
