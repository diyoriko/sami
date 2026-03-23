# CLAUDE.md

Правила работы с проектом SAMI.

## Quick Commands

При первом сообщении сессии или когда пользователь не уверен что делать — покажи эту таблицу:

| Команда | Что делает |
|---|---|
| `/catchup` | Утренний брифинг: стратег, метрики, что дальше |
| `/status` | Здоровье бота, аналитика, GitHub Actions |
| `/backlog` | Показать или обновить бэклог |
| `/deploy` | Typecheck → test → push → verify → отчёт + auto-save |
| `/save` | Сохранить сессию (перед уходом) |

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
| 1 | **Strategist** | Mac launchd (GitHub Actions готов при наличии API key) | Claude Sonnet 4.6 | вс 09:30 МСК |
| 2 | **Community** | Railway 24/7 | — | Поиск и посты вручную через бота |
| 3 | **Analytics** | модуль в community | — | 00:30 ежедневно + вс 10:00 + при старте |

### Как агенты связаны

```
Strategist (Mac launchd, вс 09:30 МСК)
  |- curl -> Railway /report/community, /report/analytics
  |- читает: STRATEGIST_BRIEF.md, COMMUNITY_TASKS.md, PRD и т.д.
  |- пишет: reports/strategist/*.md + COMMUNITY_PACKET
  |- Telegram DM -> admin

Community Bot (Railway 24/7)
  |- читает: COMMUNITY_PACKET -> YouTube search keywords
  |- поиск и публикация: вручную через кнопки бота (автокроны отключены)
  |- модерация: капча, auto-delete ссылок, /report
  |- HTTP :3000 -> /report/community, /report/analytics, /health
  |- постит: @sami_workouts канал

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
- Платформа: Mac launchd (GitHub Actions workflow готов, нужен ANTHROPIC_API_KEY)
- Уведомления: только Telegram DM
- Бриф: `STRATEGIST_BRIEF.md`
- Расписание: вс 09:30 МСК еженедельно

Команды:
```bash
bash agents/strategist.sh                          # запустить
STRATEGIST_DRY_RUN=1 bash agents/strategist.sh     # dry-run
bash agents/install-1x-daily-mac.sh                # установить cron
bash agents/uninstall-1x-daily-mac.sh              # удалить cron
```

---

## Алгоритм поиска видео

Когда админ нажимает "Неделя" в боте, для каждого дня определяется категория
(shared.ts `DAY_CATEGORY_MAP`: Пн=stretching, Вт=strength, ..., Вс=recovery).
Бот берёт случайный запрос из `CATEGORY_QUERIES[category]` (8-11 вариантов на RU/EN),
шлёт в YouTube Data API (`videoDuration=medium`, `maxResults=20`, `videoEmbeddable=true`),
затем скорит и показывает топ-3 для ручного выбора админом.

### Скоринг (youtube.ts)

`totalScore = brand * 0.50 + views * 0.35 + duration * 0.15` (веса в config.ts)

**Brand alignment** (0-100, базовый балл 50):
- Штрафы (вычитаются из 50, cap=60): weight loss (+25), fix body (+20), heavy equipment (+20),
  hype/clickbait (+15), competition (+15), wrong audience (+50), ALL CAPS title (+20)
- Бонусы (прибавляются): bodyweight/дома (+12), calm instructional (+8), SAMI pillars
  (mobility, flexibility, breathing, posture) (+6)

**Views** (0-100): бэнды 1M=100, 500K=85, 100K=70, 50K=55, 10K=40, 1K=20, иначе 5

**Duration** (0-100): ideal 8-20 мин=100, 4-8 мин=65, 20-25 мин=70, 25-30 мин=40, иначе=15.
Жёсткий фильтр: < 4 мин или > 30 мин — отбрасывается.

### Фильтры

- `wasPostedEver(videoId)` — SQLite blacklist, ранее опубликованные видео не повторяются
- `isVideoRejected(videoId)` — видео, отклонённые админом
- Дедупликация по каналу: макс 1 видео на YouTube-канал в выдаче
- Определение инвентаря: `detectEquipment` (гантели, штанга, резинка и т.д.)

### Чего НЕ делает

- Не учится на выборе админа (нет feedback loop)
- Не учитывает completion rate пользователей
- Не персонализирует выдачу под аудиторию

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

## Dashboard
- Architect Dashboard (localhost:3333) читает COMMUNITY_TASKS.md **live** при каждом запросе
- Дашборд НЕ статический — изменения в COMMUNITY_TASKS.md видны на localhost:3333/sami-backlog.html через ≤30 секунд
- Не нужно "пересобирать" дашборд — он всегда актуален

## Backlog & Session Discipline

- `COMMUNITY_TASKS.md` — единственный источник правды для задач
- При завершении задачи — отметить `[x]` в COMMUNITY_TASKS.md
- Новые задачи/баги, найденные в ходе работы — добавить в COMMUNITY_TASKS.md с приоритетом
- В конце сессии: обновить COMMUNITY_TASKS.md (отметить сделанное, добавить новое)

## Sprint → Release Process

1. **Sprint** — задачи в текущей секции COMMUNITY_TASKS.md
2. **Реализация** — код + тесты
3. **Деплой** — `git push origin main` → Railway auto-deploy + version bump (vX.Y.Z)
4. **Архивация** — закрытый спринт в `<details>`, открытые переносятся с причиной
5. **Max 3 релиза в неделю** — батчевать коммиты, каждый релиз = Railway restart

## Quality Gate

- `npm run typecheck` + `npm test` перед каждым деплоем (из `agents/community/`)
- Pre-commit hook: `tsc --noEmit` (настроен через `.githooks/`)
- CI: GitHub Actions `ci.yml` — typecheck + tests на каждый push/PR
- CodeRabbit: автоматический ревью PR → замечания попадают в `COMMUNITY_TASKS.md` через `coderabbit-to-backlog.yml`
- Coverage: `npm run test:coverage` — отчёт покрытия (@vitest/coverage-v8)

## Guardrails

- **Max 3 релиза в неделю** — батчевать fix-коммиты в один patch. Каждый релиз = Railway restart.
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
