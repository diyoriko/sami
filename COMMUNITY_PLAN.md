# Sami Community — Полный план запуска

## Что строим

**Канал** `@sami_daily` (или похожий) — чистая лента: 3 видео в день + вечерний чекин.
**Группа-обсуждение** — привязана к каналу, там пишут участники.
**Бот** — автопостинг, модерация, апрув видео тобой, чекины, сбор waitlist.

---

## Шаг 1 — Ты делаешь вручную (Telegram)

### 1.1 Создать канал
1. Telegram → New Channel
2. Название: `Sami — ежедневное движение` (или на английском `Sami Daily`)
3. Username: `@sami_daily` (или `@sami_move`, `@sami_community`)
4. Тип: **Public**
5. Описание:
   ```
   Короткие ежедневные тренировки для тех, кто хочет вернуть ритм телу и дню.

   3 видео в день: стретчинг · силовая · мобильность
   Без мотивационного шума. Только практика.

   Приложение Sami — скоро 👇
   ```

### 1.2 Создать группу-обсуждение
1. Telegram → New Group → назвать `Sami Community`
2. Тип: **Public** (чтобы был username)
3. Username: `@sami_chat`
4. Зайти в настройки канала → Discussion → привязать эту группу
5. Теперь кнопка "Comments" под каждым постом канала → ведёт в группу

### 1.3 Создать бота через @BotFather
1. Написать `@BotFather` → `/newbot`
2. Имя: `Sami Daily Bot`
3. Username: `@sami_daily_bot` (или любой свободный)
4. **Сохранить токен** — он выглядит как `123456789:ABCdef...`

### 1.4 Добавить бота как администратора
**В канал:**
- Настройки канала → Administrators → Add Admin → найти `@sami_daily_bot`
- Права: Post Messages ✅, Edit Messages ✅, Delete Messages ✅

**В группу:**
- Настройки группы → Administrators → Add Admin → `@sami_daily_bot`
- Права: Delete Messages ✅, Ban Users ✅, Pin Messages ✅, Add Members ✅

---

## Шаг 2 — Ты делаешь вручную (YouTube API Key)

1. Зайди на [console.cloud.google.com](https://console.cloud.google.com)
2. Создай новый проект: `Sami Community Bot`
3. Слева: **APIs & Services** → **Enable APIs**
4. Найди **YouTube Data API v3** → Enable
5. Слева: **APIs & Services** → **Credentials** → **Create Credentials** → **API Key**
6. Скопируй ключ (выглядит как `AIzaSy...`)
7. Нажми **Restrict Key** → API restrictions → выбери **YouTube Data API v3** → Save

> Бесплатный лимит: 10 000 units/день. Один поиск = ~100 units. Нам нужно ~3 поиска в вечер = 300 units. Хватает с запасом.

---

## Шаг 3 — Я строю: Community Agent

### Стек
- **Node.js + TypeScript**
- **grammY** — Telegram bot framework
- **SQLite** (better-sqlite3) — база данных
- **YouTube Data API v3** — поиск видео
- **node-cron** — расписание задач

### Структура проекта
```
agents/community/
├── src/
│   ├── bot.ts              — инициализация бота
│   ├── scheduler.ts        — cron-задачи
│   ├── youtube.ts          — поиск видео
│   ├── db.ts               — SQLite база
│   ├── poster.ts           — постинг в канал
│   ├── moderation.ts       — модерация группы
│   ├── approval.ts         — апрув-флоу (тебе в личку)
│   └── checkin.ts          — вечерние чекины
├── package.json
├── tsconfig.json
└── README.md
```

### Расписание агента
| Время | Действие |
|-------|----------|
| 19:00 | Поиск видео (3 категории × 3 варианта) |
| 19:10 | Отправить тебе в личку на апрув |
| 08:00 | Пост в канал: стретчинг |
| 12:00 | Пост в канал: силовая |
| 17:00 | Пост в канал: мобильность |
| 21:00 | Вечерний чекин-пост |

### Формат поста в канал
```
🧘 Стретчинг дня

*Полная растяжка спины и поясницы*

▶️ [Смотреть на YouTube](https://youtube.com/...)

💪 Мышцы: спина, поясница, бёдра
⏱ Длительность: 15 мин
📊 Уровень: Начинающий
👤 Автор: Move With Mia

#стретчинг #sami #ежедневнаяпрактика
```

### Формат чекина
```
📋 Чекин дня

Как прошёл твой день движения?

👇 Нажми ниже
```
*Inline-кнопки:* `✅ Сделал(а)` | `😅 Частично` | `❌ Не получилось`

---

## Модерация (на основе опыта @merskie_dela с 20k+ чатом)

Их опыт: начинали с простых ботов по ключевым словам → спамеры адаптировались → пришли к многослойной системе.

### Что внедряем в Sami

**Слой 1 — Welcome + верификация новых участников**
- При входе в группу: бот приветствует и задаёт 1 вопрос (фильтр от ботов + сбор данных для стратега)
- Пример: *"Привет! Выбери свою цель:"* → кнопки: `Вернуть ритм` / `Похудеть` / `Силовая` / `Просто смотреть`
- Если не ответил за 5 минут → бот удаляет сообщение о входе (не баним, просто чисто)

**Слой 2 — Ограничения для новых**
- Первые 24 часа или до 5 сообщений: нельзя отправлять ссылки и медиа
- Slow mode в группе: 30 секунд между сообщениями

**Слой 3 — Авто-удаление спама**
- Сообщения с внешними ссылками от участников (не от бота/админов) → удалить + предупреждение
- После 2 предупреждений → мут на 24 часа
- После 3 — бан

**Слой 4 — Кнопка Report**
- Участники могут репортить спам
- Бот присылает тебе в личку на решение

---

## Синхронизация Claude + Codex

### Контракт данных
```
reports/
├── strategist/
│   └── .internal/
│       ├── latest.json          ← Codex пишет, Claude читает
│       └── community_packet.json ← Codex пишет для Claude
└── community/
    └── .internal/
        └── latest.json          ← Claude пишет, Codex читает
```

**`community_packet.json`** — стратег производит каждый прогон:
```json
{
  "week_focus": "мобильность",
  "content_themes": ["поясница", "шея", "бёдра"],
  "challenge_active": true,
  "challenge_name": "7 дней гибкости"
}
```

**`reports/community/.internal/latest.json`** — агент пишет после каждого дня:
```json
{
  "date": "2026-03-06",
  "checkin_did": 23,
  "checkin_partial": 8,
  "checkin_didnt": 5,
  "new_members": 12,
  "top_category": "мобильность",
  "waitlist_new": 3
}
```

---

## Что нужно от тебя для старта

1. ✅ Создать канал + группу + бот (Шаг 1 выше)
2. ✅ Получить YouTube API key (Шаг 2 выше)
3. ✅ Прислать мне:
   - Telegram Bot Token (`123456:ABC...`)
   - YouTube API Key (`AIzaSy...`)
   - Твой Telegram User ID (узнать: написать `@userinfobot`)
   - Username канала (например `@sami_daily`)
   - Username группы (например `@sami_chat`)

После этого я запускаю агента.

---

## Environment Variables (`.env` файл агента)

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHANNEL_ID=@sami_daily
TELEGRAM_GROUP_ID=@sami_chat
TELEGRAM_ADMIN_USER_ID=123456789   # твой user ID
YOUTUBE_API_KEY=AIzaSy...
COMMUNITY_DB_PATH=./data/community.sqlite
STRATEGIST_LATEST_JSON=../../reports/strategist/.internal/latest.json
COMMUNITY_REPORT_DIR=../../reports/community/.internal
```
