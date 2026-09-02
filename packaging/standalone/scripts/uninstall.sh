#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)
#
# Removes the application files of a standalone Gulo Gulo install. Never
# deletes external data (PostgreSQL database, LDAP directory, mailbox
# storage) - none of that lives inside the install directory - and never
# deletes .env without a separate, explicit confirmation.
#
# Usage: ./uninstall.sh [--non-interactive] [--yes]
# In non-interactive mode (GULOGULO_NON_INTERACTIVE=1 or --non-interactive),
# every destructive step is skipped unless --yes is also given, so scripted
# runs never delete anything without an explicit, deliberate opt-in.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE="${GULOGULO_NON_INTERACTIVE:-0}"
FORCE_YES=0

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

log "This removes the Gulo Gulo application files in: $SCRIPT_DIR"
log "It never deletes external data (PostgreSQL database, LDAP directory,"
log "mailbox storage) or your .env file without separate confirmation."

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

log "External PostgreSQL database, LDAP directory, and mailbox storage were"
log "not touched and must be removed separately if that is what you want."
