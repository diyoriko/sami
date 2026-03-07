#!/usr/bin/env bash
set -euo pipefail

DOMAIN_TARGET="gui/$(id -u)"

# Remove old (codex) and new plist
for plist in \
  "$HOME/Library/LaunchAgents/com.sami.codex.strategist.plist" \
  "$HOME/Library/LaunchAgents/com.sami.strategist.plist"; do
  launchctl bootout "$DOMAIN_TARGET" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  echo "[strategist-uninstall] removed: $plist"
done
