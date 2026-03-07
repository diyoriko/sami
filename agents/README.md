# Sami Strategist Agent

## Быстрый старт

```bash
cd /Users/diyoriko/Documents/Projects/Sami
bash agents/strategist.sh
```

Отчеты сохраняются в:
- `reports/strategist/YYYY-MM-DD_HH-MM-SS__strategist-report.md`
- dry-run отчеты автоматически уходят в `reports/strategist/.internal/archive/`

Служебные файлы (логи, prompt, статус) сохраняются в скрытой папке:
- `reports/strategist/.internal/`

## Расписание 1 раз в день (macOS)

Установить:
```bash
bash agents/install-1x-daily-mac.sh
```

Важно:
- launchd runtime запускается из `~/Library/Application Support/Sami`, потому что macOS TCC режет фоновым агентам exec из `Documents`
- scheduled отчёты лежат в `~/Library/Application Support/Sami/reports/strategist/`
- launchd stdout/stderr лежат в `~/Library/Logs/Sami/`
- env-файл для launchd: `~/.config/sami/strategist.env`

Удалить:
```bash
bash agents/uninstall-1x-daily-mac.sh
```

## Генератор отчётов

По умолчанию используется **Claude** (`claude --print --model claude-sonnet-4-6`).
Требует авторизованный Claude CLI на Mac.

Полезные флаги:
- `STRATEGIST_GENERATOR=claude` — дефолт, использует Claude CLI (подписка Max)
- `STRATEGIST_CLAUDE_MODEL=claude-sonnet-4-6` — модель Claude
- `STRATEGIST_DRY_RUN=1` — проверить пайплайн без вызова модели
- `STRATEGIST_NOTIFY_ON_DRY_RUN=1` — тестировать Google sync даже в dry-run
- `STRATEGIST_TIMEOUT_SEC=900` — таймаут запуска
- `STRATEGIST_MAX_RETRIES=5` — число автоповторов при сетевых обрывах
- `STRATEGIST_RETRY_SLEEP_SEC=12` — пауза между повторами

Пример dry-run:
```bash
STRATEGIST_DRY_RUN=1 bash agents/strategist.sh
```

## Google sync

`strategist.sh` после каждого прогона:
- создаёт Google Task с результатом
- опционально загружает отчёт в Google Drive

One-time setup:
```bash
node agents/google-calendar-auth.mjs --credentials agents/google-oauth-client.json
```

Минимальные переменные окружения (в `~/.config/sami/strategist.env`):
```bash
export STRATEGIST_GOOGLE_OAUTH_CREDENTIALS_FILE="/Users/diyoriko/Documents/Projects/Sami/agents/google-oauth-client.json"
export STRATEGIST_GOOGLE_TOKEN_FILE="/Users/diyoriko/Documents/Projects/Sami/reports/strategist/.internal/google-calendar-token.json"
export STRATEGIST_GOOGLE_CALENDAR_ID="primary"
export STRATEGIST_GOOGLE_TASKLIST_ID="@default"
```
