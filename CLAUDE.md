# CLAUDE.md

This repository is for building small autonomous agents for the SAMI project.

---

## 🗂 БЭКЛОГ — последнее обновление: 7 марта 2026

### Что такое SAMI
Фитнес-приложение. Миссия — выстроить огромное комьюнити в России вокруг спорта на коврике в любом месте. Помогает пользователям двигаться каждый день без давления и мотивационного шума. Три тренировки в день (стретчинг / силовая / мобильность), персонализация по целям и уровню, стрики, фид и конструктор тренировок.

### Архитектура агентов (финальная)

| # | Агент | Статус | Что делает | Расписание |
|---|---|---|---|---|
| 1 | **Strategist** | ✅ работает | Лаконичный стратегический отчёт + COMMUNITY_PACKET, Telegram DM | 1x/день 09:00 МСК (launchd) |
| 2 | **Community (SMM)** | ✅ на Railway | YouTube поиск → approval → посты в @sami_daily, чекины, модерация | 19:00 поиск, 08/12/17 посты, 21:00 чекин (node-cron) |
| 3 | **Analytics** | ✅ модуль в community боте | Метрики Telegram (рост, engagement, check-in stats), еженедельный дашборд | 1x/день 00:30 + 1x/неделю вс 10:00 (node-cron) |
| 4 | **Content Curator** | ✅ модуль в community боте | Контент-план на неделю: tips, челленджи, мотивация, факты, опросы | 1x/неделю пн 09:00 (node-cron) |

### Как агенты связаны между собой

```
Strategist (1x/день, 09:00 МСК)
  ├── пишет: reports/strategist/.internal/latest.json + COMMUNITY_PACKET
  ├── читает: reports/community/.internal/latest.json (стат. от Community)
  └── читает: reports/analytics/.internal/latest.json (метрики от Analytics)

Community SMM (ежедневно)
  ├── читает: COMMUNITY_PACKET от Strategist → YouTube search keywords
  ├── читает: контент-план от Content Curator
  ├── пишет: reports/community/.internal/latest.json (daily stats)
  └── постит: @sami_daily канал + модерация группы

Analytics (ежедневно + еженедельно)
  ├── читает: reports/community/.internal/latest.json
  ├── читает: Telegram Bot API (chat member count, message stats)
  ├── пишет: reports/analytics/.internal/latest.json (метрики)
  └── пишет: reports/analytics/weekly-YYYY-WW.md (недельный дашборд)

Content Curator (еженедельно)
  ├── читает: COMMUNITY_PACKET от Strategist → темы недели
  ├── читает: reports/analytics/.internal/latest.json → что зашло
  ├── пишет: reports/content-curator/.internal/weekly-plan.json
  └── ищет: статьи, tips, челленджи, мемы (помимо YouTube)
```

### ✅ Сделано

**Strategist (полностью работает):**
- launchd plist установлен, запуск 1x/день (09:00 МСК)
- Claude-based deep research + отчёты на русском (claude-sonnet-4-6)
- Google Tasks sync — таска с ссылкой на локальный отчёт
- COMMUNITY_PACKET генерируется в каждом отчёте

**Community agent (работает на Railway):**
- Бот `@sami_workout_bot` admin в канале `@sami_daily` и группе `Sami Community`
- YouTube Data API v3 подключён, yt-dlp установлен (`/root/.nix-profile/bin/yt-dlp 2025.01.15`)
- Задеплоен на Railway, работает 24/7 независимо от Mac
- GitHub → Railway автодеплой: пуш в `main` → автоматический редеплой
- Railway Volume подключён: БД персистентна (`/data/community.db`)
- nixpacks.toml: `nodejs_22 + python3 + gcc + gnumake + yt-dlp + ffmpeg` (все нужны)
- Поиск видео: 1 видео на категорию, приоритет коврик-only, fallback с пометкой экипировки
- Апрув: кнопки `✅ Выбрать` + `🔄 Другое` (вместо пропустить), `↩️ Отменить` после выбора
- Модерация: math captcha при входе (мут → капча → правильный ответ → снятие мута → goal quiz)

**Analytics + Content Curator (модули в community боте):**
- Analytics: ежедневно 00:30, еженедельно вс 10:00 — собирает метрики, пишет JSON
- Content Curator: пн 09:00 — генерирует контент-план на неделю

**Синхронизация метрик стратегу — ✅ реализовано:**
- Community bot поднимает HTTP сервер на PORT=3000
- Endpoints: `GET /report/community` и `GET /report/analytics` (JSON), `GET /health`
- Публичный URL: `https://courageous-happiness-production.up.railway.app`
- Стратег делает `curl` перед запуском, сохраняет в `reports/community/.internal/` и `reports/analytics/.internal/`
- Отчёты появляются после первого запуска analytics (00:30 МСК)

### 🔜 Следующие шаги (приоритет)

**P1 — ✅ выполнено (метрики синхронизированы)**

**⏸ Мобильное приложение и лендинг — не в приоритете**
Начнём после того, как сообщество выйдет на стабильный engagement (waitlist > 500).
Подробности задач: `APP_TASKS.md`

---

## Working Style

- Prefer code and working automation over long explanations.
- Keep architecture minimal and practical.
- Use existing project patterns before adding abstractions.
- Keep dependencies small.
- Favor readable TypeScript/Node.js solutions.
- Communicate briefly and focus on execution.

