#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Gulo Gulo Plesk installer. Run as root from inside an extracted
# gulogulo-<version>_plesk_.tar.gz on a Debian/Ubuntu host (Plesk itself is
# not required to be installed for this script to work).
#
# This is a straight shell translation of
# packaging/plesk/debian/DEBIAN/postinst - that maintainer script is the
# source of truth this mirrors; see it for the dpkg-native equivalent of
# every step below. It exists because this target currently ships as a
# tar.gz rather than a real .deb (see build-plesk-package.ts's top-of-file
# comment: no code-signing key for DEB yet) - the DEBIAN/ maintainer scripts
# are untouched and still build a working .deb if invoked directly.
#
# Usage: ./install.sh [--non-interactive]
# Non-interactive mode is also enabled via GULOGULO_NON_INTERACTIVE=1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE="${GULOGULO_NON_INTERACTIVE:-0}"
SERVICE_USER="${GULOGULO_SERVICE_USER:-gulogulo}"
SERVICE_GROUP="${GULOGULO_SERVICE_GROUP:-$SERVICE_USER}"
READ_WRITE_PATH="${GULOGULO_SERVICE_READ_WRITE_PATH:-/var/lib/gulogulo}"
UNIT_PATH=/etc/systemd/system/gulogulo.service

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    *) echo "[install] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '[install] %s\n' "$1"; }
fail() { printf '[install] ERROR: %s\n' "$1" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  fail "this script must run as root (it creates a system user and installs a systemd unit)."
fi

# --- Preconditions, same check as DEBIAN/postinst ------------------------

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found in PATH. Install Node.js >= 26 (see INSTALL.md) before running this script."
fi
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  fail "Node.js >= 26 is required, found $NODE_VERSION."
fi
log "OK: Node.js $NODE_VERSION."

cd "$SCRIPT_DIR"

# --- Configuration --------------------------------------------------------

if [ ! -f .env ]; then
  if [ ! -f .env.example ] || ! cp .env.example .env; then
    fail "could not create .env from .env.example."
  fi
  log ".env created from .env.example - review and edit it before the service is used."
  log "In particular set the PostgreSQL POSTGRES_* variables for the existing database this install will use."
else
  log ".env already exists; leaving it untouched."
fi

PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2-)"
PORT="${PORT:-8080}"

# --- Application dependencies and database migrations ---------------------

log "Installing production dependencies (npm ci --omit=dev)..."
if ! npm ci --omit=dev --no-audit --no-fund; then
  fail "npm ci --omit=dev failed; see output above."
fi

log "Applying database migrations (skipped automatically while Postgres is disabled)..."
if ! node --env-file=.env "$SCRIPT_DIR/run-migrations.mjs"; then
  fail "database migrations failed; see output above."
fi

# --- systemd service --------------------------------------------------------

NODE_BIN="$(command -v node)"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  log "Created system user '$SERVICE_USER'."
else
  log "System user '$SERVICE_USER' already exists."
fi

sed \
  -e "s#@INSTALL_DIR@#$SCRIPT_DIR#g" \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@SERVICE_GROUP@#$SERVICE_GROUP#g" \
  -e "s#@NODE_BIN@#$NODE_BIN#g" \
  -e "s#@READ_WRITE_PATH@#$READ_WRITE_PATH#g" \
  "$SCRIPT_DIR/gulogulo.service.template" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

systemctl daemon-reload
systemctl enable --now gulogulo
log "systemd service installed, enabled, and started ($UNIT_PATH)."

# --- nginx reverse proxy (never touches the real domain config) -------------

PROXY_EXAMPLE="$SCRIPT_DIR/gulogulo-proxy.conf.example"
if [ -f "$PROXY_EXAMPLE" ] && [ "$PORT" != "8080" ]; then
  sed -i "s#127\\.0\\.0\\.1:8080#127.0.0.1:${PORT}#g" "$PROXY_EXAMPLE"
  log "Rewrote the upstream port in gulogulo-proxy.conf.example to match PORT=$PORT from .env."
fi
log "nginx reverse proxy example: $PROXY_EXAMPLE"
log "This file is never applied automatically - see the instructions inside it."

log "Install complete."

if [ "$NON_INTERACTIVE" != "1" ]; then
  log "Review .env before relying on this install in production."
fi
