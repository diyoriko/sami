#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SAMI_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONTEXT_ROOT="${SAMI_CONTEXT_ROOT:-$PROJECT_ROOT}"
ROOT_DIR="$PROJECT_ROOT"
REPORT_DIR="${STRATEGIST_REPORT_DIR:-$PROJECT_ROOT/reports/strategist}"
INTERNAL_DIR="$REPORT_DIR/.internal"
ARCHIVE_DIR="$INTERNAL_DIR/archive"
mkdir -p "$REPORT_DIR" "$INTERNAL_DIR" "$ARCHIVE_DIR"

STAMP_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP_LOCAL="$(date +%Y-%m-%d_%H-%M-%S)"
STAMP_DAY="$(date +%Y-%m-%d)"
REPORT_NAME="${STAMP_LOCAL}__strategist-report.md"
OUT_PATH="$REPORT_DIR/$REPORT_NAME"
PROMPT_PATH="$INTERNAL_DIR/prompt-$STAMP_LOCAL.md"
RAW_OUT_PATH="$INTERNAL_DIR/run-$STAMP_LOCAL.log"
LATEST_JSON="$INTERNAL_DIR/latest.json"
LATEST_MD="$INTERNAL_DIR/latest.md"
LOG_PATH="$INTERNAL_DIR/strategist.log"
LATEST_NOTIFICATION_JSON="$INTERNAL_DIR/latest-notification.json"
GOOGLE_SYNC_SCRIPT="${SAMI_AGENTS_DIR:-$SCRIPT_DIR}/google-calendar-sync.mjs"
TELEGRAM_NOTIFY_SCRIPT="${SAMI_AGENTS_DIR:-$SCRIPT_DIR}/telegram-notify.mjs"
OPENAI_RUNNER_SCRIPT="${SAMI_AGENTS_DIR:-$SCRIPT_DIR}/strategist-openai.mjs"

TIMEOUT_SEC="${STRATEGIST_TIMEOUT_SEC:-1200}"
FULL_ACCESS_MODE="${STRATEGIST_FULL_ACCESS_MODE:-1}"
DRY_RUN="${STRATEGIST_DRY_RUN:-0}"
NOTIFY_ON_DRY_RUN="${STRATEGIST_NOTIFY_ON_DRY_RUN:-0}"
ENABLE_SEARCH="${STRATEGIST_ENABLE_WEB_SEARCH:-0}"
CODEX_MODEL="${STRATEGIST_CODEX_MODEL:-gpt-5.4}"
CODEX_REASONING="${STRATEGIST_CODEX_REASONING:-xhigh}"
CODEX_PROFILE="${STRATEGIST_CODEX_PROFILE:-}"
STRATEGIST_GENERATOR="${STRATEGIST_GENERATOR:-codex}"
CLAUDE_MODEL="${STRATEGIST_CLAUDE_MODEL:-claude-sonnet-4-6}"
MAX_RETRIES="${STRATEGIST_MAX_RETRIES:-5}"
RETRY_SLEEP_SEC="${STRATEGIST_RETRY_SLEEP_SEC:-12}"

CONTEXT_FILES=(
  "$CONTEXT_ROOT/STRATEGIST_BRIEF.md"
  "$CONTEXT_ROOT/SAMI_PRD_v1.md"
  "$CONTEXT_ROOT/SAMI_MVP_SCOPE.md"
  "$CONTEXT_ROOT/SAMI_14_DAY_PLAN.md"
  "$CONTEXT_ROOT/SAMI_TASKS.md"
)

write_latest_json() {
  local status="$1"
  local code="$2"
  local notification_status="$3"
  python3 - "$LATEST_JSON" "$STAMP_UTC" "$status" "$code" "$OUT_PATH" "$REPORT_NAME" "$LATEST_NOTIFICATION_JSON" "$notification_status" <<'PY'
import json
import sys
from pathlib import Path

notification_path = Path(sys.argv[7])
notification = None
if notification_path.exists():
    try:
        notification = json.loads(notification_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        notification = None

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "timestamp": sys.argv[2],
            "status": sys.argv[3],
            "exit_code": int(sys.argv[4]),
            "report_path": sys.argv[5],
            "report_file": sys.argv[6],
            "notification_status": sys.argv[8],
            "notification_path": sys.argv[7],
            "report_url": (notification or {}).get("report_url"),
            "task_url": ((notification or {}).get("task") or {}).get("webViewLink"),
            "task_id": ((notification or {}).get("task") or {}).get("id"),
            "calendar_event_url": ((notification or {}).get("calendar") or {}).get("htmlLink"),
            "calendar_event_id": ((notification or {}).get("calendar") or {}).get("id"),
            "drive_file_url": ((notification or {}).get("drive") or {}).get("webViewLink"),
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)
PY
}

