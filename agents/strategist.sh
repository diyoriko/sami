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
STRATEGIST_GENERATOR="${STRATEGIST_GENERATOR:-claude}"
CLAUDE_MODEL="${STRATEGIST_CLAUDE_MODEL:-claude-sonnet-4-6}"
MAX_RETRIES="${STRATEGIST_MAX_RETRIES:-5}"
RETRY_SLEEP_SEC="${STRATEGIST_RETRY_SLEEP_SEC:-12}"

# Emergency Telegram alert if script crashes before normal notification flow
_emergency_notified=0
emergency_notify() {
  [[ "$_emergency_notified" -eq 1 ]] && return
  _emergency_notified=1
  local exit_code="$?"
  if [[ ! -f "$LATEST_JSON" ]] || ! grep -q '"status"' "$LATEST_JSON" 2>/dev/null; then
    if command -v node >/dev/null 2>&1 && [[ -f "$TELEGRAM_NOTIFY_SCRIPT" ]]; then
      node "$TELEGRAM_NOTIFY_SCRIPT" \
        --agent strategist \
        --status "crash" \
        --summary "Strategist упал до завершения (exit $exit_code). Проверь логи." 2>/dev/null || true
    fi
  fi
}
trap emergency_notify EXIT

COMMUNITY_AGENT_URL="${COMMUNITY_AGENT_URL:-https://courageous-happiness-production.up.railway.app}"

# Use INTERNAL_DIR (runtime-safe) for curl downloads — avoids TCC blocks on Documents
COMMUNITY_REPORT_LOCAL="$INTERNAL_DIR/community-latest.json"
ANALYTICS_REPORT_LOCAL="$INTERNAL_DIR/analytics-latest.json"

# Fetch fresh metrics from Railway before building prompt
if curl -sf --max-time 10 "$COMMUNITY_AGENT_URL/report/community" -o "$COMMUNITY_REPORT_LOCAL" 2>/dev/null; then
  echo "[strategist] fetched community report from Railway"
else
  echo "[strategist] community report unavailable (ok, skipping)"
fi
if curl -sf --max-time 10 "$COMMUNITY_AGENT_URL/report/analytics" -o "$ANALYTICS_REPORT_LOCAL" 2>/dev/null; then
  echo "[strategist] fetched analytics report from Railway"
else
  echo "[strategist] analytics report unavailable (ok, skipping)"
fi

RECENT_SUMMARIES="$INTERNAL_DIR/recent-summaries.md"

EXPERIMENTS_JSON="$INTERNAL_DIR/experiments.json"
OWNER_DECISIONS_JSON="$INTERNAL_DIR/owner-decisions.json"

COMPETITOR_DIGEST="$INTERNAL_DIR/competitor-digest.json"
PROPOSAL_STATUS="$INTERNAL_DIR/proposal-status.md"

# Sync proposal statuses before generating prompt (non-critical)
SYNC_PROPOSALS_SCRIPT="${SAMI_AGENTS_DIR:-$SCRIPT_DIR}/sync-proposal-status.mjs"
if [[ -f "$SYNC_PROPOSALS_SCRIPT" ]] && command -v node >/dev/null 2>&1; then
  if node "$SYNC_PROPOSALS_SCRIPT" 2>&1; then
    echo "[strategist] proposal statuses synced"
  else
    echo "[strategist] proposal status sync failed (non-critical)"
  fi
fi

# Apply approved proposals to COMMUNITY_TASKS.md before building prompt (non-critical)
APPLY_PROPOSALS_SCRIPT="${SAMI_AGENTS_DIR:-$SCRIPT_DIR}/apply-proposals.sh"
TASKS_FILE="$CONTEXT_ROOT/COMMUNITY_TASKS.md"
API_KEY_FOR_PROPOSALS="${STRATEGIST_API_KEY:-${TELEGRAM_BOT_TOKEN:-}}"
if [[ -z "$API_KEY_FOR_PROPOSALS" ]]; then
  API_KEY_FOR_PROPOSALS="$(grep -m1 'STRATEGIST_API_KEY=' "$HOME/.config/sami/community.env" 2>/dev/null | cut -d= -f2- || true)"
fi
if [[ -z "$API_KEY_FOR_PROPOSALS" ]]; then
  API_KEY_FOR_PROPOSALS="$(grep -m1 'TELEGRAM_BOT_TOKEN=' "$HOME/.config/sami/community.env" 2>/dev/null | cut -d= -f2- || true)"
