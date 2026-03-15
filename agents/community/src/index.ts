import { Bot, session } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { getConfig } from './config';
import { createLogger } from './logger';

const log = createLogger('sami-community');
import { getDb, closeDb } from './db';
import { registerBotMenu } from './bot-menu';
import { registerModeration } from './moderation';
import { registerApprovalCallbacks } from './approval';
import { startScheduler } from './scheduler';
import { upgradeYtDlp, logYtDlpStatus, initCookies, setAdminNotifier, runDiagnostic } from './downloader';
import { migrateStrategist, savePacketFromExternal, registerStrategistCallbacks, sendActionToAdmin, getActionById } from './strategist';
import { registerRubricHandlers } from './rubrics';
import { recordDeploy, getLatestDeploy, getLatestPost, listImplTasks, getNextImplTask, getImplTask, updateImplTaskStatus, createImplTask } from './db';
import { isYtDlpAvailable as isYtDlpAvailableCheck } from './downloader';
import type { ImplTaskStatus, ImplTaskSource } from './db';

/**
 * Audit channel/group/bot descriptions: add cross-links if missing.
 * Reads current text, appends footer with links + search keywords.
 * Idempotent — skips if cross-links already present.
 */
async function auditDescriptions(bot: Bot, config: ReturnType<typeof getConfig>): Promise<void> {
  const auditLog = createLogger('audit-desc');
  const BOT_HANDLE = '@sami_workout_bot';
  const CHANNEL_HANDLE = '@sami_workouts';
  const changes: string[] = [];

  // --- Channel description ---
  try {
    const chat = await bot.api.getChat(config.TELEGRAM_CHANNEL_ID);
    const current = ('description' in chat ? chat.description : '') ?? '';
    if (!current.includes(BOT_HANDLE)) {
      const footer = [
        '',
        'Обсуждение → «Сами Daily»',
        `Бот: ${BOT_HANDLE}`,
        '',
        'тренировки дома · стретчинг · йога · силовая · мобильность · без инвентаря',
      ].join('\n');
      const updated = (current + '\n' + footer).slice(0, 255);
      await bot.api.setChatDescription(config.TELEGRAM_CHANNEL_ID, updated);
      changes.push('Канал: + ссылки на группу и бота, ключевые слова');
    }
  } catch (err) {
    auditLog.warn('channel description update failed', { error: String(err) });
  }

  // --- Group description ---
  try {
    const chat = await bot.api.getChat(config.TELEGRAM_GROUP_ID);
    const current = ('description' in chat ? chat.description : '') ?? '';
    if (!current.includes(BOT_HANDLE)) {
      const footer = [
        '',
        `Канал: ${CHANNEL_HANDLE}`,
        `Бот: ${BOT_HANDLE}`,
        '',
        'Нажми «Я сделаль» под видео, когда закончишь.',
      ].join('\n');
      const updated = (current + '\n' + footer).slice(0, 255);
      await bot.api.setChatDescription(config.TELEGRAM_GROUP_ID, updated);
      changes.push('Группа: + ссылки на канал и бота, CTA');
    }
  } catch (err) {
    auditLog.warn('group description update failed', { error: String(err) });
  }

  // --- Bot description (shown in bot profile, max 512 chars) ---
  try {
    const { description: current } = await bot.api.getMyDescription();
    if (!current?.includes(CHANNEL_HANDLE)) {
      const newDesc = [
        'Помощник сообщества Сами — ежедневные тренировки на коврике.',
        '',
        'Что умею:',
        '• Профиль — статистика и уровень',
        '• Фильтры — по категории, уровню, длительности',
        '• 💡 Предложить тренировку — поделись находкой',
        '• 🏋️ Мои тренировки — загруженные тобой видео',
        '',
        `Канал: ${CHANNEL_HANDLE}`,
        'Группа: «Сами Daily»',
      ].join('\n');
      await bot.api.setMyDescription(newDesc.slice(0, 512));
      changes.push('Бот (описание): полное обновление с возможностями и ссылками');
    }
  } catch (err) {
    auditLog.warn('bot description update failed', { error: String(err) });
  }

  // --- Bot short description (shown in chat list, max 120 chars) ---
  try {
    const { short_description: current } = await bot.api.getMyShortDescription();
    if (!current?.includes(CHANNEL_HANDLE)) {
      const newShort = `Помощник сообщества Сами. Профиль, фильтры, тренировки. ${CHANNEL_HANDLE}`;
      await bot.api.setMyShortDescription(newShort.slice(0, 120));
      changes.push('Бот (краткое): + ссылка на канал');
    }
  } catch (err) {
    auditLog.warn('bot short description update failed', { error: String(err) });
  }

  if (changes.length > 0) {
    auditLog.info('descriptions updated', { changes });
    const { escV2 } = await import('./shared');
    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `*Описания обновлены:*\n${changes.map(c => `• ${escV2(c)}`).join('\n')}`,
      { parse_mode: 'MarkdownV2' },
    ).catch(() => {});
  } else {
    auditLog.info('descriptions already up to date');
  }
}