write_latest_md() {
  local status="$1"
  local code="$2"
  python3 - "$LATEST_MD" "$STAMP_UTC" "$status" "$code" "$OUT_PATH" "$LATEST_NOTIFICATION_JSON" <<'PY'
import json
import sys
from pathlib import Path

latest_md = Path(sys.argv[1])
notification_path = Path(sys.argv[6])
notification = {}
if notification_path.exists():
    try:
        notification = json.loads(notification_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        notification = {}

lines = [
    "# Sami Strategist Report",
    "",
    f"- Timestamp: {sys.argv[2]}",
    f"- Status: {sys.argv[3]}",
    f"- Exit code: {sys.argv[4]}",
    f"- Report: {sys.argv[5]}",
]

report_url = notification.get("report_url")
task = notification.get("task") or {}
calendar = notification.get("calendar") or {}
if report_url:
    lines.append(f"- Result link: {report_url}")
if task.get("webViewLink"):
    lines.append(f"- Google Task: {task['webViewLink']}")
if calendar.get("htmlLink"):
    lines.append(f"- Calendar event: {calendar['htmlLink']}")
if notification.get("status"):
    lines.append(f"- Notification: {notification['status']}")
if notification.get("reason"):
    lines.append(f"- Notification reason: {notification['reason']}")

latest_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

resolve_codex_bin() {
  local candidate

  if [[ -n "${STRATEGIST_CODEX_BIN:-}" && -x "${STRATEGIST_CODEX_BIN:-}" ]]; then
    printf '%s\n' "$STRATEGIST_CODEX_BIN"
    return 0
  fi

  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi

  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/codex \
    /opt/homebrew/bin/codex \
    /usr/local/bin/codex
  do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

create_error_report() {
  local code="$1"
  {
    cat <<EOF
# Sami Strategist Report — $STAMP_DAY

## Резюме
- Отчёт не был сгенерирован успешно.
- Код выхода запуска: $code.
- Проверь технический лог в скрытой папке \`.internal\`.

## Технический статус
- Timestamp (UTC): $STAMP_UTC
- Exit code: $code
- Raw log: $RAW_OUT_PATH

## Последние строки лога
\`\`\`
EOF
    tail -n 40 "$RAW_OUT_PATH" 2>/dev/null || true
    echo '```'
  } > "$OUT_PATH"
}

ensure_summary_block() {
  if [[ ! -s "$OUT_PATH" ]]; then
    create_error_report 1
    return
  fi

  if ! grep -Eq '^## (Резюме|TL;DR)' "$OUT_PATH"; then
    local tmp_path
    tmp_path="$(mktemp)"
    {
      cat <<EOF
# Sami Strategist Report — $STAMP_DAY

## Резюме
- Отчёт сгенерирован автоматически агентом Strategist.
- Ниже полный стратегический разбор.

EOF
      cat "$OUT_PATH"
    } > "$tmp_path"
    mv "$tmp_path" "$OUT_PATH"
  fi
}

run_google_sync() {
  local status="$1"
  local code="$2"
  local sync_status="skipped"

  rm -f "$LATEST_NOTIFICATION_JSON"

  if [[ "$DRY_RUN" == "1" && "$NOTIFY_ON_DRY_RUN" != "1" ]]; then
    python3 - "$LATEST_NOTIFICATION_JSON" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "status": "skipped",
            "reason": "dry_run_notifications_disabled",
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)
PY
    printf '[strategist] calendar sync skipped: dry-run notifications disabled\n' >> "$RAW_OUT_PATH"
    printf '%s\n' "$sync_status"
    return 0
  fi

  if [[ ! -f "$GOOGLE_SYNC_SCRIPT" ]]; then
    python3 - "$LATEST_NOTIFICATION_JSON" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "status": "skipped",
            "reason": "google_sync_script_missing",
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)
PY
    printf '[strategist] calendar sync skipped: script missing\n' >> "$RAW_OUT_PATH"
    printf '%s\n' "$sync_status"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    python3 - "$LATEST_NOTIFICATION_JSON" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "status": "skipped",
            "reason": "node_missing",
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)
PY
    printf '[strategist] calendar sync skipped: node missing\n' >> "$RAW_OUT_PATH"
    printf '%s\n' "$sync_status"
    return 0
  fi

  if node "$GOOGLE_SYNC_SCRIPT" \
    --report "$OUT_PATH" \
    --report-file "$REPORT_NAME" \
    --status "$status" \
    --exit-code "$code" \
    --timestamp "$STAMP_UTC" \
    --output "$LATEST_NOTIFICATION_JSON" >> "$RAW_OUT_PATH" 2>&1; then
    sync_status="$(python3 - "$LATEST_NOTIFICATION_JSON" <<'PY'
import json
import sys
from pathlib import Path

payload = {}
path = Path(sys.argv[1])
if path.exists():
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        payload = {}

print(payload.get("status", "completed"))
PY
)"
  else
    sync_status="failed"
    printf '[strategist] calendar sync failed\n' >> "$RAW_OUT_PATH"
  fi

  printf '%s\n' "$sync_status"
}