fi
if [[ -f "$APPLY_PROPOSALS_SCRIPT" && -f "$TASKS_FILE" && -n "$API_KEY_FOR_PROPOSALS" ]]; then
  if bash "$APPLY_PROPOSALS_SCRIPT" "$TASKS_FILE" "$API_KEY_FOR_PROPOSALS" "$COMMUNITY_AGENT_URL" 2>&1; then
    echo "[strategist] approved proposals applied to backlog"
  else
    echo "[strategist] apply proposals failed (non-critical)"
  fi
fi

CONTEXT_FILES=(
  "$CONTEXT_ROOT/STRATEGIST_BRIEF.md"
  "$CONTEXT_ROOT/COMMUNITY_TASKS.md"
  "$COMMUNITY_REPORT_LOCAL"
  "$ANALYTICS_REPORT_LOCAL"
  "$RECENT_SUMMARIES"
  "$EXPERIMENTS_JSON"
  "$OWNER_DECISIONS_JSON"
  "$COMPETITOR_DIGEST"
  "$PROPOSAL_STATUS"
)

write_latest_json() {
  local status="$1"
  local code="$2"
  python3 - "$LATEST_JSON" "$STAMP_UTC" "$status" "$code" "$OUT_PATH" "$REPORT_NAME" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "timestamp": sys.argv[2],
            "status": sys.argv[3],
            "exit_code": int(sys.argv[4]),
            "report_path": sys.argv[5],
            "report_file": sys.argv[6],
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
  python3 - "$LATEST_MD" "$STAMP_UTC" "$status" "$code" "$OUT_PATH" <<'PY'
import sys
from pathlib import Path

latest_md = Path(sys.argv[1])

lines = [
    "# Sami Strategist Report",
    "",
    f"- Timestamp: {sys.argv[2]}",
    f"- Status: {sys.argv[3]}",
    f"- Exit code: {sys.argv[4]}",
    f"- Report: {sys.argv[5]}",
]

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

# Extract summaries from last 5 strategist reports for memory/continuity
python3 - "$REPORT_DIR" "$RECENT_SUMMARIES" <<'PY'
import re
import sys
from pathlib import Path

report_dir = Path(sys.argv[1])
out_path = Path(sys.argv[2])

reports = sorted(
    report_dir.glob("*__strategist-report.md"),
    key=lambda p: p.name,
    reverse=True,
)[:5]

sections = []
for rp in reports:
    date = rp.name[:10]
    text = rp.read_text(encoding="utf-8", errors="ignore")
    match = re.search(r"^## Резюме\s*\n([\s\S]*?)(?:\n## |\n# |$)", text, re.MULTILINE)
    if match:
        bullets = [l for l in match.group(1).strip().splitlines() if l.strip().startswith("-")]
        if bullets:
            sections.append(f"### {date}\n" + "\n".join(bullets))

if sections:
    out_path.write_text(
        "# Резюме предыдущих отчётов\n\n" + "\n\n".join(sections) + "\n",
        encoding="utf-8",
    )
else:
    out_path.write_text("# Резюме предыдущих отчётов\n\nНет предыдущих отчётов.\n", encoding="utf-8")
PY
echo "[strategist] extracted recent summaries -> $RECENT_SUMMARIES"

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

ВАЖНО — тон и язык:
- Пиши ПО-ЧЕЛОВЕЧЕСКИ, как умный друг, а не как аналитик. Никаких «δ=0», «acquisition», «retention-механизм», «posts today = 0», «engagement», «ICP».
- Используй простой русский: «новых подписчиков нет», «никто не тренировался», «канал молчит».
- Формулировки должны быть понятны человеку без маркетингового образования.
- Метрики — конкретные цифры, но описывай словами: «3 подписчика, за неделю ни одного нового» вместо «subscribers: 3, δ=0, WAU=0».
- Фокус дня — как совет другу: «Запости тренировку — канал уже 2 дня молчит» вместо «Content cadence gap detected, publish immediately».
- Решения — простым языком: «Стоит написать 2-3 знакомым лично?» вместо «Outreach funnel: warm leads first».

ВАЖНО — экономия токенов:
- Будь лаконичен. Не повторяй контекст обратно.
- Каждый раздел: 3-5 конкретных пунктов, без воды.
- Общий объём отчёта: до 3000 слов (не больше).
- Фокус на actionable items, а не описания.

Обязательные блоки:
1. ## Резюме — 5-7 кратких буллетов (самое важное, простым языком)
2. ## Фокус дня — 3 конкретных действия на сегодня (как совет другу)
3. ## Эксперименты — таблица: гипотеза, шаги, метрика, дедлайн (только активные)
4. ## Метрики — главный показатель + 3-4 цифры (словами, не кодом)
5. ## Решения — 3 решения для владельца проекта (без жаргона)
6. ## Ресерч — 3 внешних инсайта с источниками

ВАЖНО — контекст памяти:
- В контексте есть experiments.json — трекер активных экспериментов. Обновляй статус в разделе "Эксперименты".
- В контексте есть owner-decisions.json — решения владельца. НЕ предлагай то, что уже отклонено. Учитывай принятые решения.
- В контексте есть recent-summaries.md — резюме прошлых отчётов. Не повторяй одни и те же рекомендации.

Также включи (кратко, по 2-3 пункта):
- Позиционирование и целевая аудитория
- Контентные рубрики
- Как растёт сообщество (циклы роста)
- Риски

Обязательно добавь блок предложений в бэклог (если есть что предложить):
// BACKLOG_PROPOSALS_START
- [sprint:2|3|4|5] [priority:P1|P2] Краткое описание задачи — зачем и что конкретно сделать
- [sprint:3] [priority:P1] Пример: добавить welcome-quiz после капчи — повысит retention новичков
// BACKLOG_PROPOSALS_END
Правила: только новые задачи (не дублируй то что уже в COMMUNITY_TASKS.md). Максимум 5 предложений. Учитывай owner-decisions.json.
ВАЖНО: В контексте есть proposal-status.md — статусы твоих прошлых предложений (done/accepted/pending). НЕ повторяй accepted и done предложения. Сфокусируйся на новых идеях.

Обязательно в конце добавь блок:
// COMMUNITY_PACKET_START
{{JSON с полями: week_focus, content_themes, challenge_active, challenge_name, search_keywords (stretching/strength/mobility), community_priority, actions}}
// COMMUNITY_PACKET_END

Поле actions — массив конкретных действий для бота с одобрения админа.
Каждое действие: {{ type, description, params }}
Типы: "create_poll", "update_welcome", "limit_posts", "send_digest", "update_stop_list", "create_impl_task", "backlog_proposal"
Для backlog_proposal: params: {{ task: "**Название** — описание", priority: "P1" или "P2" }}
При одобрении задача автоматически добавится в COMMUNITY_TASKS.md через GitHub API.
Если нет предложений — actions: []

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
  run_telegram_notify "dry_run"
  write_latest_json "dry_run" 0
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

# POST COMMUNITY_PACKET to Railway bot (sync strategist → community bot)
if [[ "$STATUS" == "completed" && -s "$OUT_PATH" ]]; then
  PACKET_JSON="$(python3 - "$OUT_PATH" <<'PY'
import json
import re
import sys
from pathlib import Path

report = Path(sys.argv[1]).read_text(encoding="utf-8", errors="ignore")

# Extract COMMUNITY_PACKET
match = re.search(r"// COMMUNITY_PACKET_START\s*([\s\S]*?)// COMMUNITY_PACKET_END", report)
if not match:
    print("{}")
    sys.exit(0)

try:
    packet = json.loads(match.group(1).strip())
except json.JSONDecodeError:
    print("{}")
    sys.exit(0)

# Extract summary
summary_match = re.search(r"^## Резюме\s*\n([\s\S]*?)(?:\n## |\n# |$)", report, re.MULTILINE)
summary = None
if summary_match:
    bullets = [l.strip() for l in summary_match.group(1).split("\n") if l.strip().startswith("- ")][:5]
    summary = "\n".join(bullets) if bullets else None

payload = {"packet": packet}
if summary:
    payload["report"] = {"summary": summary}

print(json.dumps(payload, ensure_ascii=False))
PY
)"

  if [[ -n "$PACKET_JSON" && "$PACKET_JSON" != "{}" ]]; then
    # Use STRATEGIST_API_KEY if available, fall back to TELEGRAM_BOT_TOKEN
    API_KEY="${STRATEGIST_API_KEY:-}"
    if [[ -z "$API_KEY" ]]; then
      API_KEY="${TELEGRAM_BOT_TOKEN:-}"
    fi
    if [[ -z "$API_KEY" ]]; then
      API_KEY="$(grep -m1 'STRATEGIST_API_KEY=' "$HOME/.config/sami/community.env" 2>/dev/null | cut -d= -f2- || true)"
    fi
    if [[ -z "$API_KEY" ]]; then
      API_KEY="$(grep -m1 'TELEGRAM_BOT_TOKEN=' "$HOME/.config/sami/community.env" 2>/dev/null | cut -d= -f2- || true)"
    fi
    if [[ -n "$API_KEY" ]]; then
      if curl -sf --max-time 15 \
        -X POST "$COMMUNITY_AGENT_URL/packet" \
        -H "Content-Type: application/json" \
        -H "X-Admin-Token: $API_KEY" \
        -d "$PACKET_JSON" >/dev/null 2>&1; then
        echo "[strategist] COMMUNITY_PACKET posted to Railway" >> "$RAW_OUT_PATH"
      else
        echo "[strategist] failed to POST packet to Railway (non-critical)" >> "$RAW_OUT_PATH"
      fi
    else
      echo "[strategist] API key not found, skipping packet POST" >> "$RAW_OUT_PATH"
    fi
  fi
