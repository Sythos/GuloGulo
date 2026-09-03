#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Upgrades an existing Plesk-target Gulo Gulo install in place from a new
# gulogulo-<version>_plesk_.tar.gz. Run as root. Backs up the current
# install directory first (same style as the standalone target's
# upgrade.sh), then copies in the new application files while preserving
# .env and anything else not shipped by the package.
#
# This is a straight shell translation of
# packaging/plesk/debian/DEBIAN/{prerm,postinst}: `prerm upgrade` is a
# no-op (it deliberately leaves the service running), then `postinst`
# re-runs its full configure sequence unconditionally - there is no
# separate "first install only" branch in postinst, and it does not
# explicitly restart the service on an upgrade beyond its own
# `systemctl enable --now`, which is a no-op on an already-running unit.
# This script preserves that exact behavior rather than adding a restart
# step postinst itself does not have - if you want the new code running
# immediately after an upgrade, restart the service yourself:
#   systemctl restart gulogulo
#
# Usage: ./upgrade.sh <new-tarball.tar.gz> <install-dir> [--non-interactive]
# --non-interactive only suppresses interactive hints; it does not change
# what this script does, since upgrade.sh never prompts.

set -euo pipefail

SERVICE_USER="${GULOGULO_SERVICE_USER:-gulogulo}"
SERVICE_GROUP="${GULOGULO_SERVICE_GROUP:-$SERVICE_USER}"
READ_WRITE_PATH="${GULOGULO_SERVICE_READ_WRITE_PATH:-/var/lib/gulogulo}"
UNIT_PATH=/etc/systemd/system/gulogulo.service

log() { printf '[upgrade] %s\n' "$1"; }
fail() { printf '[upgrade] ERROR: %s\n' "$1" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  fail "this script must run as root (it may install/enable a systemd unit)."
fi

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

# Keep using whichever runtime this install already chose (see
# switch-runtime.sh to change it); Node.js above is always required
# regardless, since npm and the migration runner never run under bun.
RUNTIME="node"
[ -f "$INSTALL_DIR/.runtime" ] && RUNTIME="$(cat "$INSTALL_DIR/.runtime")"
command -v "$RUNTIME" >/dev/null 2>&1 || fail "$RUNTIME (this install's configured runtime, see .runtime) was not found in PATH."

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
  for entry in dist web assets src package.json package-lock.json LICENSE VERSION \
               .env.example install.sh upgrade.sh uninstall.sh run-migrations.mjs \
               gulogulo.service.template gulogulo-proxy.conf.example \
               switch-runtime.sh switch-to-node.sh switch-to-bun.sh; do
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

log "Re-rendering and re-enabling the systemd unit for $RUNTIME (postinst's own behavior, run unconditionally on every configure)..."
RUNTIME_BIN="$(command -v "$RUNTIME")"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  log "Created system user '$SERVICE_USER'."
fi
sed \
  -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@SERVICE_GROUP@#$SERVICE_GROUP#g" \
  -e "s#@RUNTIME_BIN@#$RUNTIME_BIN#g" \
  -e "s#@READ_WRITE_PATH@#$READ_WRITE_PATH#g" \
  "$INSTALL_DIR/gulogulo.service.template" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

systemctl daemon-reload
systemctl enable --now gulogulo

log "Upgrade files staged in $INSTALL_DIR."
log "Previous install backed up at: $BACKUP_PATH"
log "Note: 'systemctl enable --now' does not restart an already-running service (matches DEBIAN/postinst)."
log "Restart manually if you need the new code running immediately: systemctl restart gulogulo"
