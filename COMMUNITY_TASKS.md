# COMMUNITY_TASKS.md — Бэклог: Community Agent

Последнее обновление: 6 марта 2026

---

## ✅ Сделано

- [x] Создан канал `@sami_daily` ("Sami — ежедневное движение")
- [x] Создана группа `Sami Community` (привязана к каналу)
- [x] Создан бот `@sami_workout_bot` (Sami Daily Bot)
- [x] Бот добавлен как admin в канал `@sami_daily`
- [x] Бот добавлен как admin в группу `Sami Community`
- [x] YouTube Data API v3 включён в Google Cloud
- [x] Создан YouTube API key
- [x] TypeScript скомпилирован → `agents/community/dist/`
- [x] Исправлена ошибка типов в `moderation.ts` (grammY `restrictChatMember`)
- [x] Исправлен баг: `moderation.ts` message:text handler блокировал command-хендлеры в приватных чатах — добавлен `return next()`
- [x] Исправлен `COMMUNITY_DB_PATH` в `.env` (был путь от облачной среды `/sessions/...`)
- [x] `better-sqlite3` пересобран под macOS arm64
- [x] Код запушен в GitHub: `https://github.com/diyoriko/sami`
- [x] Бот задеплоен на Railway (проект `courageous-happiness`)
- [x] Env переменные выставлены в Railway
- [x] GitHub → Railway автодеплой настроен (пуш в `main` → автодеплой, rootDir: `agents/community`)

---

## 🔜 Следующий шаг — постоянное хранилище

- [ ] Подключить Railway Volume → смонтировать в `/data`
- [ ] Обновить `COMMUNITY_DB_PATH` в Railway переменных → `/data/community.db`
- [ ] Проверить что данные сохраняются после редеплоя

**Важно:** сейчас SQLite на Railway эфемерна — при каждом редеплое база сбрасывается (теряется статистика чекинов, варны участников, история видео).

---

## 🔲 Улучшения (после стабилизации)

- [ ] Команда `/stats` для админа — статистика чекинов за день
- [ ] Waitlist-коллектор: кнопка "Жду приложение" в постах → сохраняет user_id в БД
- [ ] Реакция на слова "не получилось" / "пропустил" в группе → мягкий ответ бота
- [ ] A/B тест форматов постов (с превью vs без)
- [ ] Недельный digest по воскресеньям

---

## Деплой

| Параметр | Значение |
|---|---|
| Railway проект | `courageous-happiness` |
| Railway project ID | `af9dbf93-c76b-4224-8874-b0bca12682d0` |
| Railway service ID | `a15a112d-2225-4e22-9df3-979fe1c9b021` |
| GitHub репо | `https://github.com/diyoriko/sami` |
| Root directory | `agents/community` |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Логи | Railway dashboard → сервис → Deployments |

## Идентификаторы

| Параметр | Значение |
|---|---|
| Бот | @sami_workout_bot |
| Канал | @sami_daily → `-1003746963456` |
| Группа | Sami Community → `-1003604276410` |
| Admin user ID | `85013206` |
| Env-файл (локально) | `agents/community/.env` |

---

## Архитектура

Подробнее: `COMMUNITY_PLAN.md`
