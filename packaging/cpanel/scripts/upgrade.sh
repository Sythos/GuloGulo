#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Upgrades an existing cPanel/WHM Gulo Gulo install in place from a new
# gulogulo-<version>-cpanel.tar.gz. Backs up the current install directory
# first, then copies in the new application files while preserving .env,
# the rendered systemd unit review copy, and the Apache/AppConfig example
# files if the operator edited them in place. External data (PostgreSQL
# database, mailbox storage) lives outside the install directory and is
# never touched here.
#
# Unlike the standalone target, this script DOES restart the service
# automatically: gulogulo is a dedicated systemd unit this package itself
# installs and manages, not a process the operator might be running under
# their own supervisor.
#
# Usage: ./upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive] [--dry-run]
#   --dry-run  runs the backup/extract/copy/npm ci/migrations as normal
#              (all reversible via the backup just taken and none of them
#              touch host system config) but skips the final
#              `systemctl restart gulogulo`, printing what would run
#              instead. Also enabled via GULOGULO_DRY_RUN=1.
#   --non-interactive  accepted for consistency with install.sh/uninstall.sh;
#              this script never prompts either way.

set -euo pipefail

DRY_RUN="${GULOGULO_DRY_RUN:-0}"

log() { printf '[upgrade] %s\n' "$1"; }
fail() { printf '[upgrade] ERROR: %s\n' "$1" >&2; exit 1; }

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --non-interactive) ;;
    --dry-run) DRY_RUN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

if [ "${#ARGS[@]}" -ne 2 ]; then
  fail "Usage: $0 <new-tarball.tar.gz> <install-dir> [--non-interactive] [--dry-run]"
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

log "Copying application files, preserving .env and any other local files"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude '.env' --exclude 'node_modules' --exclude 'gulogulo.service.rendered' \
    "$EXTRACT_DIR"/ "$INSTALL_DIR"/
else
  # No rsync available: replace only the directories/files the package ships.
  for entry in dist web assets src package.json package-lock.json LICENSE VERSION \
               .env.example install.sh upgrade.sh uninstall.sh run-migrations.mjs \
               gulogulo.service.template gulogulo-proxy.conf.example gulogulo-appconfig.conf.example; do
    [ -e "$EXTRACT_DIR/$entry" ] || continue
    rm -rf "${INSTALL_DIR:?}/${entry}"
    cp -r "$EXTRACT_DIR/$entry" "$INSTALL_DIR/$entry"
  done
fi
chmod +x "$INSTALL_DIR"/install.sh "$INSTALL_DIR"/upgrade.sh "$INSTALL_DIR"/uninstall.sh "$INSTALL_DIR"/run-migrations.mjs

cd "$INSTALL_DIR"
log "Installing production dependencies (npm ci --omit=dev)..."
npm ci --omit=dev --no-audit --no-fund

log "Applying database migrations..."
node --env-file=.env "$INSTALL_DIR/run-migrations.mjs"

if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] would run: systemctl restart gulogulo"
else
  log "Restarting the gulogulo systemd service..."
  systemctl restart gulogulo
  log "Service restarted."
fi

log "Upgrade complete in $INSTALL_DIR."
log "Previous install backed up at: $BACKUP_PATH"
