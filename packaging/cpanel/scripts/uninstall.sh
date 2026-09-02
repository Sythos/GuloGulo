#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Removes a cPanel/WHM Gulo Gulo install: stops/disables the systemd
# service, then (with separate confirmation) removes the application files.
# Never deletes external data (PostgreSQL database, mailbox storage) - none
# of that lives inside the install directory - and never deletes .env
# without its own separate confirmation. Never touches Apache configuration
# or WHM AppConfig registration; only prints reminders for those, since
# both are manual, host-wide changes the operator made deliberately.
#
# Usage: ./uninstall.sh [--non-interactive] [--dry-run] [--yes]
# In non-interactive mode (GULOGULO_NON_INTERACTIVE=1 or --non-interactive),
# every destructive/system step is skipped unless --yes is also given, so
# scripted runs never delete or disable anything without an explicit,
# deliberate opt-in. --dry-run always wins over --yes: nothing destructive
# or system-changing actually runs, only a description of what would.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE="${GULOGULO_NON_INTERACTIVE:-0}"
DRY_RUN="${GULOGULO_DRY_RUN:-0}"
FORCE_YES="${GULOGULO_ASSUME_YES:-0}"

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) FORCE_YES=1 ;;
    *) echo "[uninstall] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '[uninstall] %s\n' "$1"; }

confirm() {
  local prompt="$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] would ask/perform: $prompt"
    return 1
  fi
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

log "This removes the Gulo Gulo cPanel install in: $SCRIPT_DIR"
log "It never deletes external data (PostgreSQL database, mailbox storage)"
log "or your .env file without separate confirmation, and never touches"
log "Apache configuration or WHM AppConfig registration."

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files gulogulo.service >/dev/null 2>&1; then
  if confirm "Stop and disable the gulogulo systemd service (systemctl disable --now gulogulo)?"; then
    systemctl disable --now gulogulo
    log "Service stopped and disabled."
    if confirm "Also remove the unit file /etc/systemd/system/gulogulo.service?"; then
      rm -f /etc/systemd/system/gulogulo.service
      systemctl daemon-reload
      log "Unit file removed."
    fi
  else
    log "systemd service left running/enabled."
  fi
else
  log "No gulogulo systemd unit found (or systemctl unavailable) - nothing to stop/disable."
fi

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

log "External PostgreSQL database and mailbox storage were not touched and"
log "must be removed separately if that is what you want."
log "Reminders (never done automatically by this script):"
log "  - remove the Apache reverse proxy snippet you added from"
log "    gulogulo-proxy.conf.example (WHM Include Editor or your userdata hook)."
log "  - if you registered the optional WHM AppConfig entry, unregister it:"
log "      /usr/local/cpanel/bin/unregister_appconfig gulogulo"
