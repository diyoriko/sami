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

## Расписание 3 раза в день (macOS)

Установить:
```bash
bash agents/install-3x-daily-mac.sh
```

Важно:
- launchd runtime запускается не из `~/Documents`, а из `~/Library/Application Support/Sami`, потому что macOS TCC режет фоновым агентам прямой exec из `Documents`
- scheduled отчёты и служебные файлы лежат в `~/Library/Application Support/Sami/reports/strategist/`
- launchd stdout/stderr лежат в `~/Library/Logs/Sami/`
- рекомендуемый env-файл для launchd: `~/.config/sami/strategist.env`

Удалить:
```bash
bash agents/uninstall-3x-daily-mac.sh
```

## Полезные флаги

- `STRATEGIST_DRY_RUN=1` — проверить пайплайн без запуска codex
- `STRATEGIST_NOTIFY_ON_DRY_RUN=1` — тестировать Google Calendar sync даже в dry-run
- `STRATEGIST_GENERATOR=codex` — генератор отчёта по умолчанию; использует локальную авторизацию Codex
- `STRATEGIST_TIMEOUT_SEC=900` — таймаут запуска
- `STRATEGIST_FULL_ACCESS_MODE=0` — запуск в sandbox режиме
- `STRATEGIST_ENABLE_WEB_SEARCH=0` — legacy флаг, в текущем CLI игнорируется
- `STRATEGIST_CODEX_PROFILE=agents` — опциональный профиль codex; по умолчанию не используется
- `STRATEGIST_CODEX_MODEL=gpt-5.4` — модель для агента
- `STRATEGIST_CODEX_REASONING=xhigh` — уровень reasoning для агента
- `STRATEGIST_CODEX_HOME=/path/to/codex-home` — опциональный изолированный Codex home; по умолчанию агент использует обычный `~/.codex`
- `STRATEGIST_MAX_RETRIES=5` — число автоповторов при сетевых обрывах
- `STRATEGIST_RETRY_SLEEP_SEC=12` — пауза между повторами
- `STRATEGIST_GOOGLE_CALENDAR_ID=primary` — календарь для cleanup старых strategist events
- `STRATEGIST_GOOGLE_TASKLIST_ID=@default` — task list для post-run задач
- `STRATEGIST_GOOGLE_DRIVE_FOLDER_ID=...` — если задан, отчёт загружается в Google Drive и ссылка идёт в событие
- `STRATEGIST_GOOGLE_OAUTH_CREDENTIALS_FILE=agents/google-oauth-client.json` — OAuth client JSON из Google Cloud
- `STRATEGIST_GOOGLE_TOKEN_FILE=reports/strategist/.internal/google-calendar-token.json` — refresh token для post-run sync
- `STRATEGIST_REPORT_PUBLIC_BASE_URL=https://.../reports/strategist` — опциональная внешняя ссылка на опубликованные markdown-отчёты

Пример dry-run:
```bash
STRATEGIST_DRY_RUN=1 bash agents/strategist.sh
```

## Google sync

`strategist.sh` умеет после каждого прогона:
- создать Google Task с результатом прогона;
- положить в задачу ссылку на результат или локальный путь к отчёту;
- опционально загрузить markdown-отчёт в Google Drive и использовать `webViewLink`.

One-time setup:
```bash
node agents/google-calendar-auth.mjs --credentials agents/google-oauth-client.json
```

Нужен OAuth Desktop App client из Google Cloud с включёнными Google Calendar API, Google Tasks API и Google Drive API.

Минимальные переменные окружения:
```bash
export STRATEGIST_GOOGLE_OAUTH_CREDENTIALS_FILE="/Users/diyoriko/Documents/Projects/Sami/agents/google-oauth-client.json"
export STRATEGIST_GOOGLE_TOKEN_FILE="/Users/diyoriko/Documents/Projects/Sami/reports/strategist/.internal/google-calendar-token.json"
export STRATEGIST_GOOGLE_CALENDAR_ID="primary"
export STRATEGIST_GOOGLE_TASKLIST_ID="@default"
export STRATEGIST_GOOGLE_DRIVE_FOLDER_ID="your_drive_folder_id"
```

Для launchd удобнее хранить эти переменные в `~/.config/sami/strategist.env`, например:
```bash
export OPENAI_API_KEY="..."
export STRATEGIST_GOOGLE_OAUTH_CREDENTIALS_FILE="/Users/diyoriko/Documents/Projects/Sami/agents/google-oauth-client.json"
export STRATEGIST_GOOGLE_TOKEN_FILE="/Users/diyoriko/Library/Application Support/Sami/google-calendar-token.json"
export STRATEGIST_GOOGLE_CALENDAR_ID="primary"
export STRATEGIST_GOOGLE_TASKLIST_ID="@default"
export STRATEGIST_GOOGLE_DRIVE_FOLDER_ID="your_drive_folder_id"
```

После этого любой запуск `bash agents/strategist.sh` создаёт:
- отчёт в `reports/strategist/`
- метаданные в `reports/strategist/.internal/latest.json`
- статус Google sync в `reports/strategist/.internal/latest-notification.json`
