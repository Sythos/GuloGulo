#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Removes a cPanel/WHM Gulo Gulo install. Run as root. Never deletes
# external data (PostgreSQL database, /var/lib/gulogulo) and never deletes
# .env or the dedicated system user without a separate, explicit
# confirmation.
#
# This is a straight shell translation of packaging/cpanel/gulogulo.spec's
# %preun and %postun scriptlets - see that file for the RPM-native
# equivalent of every step below.
#
# Usage: ./uninstall.sh [--non-interactive] [--yes]
# In non-interactive mode (GULOGULO_NON_INTERACTIVE=1 or --non-interactive),
# every destructive step is skipped unless --yes is also given, so scripted
# runs never delete anything without an explicit, deliberate opt-in.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE="${GULOGULO_NON_INTERACTIVE:-0}"
FORCE_YES=0
UNIT_PATH=/etc/systemd/system/gulogulo.service

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --yes) FORCE_YES=1 ;;
    *) echo "[uninstall] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '[uninstall] %s\n' "$1"; }

confirm() {
  local prompt="$1"
  if [ "$NON_INTERACTIVE" = "1" ]; then
    if [ "$FORCE_YES" = "1" ]; then
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

if [ "$(id -u)" -ne 0 ]; then
  log "WARNING: not running as root - stopping/disabling the systemd service will fail."
fi

log "This removes the Gulo Gulo application files in: $SCRIPT_DIR"
log "It never deletes external data (PostgreSQL database, /var/lib/gulogulo)"
log "or your .env file/dedicated system user without separate confirmation."

# --- %preun equivalent: stop and disable the systemd service ------------

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files gulogulo.service >/dev/null 2>&1; then
  systemctl disable --now gulogulo >/dev/null 2>&1 || log "WARNING: systemctl disable --now gulogulo failed (continuing)."
  log "Service stopped and disabled."
else
  log "No gulogulo systemd unit found - nothing to stop/disable."
fi

if [ -f "$UNIT_PATH" ]; then
  rm -f "$UNIT_PATH"
  systemctl daemon-reload >/dev/null 2>&1 || true
  log "Removed systemd unit $UNIT_PATH."
fi

# --- %postun equivalent: application files and runtime-generated output -

if confirm "Remove application files (dist/, web/, assets/, src/, node_modules/, package*.json)?"; then
  rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/web" "$SCRIPT_DIR/assets" "$SCRIPT_DIR/src" "$SCRIPT_DIR/node_modules"
  rm -f "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json" "$SCRIPT_DIR/LICENSE" "$SCRIPT_DIR/VERSION"
  log "Application files removed."
else
  log "Application files left in place."
fi

if [ -f "$SCRIPT_DIR/.env" ]; then
  if confirm "Also remove the .env configuration file? This cannot be undone."; then
    rm -f "$SCRIPT_DIR/.env"
    log ".env removed."
  else
    log ".env preserved at $SCRIPT_DIR/.env"
  fi
fi

log "External PostgreSQL database and /var/lib/gulogulo were not touched and"
log "must be removed separately if that is what you want."
log "The dedicated 'gulogulo' system user was NOT removed - drop it yourself"
log "(userdel gulogulo) if you want it gone."
log "Reminders (never done automatically by this package):"
log "  - remove the Apache reverse proxy snippet you added from gulogulo-proxy.conf.example."
log "  - if you registered the optional WHM AppConfig entry, unregister it:"
log "      /usr/local/cpanel/bin/unregister_appconfig gulogulo"
