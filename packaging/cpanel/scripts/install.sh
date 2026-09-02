#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Gulo Gulo cPanel/WHM installer. Must run as root on a real cPanel/WHM
# server, from inside an extracted gulogulo-<version>-cpanel.tar.gz. Unlike
# the standalone target, this installer REALLY installs and starts a
# systemd service (cPanel Application Manager/Passenger cannot host a
# standalone-port Node process the way Gulo Gulo needs one), and writes
# ready-to-review Apache reverse proxy / WHM AppConfig examples - it never
# touches cPanel's real Apache configuration or runs register_appconfig
# itself.
#
# Usage: ./install.sh [--non-interactive] [--dry-run] [--yes]
#   --non-interactive  no prompts; irreversible system actions (writing the
#                       systemd unit, systemctl enable --now, creating the
#                       system user) are skipped unless --yes is also given.
#                       Also enabled via GULOGULO_NON_INTERACTIVE=1.
#   --dry-run           never touch systemd/Apache/the system user, no
#                       matter what else is passed; print what would happen
#                       instead. Intended for CI, where the runner is not a
#                       real cPanel host. Also enabled via GULOGULO_DRY_RUN=1.
#   --yes               combined with --non-interactive, actually perform
#                       the irreversible system actions without prompting
#                       (for scripted real deployments). Ignored under
#                       --dry-run. Also enabled via GULOGULO_ASSUME_YES=1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE="${GULOGULO_NON_INTERACTIVE:-0}"
DRY_RUN="${GULOGULO_DRY_RUN:-0}"
ASSUME_YES="${GULOGULO_ASSUME_YES:-0}"

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "[install] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '[install] %s\n' "$1"; }
warn() { printf '[install] WARNING: %s\n' "$1" >&2; }
fail() { printf '[install] ERROR: %s\n' "$1" >&2; exit 1; }

# Returns 0 (do it) if the caller should perform an irreversible system
# action, 1 (skip it) otherwise. --dry-run always wins (never do it, but
# still explain what would have run). Otherwise: interactive mode prompts;
# non-interactive mode requires --yes/GULOGULO_ASSUME_YES.
confirm_system_action() {
  local prompt="$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] would ask/perform: $prompt"
    return 1
  fi
  if [ "$NON_INTERACTIVE" = "1" ]; then
    if [ "$ASSUME_YES" = "1" ]; then
      return 0
    fi
    log "Non-interactive mode without --yes: skipping '$prompt'"
    return 1
  fi
  read -r -p "$prompt [y/N] " reply
  case "$reply" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Preconditions ----------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
  if [ "$DRY_RUN" = "1" ]; then
    warn "not running as root; continuing only because --dry-run was given. A real install must run as root."
  else
    fail "this installer must be run as root on the target cPanel/WHM server."
  fi
fi

if [ ! -d /usr/local/cpanel ]; then
  if [ "$DRY_RUN" = "1" ]; then
    warn "/usr/local/cpanel not found; continuing only because --dry-run was given (expected on a non-cPanel CI runner)."
  else
    fail "/usr/local/cpanel not found - this installer targets a cPanel/WHM server only."
  fi
fi

command -v node >/dev/null 2>&1 || fail "Node.js is required but was not found in PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  fail "Node.js >= 26 is required (found $(node -v))."
fi

cd "$SCRIPT_DIR"

# --- Configuration ------------------------------------------------------

if [ ! -f .env ]; then
  cp .env.example .env
  log ".env created from .env.example - review and edit it before starting the service."
  log "In particular set the CPANEL_API_* variables for the UAPI identity adapter"
  log "and POSTGRES_* for the existing PostgreSQL database this install will use."
else
  log ".env already exists; leaving it untouched."
fi

PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2-)"
PORT="${PORT:-8080}"

log "Installing production dependencies (npm ci --omit=dev)..."
npm ci --omit=dev --no-audit --no-fund

log "Applying database migrations (skipped automatically while Postgres is disabled)..."
node --env-file=.env "$SCRIPT_DIR/run-migrations.mjs"

# --- systemd service ------------------------------------------------------

SERVICE_USER="${GULOGULO_SERVICE_USER:-gulogulo}"
SERVICE_GROUP="${GULOGULO_SERVICE_GROUP:-$SERVICE_USER}"
READ_WRITE_PATH="${GULOGULO_SERVICE_READ_WRITE_PATH:-/var/lib/gulogulo}"
NODE_BIN="$(command -v node)"
UNIT_PATH="/etc/systemd/system/gulogulo.service"
RENDERED_UNIT="$(mktemp)"

sed \
  -e "s#@INSTALL_DIR@#$SCRIPT_DIR#g" \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@SERVICE_GROUP@#$SERVICE_GROUP#g" \
  -e "s#@NODE_BIN@#$NODE_BIN#g" \
  -e "s#@READ_WRITE_PATH@#$READ_WRITE_PATH#g" \
  "$SCRIPT_DIR/gulogulo.service.template" > "$RENDERED_UNIT"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  if confirm_system_action "Create dedicated system user '$SERVICE_USER' to run the service?"; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    log "Created system user '$SERVICE_USER'."
  else
    warn "system user '$SERVICE_USER' was not created; create it yourself before enabling the service, or set GULOGULO_SERVICE_USER to an existing user."
  fi
else
  log "System user '$SERVICE_USER' already exists."
fi

if confirm_system_action "Install and enable the gulogulo systemd service at $UNIT_PATH?"; then
  cp "$RENDERED_UNIT" "$UNIT_PATH"
  chmod 0644 "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable --now gulogulo
  log "systemd service installed, enabled, and started ($UNIT_PATH)."
else
  cp "$RENDERED_UNIT" "$SCRIPT_DIR/gulogulo.service.rendered"
  log "Rendered systemd unit left at $SCRIPT_DIR/gulogulo.service.rendered for review."
  log "Install it manually with:"
  log "  cp gulogulo.service.rendered $UNIT_PATH && systemctl daemon-reload && systemctl enable --now gulogulo"
fi
rm -f "$RENDERED_UNIT"

# --- Apache reverse proxy (never touches real Apache config) ------------

PROXY_EXAMPLE="$SCRIPT_DIR/gulogulo-proxy.conf.example"
if [ -f "$PROXY_EXAMPLE" ] && [ "$PORT" != "8080" ]; then
  PROXY_TMP="$(mktemp)"
  sed "s#127\\.0\\.0\\.1:8080#127.0.0.1:${PORT}#g" "$PROXY_EXAMPLE" > "$PROXY_TMP"
  mv "$PROXY_TMP" "$PROXY_EXAMPLE"
  log "Rewrote the upstream port in gulogulo-proxy.conf.example to match PORT=$PORT from .env."
fi
log "Apache reverse proxy example: $PROXY_EXAMPLE"
log "This file is never applied automatically - see the instructions inside it"
log "(WHM Include Editor or a userdata hook, then rebuild/restart Apache)."

# --- Optional WHM AppConfig link (never registered automatically) -------

APPCONFIG_EXAMPLE="$SCRIPT_DIR/gulogulo-appconfig.conf.example"
log "Optional WHM AppConfig example: $APPCONFIG_EXAMPLE"
log "Not required for Gulo Gulo to work. To register it manually, review the"
log "file first, then run:"
log "  cp gulogulo-appconfig.conf.example /var/cpanel/apps/gulogulo.conf"
log "  /usr/local/cpanel/bin/register_appconfig /var/cpanel/apps/gulogulo.conf"

log "Install complete."
if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] No systemd unit, system user, or Apache/AppConfig file outside $SCRIPT_DIR was touched."
fi