async function sendDeployReport(
  bot: Bot,
  config: ReturnType<typeof getConfig>,
  pkgVersion?: string,
): Promise<void> {
  const { escV2: e } = await import('./shared');
  const {
    getDeployStats, getActiveSeason, getSeasonDay, getSeasonWeekNumber,
    getChannelStats, getLastStrategistTimestamp, getLatestPost: getLatestPostDb,
    getSeasonWeekStatus, initSeasonWeekSlots,
  } = await import('./db');
  const { todayMsk } = await import('./dates');
  const { isYtDlpAvailable } = await import('./downloader');
  const { SEASON_DAY_MAP, CATEGORY_RU, CATEGORY_EMOJI } = await import('./shared');

  const today = todayMsk();
  const stats = getDeployStats();
  const season = getActiveSeason();
  const channelStats = getChannelStats(today);
  const lastStrat = getLastStrategistTimestamp();
  const latestPost = getLatestPostDb();
  const ytDlp = isYtDlpAvailable();

  const rawCommitMsg = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.trim();
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);

  // ── Header ──
  const vTag = pkgVersion ? ` v${e(pkgVersion)}` : '';
  const shaTag = sha ? ` · \`${sha}\`` : '';
  const lines: string[] = [
    `🚀 *Деплой SAMI${vTag}*${shaTag}`,
  ];

  // ── What changed ──
  if (rawCommitMsg) {
    const commitLines = rawCommitMsg
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && !l.startsWith('Co-Authored-By:'));

    if (commitLines.length > 0) {
      const TYPE_RU: Record<string, string> = {
        feat: '✨ Новое', fix: '🔧 Исправлено', chore: '🔩 Обслуживание',
        test: '🧪 Тесты', ci: '⚙️ CI', refactor: '♻️ Рефакторинг',
        docs: '📝 Документация', perf: '⚡ Оптимизация', impl: '🔨 Задача',
        style: '🎨 Оформление', build: '📦 Сборка',
      };

      const header = commitLines[0];
      const convMatch = header.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
      const typeLabel = convMatch ? (TYPE_RU[convMatch[1]] ?? convMatch[1]) : null;
      const summary = convMatch ? convMatch[2] : header;

      lines.push('');
      lines.push(`${typeLabel ?? '📦 Обновление'}: *${e(summary)}*`);

      for (let i = 1; i < Math.min(commitLines.length, 15); i++) {
        const line = commitLines[i];
        const cleaned = line.replace(/^[-•]\s*/, '');
        lines.push(`  · ${e(cleaned)}`);
      }
    }
  }

  // ── Services status ──
  lines.push('');
  lines.push(`⚙️ *Сервисы:*`);
  lines.push(`  Бот — отвечает на команды ✅`);
  lines.push(`  Веб\\-сервер — принимает данные от стратега ✅ :${e(process.env.PORT || '3000')}`);
  lines.push(`  Загрузчик видео — скачивает с YouTube ${ytDlp ? '✅' : '❌'}`);
  lines.push(`  Стратег — ежедневный анализ ${lastStrat ? `✅ ${e(lastStrat.slice(0, 16).replace('T', ' '))}` : '⏳ нет данных'}`);
  lines.push(`  Аналитика — метрики и дашборды ✅`);

  // ── Season ──
  if (season) {
    const dayNum = getSeasonDay(season.start_date, today);
    const weekNum = getSeasonWeekNumber(dayNum);
    const dow = new Date(today + 'T00:00:00').getDay();
    const todayCat = SEASON_DAY_MAP[dow];
    const catLabel = todayCat ? `${CATEGORY_EMOJI[todayCat]} ${CATEGORY_RU[todayCat]}` : '?';

    initSeasonWeekSlots(season.id, weekNum);
    const slots = getSeasonWeekStatus(season.id, weekNum);
    const filled = slots.filter(s => s.status === 'queued' || s.status === 'posted').length;
    const posted = slots.filter(s => s.status === 'posted').length;

    lines.push('');
    lines.push(`🏆 *Сезон ${e(String(season.number))}:*`);
    lines.push(`  День ${e(String(dayNum))}/21 · Неделя ${weekNum}`);
    lines.push(`  Сегодня: ${e(catLabel)}`);
    lines.push(`  Очередь: ${e(String(filled))}/7 заполнено, ${e(String(posted))} опубликовано`);
  } else {
    lines.push('');
    lines.push(`🏆 *Сезон:* нет активного`);
  }

  // ── Community metrics ──
  lines.push('');
  lines.push(`📊 *Метрики:*`);
  if (channelStats && channelStats.subscriber_count > 0) {
    lines.push(`  Подписчики канала: ${e(String(channelStats.subscriber_count))}`);
    lines.push(`  Участники группы: ${e(String(channelStats.group_member_count))}`);
  }
  lines.push(`  Всего участников: ${e(String(stats.totalMembers))}`);
  lines.push(`  Видео в базе: ${e(String(stats.totalVideos))}`);
  lines.push(`  Постов: ${e(String(stats.totalPosts))} · Выполнений: ${e(String(stats.totalCompletions))}`);
  lines.push(`  Активных юзеров: ${e(String(stats.activeUsers))}`);
  if (stats.ugcPending > 0) {
    lines.push(`  ⚠️ Тренировки на модерации: ${e(String(stats.ugcPending))}`);
  }
  if (stats.modActions7d > 0) {
    lines.push(`  Модерация \\(7д\\): ${e(String(stats.modActions7d))} действий`);
  }

  // ── Last post ──
  if (latestPost) {
    lines.push('');
    lines.push(`📤 Последний пост: ${e(latestPost.category)} · ${e(latestPost.date)}`);
  }

  // ── Quick actions reminder ──
  lines.push('');
  lines.push(`_Кнопки: 📅 Неделя · 📊 Статус · 📈 Аналитика_`);

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    lines.join('\n'),
    { parse_mode: 'MarkdownV2' },
  );
}

