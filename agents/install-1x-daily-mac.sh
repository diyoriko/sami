#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.sami.codex.strategist.plist"
LABEL="com.sami.codex.strategist"
DOMAIN_TARGET="gui/$(id -u)"
LOG_DIR="$HOME/Library/Logs/Sami"
LAUNCHD_OUT_LOG="$LOG_DIR/strategist.launchd.out.log"
LAUNCHD_ERR_LOG="$LOG_DIR/strategist.launchd.err.log"
APP_SUPPORT_DIR="$HOME/Library/Application Support/Sami"
RUNTIME_DIR="$APP_SUPPORT_DIR/agents"
RUNTIME_CONTEXT_DIR="$APP_SUPPORT_DIR/context"
RUNTIME_REPORT_DIR="$APP_SUPPORT_DIR/reports/strategist"
RUNTIME_RUNNER_PATH="$RUNTIME_DIR/strategist-launchd-runner.sh"
RUNTIME_STRATEGIST_PATH="$RUNTIME_DIR/strategist.sh"
RUNTIME_GOOGLE_SYNC_PATH="$RUNTIME_DIR/google-calendar-sync.mjs"
RUNTIME_TELEGRAM_NOTIFY_PATH="$RUNTIME_DIR/telegram-notify.mjs"
RUNTIME_OPENAI_RUNNER_PATH="$RUNTIME_DIR/strategist-openai.mjs"
RUNTIME_GOOGLE_OAUTH_CLIENT_PATH="$APP_SUPPORT_DIR/google-oauth-client.json"

mkdir -p "$PLIST_DIR" "$ROOT_DIR/reports/strategist"
mkdir -p "$ROOT_DIR/reports/strategist/.internal"
mkdir -p "$LOG_DIR"
mkdir -p "$RUNTIME_DIR"
mkdir -p "$RUNTIME_CONTEXT_DIR"
mkdir -p "$RUNTIME_REPORT_DIR"
touch "$LAUNCHD_OUT_LOG"
touch "$LAUNCHD_ERR_LOG"

cp "$ROOT_DIR/agents/strategist.sh" "$RUNTIME_STRATEGIST_PATH"
cp "$ROOT_DIR/agents/google-calendar-sync.mjs" "$RUNTIME_GOOGLE_SYNC_PATH"
cp "$ROOT_DIR/agents/telegram-notify.mjs" "$RUNTIME_TELEGRAM_NOTIFY_PATH"
cp "$ROOT_DIR/agents/strategist-openai.mjs" "$RUNTIME_OPENAI_RUNNER_PATH"
if [[ -f "$ROOT_DIR/agents/google-oauth-client.json" ]]; then
  cp "$ROOT_DIR/agents/google-oauth-client.json" "$RUNTIME_GOOGLE_OAUTH_CLIENT_PATH"
fi
cp "$ROOT_DIR/STRATEGIST_BRIEF.md" "$RUNTIME_CONTEXT_DIR/STRATEGIST_BRIEF.md"
cp "$ROOT_DIR/SAMI_PRD_v1.md" "$RUNTIME_CONTEXT_DIR/SAMI_PRD_v1.md"
cp "$ROOT_DIR/SAMI_MVP_SCOPE.md" "$RUNTIME_CONTEXT_DIR/SAMI_MVP_SCOPE.md"
cp "$ROOT_DIR/SAMI_14_DAY_PLAN.md" "$RUNTIME_CONTEXT_DIR/SAMI_14_DAY_PLAN.md"
cp "$ROOT_DIR/APP_TASKS.md" "$RUNTIME_CONTEXT_DIR/APP_TASKS.md"

cat > "$RUNTIME_RUNNER_PATH" <<RUNNER
#!/bin/bash
set -euo pipefail

build_path() {
  local path_value="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local candidate

  for candidate in "\$HOME"/.nvm/versions/node/*/bin; do
    if [[ -d "\$candidate" ]]; then
      path_value="\$candidate:\$path_value"
    fi
  done

  printf '%s\n' "\$path_value"
}

load_exported_vars() {
  local env_file="\$1"
  [[ -f "\$env_file" ]] || return 0

  while IFS= read -r line; do
    case "\$line" in
      export\ OPENAI_API_KEY=*|export\ STRATEGIST_*|export\ GOOGLE_*)
        eval "\$line"
        ;;
    esac
  done < "\$env_file"
}

export PATH="\$(build_path)"
export HOME="\${HOME:-$(cd ~ && pwd)}"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"
export SAMI_PROJECT_ROOT="$ROOT_DIR"
export SAMI_AGENTS_DIR="$RUNTIME_DIR"
export SAMI_CONTEXT_ROOT="$RUNTIME_CONTEXT_DIR"
export STRATEGIST_REPORT_DIR="$RUNTIME_REPORT_DIR"
export STRATEGIST_GENERATOR="\${STRATEGIST_GENERATOR:-codex}"

if [[ -f "\$HOME/.config/sami/strategist.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "\$HOME/.config/sami/strategist.env"
  set +a
fi

load_exported_vars "\$HOME/.zshrc"
load_exported_vars "\$HOME/.bashrc"
load_exported_vars "\$HOME/.profile"

if [[ "\${STRATEGIST_GENERATOR:-codex}" == "codex" ]]; then
  unset OPENAI_API_KEY || true
fi

cd "$RUNTIME_DIR"
exec /bin/bash "$RUNTIME_STRATEGIST_PATH"
RUNNER

chmod +x "$RUNTIME_RUNNER_PATH"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>$RUNTIME_RUNNER_PATH</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$RUNTIME_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>

    <key>StandardOutPath</key>
    <string>$LAUNCHD_OUT_LOG</string>
    <key>StandardErrorPath</key>
    <string>$LAUNCHD_ERR_LOG</string>
  </dict>
</plist>
PLIST

launchctl bootout "$DOMAIN_TARGET" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN_TARGET" "$PLIST_PATH"

echo "[strategist-install] installed: $PLIST_PATH"
echo "[strategist-install] schedule: 09:00 local time (1x/day)"
