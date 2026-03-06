# CLAUDE.md

This repository is for building small autonomous agents for the SAMI project.

---

## 🗂 БЭКЛОГ — последнее обновление: 6 марта 2026

### Что такое SAMI
Фитнес-приложение. Помогает пользователям двигаться каждый день без давления и мотивационного шума. Три тренировки в день (стретчинг / силовая / мобильность), персонализация по целям и уровню, стрики, фид и конструктор тренировок.

### Где сейчас находимся

| Компонент | Статус | Примечание |
|---|---|---|
| Strategist agent | ✅ работает | 3x в день через launchd, читает Google Calendar |
| Community agent (Telegram) | ✅ готов к запуску | код собран, бот — admin в канале и группе |
| SAMI мобильное приложение | 🔲 не начато | FlutterFlow + Supabase/Firebase |

### ✅ Сделано (community agent, март 2026)
- Бот `@sami_workout_bot` добавлен как admin в канал `@sami_daily`
- Бот добавлен как admin в группу `Sami Community`
- YouTube Data API v3 включён, API-ключ создан
- Env-файл заполнен: `~/.config/sami/community.env`
- TypeScript скомпилирован в `agents/community/dist/`
- Исправлена ошибка типов в `moderation.ts` (grammY `restrictChatMember`)

### 🔜 Следующий шаг — запустить community agent на Mac

```bash
cd agents/community
cp .env.production .env   # или скопировать ~/.config/sami/community.env
npm install               # скомпилирует better-sqlite3 под macOS
npm start                 # запуск
```

После запуска проверить:
- бот отвечает в `@sami_daily` (отправить `/start`)
- в 19:00 приходит approval DM от бота
- в 21:00 публикуется вечерний чекин

### 🔜 После запуска community agent — SAMI приложение (FlutterFlow)

Полный список задач: `APP_TASKS.md`

Приоритет:
1. **P0** — FlutterFlow проект + дизайн-токены + backend (Supabase) + онбординг
2. **P1** — Timeline: лента на день, карточки активностей, стрик
3. **P2** — Feed: фид тренировок, фильтры
4. **P3** — Workout Creator: визард создания тренировки
5. **P4** — Profile + уведомления + QA + TestFlight

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
- `strategist` — работает в продакшне
- `community` — собран, готов к запуску на Mac

Следующий проект:
- SAMI мобильное приложение (FlutterFlow)

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
- `agents/install-3x-daily-mac.sh`
- `agents/uninstall-3x-daily-mac.sh`

Important runtime details:
- Background `launchd` execution runs from `~/Library/Application Support/Sami` because macOS blocks reliable background execution from `~/Documents`.
- Local project reports path `reports/strategist` points to the active runtime reports location.
- Google Calendar sync is enabled.
- Google Drive upload is intentionally disabled.

Useful commands:

```bash
bash agents/strategist.sh
STRATEGIST_DRY_RUN=1 bash agents/strategist.sh
bash agents/install-3x-daily-mac.sh
bash agents/uninstall-3x-daily-mac.sh
```

Useful status files:
- `reports/strategist/.internal/latest.json`
- `reports/strategist/.internal/latest-notification.json`
- `reports/strategist/.internal/latest.md`

## Community Agent

Status: **active** — `agents/community/`

Target product:
- Telegram channel for daily workout posts (`@sami_daily` or configured via env)
- Linked discussion group for comments
- Bot-based moderation
- Daily evening check-in with inline buttons
- Tight integration with strategist outputs

Content model:
- 3 workout posts per day (YouTube videos, admin-approved):
  - 08:00 stretching
  - 12:00 strength
  - 17:00 mobility
- 1 evening check-in post at 21:00
- Evening video search + approval flow at 19:00 (sent to admin in DM)

Moderation layers:
- New member welcome + goal quiz (captcha-style, filters bots)
- Link restrictions for new members (first 24h or 5 messages)
- Auto-delete external links from non-admins
- Warning → mute → ban escalation
- Slow mode: 30s between messages

Integration contract:
- `strategist` produces markdown reports + `COMMUNITY_PACKET_START...END` JSON block
- `community-agent` reads that packet for YouTube search keywords and weekly focus
- `community-agent` writes daily stats to `reports/community/.internal/latest.json`
- `strategist` reads that file for next cycle context

Main entrypoints:
- `agents/community/src/bot.ts` — start bot
- `agents/community/src/scheduler.ts` — cron jobs
- `node agents/community/dist/index.js` — production run

Useful commands:
```bash
cd agents/community && npm install
npm run dev        # development with ts-node
npm run build && npm start  # production
```

Environment variables (store in `~/.config/sami/community.env`):
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`
- `TELEGRAM_GROUP_ID`
- `TELEGRAM_ADMIN_USER_ID`
- `YOUTUBE_API_KEY`
- `COMMUNITY_DB_PATH`

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
