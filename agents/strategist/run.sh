#!/bin/bash
# SAMI Strategist — uses shared strategist-base.sh v4
#
# Migrated from standalone agents/strategist.sh (783 lines → ~150 lines)
# Railway-specific: trigger-analytics, community/analytics fetch,
# COMMUNITY_PACKET POST, proposal approval buttons

set -euo pipefail

# ─── Project config ───────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_NAME="Sami"
REPORTS_DIR="$PROJECT_DIR/reports/strategist"
AGENT_DIR="$PROJECT_DIR/agents/strategist"
CALENDAR_SECTION="## Фокус дня"

COMMUNITY_AGENT_URL="${COMMUNITY_AGENT_URL:-https://courageous-happiness-production.up.railway.app}"
STRATEGIST_HC_UUID="d22ef7e8-38ab-4930-816e-dcd434a0c914"

# ─── Source shared runner ─────────────────────────────────────────────
source "$HOME/Documents/Projects/Architect/shared/strategist-base.sh"

# ─── Load env (API key for Railway) ──────────────────────────────────
# Bot token: loaded from ~/.config/diyoriko/notify-bot-token by strategist-base.sh
#
# IMPORTANT: STRATEGIST_API_KEY (the value Railway expects in x-admin-token)
# is DIFFERENT from the Telegram BOT_TOKEN. Do NOT fall back to BOT_TOKEN —
# the previous version did `${STRATEGIST_API_KEY:-${BOT_TOKEN:-}}` which
# silently sent the Telegram token to Railway after strategist-base.sh
# loaded BOT_TOKEN from ~/.config/diyoriko/notify-bot-token, producing
# 401 on every fetch under launchd. See SM-1056.
_load_env() {
  if [ -n "${STRATEGIST_API_KEY:-}" ]; then
    SAMI_API_KEY="$STRATEGIST_API_KEY"
  elif [ -f "$HOME/.config/sami/community.env" ]; then
    SAMI_API_KEY=$(grep -m1 '^STRATEGIST_API_KEY=' "$HOME/.config/sami/community.env" 2>/dev/null | cut -d= -f2- || true)
  fi
  SAMI_API_KEY="${SAMI_API_KEY:-}"
}

# ─── pre_run: Railway fetches + proposal sync ─────────────────────────
pre_run() {
  _load_env

  if [ -z "${SAMI_API_KEY:-}" ]; then
    echo "$(_ts) WARN: SAMI_API_KEY not set — Railway endpoints will return 401 (set STRATEGIST_API_KEY in ~/.config/sami/community.env)"
  fi

  # Trigger fresh analytics so subscriber_count is current
  # Auth: x-admin-token required since 04.04 P0-1 security fix (commit 1d8b2a1)
  echo "$(_ts) Triggering analytics refresh..."
  local trigger_code
  trigger_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
    -H "x-admin-token: ${SAMI_API_KEY:-}" \
    "$COMMUNITY_AGENT_URL/trigger-analytics" 2>/dev/null || echo "000")
  if [ "$trigger_code" = "200" ]; then
    echo "$(_ts) Analytics refreshed"
  else
    echo "$(_ts) Analytics refresh unavailable (HTTP $trigger_code, using cached)"
  fi
  sleep 3

  # Fetch community + analytics reports
  local internal="$_SB_INTERNAL_DIR"
  local community_code analytics_code
  community_code=$(curl -s -w '%{http_code}' --max-time 10 \
    -H "x-admin-token: ${SAMI_API_KEY:-}" \
    "$COMMUNITY_AGENT_URL/report/community" \
    -o "$internal/community-latest.json" 2>/dev/null || echo "000")
  if [ "$community_code" = "200" ]; then
    echo "$(_ts) Fetched community report"
  else
    echo "$(_ts) Community report unavailable (HTTP $community_code)"
  fi
  analytics_code=$(curl -s -w '%{http_code}' --max-time 10 \
    -H "x-admin-token: ${SAMI_API_KEY:-}" \
    "$COMMUNITY_AGENT_URL/report/analytics" \
    -o "$internal/analytics-latest.json" 2>/dev/null || echo "000")
  if [ "$analytics_code" = "200" ]; then
    echo "$(_ts) Fetched analytics report"
  else
    echo "$(_ts) Analytics report unavailable (HTTP $analytics_code)"
  fi

  # Sync proposal statuses (non-critical)
  local sync_script="$PROJECT_DIR/agents/sync-proposal-status.mjs"
  if [ -f "$sync_script" ] && command -v node >/dev/null 2>&1; then
    node "$sync_script" 2>&1 && echo "$(_ts) Proposals synced" \
      || echo "$(_ts) Proposal sync failed (non-critical)"
  fi

  # Apply approved proposals to BACKLOG.md (non-critical)
  local apply_script="$PROJECT_DIR/agents/apply-proposals.sh"
  if [ -f "$apply_script" ] && [ -f "$PROJECT_DIR/BACKLOG.md" ] && [ -n "$SAMI_API_KEY" ]; then
    bash "$apply_script" "$PROJECT_DIR/BACKLOG.md" "$SAMI_API_KEY" "$COMMUNITY_AGENT_URL" 2>&1 \
      && echo "$(_ts) Approved proposals applied" \
      || echo "$(_ts) Apply proposals failed (non-critical)"
  fi
}

