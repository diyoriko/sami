# COMMUNITY_TASKS.md — Бэклог Sami Community

Последнее обновление: 10 марта 2026

---

## Сделано

**v0.1.0 (08.03):**
- [x] Канал + группа + бот, Railway 24/7, автодеплой, persistent volume
- [x] YouTube Data API v3 + yt-dlp (видео файлом, cookies из env, мониторинг ошибок)
- [x] Approval flow: поиск -> 1 видео на категорию -> кнопки выбора
- [x] Модерация: math captcha, мут, auto-delete ссылок, /report
- [x] Автоперевод EN->RU, очистка кликбейта/капса, кириллический hype-strip
- [x] Расписание: 07:30 стретчинг, 12:00 силовая, 19:00 мобильность (крон определён, автопостинг отключён)
- [x] Стратег на Claude Sonnet 4.6, ежедневно 12:30
- [x] Analytics: 00:30 ежедневно + вс 10:00 + при старте
- [x] Формат поста: моно-теги, рейтинг, автор + оригинал, "Я сделал(а)" с live-счётчиком
- [x] Completions: запись в БД, дедупликация, метрики в аналитике
- [x] Рейтинг видео: 0.4*views + 0.3*likes + 0.2*channel + 0.1*completions
- [x] Persistent menu: "Мои тренировки", "Предложить тренировку", admin-кнопки
- [x] UGC: YouTube-ссылка -> категория -> сложность -> название -> модерация -> уведомление
- [x] "Мои тренировки": список загруженных пользователем тренировок со статусами
- [x] Тесты: vitest, 36 тестов
- [x] Residential proxy (Dataimpulse, 5GB)
- [x] Мониторинг: DM админу после 3 фейлов

**v0.2.0 (10.03):**
- [x] /post перехват UGC-хэндлером
- [x] Очередь не очищается после публикации
- [x] yt-dlp: async upgrade при старте, кэш бинаря, semver-сравнение
- [x] Стратег Mac: TCC fix, env vars, curl paths
- [x] Стратег → бот: POST /packet endpoint, COMMUNITY_PACKET в SQLite

**v0.2.1 (10.03):**
- [x] Дубликат поста: CHECK constraint убран, UNIQUE(date, category, video_id)
- [x] Атомарная публикация: withTransaction() вокруг recordPost + markApprovalPosted
- [x] post_type трекинг: различаем video/link в posts таблице
- [x] Капча в SQLite: pending_captchas таблица, periodic cleanup каждые 30с
- [x] UGC-диалог в SQLite: ugc_conversation_state таблица
- [x] Graceful shutdown: SIGTERM → bot.stop() + httpServer.close() + closeDb()

**v0.2.2 (10.03):**
- [x] Дубликат видео+текст: отделить DB-ошибку от upload-ошибки в poster.ts
- [x] backlog.html: auto-fetch COMMUNITY_TASKS.md с GitHub, парсинг MD, кэш в localStorage

**v0.2.3 (10.03):**
- [x] P0: Стратег launchd — PATH fix, контекст-синхронизация, TCC fallback
- [x] "Я сделал(а)" → "Я сделаль"
- [x] Админ-панель "Статус": подписчики, UGC, стратег, uptime
- [x] Аналитика: retention, completions по категориям, top-5 видео, cumulative, breakdown
- [x] analytics-latest.json + community-latest.json для стратега
- [x] DM формат: аналитика + deploy notification
- [x] Формат постов: теги на строках, автор как ссылка
- [x] Structured logging с correlation ID
- [x] Алерт с первого фейла, timeout + circuit breaker, rate limiting
- [x] Soft delete, отдельный API-ключ стратега, трекинг активности
- [x] Стратег: память (recent-summaries.md), Google Tasks убран → Telegram DM обогащён

**v0.2.4 (10.03):**
- [x] Очередь "Статус": фильтр сегодня/завтра, auto-cleanup, дедупликация
- [x] Аудит поиска видео: scoring weights + duration range в config.ts
- [x] backlog.html синхронизирован через sync-backlog-html.mjs
- [x] Стратег: experiments.json + owner-decisions.json в контексте

