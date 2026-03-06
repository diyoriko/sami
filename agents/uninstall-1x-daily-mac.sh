#!/usr/bin/env bash
set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/com.sami.codex.strategist.plist"
DOMAIN_TARGET="gui/$(id -u)"
launchctl bootout "$DOMAIN_TARGET" "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
echo "[strategist-uninstall] removed: $PLIST_PATH"
