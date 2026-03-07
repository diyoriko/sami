# YouTube Cookies — инструкция

yt-dlp использует cookies для обхода блокировки "Sign in to confirm you're not a bot" на серверах Railway.

## Когда обновлять

Раз в 2-4 недели. Если видео перестали загружаться (постятся текстом вместо видеофайла) — пора обновить.

## Как экспортировать

1. Открой YouTube в Chrome/Firefox (убедись что залогинен)
2. Установи расширение **"Get cookies.txt LOCALLY"** ([Chrome](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc))
3. Перейди на youtube.com
4. Кликни на иконку расширения -> "Export" -> скачается файл `youtube.com_cookies.txt`

## Как загрузить на Railway

```bash
# Из корня проекта:
railway link          # если не привязан к проекту
railway up            # или через volume mount:

# Загрузить файл на persistent volume:
railway shell
# внутри shell:
cat > /data/cookies.txt << 'PASTE'
<вставить содержимое файла cookies.txt>
PASTE
exit
```

Или через Railway Dashboard -> Service -> Volume -> Upload file `/data/cookies.txt`.

## Проверка

После загрузки бот автоматически подхватит cookies при следующем постинге. Проверить:
- В логах Railway: yt-dlp должен использовать `--cookies /data/cookies.txt`
- Нажми "Опубликовать" — видео должно загрузиться файлом, а не текстом

## Техническое

- Код: `agents/community/src/downloader.ts` — проверяет `YT_COOKIES_PATH` env или `/data/cookies.txt`
- Env var (опционально): `YT_COOKIES_PATH=/data/cookies.txt` (по умолчанию уже этот путь)