run_telegram_notify() {
  local status="$1"

  if [[ "$DRY_RUN" == "1" && "$NOTIFY_ON_DRY_RUN" != "1" ]]; then
    printf '[strategist] telegram notify skipped: dry-run\n' >> "$RAW_OUT_PATH"
    return 0
  fi

  if [[ ! -f "$TELEGRAM_NOTIFY_SCRIPT" ]]; then
    printf '[strategist] telegram notify skipped: script missing\n' >> "$RAW_OUT_PATH"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    printf '[strategist] telegram notify skipped: node missing\n' >> "$RAW_OUT_PATH"
    return 0
  fi

  if node "$TELEGRAM_NOTIFY_SCRIPT" \
    --agent strategist \
    --status "$status" \
    --report "$OUT_PATH" >> "$RAW_OUT_PATH" 2>&1; then
    printf '[strategist] telegram notify sent\n' >> "$RAW_OUT_PATH"
  else
    printf '[strategist] telegram notify failed\n' >> "$RAW_OUT_PATH"
  fi
}

python3 - "$PROMPT_PATH" "${CONTEXT_FILES[@]}" <<'PY'
import sys
from pathlib import Path

out = Path(sys.argv[1])
files = [Path(p) for p in sys.argv[2:]]
parts = []
for p in files:
    if p.exists():
        text = p.read_text(encoding='utf-8', errors='ignore').strip()
        if text:
            parts.append(f"## Source: {p.name}\n\n{text[:6000]}")

context = "\n\n".join(parts)

prompt = f"""Ты стратегический агент проекта Sami. Запуск: 1 раз в день утром.

Цель: построить Telegram-сообщество так, чтобы оно конвертировалось в будущий запуск приложения.

ВАЖНО — экономия токенов:
- Будь лаконичен. Не повторяй контекст обратно.
- Каждый раздел: 3-5 конкретных пунктов, без воды.
- Общий объём отчёта: до 3000 слов (не больше).
- Фокус на actionable items, а не описания.

Обязательные блоки:
1. ## Резюме — 5-7 кратких буллетов (самое важное)
2. ## Фокус дня — 3 конкретных действия на сегодня
3. ## Эксперименты — таблица: гипотеза, шаги, метрика, дедлайн (только активные)
4. ## Метрики — North Star + 3-4 ведущих показателя (цифры, не описания)
5. ## Решения — 3 решения для владельца проекта
6. ## Ресерч — 3 внешних инсайта с источниками

Также включи (кратко, по 2-3 пункта):
- Позиционирование и ICP
- Контентные рубрики
- Growth loops
- Риски

Обязательно в конце добавь блок:
// COMMUNITY_PACKET_START
{{JSON с полями: week_focus, content_themes, challenge_active, challenge_name, search_keywords (stretching/strength/mobility), community_priority}}
// COMMUNITY_PACKET_END

Формат: валидный Markdown. Заголовок: "# Sami Strategist Report — YYYY-MM-DD".
Пиши на русском. Только текстовый отчёт, без команд и файловых операций.

Контекст проекта:
{context}
"""

