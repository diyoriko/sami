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
- [x] Заполнен env-файл: `~/.config/sami/community.env`
- [x] TypeScript скомпилирован → `agents/community/dist/`
- [x] Исправлена ошибка типов в `moderation.ts` (grammY `restrictChatMember`)
- [x] Файл `.env.production` сохранён в `agents/community/`

---

## 🔜 Запуск (следующий шаг)

- [ ] На Mac: `cd agents/community && cp .env.production .env && npm install && npm start`
- [ ] Проверить: бот отвечает на `/start` в `@sami_daily`
- [ ] Проверить: в 19:00 приходит approval DM
- [ ] Проверить: в 21:00 публикуется вечерний чекин
- [ ] Проверить: посты в 08:00, 12:00, 17:00 (стретчинг / силовая / мобильность)

---

## 🔲 После запуска

- [ ] Настроить launchd автозапуск на Mac (как у strategist)
- [ ] Мониторинг первой недели: логи, ошибки, отвалы
- [ ] Проверить интеграцию со strategist: читает ли агент `community_packet.json`
- [ ] Проверить запись статистики в `reports/community/.internal/latest.json`

---

## 🔲 Улучшения (после стабилизации)

- [ ] Команда `/stats` для админа — статистика чекинов за день
- [ ] Waitlist-коллектор: кнопка "Жду приложение" в постах → сохраняет user_id в БД
- [ ] Реакция на слова "не получилось" / "пропустил" в группе → мягкий ответ бота
- [ ] A/B тест форматов постов (с превью vs без)
- [ ] Недельный digest по воскресеньям

---

## Идентификаторы

| Параметр | Значение |
|---|---|
| Бот | @sami_workout_bot |
| Bot token | `8709141907:AAHcMa7JEpShG3N-yra2GUCmo-zWiDv9SyM` |
| Канал | @sami_daily → `-1003746963456` |
| Группа | Sami Community → `-1003604276410` |
| Admin user ID | `85013206` |
| YouTube API key | `AIzaSyA2Y0ea6SynPKKNvj6OoN3OHT_6T9UPsEc` |
| Env-файл | `~/.config/sami/community.env` |

---

## Архитектура

Подробнее: `COMMUNITY_PLAN.md`
