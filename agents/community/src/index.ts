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
import { recordDeploy, getLatestDeploy, listImplTasks, getNextImplTask, getImplTask, updateImplTaskStatus, createImplTask } from './db';
import type { ImplTaskStatus, ImplTaskSource } from './db';

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
    await ctx.reply(
      `*Sami — статус*\n\n` +
      `Дата: ${date}\n` +
      `Постов: ${posts}\n` +
      `Выполнений: ${completions} (${users} чел.)`,
      { parse_mode: 'Markdown' }
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
    const categories = ['stretching', 'strength', 'mobility'] as const;
    const hasTomorrow = categories.some(c => getApprovedVideo(tomorrow, c) !== null);
    const hasToday = categories.some(c => getApprovedVideo(today, c) !== null);
    const date = hasTomorrow ? tomorrow : hasToday ? today : null;

    if (!date) {
      await ctx.reply(`⚠️ Нет одобренных видео ни на ${today}, ни на ${tomorrow}. Сначала /search и выбери видео.`);
      return;
    }

    await ctx.reply(`📤 Публикую видео на ${date}...`);

    const report: string[] = [];
    for (const cat of categories) {
      const result = await postVideoToChannel(bot, date, cat, { force: true });
      const label = { stretching: 'Стретчинг', strength: 'Силовая', mobility: 'Мобильность' }[cat];
      if (result === 'posted') report.push(`✅ ${label}`);
      else if (result === 'no_video') report.push(`⚠️ ${label} — не выбрано`);
      else if (result === 'error') report.push(`❌ ${label} — ошибка`);
      else report.push(`⏭ ${label} — пропущено`);
    }

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: deploy?.version ?? null,
        commit: deploy?.commit_sha?.slice(0, 7) ?? null,
        deployed_at: deploy?.deployed_at ?? null,
        uptime_seconds: Math.floor(process.uptime()),
      }));
      return;
    }

    // POST /packet — receive COMMUNITY_PACKET from Mac strategist
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
            const lines = [
              `*Задача #${payload.id}: ${label}*`,
              `${existing.title}`,
            ];
            if (payload.result) lines.push(`\nРезультат: ${payload.result.slice(0, 500)}`);
            if (payload.branch) lines.push(`Ветка: ${payload.branch}`);
            bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join('\n'), {
              parse_mode: 'Markdown',
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
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

      // Notify admin on startup with deploy info
      const rawCommitMsg = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.trim();
      const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);

      const deployLines = ['Бот обновлён и запущен.'];
      if (pkgVersion) deployLines.push(`Версия: ${pkgVersion}`);
      if (commitSha) deployLines.push(`Коммит: ${commitSha}`);
      if (rawCommitMsg) {
        // Extract first meaningful line, clean technical noise
        const firstLine = rawCommitMsg
          .split('\n')
          .filter(l => !l.startsWith('Co-Authored-By:') && l.trim() !== '')
          .map(l => l.trim())[0];
        if (firstLine) deployLines.push(`Что нового: ${firstLine}`);
      }

      bot.api.sendMessage(
        config.TELEGRAM_ADMIN_USER_ID,
        deployLines.join('\n'),
      ).catch(() => {});

      // Run download diagnostic — only notify if something is wrong
      runDiagnostic().then((report) => {
        const hasIssue = report.toLowerCase().includes('fail') || report.toLowerCase().includes('error') || report.toLowerCase().includes('not found');
        if (hasIssue) {
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
          text: `\u26a0\ufe0f *SAMI Community Bot* — fatal crash\n\n\`${String(err)}\``,
          parse_mode: 'Markdown',
        }),
      });
    }
  } catch { /* nothing we can do */ }
  process.exit(1);
});