---

## SPRINT 2 — стабильность и polish

Статус: **завершён** | Текущая версия: v0.2.4 | Прогресс: 10/10

### P1: Очередь в "Статус" — только сегодня/завтра

- [x] **Фильтровать очередь по дате** — getApprovalQueue(fromDate, toDate), показывает только сегодня/завтра
- [x] **Очистка старых сессий** — cleanupOldApprovalSessions(2) при старте бота
- [x] **Дедупликация в очереди** — softDeletePendingSessions() при refresh

### P1: Аудит параметров поиска видео

- [x] **Ревизия youtube.ts** — scoring weights и duration range в config.ts, паттерны проверены

### P1: Автоматизация синхронизации бэклога

- [x] **Стратег → обновляет backlog.html** — agents/sync-backlog-html.mjs
- [x] **Стратег → обновляет COMMUNITY_TASKS.md** — BACKLOG_PROPOSALS в промпте + extract-backlog-proposals.mjs
- [x] **Бот → обновляет бэклог после деплоя** — deploy_history в SQLite, версия в /health, запись при старте

### P1: backlog.html — синхронизация с реальностью

- [x] **backlog.html актуализирован** — staticData регенерирован через sync-backlog-html.mjs

### P1: Стратег — память и feedback loop

- [x] **Трекер экспериментов:** experiments.json в контексте стратега
- [x] **Лог решений владельца:** owner-decisions.json в контексте стратега

---

## SPRINT 3 — операционка, качество, quick wins

Статус: **в работе** | Фокус: надёжность процессов, качество кода, первые UX-улучшения

### P1: Мониторинг деплоя (Web Fetch)

- [x] **Health check после пуша** — agents/check-deploy.sh: проверяет /health, /report/analytics, /report/community, strategist latest.json
- [x] **Проверка endpoints** — включена в check-deploy.sh, ждёт нового коммита через --wait
- [x] **Мониторинг стратега** — check-deploy.sh проверяет latest.json на свежесть

### P1: Code quality (/simplify)

- [x] **Аудит кода после Sprint 2** — проведён аудит youtube.ts, db.ts, approval.ts, bot-menu.ts, scheduler.ts
- [x] **Тесты на новый функционал** — 10 новых тестов (47 всего): getApprovalQueue, cleanupOldApprovalSessions, softDeletePendingSessions, computeTotalScore, deploy history, getLatestPostForDate

### P1: Стратег — реальный ресерч (Web Search)

- [x] **Дайджест конкурентов перед запуском стратега** — competitor-digest.json в контексте стратега, данные из Web Search
- [x] **Ликвидировать галлюцинации** — стратег получает реальные данные из дайджеста вместо выдуманных
- [x] **Бенчмарки** — метрики по размерам каналов в competitor-digest.json

### P1: Welcome-поток

- [x] **Авто-сообщение после капчи** — после goal quiz бот отправляет ссылку на сегодняшнюю тренировку
- [x] **Привязка к расписанию** — показывает последний опубликованный пост за сегодня с категорией

### P1: UX — кнопка "Другое" (approval flow)

- [x] **Редактирование вместо нового сообщения** — editMessageMedia заменяет карточку in-place, fallback на sendPhoto

---

## SPRINT 4 — UGC, профили, фильтрация

Статус: **запланирован** | Фокус: пользовательский контент и персонализация

### P1: Социальные профили участников

- [ ] **Статус/рейтинг** — мягкая механика: кол-во тренировок, реакции на UGC. Уровни: "новичок → практик → наставник"
- [ ] **Публичный профиль** — список видео (выполненные + UGC), описание интересов
- [ ] **Просмотр профилей** — кнопка "Профиль" в боте, просмотр по username

### P1: UGC — доработки

- [ ] Основной флоу: загрузка видеофайла (не только YouTube-ссылка)
- [ ] Дополнительные поля: длительность, группы мышц, инвентарь
- [ ] При публикации UGC: автор указывается в посте

