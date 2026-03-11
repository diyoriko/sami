# COMMUNITY_TASKS.md — Бэклог Sami Community

Последнее обновление: 11 марта 2026 (ночь)

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

**v0.2.5 (10.03):**
- [x] Deploy tracking: deploy_history в SQLite, версия/коммит в /health
- [x] Стратег → COMMUNITY_TASKS.md: BACKLOG_PROPOSALS + extract-backlog-proposals.mjs
- [x] Бот → бэклог после деплоя: запись в DB при старте
- [x] backlog.html: file:// использует staticData, поддержка статуса "завершён"

**v0.3.0 (10.03):**
- [x] Мониторинг деплоя: agents/check-deploy.sh (health, endpoints, стратег)
- [x] Аудит кода: youtube.ts, db.ts, approval.ts, bot-menu.ts, scheduler.ts
- [x] 10 новых тестов (47 всего)
- [x] Competitor digest: реальные фитнес-каналы + бенчмарки в контексте стратега
- [x] Welcome-поток: ссылка на тренировку после капчи
- [x] Кнопка "Другое": editMessageMedia вместо нового сообщения

**v0.3.1 (11.03):**
- [x] Fix: H.264 кодек для Telegram — yt-dlp предпочитает avc1, ffprobe проверяет, ffmpeg перекодирует если VP9/AV1
- [x] Автопоиск видео отключён — админ ищет и публикует вручную через кнопки бота

**v0.6.0 (11.03) — Sprint 6:**
- [x] shared.ts SSoT: 7 категорий, 3 уровня, 12 групп мышц, 12 типов инвентаря, эмодзи, YouTube-запросы
- [x] DB миграция CHECK constraints (yoga, breathing, recovery, cardio) — транзакционный rebuild
- [x] Рейтинг: +15% completions из Telegram (35/30/20/15), normalizeCompletions
- [x] Health dashboard в backlog.html — live-fetch /health с Railway
- [x] Пост-онбординг DM новым участникам после goal quiz
- [x] Рубрики: #ритуал_недели (DB + кнопки) + #прогресс_пятницы (top-5 активных)
- [x] 25 UX smoke-тестов (82 всего)
- [x] Proxy без cookies, стратег feedback loop, UGC fixes (видеофайл, пуш, "Мои тренировки")
- [x] sync-proposal-status.mjs — автосинхронизация предложений стратега

**v0.4.0 (11.03) — Sprint 4:**
- [x] Стратег v2: actions[] в COMMUNITY_PACKET, кнопки одобрения, исполнение (poll/welcome/limits/digest)
- [x] UX: кнопки "Сохранить" + "★ рейтинг" под постами, popup с формулой
- [x] Фильтры: категория, уровень, длительность + 4 пресета в меню бота
- [x] Профили: уровни (новичок/практик/наставник), кнопка "Профиль" в боте
- [x] Избранное: кнопка "Сохранённое" в боте, пагинация, ссылки на посты
- [x] UGC: загрузка видеофайла напрямую + YouTube-ссылка, автор в подтверждении
- [x] Tech debt: shared.ts, HTML entities, типизация, channel URL
- [x] Deploy notification: очеловечен формат, диагностика только при ошибках
- [x] 57 тестов

**v0.5.0 (11.03) — Sprint 5:**
- [x] Модерация Phase 2: антифлуд, cooldown, репутация, ночной режим, стоп-лист, логирование
- [x] Buddy invite после 3-го выполнения
- [x] Имплементатор: impl_tasks таблица, HTTP endpoints, action type create_impl_task
- [x] GitHub Actions: стратег + имплементатор workflows, self-hosted runner ($0)
- [x] Убраны inline-кнопки из канала — "Комментировать" от Telegram теперь видна
- [x] Бот пишет "Я сделаль" кнопку как комментарий в discussion group
- [x] Убрана кнопка "Сохранить" из постов (стратег: упростить UX)
- [x] UGC auto-publish при одобрении, рейтинг без completions, tech debt cleanup
- [x] Архитектура: канал + группа зафиксирована до 50 подписчиков
- [x] 57 тестов, tsc clean

---

## Завершённые спринты

<details>
<summary>Sprint 4 — Качество видео, стратег v2, UX (v0.4.0)</summary>

- Блеклист, scoring, дедупликация каналов, retry загрузки
- Стратег v2: actions[], кнопки одобрения, исполнение, feedback loop
- UX: "Сохранить", рейтинг popup, фильтры, профили, избранное
- UGC: видеофайл + YouTube, автор в подтверждении
- Баги: "Пост не найден", счётчик, HTML entities
- Tech debt: shared.ts, типизация, channel URL
</details>

