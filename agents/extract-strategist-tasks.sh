#!/bin/bash
# Extract BACKLOG_PROPOSALS from strategist report and send as proposals for admin approval.
# Tasks are sent to Telegram with Approve/Reject buttons.
# Approved tasks are fetched via GET /proposals on next run by apply-proposals.sh.
#
# Usage:
#   bash agents/extract-strategist-tasks.sh <report-file> <backlog-file> [bot-token] [admin-chat-id] [bot-url]

set -euo pipefail

REPORT_FILE="$1"
BACKLOG_FILE="$2"
BOT_TOKEN="${3:-}"
ADMIN_CHAT_ID="${4:-}"
BOT_URL="${5:-}"

if [ ! -f "$REPORT_FILE" ]; then
  echo "Report not found: $REPORT_FILE"
  exit 1
fi

if [ ! -f "$BACKLOG_FILE" ]; then
  echo "Backlog not found: $BACKLOG_FILE"
  exit 1
fi

# Extract tasks from BACKLOG_PROPOSALS block
TASKS=$(awk '
  /\/\/ BACKLOG_PROPOSALS_START/ { found=1; next }
  /\/\/ BACKLOG_PROPOSALS_END/ { if(found) exit }
  /^- / { if(found) print }
' "$REPORT_FILE")

if [ -z "$TASKS" ]; then
  echo "No new tasks found in report"
  exit 0
fi

TASK_COUNT=$(echo "$TASKS" | wc -l | tr -d ' ')
echo "Found $TASK_COUNT new tasks"

# Check for duplicates against existing backlog and send proposals
SENT=0
while IFS= read -r task; do
  # Extract task name (text after priority tags, or bold text)
  TASK_NAME=$(echo "$task" | sed -n 's/.*\*\*\(.*\)\*\*.*/\1/p')
  if [ -z "$TASK_NAME" ]; then
    # Try extracting from [sprint:N] [priority:PN] format
    TASK_NAME=$(echo "$task" | sed -n 's/^- \[sprint:[0-9]*\] \[priority:P[0-3]\] \(.*\)/\1/p')
  fi
  if [ -z "$TASK_NAME" ]; then
    # Last resort: use entire line without leading "- "
    TASK_NAME=$(echo "$task" | sed 's/^- //')
  fi

  if [ -z "$TASK_NAME" ]; then
    continue
  fi

  # Check if task already exists in backlog
  if grep -qF "$TASK_NAME" "$BACKLOG_FILE"; then
    echo "Skip (exists): $TASK_NAME"
    continue
  fi

  # If no bot credentials, just log
  if [ -z "$BOT_TOKEN" ] || [ -z "$ADMIN_CHAT_ID" ] || [ -z "$BOT_URL" ]; then
    echo "No bot credentials — skipping: $TASK_NAME"
    continue
  fi

  # Save proposal to bot DB via HTTP and get ID
  PROPOSAL_ID=$(curl -s -X POST "${BOT_URL}/proposal" \
    -H "Content-Type: application/json" \
    -H "x-admin-token: ${BOT_TOKEN}" \
    -d "{\"task_text\": $(echo "$task" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('id', ''))" 2>/dev/null || echo "")

  if [ -z "$PROPOSAL_ID" ]; then
    echo "Failed to save proposal to bot DB, skipping: $TASK_NAME"
    continue
  fi

  # Send as Telegram message with Approve/Reject inline buttons
  python3 -c "
import json, urllib.request, re

task_text = $(echo "$task" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')

# Clean markdown for Telegram readability
task_text = re.sub(r'\*\*(.+?)\*\*', r'\1', task_text)
task_text = re.sub(r'\*(.+?)\*', r'\1', task_text)
task_text = re.sub(r'^[-*]\s+', '\u2022 ', task_text, flags=re.MULTILINE)

payload = {
    'chat_id': '${ADMIN_CHAT_ID}',
    'text': f'\U0001F4CB \u041F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0430:\n\n{task_text}',
    'reply_markup': {
        'inline_keyboard': [[
            {'text': '\u2705 \u041E\u0434\u043E\u0431\u0440\u0438\u0442\u044C', 'callback_data': 'prop_approve:${PROPOSAL_ID}'},
            {'text': '\u274C \u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C', 'callback_data': 'prop_reject:${PROPOSAL_ID}'}
        ]]
    }
}
data = json.dumps(payload).encode()
req = urllib.request.Request(
    'https://api.telegram.org/bot${BOT_TOKEN}/sendMessage',
    data=data,
    headers={'Content-Type': 'application/json'}
)
try:
    urllib.request.urlopen(req)
except Exception as e:
    print(f'Telegram send failed: {e}')
" 2>&1 || echo "Telegram notification failed for: $TASK_NAME"

  echo "Sent proposal: $TASK_NAME (id: $PROPOSAL_ID)"
  SENT=$((SENT + 1))
done <<< "$TASKS"

echo "Sent $SENT proposals for approval"
