# CLAUDE.md

Правила работы с проектом SAMI.

---

## Что такое SAMI

Telegram-сообщество вокруг ежедневного движения на коврике. Видео-тренировки по стретчингу, мобильности и силе — дома или где угодно, с инвентарём или без.

Миссия: тёплая, честная и эстетичная среда для заботы о теле. Нужен только коврик.
One-liner: "Не мотивация. Структура."

Приложение, лендинг, waitlist — НЕ в приоритете. Весь фокус на Telegram.

---

## Архитектура агентов

| # | Агент | Платформа | Модель | Расписание |
|---|---|---|---|---|
| 1 | **Strategist** | launchd на Mac | Claude Sonnet 4.6 | 12:30 МСК |
| 2 | **Community** | Railway 24/7 | — | 07:30/12:00/19:00 посты, 19:00 поиск |
| 3 | **Analytics** | модуль в community | — | 00:30 ежедневно + вс 10:00 + при старте |

### Как агенты связаны

```
Strategist (Mac, 12:30 МСК)
  |- curl -> Railway /report/community, /report/analytics
  |- читает: STRATEGIST_BRIEF.md, COMMUNITY_TASKS.md, PRD и т.д.
  |- пишет: reports/strategist/*.md + COMMUNITY_PACKET
  |- Telegram DM -> admin

Community Bot (Railway 24/7)
  |- читает: COMMUNITY_PACKET -> YouTube search keywords
  |- cron: 07:30 стретчинг, 12:00 силовая, 19:00 мобильность
  |- модерация: капча, auto-delete ссылок, /report
  |- HTTP :3000 -> /report/community, /report/analytics, /health
  |- постит: @sami_daily канал

Analytics (модуль в community, Railway)
  |- при старте + 00:30: собирает метрики -> reports/analytics/.internal/latest.json
  |- вс 10:00: недельный дашборд
```

---

## Telegram

| Параметр | Значение |
|---|---|
| Бот | `@sami_workout_bot` (отображается как "Сами botik") |
| Канал | `@sami_workouts` ("Сами") (`-1003746963456`) |
| Группа | "Сами Daily" (`-1003604276410`) |
| Admin user ID | `85013206` |

Admin-команды (в личке боту):
`/status` `/search` `/reset` `/post` `/analytics`

---

## Railway

| Параметр | Значение |
|---|---|
| Проект | `courageous-happiness` |
| Project ID | `af9dbf93-c76b-4224-8874-b0bca12682d0` |
| Service ID | `a15a112d-2225-4e22-9df3-979fe1c9b021` |
| Public URL | `https://courageous-happiness-production.up.railway.app` |
| Volume | `/data/community.db` |
| nixpacks | `nodejs_22 + python3 + gcc + gnumake + yt-dlp + ffmpeg` |

Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_GROUP_ID`, `TELEGRAM_ADMIN_USER_ID`, `YOUTUBE_API_KEY`, `COMMUNITY_DB_PATH=/data/community.db`, `CLAUDE_AUTH_TOKEN`

Деплой:
```bash
git add . && git commit -m "..." && git push origin main
# Railway автоматически подхватывает
```

---

## Strategist

- Entrypoint: `agents/strategist.sh`
- Генератор: `claude --print --model claude-sonnet-4-6` (дефолт)
- launchd plist: `com.sami.strategist`
- Runtime: `~/Library/Application Support/Sami/agents/`
- Google Calendar sync включён, Drive upload выключен
- Бриф: `STRATEGIST_BRIEF.md`
- Расписание: 12:30 МСК ежедневно

Команды:
```bash
bash agents/strategist.sh                          # запустить
STRATEGIST_DRY_RUN=1 bash agents/strategist.sh     # dry-run
bash agents/install-1x-daily-mac.sh                # установить cron
bash agents/uninstall-1x-daily-mac.sh              # удалить cron
```

---

## Документы проекта

| Файл | Что содержит |
|---|---|
| `COMMUNITY_TASKS.md` | Бэклог: спринты, приоритеты, задачи |
| `STRATEGIST_BRIEF.md` | Контекст и задание для стратега |

---

## Working Style

- Код и автоматизация > объяснения
- Архитектура минимальная и практичная
- Существующие паттерны > новые абстракции
- Зависимости маленькие
- TypeScript/Node.js, читаемый код
- Кратко, фокус на execution

## Implementation Preferences

- Стек: Node.js, TypeScript, SQLite
- Telegram: grammY
- Валидация: zod
- Модульно, но без over-engineering

## Guardrails

- Не создавать группы/каналы автоматически — только вручную, потом добавлять бота
- Не полагаться на Google Drive для доставки отчётов
- Не удалять пользовательские данные без явного запроса
- Детерминированные логи, machine-readable outputs
- Все даты в МСК (модуль `dates.ts`)

## Extending The Repo

- Код агентов: `agents/`
- Отчёты: `reports/<agent-name>/`
- Изменения в поведении -> обновить `agents/README.md`
- Env variables -> документировать рядом с агентом