out.write_text(prompt, encoding='utf-8')
PY

if [[ "$DRY_RUN" == "1" ]]; then
  REPORT_NAME="${STAMP_LOCAL}__strategist-dry-run.md"
  OUT_PATH="$ARCHIVE_DIR/$REPORT_NAME"
  cat > "$OUT_PATH" <<EOF
# Sami Strategist Report — $STAMP_DAY

## Резюме
- Dry-run успешно выполнен.
- Проверен пайплайн генерации отчёта.
- Реальный запуск Codex в этом прогоне отключён.

## Статус
- Timestamp (UTC): $STAMP_UTC
- Mode: dry-run
EOF
  NOTIFICATION_STATUS="$(run_google_sync "dry_run" 0)"
  run_telegram_notify "dry_run"
  write_latest_json "dry_run" 0 "$NOTIFICATION_STATUS"
  write_latest_md "dry_run" 0
  echo "[$STAMP_UTC] status=dry_run report=$OUT_PATH" >> "$LOG_PATH"
  exit 0
fi

if [[ "$FULL_ACCESS_MODE" == "1" ]]; then
  MODE_FLAG="--dangerously-bypass-approvals-and-sandbox"
else
  MODE_FLAG="--full-auto"
fi

set +e
RUNNER_KIND="$STRATEGIST_GENERATOR"
if [[ "$RUNNER_KIND" == "codex" ]]; then
  CODEX_BIN="$(resolve_codex_bin || true)"
  if [[ -z "$CODEX_BIN" ]]; then
    printf 'codex executable not found in PATH\n' > "$RAW_OUT_PATH"
    RC=127
  else
    TIMEOUT_MARK="$INTERNAL_DIR/.timeout-$STAMP_LOCAL"
    CMD=("$CODEX_BIN" exec --cd "$CONTEXT_ROOT" --skip-git-repo-check "$MODE_FLAG")
    if [[ -n "$CODEX_PROFILE" ]]; then
      CMD+=(--profile "$CODEX_PROFILE")
    fi
    CMD+=(-m "$CODEX_MODEL")
    if [[ -n "$CODEX_REASONING" ]]; then
      CMD+=(-c "model_reasoning_effort=\"$CODEX_REASONING\"")
    fi
    CMD+=(-o "$OUT_PATH" -)
    : > "$RAW_OUT_PATH"
    if [[ "$ENABLE_SEARCH" == "1" ]]; then
      printf '[strategist] web search requested; relying on codex built-in capabilities\n' >> "$RAW_OUT_PATH"
    fi
  fi
elif [[ "$RUNNER_KIND" == "claude" ]]; then
  if ! command -v claude >/dev/null 2>&1; then
    printf 'claude executable not found in PATH\n' > "$RAW_OUT_PATH"
    RC=127
  else
    TIMEOUT_MARK="$INTERNAL_DIR/.timeout-$STAMP_LOCAL"
    CMD=(claude --print --output-format text --model "$CLAUDE_MODEL")
    : > "$RAW_OUT_PATH"
  fi
elif [[ ! -f "$OPENAI_RUNNER_SCRIPT" ]]; then
  printf 'strategist OpenAI runner script not found: %s\n' "$OPENAI_RUNNER_SCRIPT" > "$RAW_OUT_PATH"
  RC=127
elif ! command -v node >/dev/null 2>&1; then
  printf 'node executable not found in PATH\n' > "$RAW_OUT_PATH"
  RC=127
