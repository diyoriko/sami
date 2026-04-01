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
import { sendAdminMessage } from './notify-admin';
import { recordDeploy, getLatestDeploy, getLatestPost, listImplTasks, getNextImplTask, getImplTask, updateImplTaskStatus, createImplTask, saveProposal, getApprovedProposals, deleteProposals } from './db';
import { isYtDlpAvailable as isYtDlpAvailableCheck } from './downloader';
import type { ImplTaskStatus, ImplTaskSource } from './db';

async function sendDeployReport(
  bot: Bot,
  config: ReturnType<typeof getConfig>,
  pkgVersion?: string,
): Promise<void> {
  const { escV2: e } = await import('./shared');
  const {
    getDeployStats, getActiveChallenge, getChallengeDay, getChallengeWeekNumber,
    getChannelStats, getLastStrategistTimestamp, getLatestPost: getLatestPostDb,
    getWeekStatus, initWeekSlots,
  } = await import('./db');
  const { todayMsk } = await import('./dates');
  const { isYtDlpAvailable } = await import('./downloader');
  const { DAY_CATEGORY_MAP, CATEGORY_RU, CATEGORY_EMOJI } = await import('./shared');

  const today = todayMsk();
  const stats = getDeployStats();
  const challenge = getActiveChallenge();
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

  // ── Challenge ──
  if (challenge) {
    const dayNum = getChallengeDay(challenge.start_date, today);
    const weekNum = getChallengeWeekNumber(dayNum);
    const dow = new Date(today + 'T00:00:00').getDay();
    const todayCat = DAY_CATEGORY_MAP[dow];
    const catLabel = todayCat ? `${CATEGORY_EMOJI[todayCat]} ${CATEGORY_RU[todayCat]}` : '?';

    initWeekSlots(challenge.id, weekNum);
    const slots = getWeekStatus(challenge.id, weekNum);
    const filled = slots.filter(s => s.status === 'queued' || s.status === 'posted').length;
    const posted = slots.filter(s => s.status === 'posted').length;

    lines.push('');
    lines.push(`📅 *Неделя:*`);
    lines.push(`  Сегодня: ${e(catLabel)}`);
    lines.push(`  Очередь: ${e(String(filled))}/7 заполнено, ${e(String(posted))} опубликовано`);
  } else {
    lines.push('');
    lines.push(`📅 *Неделя:* нет активной`);
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
  lines.push(`_Кнопки: 📊 Дашборд · 📅 Неделя_`);

  // Send via unified bot (plain text — strip MarkdownV2 escapes)
  const plainText = lines.join('\n')
    .replace(/\\([.!>=#{}()|~_-])/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  await sendAdminMessage(plainText);
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

  // /wipe — clear all data (videos, posts, challenges, UGC, etc.)
  bot.command('wipe', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;

    // Two-step confirmation: first call shows warning, second (with "confirm") executes
    const args = ctx.match?.trim();
    if (args !== 'confirm') {
      await ctx.reply(
        '⚠️ Это удалит ВСЕ данные: видео, посты, челленджи, тренировки, участников, статистику.\n\n' +
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

  // /rewrite — re-generate captions for all channel posts with new title logic
  bot.command('rewrite', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { formatCaption } = await import('./poster');
    const { getDb, getVideoById } = await import('./db');
    const { escV2: esc } = await import('./shared');

    const posts = getDb().prepare(`
      SELECT p.id, p.video_id, p.channel_message_id, p.category, p.post_type
      FROM posts p
      WHERE p.channel_message_id IS NOT NULL
      ORDER BY p.posted_at DESC
    `).all() as { id: number; video_id: number; channel_message_id: number; category: string; post_type: string }[];

    await ctx.reply(`✏️ Переписываю ${posts.length} постов...`);

    let ok = 0;
    let fail = 0;
    for (const p of posts) {
      const video = getVideoById(p.video_id);
      if (!video) { fail++; continue; }

      const caption = await formatCaption(video, undefined, undefined, p.category as any);

      try {
        if (p.post_type === 'video') {
          await bot.api.editMessageCaption(config.TELEGRAM_CHANNEL_ID, p.channel_message_id, {
            caption,
            parse_mode: 'MarkdownV2',
          });
        } else {
          await bot.api.editMessageText(config.TELEGRAM_CHANNEL_ID, p.channel_message_id, caption, {
            parse_mode: 'MarkdownV2',
            link_preview_options: { is_disabled: true },
          });
        }
        ok++;
      } catch (err: any) {
        // "message is not modified" is OK — content didn't change
        if (err?.description?.includes('not modified')) { ok++; continue; }
        fail++;
      }

      // Telegram rate limit: max ~30 msg/sec, 300ms delay is safe
      await new Promise(r => setTimeout(r, 300));
    }

    await ctx.reply(`✅ Готово: ${ok} обновлено, ${fail} ошибок.`);
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

      const MAX_BODY = 5 * 1024 * 1024; // 5 MB
      const chunks: Buffer[] = [];
      let bodySize = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY) { tooBig = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (tooBig) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const payload = JSON.parse(body);
          if (!payload.packet || typeof payload.packet !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'packet must be an object' }));
            return;
          }
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

      const MAX_COOKIES = 1 * 1024 * 1024; // 1 MB
      const chunks: Buffer[] = [];
      let bodySize = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_COOKIES) { tooBig = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const cookiesPath = process.env.YT_COOKIES_PATH || '/data/cookies.txt';
          // Path traversal guard: must be within /data/ or project dir
          const resolved = path.resolve(cookiesPath);
          if (!resolved.startsWith('/data/') && !resolved.startsWith(path.resolve(__dirname, '..'))) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid cookies path' }));
            return;
          }
          fs.writeFileSync(resolved, body, 'utf8');
          const lines = body.split('\n').length;
          createLogger('http').info(`cookies updated: ${lines} lines`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', lines }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'write failed' }));
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

      const MAX_BODY = 1 * 1024 * 1024; // 1 MB
      const chunks: Buffer[] = [];
      let bodySize = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY) { tooBig = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (tooBig) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString('utf8');
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
        } catch (err) {
          log.warn('invalid JSON in /task endpoint', { error: String(err) });
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

      const MAX_BODY = 1 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let bodySize = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY) { tooBig = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString('utf8');
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
        } catch (err) {
          log.warn('invalid JSON in /impl/create endpoint', { error: String(err) });
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // --- Proposal endpoints (strategist → admin approval → backlog) ---

    if (parsedUrl.pathname === '/proposal' && req.method === 'POST') {
      const authHeader = req.headers['x-admin-token'];
      const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const MAX_BODY = 512 * 1024;
      const chunks: Buffer[] = [];
      let bodySize = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY) { tooBig = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const payload = JSON.parse(body) as { task_text: string };
          if (!payload.task_text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'task_text is required' }));
            return;
          }
          const id = saveProposal(payload.task_text);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', id }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    if (parsedUrl.pathname === '/proposals' && req.method === 'GET') {
      const authHeader = req.headers['x-admin-token'];
      const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const approved = getApprovedProposals();
      // Delete fetched proposals so they are not re-applied
      if (approved.length > 0) {
        deleteProposals(approved.map(p => p.id));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proposals: approved.map(p => ({ id: p.id, taskText: p.task_text })) }));
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
    createLogger('http').info(`report server on :${port} — /report/community /report/analytics /packet /health /impl/* /proposal /proposals`);
  });

  // Graceful shutdown (Railway sends SIGTERM on redeploy, 10s before SIGKILL)
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down...`);
    // Force exit after 8s (Railway SIGKILL at 10s)
    const forceTimer = setTimeout(() => { log.info('force exit'); process.exit(0); }, 8000);
    forceTimer.unref();
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

      // Description audit removed — owner manages descriptions manually

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
