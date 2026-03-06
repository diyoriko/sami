import { Bot, session } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { getDb } from './db';
import { registerModeration } from './moderation';
import { registerApprovalCallbacks } from './approval';
import { startScheduler } from './scheduler';
import { logYtDlpStatus } from './downloader';

async function main(): Promise<void> {
  const config = getConfig();

  // Init DB
  getDb();
  console.log('[sami-community] database ready');

  // Check yt-dlp availability on startup
  logYtDlpStatus();

  // Ensure report directories exist
  const reportDirs = [
    config.COMMUNITY_REPORT_DIR,
    config.ANALYTICS_REPORT_DIR,
    config.ANALYTICS_WEEKLY_DIR,
    config.CONTENT_CURATOR_REPORT_DIR,
  ];
  for (const dir of reportDirs) {
    const resolved = path.resolve(__dirname, '..', dir);
    fs.mkdirSync(resolved, { recursive: true });
  }
  console.log('[sami-community] report directories ready');

  // Init bot
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Register handlers
  registerModeration(bot);
  registerApprovalCallbacks(bot);

  // /status command for admin
  bot.command('status', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { getCheckinStats } = await import('./db');
    const date = new Date().toISOString().slice(0, 10);
    const stats = getCheckinStats(date);
    await ctx.reply(
      `📊 *Sami Community — статус*\n\n` +
      `📅 Дата: ${date}\n` +
      `✅ Чекин сделали: ${stats.did}\n` +
      `😅 Частично: ${stats.partial}\n` +
      `❌ Не получилось: ${stats.didnt}\n`,
      { parse_mode: 'Markdown' }
    );
  });

  // /search command — manual video search trigger for admin
  bot.command('search', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { runApprovalFlow } = await import('./approval');
    const date = new Date().toISOString().slice(0, 10);
    await ctx.reply('🔍 Запускаю поиск видео вручную...');
    await runApprovalFlow(bot, date);
  });

  // /post command — manually trigger posting for admin
  bot.command('post', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const args = ctx.match?.trim() as 'stretching' | 'strength' | 'mobility' | undefined;
    const { postVideoToChannel } = await import('./poster');
    const date = new Date().toISOString().slice(0, 10);

    const categories = args ? [args] : (['stretching', 'strength', 'mobility'] as const);
    for (const cat of categories) {
      await postVideoToChannel(bot, date, cat);
    }
    await ctx.reply(`✅ Пост(ы) опубликованы`);
  });

  // /checkin command — manually trigger check-in post
  bot.command('checkin', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { postCheckin } = await import('./poster');
    const date = new Date().toISOString().slice(0, 10);
    await postCheckin(bot, date);
    await ctx.reply('✅ Чекин опубликован');
  });

  // /analytics command — manually trigger daily analytics
  bot.command('analytics', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { runDailyAnalytics } = await import('./analytics');
    const date = new Date().toISOString().slice(0, 10);
    await ctx.reply('📊 Запускаю аналитику...');
    await runDailyAnalytics(bot, date);
  });

  // /curator command — manually trigger content curation
  bot.command('curator', async (ctx) => {
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    const { runContentCuration } = await import('./content-curator');
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const diff = now.getTime() - start.getTime();
    const week = Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
    const weekStr = `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
    await ctx.reply('📋 Генерирую контент-план...');
    await runContentCuration(bot, weekStr);
  });

  // Start scheduler
  startScheduler(bot);

  // Start bot
  console.log('[sami-community] starting bot...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`[sami-community] bot @${botInfo.username} is running`);
      // Notify admin on startup
      bot.api.sendMessage(
        config.TELEGRAM_ADMIN_USER_ID,
        `🚀 *Sami Community Bot запущен*\n\nКоманды:\n/status — статус дня\n/search — поиск видео\n/post [stretching|strength|mobility] — опубликовать пост\n/checkin — чекин\n/analytics — аналитика\n/curator — контент-план`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    },
  });
}

main().catch((err) => {
  console.error('[sami-community] fatal error:', err);
  process.exit(1);
});