fi

# Extract BACKLOG_PROPOSALS from report (non-critical)
EXTRACT_PROPOSALS_SCRIPT="${SAMI_AGENTS_DIR:-$SCRIPT_DIR}/extract-backlog-proposals.mjs"
if [[ "$STATUS" == "completed" && -s "$OUT_PATH" && -f "$EXTRACT_PROPOSALS_SCRIPT" ]]; then
  if command -v node >/dev/null 2>&1; then
    if node "$EXTRACT_PROPOSALS_SCRIPT" "$OUT_PATH" >> "$RAW_OUT_PATH" 2>&1; then
      echo "[strategist] backlog proposals extracted" >> "$RAW_OUT_PATH"
    else
      echo "[strategist] backlog proposals extraction failed (non-critical)" >> "$RAW_OUT_PATH"
    fi
  fi
fi

# Send BACKLOG_PROPOSALS as Telegram proposals with Approve/Reject buttons (non-critical)
EXTRACT_TASKS_SCRIPT="${SAMI_AGENTS_DIR:-$SCRIPT_DIR}/extract-strategist-tasks.sh"
if [[ "$STATUS" == "completed" && -s "$OUT_PATH" && -f "$EXTRACT_TASKS_SCRIPT" && -f "$TASKS_FILE" ]]; then
  ADMIN_CHAT_ID="${TELEGRAM_ADMIN_USER_ID:-85013206}"
  ETK="${STRATEGIST_API_KEY:-${TELEGRAM_BOT_TOKEN:-}}"
  if [[ -z "$ETK" ]]; then
    ETK="$(grep -m1 'STRATEGIST_API_KEY=' "$HOME/.config/sami/community.env" 2>/dev/null | cut -d= -f2- || true)"
  fi
  TBT="${TELEGRAM_BOT_TOKEN:-}"
  if [[ -z "$TBT" ]]; then
    TBT="$(grep -m1 'TELEGRAM_BOT_TOKEN=' "$HOME/.config/sami/community.env" 2>/dev/null | cut -d= -f2- || true)"
  fi
  if [[ -n "$ETK" && -n "$TBT" ]]; then
    if bash "$EXTRACT_TASKS_SCRIPT" "$OUT_PATH" "$TASKS_FILE" "$TBT" "$ADMIN_CHAT_ID" "$COMMUNITY_AGENT_URL" >> "$RAW_OUT_PATH" 2>&1; then
      echo "[strategist] proposals sent for approval" >> "$RAW_OUT_PATH"
    else
      echo "[strategist] extract-strategist-tasks failed (non-critical)" >> "$RAW_OUT_PATH"
    fi
  fi
fi

# Google Calendar event with focus of the day
if [[ "$STATUS" == "completed" ]] && command -v gcalcli >/dev/null 2>&1; then
  FOCUS=$(grep -A 5 "## Фокус дня" "$OUT_PATH" 2>/dev/null | tail -4 | tr '\n' ' ' | cut -c1-200)
  if [ -n "$FOCUS" ]; then
    gcalcli add \
      --calendar "Personal" \
      --title "SAMI Strategist — $(date +%Y-%m-%d)" \
      --when "$(date -v+1H '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S')" \
      --duration 15 \
      --description "$FOCUS" \
      --noprompt 2>/dev/null && echo "[strategist] Google Calendar event created" >> "$RAW_OUT_PATH" \
      || echo "[strategist] Google Calendar event failed (non-critical)" >> "$RAW_OUT_PATH"
  fi
fi

run_telegram_notify "$STATUS"
write_latest_json "$STATUS" "$RC"
write_latest_md "$STATUS" "$RC"
echo "[$STAMP_UTC] status=$STATUS code=$RC report=$OUT_PATH" >> "$LOG_PATH"
_emergency_notified=1
exit "$RC"
