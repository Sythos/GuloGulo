#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Removes a Plesk-target Gulo Gulo install. Run as root. Never touches
# external data (PostgreSQL database, mailbox storage, or
# GULOGULO_SERVICE_READ_WRITE_PATH/var/lib/gulogulo) and never deletes the
# dedicated system user.
#
# This is a straight shell translation of
# packaging/plesk/debian/DEBIAN/{prerm,postrm} - see those files for the
# dpkg-native equivalent of every step below. --purge (below) mirrors
# `postrm purge`'s extra step of also removing .env; a plain run mirrors
# `postrm remove`, which leaves .env in place.
#
# Usage: ./uninstall.sh [--non-interactive] [--yes] [--purge]
# In non-interactive mode (GULOGULO_NON_INTERACTIVE=1 or --non-interactive),
# every destructive step is skipped unless --yes is also given, so scripted
# runs never delete anything without an explicit, deliberate opt-in.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE="${GULOGULO_NON_INTERACTIVE:-0}"
FORCE_YES=0
PURGE=0
UNIT_PATH=/etc/systemd/system/gulogulo.service
PURGE_UNIT_PATH=/etc/systemd/system/gulogulo-purge.service
PURGE_TIMER_PATH=/etc/systemd/system/gulogulo-purge.timer

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --yes) FORCE_YES=1 ;;
    --purge) PURGE=1 ;;
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
log "It never touches external data (PostgreSQL database, mailbox storage,"
log "or /var/lib/gulogulo) or the dedicated system user."

# --- prerm equivalent: stop and disable the systemd service --------------

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files gulogulo.service >/dev/null 2>&1; then
  systemctl disable --now gulogulo || log "WARNING: systemctl disable --now gulogulo failed (continuing)."
  log "Service stopped and disabled."
else
  log "No gulogulo systemd unit found - nothing to stop/disable."
fi

# --- purge timer: same stop/disable treatment as the main service --------

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files gulogulo-purge.timer >/dev/null 2>&1; then
  systemctl disable --now gulogulo-purge.timer || log "WARNING: systemctl disable --now gulogulo-purge.timer failed (continuing)."
  log "Purge timer stopped and disabled."
else
  log "No gulogulo-purge.timer systemd unit found - nothing to stop/disable."
fi

# --- postrm equivalent: runtime-generated files ---------------------------

if [ -d "$SCRIPT_DIR/node_modules" ]; then
  rm -rf "$SCRIPT_DIR/node_modules"
  log "Removed node_modules/ (npm ci output, not part of the package payload)."
fi
if [ -f "$UNIT_PATH" ]; then
  rm -f "$UNIT_PATH"
  systemctl daemon-reload 2>/dev/null || true
  log "Removed systemd unit $UNIT_PATH."
fi
if [ -f "$PURGE_UNIT_PATH" ] || [ -f "$PURGE_TIMER_PATH" ]; then
  rm -f "$PURGE_UNIT_PATH" "$PURGE_TIMER_PATH"
  systemctl daemon-reload 2>/dev/null || true
  log "Removed purge systemd units ($PURGE_UNIT_PATH, $PURGE_TIMER_PATH)."
fi

if confirm "Remove application files (dist/, web/, assets/, src/, package*.json)?"; then
  rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/web" "$SCRIPT_DIR/assets" "$SCRIPT_DIR/src"
  rm -f "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json" "$SCRIPT_DIR/LICENSE" "$SCRIPT_DIR/VERSION"
  log "Application files removed."
else
  log "Application files left in place."
fi

if [ "$PURGE" = "1" ] && [ -f "$SCRIPT_DIR/.env" ]; then
  if confirm "Also remove the .env configuration file? This cannot be undone."; then
    rm -f "$SCRIPT_DIR/.env"
    log ".env removed (purge)."
  fi
elif [ -f "$SCRIPT_DIR/.env" ]; then
  log "$SCRIPT_DIR/.env left in place. Re-run with --purge to also remove it."
fi

log "External PostgreSQL database and mailbox storage were not touched and"
log "must be removed separately if that is what you want."
log "The dedicated system user was NOT removed - drop it yourself if wanted."
log "Reminder (never done automatically by this package): remove the nginx"
log "directives you added from gulogulo-proxy.conf.example."
