#!/usr/bin/env bash
# Quick post-deploy health check for Sami community bot.
# Usage: bash agents/check-deploy.sh [--wait SECONDS]
#
# Checks: /health, /report/analytics, /report/community
# Waits for new deploy if --wait specified (default: polls every 15s for 3 min)

set -euo pipefail

BASE_URL="${SAMI_BOT_URL:-https://courageous-happiness-production.up.railway.app}"
WAIT_SEC=0
if [[ "${1:-}" == "--wait" ]]; then
  WAIT_SEC="${2:-180}"
fi
POLL_INTERVAL=15

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

check_endpoint() {
  local path="$1"
  local label="$2"
  local response
  response="$(curl -sf --max-time 10 "${BASE_URL}${path}" 2>/dev/null)" || {
    printf "${RED}FAIL${NC} %s — no response\n" "$label"
    return 1
  }
  printf "${GREEN}  OK${NC} %s\n" "$label"
  echo "     $response" | head -c 200
  echo ""
  return 0
}

# If --wait, poll /health until commit changes
if [[ "$WAIT_SEC" -gt 0 ]]; then
  BEFORE="$(curl -sf --max-time 5 "${BASE_URL}/health" 2>/dev/null || echo '{}')"
  BEFORE_COMMIT="$(echo "$BEFORE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit",""))' 2>/dev/null || echo "")"
  printf "${YELLOW}Waiting for new deploy (current: %s)...${NC}\n" "$BEFORE_COMMIT"

  ELAPSED=0
  while [[ "$ELAPSED" -lt "$WAIT_SEC" ]]; do
    sleep "$POLL_INTERVAL"
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
    NOW="$(curl -sf --max-time 5 "${BASE_URL}/health" 2>/dev/null || echo '{}')"
    NOW_COMMIT="$(echo "$NOW" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit",""))' 2>/dev/null || echo "")"
    if [[ -n "$NOW_COMMIT" && "$NOW_COMMIT" != "$BEFORE_COMMIT" ]]; then
      printf "${GREEN}New deploy detected: %s${NC}\n" "$NOW_COMMIT"
      break
    fi
    printf "  ... %ds elapsed\n" "$ELAPSED"
  done
fi

echo ""
echo "=== Sami Deploy Check ==="
echo ""

FAIL=0
check_endpoint "/health" "/health" || FAIL=1
echo ""
check_endpoint "/report/analytics" "/report/analytics" || FAIL=1
echo ""
check_endpoint "/report/community" "/report/community" || FAIL=1
echo ""

# Check strategist freshness
STRATEGIST_LATEST="${HOME}/Library/Application Support/Sami/reports/strategist/.internal/latest.json"
if [[ -f "$STRATEGIST_LATEST" ]]; then
  STRAT_TS="$(python3 -c "import json; print(json.load(open('$STRATEGIST_LATEST'))['timestamp'])" 2>/dev/null || echo "unknown")"
  STRAT_STATUS="$(python3 -c "import json; print(json.load(open('$STRATEGIST_LATEST'))['status'])" 2>/dev/null || echo "unknown")"
  printf "${GREEN}  OK${NC} strategist latest: %s (%s)\n" "$STRAT_TS" "$STRAT_STATUS"
else
  printf "${YELLOW}SKIP${NC} strategist latest.json not found\n"
fi

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  printf "${GREEN}All checks passed.${NC}\n"
else
  printf "${RED}Some checks failed.${NC}\n"
  exit 1
fi
