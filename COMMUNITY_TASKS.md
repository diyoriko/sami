# COMMUNITY_TASKS.md — Бэклог: Community Agent

Последнее обновление: 7 марта 2026

---

## Сделано

- [x] Канал `@sami_daily`, группа `Sami Community`, бот `@sami_workout_bot` (admin в обоих)
- [x] YouTube Data API v3 + yt-dlp (скачивание видео, постинг файлом)
- [x] Деплой на Railway с автодеплоем из GitHub main
- [x] Railway Volume подключён — БД персистентна (`/data/community.db`)
- [x] Approval flow: поиск → 1 видео на категорию → кнопки "Выбрать" / "Другое" / "Отменить"
- [x] Модерация: math captcha при входе, мут новых, auto-delete ссылок, /report
- [x] Analytics модуль: ежедневные метрики 00:30, недельный дашборд вс 10:00
- [x] Content Curator модуль: контент-план на неделю пн 09:00
- [x] HTTP endpoint для метрик: `/report/community`, `/report/analytics`, `/health`
- [x] Русские заголовки категорий (Стретчинг / Силовая / Мобильность)
- [x] Автоперевод EN заголовков → RU, очистка кликбейта
- [x] Английские видео в пуле поиска (расширенные запросы)
- [x] Ротация API ключей (секреты вычищены из git-истории)

---

## P0 — Починить pipeline метрик

Стратег не видит данные от community/analytics. Отчёт от 07.03: "Аналитические файлы не найдены, все метрики н/д".

- [ ] Диагностика: проверить что analytics реально генерирует файлы на Railway
- [ ] Проверить что curl к Railway endpoints работает из strategist.sh
- [ ] Убедиться что стратег сохраняет ответ в `reports/community/.internal/latest.json`

---

## P1 — Waitlist-механика

North Star = 500 waitlist до запуска MVP. Сбор не начат.

- [ ] Создать waitlist-форму (Typeform / Tally / Google Form)
- [ ] Добавить кнопку "Хочу в первые тестеры" в вечерний чекин
- [ ] Первый CTA-пост в канале со ссылкой на waitlist
- [ ] Ссылка в описание канала и группы

---

## P2 — Вовлечение и активация

- [ ] Welcome quiz после капчи: цель / уровень / время → персональная рекомендация
- [ ] Рубрики: #ритуал_недели, #прогресс_пятницы, #механика, #за_кулисами
- [ ] Buddy invite: после первого чекина предложить пригласить друга
- [ ] Разнесение видео по времени (07:30 / 12:00 / 19:00 вместо всех в 08:00)
- [ ] Реакция на "не получилось" / "пропустил" → мягкий ответ бота
- [ ] Недельный digest по воскресеньям

---

## P3 — Эксперименты (из стратегических отчётов)

- [ ] 7-day sprint "Верни ритм" → финальный CTA в waitlist
- [ ] A/B тест форматов постов (видео-файл vs ссылка с превью)
- [ ] Product polls: 2-3 forced-choice вопроса в группе
- [ ] UI preview из Figma → пост с CTA в waitlist
- [ ] Creator pilot: пригласить 3 микро-креатора

---

## Деплой

| Параметр | Значение |
|---|---|
| Railway проект | `courageous-happiness` |
| Railway project ID | `af9dbf93-c76b-4224-8874-b0bca12682d0` |
| Railway service ID | `a15a112d-2225-4e22-9df3-979fe1c9b021` |
| GitHub репо | `https://github.com/diyoriko/sami` |
| Root directory | `agents/community` |
| Public URL | `https://courageous-happiness-production.up.railway.app` |

## Идентификаторы

| Параметр | Значение |
|---|---|
| Бот | @sami_workout_bot |
| Канал | @sami_daily → `-1003746963456` |
| Группа | Sami Community → `-1003604276410` |
| Admin user ID | `85013206` |
