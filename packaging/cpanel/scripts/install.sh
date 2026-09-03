#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Gulo Gulo cPanel/WHM installer. Run as root from inside an extracted
# gulogulo-<version>_cpanel_.tar.gz on a RHEL-family host (AlmaLinux/
# CloudLinux/RHEL) with cPanel & WHM installed.
#
# This is a straight shell translation of packaging/cpanel/gulogulo.spec's
# %pre and %post scriptlets (first-install branch) - that spec file is the
# source of truth this script mirrors; see it for the RPM-native equivalent
# of every step below. It exists because this target currently ships as a
# tar.gz rather than a real .rpm (see build-cpanel-package.ts's top-of-file
# comment: no code-signing key for RPM yet) - `gulogulo.spec` itself is
# untouched and still builds a working RPM if invoked directly.
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

# --- Preconditions, same check as gulogulo.spec's %post -----------------

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found in PATH. Install Node.js >= 26 first, e.g. via the NodeSource RPM repo:
  curl -fsSL https://rpm.nodesource.com/setup_26.x | bash -
  dnf install -y nodejs
then re-run this script."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  fail "Node.js >= 26 is required (found $(node -v))."
fi

cd "$SCRIPT_DIR"

# --- %pre equivalent: dedicated system user/group -----------------------

getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
getent passwd "$SERVICE_USER" >/dev/null || useradd --system --no-create-home \
  --shell /sbin/nologin --gid "$SERVICE_GROUP" \
  --comment "Gulo Gulo groupware service account" "$SERVICE_USER"

# --- %post equivalent: .env, dependencies, migrations --------------------

if [ ! -f .env ]; then
  cp .env.example .env
  # Unlike the standalone target, this host is definitionally full of other,
  # untrusted shell users (cPanel accounts) - lock .env down to the service
  # user/group only, same as %post does.
  chown "root:${SERVICE_GROUP}" .env
  chmod 0640 .env
  log ".env created from .env.example (mode 0640, root:${SERVICE_GROUP}) - review and edit it before starting the service."
  log "In particular set CPANEL_API_* for the UAPI identity adapter and POSTGRES_* for an existing PostgreSQL database."
else
  log ".env already exists; leaving it untouched."
fi

log "Installing production dependencies (npm ci --omit=dev)..."
npm ci --omit=dev --no-audit --no-fund

log "Applying database migrations (skipped cleanly while POSTGRES_ENABLED=false)..."
node --env-file=.env "$SCRIPT_DIR/run-migrations.mjs"

mkdir -p "$READ_WRITE_PATH"
chown "${SERVICE_USER}:${SERVICE_GROUP}" "$READ_WRITE_PATH"
chmod 0750 "$READ_WRITE_PATH"

# --- systemd unit: render the shared template and install it ------------

NODE_BIN="$(command -v node)"
sed \
  -e "s#@INSTALL_DIR@#$SCRIPT_DIR#g" \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@SERVICE_GROUP@#$SERVICE_GROUP#g" \
  -e "s#@NODE_BIN@#$NODE_BIN#g" \
  -e "s#@READ_WRITE_PATH@#$READ_WRITE_PATH#g" \
  "$SCRIPT_DIR/gulogulo.service.template" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

systemctl daemon-reload
# Matches gulogulo.spec's %post first-install branch: enable but do not
# start - the operator must review .env first.
systemctl enable gulogulo
log "systemd service installed and enabled (not started, $UNIT_PATH). Review .env, then run:"
log "  systemctl start gulogulo"

log "Apache reverse proxy (never applied automatically): $SCRIPT_DIR/gulogulo-proxy.conf.example"
log "  apply it via WHM > Service Configuration > Apache Configuration > Include Editor, or a userdata"
log "  hook, then /scripts/rebuildhttpdconf && systemctl restart httpd."
log "Optional WHM AppConfig registration (never applied automatically): $SCRIPT_DIR/gulogulo-appconfig.conf.example"

if [ "$NON_INTERACTIVE" != "1" ]; then
  log "Review .env before starting the service in production."
fi