### P1: Фильтрация видео через бота

- [ ] Кнопка "Фильтры" в persistent menu
- [ ] Параметры: вид тренировки, длительность, уровень
- [ ] Быстрые пресеты: "Новичок", "Утро", "После работы", "Быстрая"
- [ ] Бот отправляет подходящие видео со ссылками на посты
- [ ] Индексация: все видео в БД с полными метаданными

### P2: Рейтинг — доработка

- [ ] Пересчёт рейтинга при росте completions

### P3: Монетизация

- [ ] Опрос в группе (когда будет 50+ участников)
- [ ] Архитектура: бесплатный/premium в боте

---

## SPRINT 5 — вовлечение, рост, агентность

Статус: **запланирован** | Фокус: growth loops и умный стратег

### P1: Стратег — агентность (действия, а не только текст)

- [ ] COMMUNITY_PACKET v2: конкретные действия (опрос, welcome-текст, A/B варианты)
- [ ] Бот выполняет действия из пакета: создать опрос, изменить welcome-текст
- [ ] Feedback: бот отправляет стратегу результат (опрос создан, N голосов)

### P1: Figma → лендинг Sami

- [ ] **Pixel-perfect вёрстка лендинга** — дизайн в Figma готов. Сверка через Figma MCP: get_design_context + get_screenshot по секциям
- [ ] **Деплой лендинга** — GitHub Pages или Railway static

### P2: Рубрики

- [ ] #ритуал_недели (пн) — одна практика-фокус
- [ ] #механика (ср) — разбор упражнения
- [ ] #прогресс_пятницы (пт) — итоги, признание активных

### P2: Growth

- [ ] Buddy invite после 3-го выполнения
- [ ] Cross-promotion с микро-тренерами
- [ ] Оффлайн-мероприятия

---

## Инструменты Claude Code для Sami

| Инструмент | Применение | Когда использовать |
|---|---|---|
| **Web Fetch** | Health check Railway, проверка endpoints после деплоя | После каждого пуша |
| **Web Search** | Дайджест конкурентов, бенчмарки, yt-dlp updates | Перед запуском стратега, при ресёрче |
| **/simplify** | Аудит кода на дублирование, хардкоды, мёртвый код | После каждого спринта |
| **/loop** | Мониторинг деплоя (health check каждые 2 мин), стратег (latest.json) | После пуша, диагностика |
| **Figma MCP** | Pixel-perfect сверка лендинга с дизайном | Sprint 5 (лендинг) |

---

## Качество — приоритет

Каждый элемент должен соответствовать бренду:
- Тон: спокойно, конкретно, методично
- Без: "ПОГНАЛИ", "жиросжигание", "до/после"
- Стиль: тренер-методист, не инфлюенсер
- One-liner: "Не мотивация. Структура."

---

## Деплой

| Параметр | Значение |
|---|---|
| Railway проект | `courageous-happiness` |
| Railway project ID | `af9dbf93-c76b-4224-8874-b0bca12682d0` |
| Railway service ID | `a15a112d-2225-4e22-9df3-979fe1c9b021` |
| GitHub репо | `https://github.com/diyoriko/sami` |
| Public URL | `https://courageous-happiness-production.up.railway.app` |

## Идентификаторы

| Параметр | Значение |
|---|---|
| Бот | @sami_workout_bot (отображается как "Сами botik") |
| Канал | @sami_workouts ("Сами") -> `-1003746963456` |
| Группа | "Сами Daily" -> `-1003604276410` |
| Admin user ID | `85013206` |

## Платные сервисы

| Сервис | Назначение | Стоимость |
|--------|-----------|-----------|
| Railway | Хостинг бота 24/7, persistent volume | ~$5/мес (usage-based) |
| Dataimpulse | Residential proxy для yt-dlp | Prepaid 5GB |
| Claude CLI | Стратег-агент (`claude --print`) | Входит в подписку Max |
| YouTube Data API v3 | Поиск видео | Бесплатная квота (10K units/day) |
| Telegram Bot API | Бот | Бесплатно |