else
  TIMEOUT_MARK="$INTERNAL_DIR/.timeout-$STAMP_LOCAL"
  CMD=(node "$OPENAI_RUNNER_SCRIPT" \
    --prompt "$PROMPT_PATH" \
    --output "$OUT_PATH" \
    --model "$CODEX_MODEL" \
    --reasoning "$CODEX_REASONING")

  : > "$RAW_OUT_PATH"
  if [[ "$ENABLE_SEARCH" == "1" ]]; then
    printf '[strategist] STRATEGIST_ENABLE_WEB_SEARCH=1 ignored: strategist uses direct OpenAI API without web tools\n' >> "$RAW_OUT_PATH"
  fi
fi

if [[ -n "${CMD[*]:-}" ]]; then
  ATTEMPT=1
  RC=1
  while [[ "$ATTEMPT" -le "$MAX_RETRIES" ]]; do
    echo "[strategist] attempt $ATTEMPT/$MAX_RETRIES" >> "$RAW_OUT_PATH"
    rm -f "$TIMEOUT_MARK"

    if [[ "$RUNNER_KIND" == "codex" ]]; then
      (
        OPENAI_API_KEY="" \
        OTEL_SDK_DISABLED="${OTEL_SDK_DISABLED:-true}" \
        OTEL_TRACES_EXPORTER="${OTEL_TRACES_EXPORTER:-none}" \
        OTEL_METRICS_EXPORTER="${OTEL_METRICS_EXPORTER:-none}" \
        OTEL_LOGS_EXPORTER="${OTEL_LOGS_EXPORTER:-none}" \
        "${CMD[@]}" < "$PROMPT_PATH" >> "$RAW_OUT_PATH" 2>&1
      ) &
    elif [[ "$RUNNER_KIND" == "claude" ]]; then
      (
        unset CLAUDECODE
        "${CMD[@]}" < "$PROMPT_PATH" > "$OUT_PATH" 2>> "$RAW_OUT_PATH"
      ) &
    else
      (
        "${CMD[@]}" >> "$RAW_OUT_PATH" 2>&1
      ) &
    fi
    RUN_PID="$!"

    (
      sleep "$TIMEOUT_SEC"
      if kill -0 "$RUN_PID" 2>/dev/null; then
        printf '\n[strategist] timed out after %ss\n' "$TIMEOUT_SEC" >> "$RAW_OUT_PATH"
        : > "$TIMEOUT_MARK"
        kill -TERM "$RUN_PID" 2>/dev/null || true
        pkill -TERM -P "$RUN_PID" 2>/dev/null || true
        sleep 5
        kill -KILL "$RUN_PID" 2>/dev/null || true
        pkill -KILL -P "$RUN_PID" 2>/dev/null || true
      fi
    ) &
    WATCHDOG_PID="$!"

    wait "$RUN_PID"
    RC="$?"
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true

    if [[ -f "$TIMEOUT_MARK" ]]; then
      RC=124
      rm -f "$TIMEOUT_MARK"
    fi

    if [[ "$RC" -eq 0 ]]; then
      break
    fi

    if grep -Eq "fetch failed|timed out|stream disconnected before completion|error sending request for url \\(https://api.openai.com/v1/responses\\)|openai_request_failed:(408|409|429|500|502|503|504)|overloaded_error|rate_limit_error|529" "$RAW_OUT_PATH"; then
      if [[ "$ATTEMPT" -lt "$MAX_RETRIES" ]]; then
        echo "[strategist] transient network error, retry in ${RETRY_SLEEP_SEC}s" >> "$RAW_OUT_PATH"
        sleep "$RETRY_SLEEP_SEC"
        ATTEMPT=$((ATTEMPT + 1))
        continue
      fi
    fi
    break
  done
fi
set -e

if [[ "$RC" -ne 0 ]]; then
  create_error_report "$RC"
else
  ensure_summary_block
fi

if [[ ! -s "$OUT_PATH" ]]; then
  create_error_report "${RC:-1}"
fi

STATUS="completed"
if [[ "$RC" -ne 0 ]]; then
  STATUS="failed"
fi
NOTIFICATION_STATUS="$(run_google_sync "$STATUS" "$RC")"
run_telegram_notify "$STATUS"
write_latest_json "$STATUS" "$RC" "$NOTIFICATION_STATUS"
write_latest_md "$STATUS" "$RC"
echo "[$STAMP_UTC] status=$STATUS code=$RC report=$OUT_PATH" >> "$LOG_PATH"
exit "$RC"
