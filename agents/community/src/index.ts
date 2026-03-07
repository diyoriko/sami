import { Bot, session } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { getConfig } from './config';
import { getDb } from './db';
import { registerBotMenu } from './bot-menu';
import { registerModeration } from './moderation';
import { registerApprovalCallbacks } from './approval';
import { startScheduler } from './scheduler';
import { logYtDlpStatus, initCookies, setAdminNotifier } from './downloader';

async function main(): Promise<void> {
  const config = getConfig();

  // Init DB
  getDb();
  console.log('[sami-community] database ready');

  // Init YouTube cookies from env and check yt-dlp
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
  console.log('[sami-community] report directories ready');

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

  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
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
  }).listen(port, () => {
    console.log(`[http] report server on :${port} — /report/community /report/analytics /health`);
  });

  // Start bot
  console.log('[sami-community] starting bot...');
  await bot.start({
    onStart: async (botInfo) => {
      console.log(`[sami-community] bot @${botInfo.username} is running`);

      // Set bot commands menu for private chats
      await bot.api.setMyCommands(
        [
          { command: 'start', description: 'Главное меню' },
          { command: 'cancel', description: 'Отменить текущее действие' },
        ],
        { scope: { type: 'all_private_chats' } }
      ).catch(() => {});

      // Notify admin on startup with deploy info
      const commitMsg = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.trim();
      const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);

      const lines = ['*Sami Bot запущен*'];
      if (commitMsg) {
        lines.push('', `\`${commitSha}\` ${commitMsg}`);
      }
      lines.push(
        '',
        'Команды: /status /search /reset /post /analytics',
      );

      bot.api.sendMessage(
        config.TELEGRAM_ADMIN_USER_ID,
        lines.join('\n'),
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    },
  });
}

main().catch(async (err) => {
  console.error('[sami-community] fatal error:', err);
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