<details>
<summary>Sprint 5 — Стабильная версия (v0.5.0)</summary>

- Модерация Phase 2: антифлуд, cooldown, репутация, ночной режим, стоп-лист
- Buddy invite после 3-го выполнения
- Имплементатор: impl_tasks, HTTP endpoints
- "Я сделаль" как комментарий в discussion group
- UGC auto-publish, убраны inline-кнопки из канала
</details>

---

## SPRINT 6 — Качество + UX

Статус: **в работе** | Версия: v0.6.0

Решение по архитектуре (11.03): **канал + группа зафиксирована** до 50 подписчиков.

### P0: DONE (v0.6.0)

- [x] Публикация: CATEGORIES из shared.ts вместо хардкода 3
- [x] UGC: published_at трекинг, "Мои тренировки" только опубликованные
- [x] "Я сделаль" fallback для незарегистрированных постов
- [x] Health dashboard: FK migration crash hotfix
- [x] UX сообщения при публикации: только выбранные категории + название

### P0: Сломанные core-фичи — блокируют использование

- [ ] **"Я сделаль": Loading и зависание** — callback зависает, счётчик "Сделали" не обновляется. Разобраться: done: vs done_msg:, может ли бот редактировать caption канального поста из discussion group, cooldown не работает
- [ ] **Капча не срабатывает** — новый участник написал в группе без капчи. Бот не получает chat_member update при вступлении через канал/discussion. Нужен интеграционный тест
- [ ] **"Другое" в поиске: "Сессия не найдена"** — не работает для новых категорий (восстановление и др.) после v0.6.0
- [ ] **UGC YouTube: Error 153** — "Video player configuration error" при открытии одобренного YouTube-видео в Telegram

### P1: Баги — сломано, но не блокирует

- [ ] **Поиск видео: дублирует сообщение** — "Ищу видео..." отправляется дважды
- [ ] **Статус: очередь показывает невыбранные видео** — показывает все pending, а не только approved
- [ ] **Кнопки сложности обрезаются** — множественные эмодзи 💎💎💎 + длинный текст. Сократить (Легко / Средне / Сложно)
- [ ] **Рейтинг: заменить ★ на эмодзи ⭐** — символ выглядит как текст, не как остальные строки поста

### P1: UX улучшения — делают продукт лучше

- [ ] **Убрать "Опубликовать" из persistent menu** — inline-кнопка "Опубликовать" рядом с "Выбрано" при выборе видео. Убрать "Сбросить выбор"
- [ ] **Формат автора в постах** — "Автор: имя, 📎 [YouTube](ссылка)" вместо ссылки на канал
- [ ] **UGC flow: недостающие параметры** — не спрашивает мышцы, длительность, инвентарь. Ревью всего flow
- [ ] **Рейтинг некликабельный** — нужен popup с формулой. Inline-кнопки убраны из канала — решение: кнопка в автокомменте
- [ ] **Ревью UX автокоммента в группе** — что видит пользователь, какие действия, не перегружен ли
- [ ] **Очеловечить приветствие бота** — "Ботик Сами", тёплый тон, что умеет
- [ ] **Описание канала и bio бота** — ключевые слова для поиска в Telegram

### P1: Тестирование

- [ ] **Интеграционные тесты с реальным ботом** — smoke тесты проверяют только наличие кода, не реальное поведение. Нужны тесты которые отправляют mock-updates через grammY test utilities и проверяют ответы бота: капча при вступлении, "Я сделаль" callback, UGC flow end-to-end, approval + publish. Заменит ручное кликание

### P1: Качество контента

- [ ] **Ревью алгоритма поиска видео** — like_ratio + subscribers в scoring, brand alignment, стратег влияет на keywords
- [ ] **Поиск тренировки в канале/боте** — вход из канала: закреплённый пост, поиск, подборки

### P2: Автоматизация

- [ ] **Стратег: предложения → одобрение → бэклог** — BACKLOG_PROPOSALS → кнопки → автодобавление в COMMUNITY_TASKS.md

### P2: Growth (ручная работа, не код)

- [ ] **Cross-promo с 3 микро-каналами**
- [ ] **Посевной пост** — подборка "тренировки недели"
- [ ] **Контент-расписание** — план на 2 недели
- [ ] **#механика** (ср) — разбор упражнения, shareable-контент

### P3: Отложено (после 50+ участников)

- [ ] Монетизация: опрос в группе, архитектура premium
- [ ] Weekly personal stats DM
- [ ] Attribution flow для тренеров
- [ ] MarkdownV2
- [ ] Лендинг Sami
- [ ] Ручной посев — 10 приглашений

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