# ─── build_prompt: SAMI-specific context ──────────────────────────────
build_prompt() {
  local internal="$_SB_INTERNAL_DIR"

  # Prompt template
  cat "$AGENT_DIR/prompt.md"
  echo ""
  echo "---"
  echo ""

  # STRATEGIST_BRIEF
  if [ -f "$PROJECT_DIR/docs/research/STRATEGIST_BRIEF.md" ]; then
    echo "=== STRATEGIST_BRIEF.md ==="
    cat "$PROJECT_DIR/docs/research/STRATEGIST_BRIEF.md"
    echo ""
  fi

  # BACKLOG (smart: current sprint + all completed)
  echo "=== BACKLOG.md ==="
  _smart_backlog "$PROJECT_DIR/BACKLOG.md"
  echo ""

  # Railway data
  for f in community-latest.json analytics-latest.json; do
    if [ -f "$internal/$f" ]; then
      echo "=== $f ==="
      cat "$internal/$f"
      echo ""
    fi
  done

  # Data freshness for analytics
  if [ -f "$internal/analytics-latest.json" ]; then
    local written_at age_info
    written_at=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('written_at','unknown'))" \
      "$internal/analytics-latest.json" 2>/dev/null || echo "unknown")
    if [ "$written_at" != "unknown" ]; then
      age_info=$(python3 -c "
from datetime import datetime, timezone
w = datetime.fromisoformat('$written_at'.replace('Z','+00:00'))
age = (datetime.now(timezone.utc) - w).total_seconds()
h = int(age // 3600)
print(f'{h}h' if h > 0 else f'{int(age//60)}m')
" 2>/dev/null || echo "unknown")
      echo "Аналитика: возраст данных = ${age_info} (written_at: $written_at)"
      echo ""
    fi
  fi

  # Proposal status
  if [ -f "$internal/proposal-status.md" ]; then
    echo "=== proposal-status.md ==="
    cat "$internal/proposal-status.md"
    echo ""
  fi

  # Competitor digest (if exists)
  if [ -f "$internal/competitor-digest.json" ]; then
    echo "=== competitor-digest.json ==="
    cat "$internal/competitor-digest.json"
    echo ""
  fi
}

# ─── custom_extract_tasks: SAMI proposal system ──────────────────────
custom_extract_tasks() {
  local report_file="$1"

  # Extract BACKLOG_PROPOSALS to proposed-tasks.md
  local extract_proposals="$PROJECT_DIR/agents/extract-backlog-proposals.mjs"
  if [ -f "$extract_proposals" ] && command -v node >/dev/null 2>&1; then
    node "$extract_proposals" "$report_file" 2>&1 \
      && echo "$(_ts) Backlog proposals extracted" \
      || echo "$(_ts) Proposal extraction failed (non-critical)"
  fi

  # Send proposals as Telegram messages with Approve/Reject buttons
  # SAMI_API_KEY is exported so extract-strategist-tasks.sh can authenticate
  # against Railway's /proposal endpoint (which expects STRATEGIST_API_KEY,
  # not the Telegram BOT_TOKEN). BOT_TOKEN/ADMIN_CHAT_ID are still used for
  # the Telegram sendMessage call inside the script.
  local extract_tasks="$PROJECT_DIR/agents/extract-strategist-tasks.sh"
  if [ -f "$extract_tasks" ] && [ -n "${BOT_TOKEN:-}" ] && [ -n "${SAMI_API_KEY:-}" ]; then
    SAMI_API_KEY="$SAMI_API_KEY" bash "$extract_tasks" "$report_file" "$PROJECT_DIR/BACKLOG.md" \
      "$BOT_TOKEN" "$ADMIN_CHAT_ID" "$COMMUNITY_AGENT_URL" 2>&1 \
      && echo "$(_ts) Proposals sent for approval" \
      || echo "$(_ts) Proposal buttons failed (non-critical)"
  fi
}

# ─── post_report: COMMUNITY_PACKET + metadata ────────────────────────
post_report() {
  local report_file="$1"

  # Extract and POST COMMUNITY_PACKET to Railway bot
  local packet_json
  packet_json=$(python3 -c '
import json, re, sys
from pathlib import Path
report = Path(sys.argv[1]).read_text(encoding="utf-8", errors="ignore")
match = re.search(r"// COMMUNITY_PACKET_START\s*([\s\S]*?)// COMMUNITY_PACKET_END", report)
if not match: print("{}"); sys.exit(0)
try: packet = json.loads(match.group(1).strip())
except json.JSONDecodeError: print("{}"); sys.exit(0)
sm = re.search(r"^## Резюме\s*\n([\s\S]*?)(?:\n## |\n# |$)", report, re.MULTILINE)
summary = None
if sm:
    bullets = [l.strip() for l in sm.group(1).split("\n") if l.strip().startswith("- ")][:5]
    summary = "\n".join(bullets) if bullets else None
payload = {"packet": packet}
if summary: payload["report"] = {"summary": summary}
print(json.dumps(payload, ensure_ascii=False))
' "$report_file" 2>/dev/null || echo "{}")

  if [ -n "$packet_json" ] && [ "$packet_json" != "{}" ] && [ -n "${SAMI_API_KEY:-}" ]; then
    if curl -sf --max-time 15 \
      -X POST "$COMMUNITY_AGENT_URL/packet" \
      -H "Content-Type: application/json" \
      -H "X-Admin-Token: $SAMI_API_KEY" \
      -d "$packet_json" >/dev/null 2>&1; then
      echo "$(_ts) COMMUNITY_PACKET posted to Railway"
    else
      echo "$(_ts) Failed to POST packet (non-critical)"
    fi
  fi

  # Rich Telegram notification (via Node.js for better formatting)
  local notify_script="$PROJECT_DIR/agents/telegram-notify.mjs"
  if [ -f "$notify_script" ] && command -v node >/dev/null 2>&1; then
    node "$notify_script" --agent strategist --status completed --report "$report_file" 2>&1 \
      || echo "$(_ts) telegram-notify.mjs failed (non-critical)"
  fi

  # Write status files (for bot /health and dashboard)
  local stamp_utc stamp_local
  stamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  stamp_local=$(date +%Y-%m-%d_%H-%M-%S)
  local report_name
  report_name=$(basename "$report_file")

  cat > "$_SB_INTERNAL_DIR/latest.json" <<LATEST_EOF
{
  "timestamp": "$stamp_utc",
  "status": "completed",
  "exit_code": 0,
  "report_path": "$report_file",
  "report_file": "$report_name"
}
LATEST_EOF
}

# ─── Run ──────────────────────────────────────────────────────────────
run_strategist