async function main(): Promise<void> {
  const config = getConfig();

  // Init DB
  getDb();
  migrateStrategist();

  // Record deploy in DB
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA;
  const commitMsg = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.trim();
  const pkgVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version; }
    catch { return undefined; }
  })();
  recordDeploy(commitSha, commitMsg, pkgVersion);

  log.info('database ready');

  // Upgrade yt-dlp to latest, init cookies, log status
  await upgradeYtDlp();
  initCookies();
  logYtDlpStatus();

  // Ensure report directories exist
  const reportDirs = [
    config.COMMUNITY_REPORT_DIR,
    config.ANALYTICS_REPORT_DIR,
    config.ANALYTICS_WEEKLY_DIR,
  ];
  for (const dir of reportDirs) {
    const resolved = path.resolve(__dirname, '..', dir);
    fs.mkdirSync(resolved, { recursive: true });
  }
  log.info('report directories ready');

  // Init bot
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Wire up admin notification for download failures
  setAdminNotifier((msg) => {
    bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, msg).catch(() => {});
  });

  // Register handlers
  registerBotMenu(bot);
  registerModeration(bot);
  registerApprovalCallbacks(bot);
  registerStrategistCallbacks(bot);
  registerRubricHandlers(bot);

  // --- Admin commands (all use Moscow timezone) ---

  const { todayMsk, tomorrowMsk, currentWeekMsk } = await import('./dates');

  // /status — daily stats
  bot.command('status', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { getPostCountForDate, getCompletionCountForDate, getUniqueCompletionUsersForDate } = await import('./db');
    const date = todayMsk();
    const posts = getPostCountForDate(date);
    const completions = getCompletionCountForDate(date);
    const users = getUniqueCompletionUsersForDate(date);
    const { escV2: esc } = await import('./shared');
    await ctx.reply(
      `*Sami — статус*\n\n` +
      `Дата: ${esc(date)}\n` +
      `Постов: ${esc(String(posts))}\n` +
      `Выполнений: ${esc(String(completions))} \\(${esc(String(users))} чел\\.\\)`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // /search — find videos for tomorrow (MSK), send to admin for approval
  bot.command('search', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { runApprovalFlow } = await import('./approval');
    const date = tomorrowMsk();
    await ctx.reply(`🔍 Ищу видео на ${date}...`);
    await runApprovalFlow(bot, date);
  });

  // /post — manually publish approved videos to channel (always force, no duplicate check)
  bot.command('post', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { postVideoToChannel } = await import('./poster');
    const { getApprovedVideo } = await import('./db');

    const today = todayMsk();
    const tomorrow = tomorrowMsk();

    // Find which date has approved videos: tomorrow first (where /search writes), then today
    const { CATEGORIES: ALL_CATS, CATEGORY_RU: CAT_RU, CATEGORY_EMOJI: CAT_EMOJI } = await import('./shared');
    const hasTomorrow = ALL_CATS.some(c => getApprovedVideo(tomorrow, c) !== null);
    const hasToday = ALL_CATS.some(c => getApprovedVideo(today, c) !== null);
    const date = hasTomorrow ? tomorrow : hasToday ? today : null;

    if (!date) {
      await ctx.reply(`⚠️ Нет одобренных видео ни на ${today}, ни на ${tomorrow}. Сначала /search и выбери видео.`);
      return;
    }

    await ctx.reply(`📤 Публикую видео на ${date}...`);

    const report: string[] = [];
    for (const cat of ALL_CATS) {
      const approved = getApprovedVideo(date, cat);
      if (!approved) continue;
      const result = await postVideoToChannel(bot, date, cat, { force: true });
      const label = `${CAT_EMOJI[cat]} ${CAT_RU[cat]}`;
      if (result === 'posted') report.push(`✅ ${label}`);
      else if (result === 'error') report.push(`❌ ${label} — ошибка`);
      else report.push(`⏭ ${label} — пропущено`);
    }

    // Clean up remaining pending/approved sessions for this date (unpublished categories)
    const { cleanupUnpostedSessions } = await import('./db');
    const cleaned = cleanupUnpostedSessions(date);
    if (cleaned > 0) report.push(`🧹 Очищено ${cleaned} неиспользованных сессий`);

    await ctx.reply(report.join('\n'));
  });

  // /reset — clear tomorrow's approved videos, allows re-searching
  bot.command('reset', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { resetApprovalSessions } = await import('./db');
    const date = tomorrowMsk();
    const count = resetApprovalSessions(date);
    await ctx.reply(`🔄 Сброшено ${count} сессий на ${date}. Запусти /search для нового поиска.`);
  });

  // /wipe — clear all data (videos, posts, seasons, UGC, etc.)
  bot.command('wipe', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;

    // Two-step confirmation: first call shows warning, second (with "confirm") executes
    const args = ctx.match?.trim();
    if (args !== 'confirm') {
      await ctx.reply(
        '⚠️ Это удалит ВСЕ данные: видео, посты, сезоны, тренировки, участников, статистику.\n\n' +
        'Схема и настройки сохранятся.\n\n' +
        'Для подтверждения напиши: /wipe confirm'
      );
      return;
    }

    const { wipeAllData } = await import('./db');
    const result = wipeAllData();
    const nonZero = Object.entries(result.deleted)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `  ${t}: ${n}`)
      .join('\n');
    await ctx.reply(
      `🗑 БД очищена.\n\n${nonZero || '  (всё уже было пусто)'}\n\nГотово к чистому старту.`
    );
  });

  // /analytics — manually run daily analytics
  bot.command('analytics', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { runDailyAnalytics } = await import('./analytics');
    await ctx.reply('📊 Запускаю аналитику...');
    await runDailyAnalytics(bot, todayMsk());
  });

  // Start scheduler
  startScheduler(bot);

  // HTTP report server — стратег читает отсюда метрики
  const port = parseInt(process.env.PORT || '3000');
  const reportBase = path.resolve(__dirname, '..');
  const reportFiles: Record<string, string> = {
    '/report/community': path.resolve(reportBase, config.COMMUNITY_REPORT_DIR, 'latest.json'),
    '/report/analytics': path.resolve(reportBase, config.ANALYTICS_REPORT_DIR, 'latest.json'),
  };

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const deploy = getLatestDeploy();
      const latestPost = getLatestPost();
      const ytDlpAvailable = isYtDlpAvailableCheck();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        status: 'ok',
        version: deploy?.version ?? null,
        commit: deploy?.commit_sha?.slice(0, 7) ?? null,
        deployed_at: deploy?.deployed_at ?? null,
        uptime_seconds: Math.floor(process.uptime()),
        ytDlpAvailable,
        lastPost: latestPost ? { date: latestPost.date, category: latestPost.category, posted_at: latestPost.posted_at } : null,
      }));
      return;
    }

    // GET /backup — download SQLite database (auth required)
    if (req.url === '/backup' && req.method === 'GET') {
      const authHeader = req.headers['x-admin-token'];
      const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const dbPath = config.COMMUNITY_DB_PATH;
      if (!fs.existsSync(dbPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'database not found' }));
        return;
      }
      // Checkpoint WAL to ensure backup includes all committed data
      try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch {}
      const stat = fs.statSync(dbPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="community-backup-${new Date().toISOString().slice(0, 10)}.db"`,
        'Content-Length': stat.size,
      });
      fs.createReadStream(dbPath).pipe(res);
      return;
    }

    // POST /packet — receive COMMUNITY_PACKET from strategist
    if (req.url === '/packet' && req.method === 'POST') {
      const authHeader = req.headers['x-admin-token'];
      const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const { packetId, actionIds } = savePacketFromExternal(payload.packet, payload.report);

          // Send proposed actions to admin for approval
          for (const actionId of actionIds) {
            const action = getActionById(actionId);
            if (action) {
              await sendActionToAdmin(bot, actionId, action);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', actions: actionIds.length }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // POST /upload-cookies — update yt-dlp cookies from local machine
    if (req.url === '/upload-cookies' && req.method === 'POST') {
      const authHeader = req.headers['x-admin-token'];
      const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const cookiesPath = process.env.YT_COOKIES_PATH || '/data/cookies.txt';
          const fs = require('fs');
          fs.writeFileSync(cookiesPath, body, 'utf8');
          const lines = body.split('\n').length;
          createLogger('http').info(`cookies updated: ${lines} lines written to ${cookiesPath}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', lines, path: cookiesPath }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // --- Implementor endpoints ---

    const parsedUrl = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (parsedUrl.pathname === '/impl/tasks' && req.method === 'GET') {
      const statusFilter = parsedUrl.searchParams.get('status') as ImplTaskStatus | null;
      const tasks = listImplTasks(statusFilter ?? undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks }));
      return;
    }

    if (parsedUrl.pathname === '/impl/next' && req.method === 'GET') {
      const task = getNextImplTask();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task }));
      return;
    }

    if (parsedUrl.pathname === '/impl/result' && req.method === 'POST') {
      const authHeader = req.headers['x-admin-token'];
      const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body) as {
            id: number;
            status: ImplTaskStatus;
            result?: string;
            branch?: string;
            commit_sha?: string;
          };
          if (!payload.id || !payload.status) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'id and status are required' }));
            return;
          }
          const existing = getImplTask(payload.id);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'task not found' }));
            return;
          }
          updateImplTaskStatus(payload.id, payload.status, payload.result, payload.branch, payload.commit_sha);

          // DM notification for key status changes
          if (['in_progress', 'done', 'failed'].includes(payload.status)) {
            const statusLabels: Record<string, string> = {
              in_progress: 'В работе',
              done: 'Выполнена',
              failed: 'Ошибка',
            };
            const label = statusLabels[payload.status] ?? payload.status;
            const { escV2: esc2 } = await import('./shared');
            const lines = [
              `*Задача \\#${esc2(String(payload.id))}: ${esc2(label)}*`,
              `${esc2(existing.title)}`,
            ];
            if (payload.result) lines.push(`\nРезультат: ${esc2(payload.result.slice(0, 500))}`);
            if (payload.branch) lines.push(`Ветка: ${esc2(payload.branch)}`);
            bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join('\n'), {
              parse_mode: 'MarkdownV2',
            }).catch(() => {});
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    if (parsedUrl.pathname === '/impl/create' && req.method === 'POST') {
      const authHeader = req.headers['x-admin-token'];
      const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body) as {
            title: string;
            spec: string;
            priority?: string;
          };
          if (!payload.title || !payload.spec) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'title and spec are required' }));
            return;
          }
          const taskId = createImplTask(payload.title, payload.spec, 'manual', payload.priority ?? 'P2');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', id: taskId }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    const filePath = reportFiles[req.url ?? ''];
    if (filePath) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      if (fs.existsSync(filePath)) {
        res.end(fs.readFileSync(filePath, 'utf8'));
      } else {
        res.end(JSON.stringify({ status: 'pending', message: 'report not generated yet', data: null }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown endpoint' }));
    }
  });
  httpServer.listen(port, () => {
    createLogger('http').info(`report server on :${port} — /report/community /report/analytics /packet /health /impl/*`);
  });

  // Graceful shutdown (Railway sends SIGTERM on redeploy)
  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down...`);
    try { await bot.stop(); } catch {}
    httpServer.close();
    closeDb();
    log.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start bot
  log.info('starting bot...');
  await bot.start({
    allowed_updates: [
      'message', 'edited_message', 'callback_query',
      'chat_member',  // Required for captcha: new member join events
      'channel_post', 'edited_channel_post',
      'poll',  // Required for poll results tracking
    ],
    onStart: async (botInfo) => {
      log.info(`bot @${botInfo.username} is running`);

      // Set bot commands menu for private chats
      await bot.api.setMyCommands(
        [
          { command: 'start', description: 'Главное меню' },
          { command: 'cancel', description: 'Отменить текущее действие' },
        ],
        { scope: { type: 'all_private_chats' } }
      ).catch(() => {});

      // ── Rich deploy notification ──────────────────────────────────
      await sendDeployReport(bot, config, pkgVersion).catch(err => {
        log.error('deploy report failed', { error: String(err) });
      });

      // One-time: audit channel/group/bot descriptions — add cross-links if missing
      auditDescriptions(bot, config).catch(err => {
        log.error('description audit failed', { error: String(err) });
      });

      // Run download diagnostic — only notify if something is wrong
      runDiagnostic().then((report) => {
        // Only alert if yt-dlp binary missing or ALL download attempts failed
        const lines = report.split('\n');
        const binaryMissing = lines.some(l => l.includes('FAIL: yt-dlp not found'));
        const allFailed = lines.some(l => l.includes('ALL ATTEMPTS FAILED'));
        if (binaryMissing || allFailed) {
          bot.api.sendMessage(
            config.TELEGRAM_ADMIN_USER_ID,
            `Проблема с загрузкой видео:\n${report}`,
          ).catch(() => {});
        }
      });
    },
  });
}

main().catch(async (err) => {
  log.error('fatal error', { error: String(err) });
  // Try to alert admin before dying
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
    if (token && adminId) {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(adminId),
          text: `\u26a0\ufe0f *SAMI Community Bot* — fatal crash\n\n\`${String(err).replace(/[`\\]/g, '\\$&')}\``,
          parse_mode: 'MarkdownV2',
        }),
      });
    }
  } catch { /* nothing we can do */ }
  process.exit(1);
});