## Project Context

Active agents:
- `strategist` — ✅ работает в продакшне (1x/день 09:00 МСК, launchd на Mac)
- `community` — ✅ работает на Railway (24/7, автодеплой из GitHub)
- `analytics` — ✅ модуль в community боте (00:30 + вс 10:00, данные на Railway)
- `content-curator` — ✅ модуль в community боте (пн 09:00)

GitHub: `https://github.com/diyoriko/sami`

Primary docs in repo:
- `COMMUNITY_TASKS.md` — бэклог: Telegram community agent
- `APP_TASKS.md` — бэклог: SAMI мобильное приложение (FlutterFlow)
- `SAMI_PRD_v1.md`
- `SAMI_MVP_SCOPE.md`
- `SAMI_DATA_MODEL.md`
- `SAMI_UI_MAP.md`
- `STRATEGIST_BRIEF.md`
- `COMMUNITY_PLAN.md` — архитектура community agent

## Strategist Runtime

Main entrypoints:
- `agents/strategist.sh`
- `agents/install-1x-daily-mac.sh`
- `agents/uninstall-1x-daily-mac.sh`

Important runtime details:
- Background `launchd` execution runs from `~/Library/Application Support/Sami` because macOS blocks reliable background execution from `~/Documents`.
- Local project reports path `reports/strategist` points to the active runtime reports location.
- Google Calendar sync is enabled.
- Google Drive upload is intentionally disabled.

Useful commands:

```bash
bash agents/strategist.sh
STRATEGIST_DRY_RUN=1 bash agents/strategist.sh
bash agents/install-1x-daily-mac.sh
bash agents/uninstall-1x-daily-mac.sh
```

Useful status files:
- `reports/strategist/.internal/latest.json`
- `reports/strategist/.internal/latest-notification.json`
- `reports/strategist/.internal/latest.md`

## Community Agent

Status: **✅ production on Railway** — `agents/community/`

Railway:
- Project: `courageous-happiness` (ID: `af9dbf93-c76b-4224-8874-b0bca12682d0`)
- Service ID: `a15a112d-2225-4e22-9df3-979fe1c9b021`
- Auto-deploy: GitHub `main` branch → Railway
- Logs: Railway dashboard → сервис → Deployments

Telegram:
- Bot: `@sami_workout_bot`
- Channel: `@sami_daily` (ID: `-1003746963456`)
- Group: `Sami Community` (ID: `-1003604276410`)
- Admin user ID: `85013206`

Content model:
- 3 workout posts одновременно в 08:00 (stretching + strength + mobility)
- 1 evening check-in post at 22:00
- Video search + approval flow at 19:00 (ищет видео на ЗАВТРА, отправляет в DM)
- 1 video per category; `🔄 Другое` для замены; `↩️ Отменить` после выбора
- yt-dlp скачивает видео и постит файлом (не ссылкой); fallback — ссылка

Admin commands (в личке боту):
- `/status` — статистика чекинов за день
- `/search` — найти видео на завтра
- `/reset` — сбросить выбор на завтра (для повторного /search)
- `/post` — опубликовать все 3 видео сегодня
- `/checkin` — опубликовать вечерний чекин вручную
- `/analytics` — запустить аналитику вручную
- `/curator` — запустить контент-план вручную

Moderation layers:
- Math captcha при входе: мут → пример → правильный ответ → снятие мута → goal quiz
- Неправильный ответ или таймаут 2 мин → кик (может вернуться)
- Auto-delete external links from non-admins + warning → mute 24h → ban
- /report команда для жалоб

Integration contract:
- `strategist` produces markdown reports + `COMMUNITY_PACKET_START...END` JSON block
- `community-agent` reads that packet for YouTube search keywords and weekly focus
- `community-agent` writes daily stats to `reports/community/.internal/latest.json` (на Railway)
- `strategist` должен читать этот файл, но он на Railway — синхронизация не реализована (P1)

Local development:
```bash
cd agents/community
npm install
npm run dev        # development with ts-node
npm run build && npm start  # production local
```

Deploy:
```bash
git add . && git commit -m "..." && git push origin main
# Railway автоматически подхватывает и деплоит
```

Environment variables (в Railway):
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`
- `TELEGRAM_GROUP_ID`
- `TELEGRAM_ADMIN_USER_ID`
- `YOUTUBE_API_KEY`
- `COMMUNITY_DB_PATH=/data/community.db` (Railway Volume смонтирован, данные персистентны)

## Implementation Preferences

- Preferred stack: `Node.js`, `TypeScript`, `SQLite`
- For Telegram, prefer `grammY` or `Telegraf`
- Use `zod` for structured validation
- Keep files modular but not over-engineered

## Guardrails

- Do not assume Telegram bots can create groups autonomously; prefer manual channel/group creation and then add the bot.
- Do not rely on Google Drive for report delivery in this repo.
- Do not delete or rewrite existing user data unless explicitly asked.
- For agent automation, prefer deterministic logs and machine-readable outputs.

## When Extending The Repo

- Add new agent code under `agents/`
- Add reports under `reports/<agent-name>/`
- Add setup notes to `agents/README.md` when operational behavior changes
- Keep environment variables documented near the agent that uses them
