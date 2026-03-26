# SAMI — Fitness Community Bot

Telegram-бот + канал для фитнес-сообщества. Видео-тренировки, челленджи, аналитика, модерация.

## Stack

Node.js 22, TypeScript, grammY, SQLite, YouTube API, yt-dlp

## Run

```bash
cd agents/community
cp .env.example .env  # fill in tokens
npm install && npm run dev
```

## Deploy

Railway auto-deploy from `main`. Bot: [@sami_workout_bot](https://t.me/sami_workout_bot)
