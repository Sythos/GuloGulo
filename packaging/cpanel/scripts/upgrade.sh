#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Upgrades an existing cPanel/WHM Gulo Gulo install in place from a new
# gulogulo-<version>_cpanel_.tar.gz. Run as root. Backs up the current
# install directory first (same style as the standalone target's
# upgrade.sh), then copies in the new application files while preserving
# .env and anything else not shipped by the package.
#
# This is a straight shell translation of packaging/cpanel/gulogulo.spec's
# %post scriptlet's upgrade branch ($1 >= 2: rpm's own upgrade transaction
# calling %post again) - see that file for the RPM-native equivalent. Unlike
# %post, which rpm re-invokes automatically as part of `rpm -Uvh`, this
# script must be run explicitly, same as the standalone target's upgrade.sh.
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
  fail "this script must run as root (it restarts a systemd unit and may touch .env ownership)."
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
               gulogulo.service.template gulogulo-proxy.conf.example gulogulo-appconfig.conf.example \
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

log "Re-rendering the systemd unit for $RUNTIME (paths/user are re-applied on every upgrade, same as a fresh install)..."
RUNTIME_BIN="$(command -v "$RUNTIME")"
sed \
  -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@SERVICE_GROUP@#$SERVICE_GROUP#g" \
  -e "s#@RUNTIME_BIN@#$RUNTIME_BIN#g" \
  -e "s#@READ_WRITE_PATH@#$READ_WRITE_PATH#g" \
  "$INSTALL_DIR/gulogulo.service.template" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

systemctl daemon-reload
# Matches gulogulo.spec's %post upgrade branch ($1 >= 2): gulogulo is a
# dedicated systemd unit this package itself manages, not a process the
# operator runs under their own supervisor, so restart automatically to
# pick up the new code. Deliberately does not re-run `systemctl enable` -
# an operator who disabled the unit between versions stays disabled.
if systemctl is-enabled gulogulo >/dev/null 2>&1; then
  log "Upgrade detected - restarting the gulogulo systemd service..."
  systemctl restart gulogulo
  log "Service restarted."
else
  log "gulogulo.service is not enabled; not starting it automatically. Run 'systemctl enable --now gulogulo' when ready."
fi

log "Upgrade files staged in $INSTALL_DIR."
log "Previous install backed up at: $BACKUP_PATH"
