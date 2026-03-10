import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { runApprovalFlow } from './approval';
import { readCommunityPacket, writeCommunityReport } from './strategist-sync';
import { runDailyAnalytics, runWeeklyAnalytics } from './analytics';

import { notifyAdmin } from './notify-admin';
import { todayMsk, tomorrowMsk, currentWeekMsk, moscowHour } from './dates';

const log = createLogger('scheduler');

let newMembersToday = 0;

export function incrementNewMembers(): void {
  newMembersToday++;
}

export function startScheduler(bot: Bot): void {
  const config = getConfig();

  log.info('starting cron jobs...');

  // 19:00 — search videos for TOMORROW & send approval to admin
  cron.schedule(config.CRON_SEARCH_VIDEOS, async () => {
    log.info('running video search & approval flow');
    try {
      const packet = readCommunityPacket();
      const date = tomorrowMsk();
      await runApprovalFlow(bot, date, {
        stretching: packet.search_keywords?.stretching,
        strength: packet.search_keywords?.strength,
        mobility: packet.search_keywords?.mobility,
      });
    } catch (err) {
      log.error('video search failed', { error: String(err) });
      await notifyAdmin(bot, 'Community', `Поиск видео упал:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // Auto-posting disabled — admin publishes manually via "Опубликовать" button

  // 23:55 — write daily report for strategist
  cron.schedule('55 23 * * *', () => {
    log.info('writing daily community report');
    writeCommunityReport(todayMsk(), newMembersToday);
    newMembersToday = 0;
  }, { timezone: 'Europe/Moscow' });

  // ---- Analytics agent ----

  // 00:30 — daily analytics: collect Telegram stats, DM admin
  cron.schedule(config.CRON_ANALYTICS_DAILY, async () => {
    log.info('running daily analytics');
    try {
      await runDailyAnalytics(bot, todayMsk());
    } catch (err) {
      log.error('daily analytics failed', { error: String(err) });
      await notifyAdmin(bot, 'Analytics', `Ежедневная аналитика упала:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // Sunday 10:00 — weekly analytics dashboard
  cron.schedule(config.CRON_ANALYTICS_WEEKLY, async () => {
    log.info('running weekly analytics');
    try {
      await runWeeklyAnalytics(bot, currentWeekMsk());
    } catch (err) {
      log.error('weekly analytics failed', { error: String(err) });
      await notifyAdmin(bot, 'Analytics', `Недельный дашборд упал:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // Strategist runs on Mac (claude --print, Max subscription) and POSTs packet to /packet endpoint.
  // If ANTHROPIC_API_KEY is set, can also run locally on Railway (future option).

  log.info('all cron jobs registered (community + analytics)');

  // Cleanup old approval sessions on startup
  setTimeout(() => {
    try {
      const { cleanupOldApprovalSessions } = require('./db');
      const cleaned = cleanupOldApprovalSessions(2);
      if (cleaned > 0) log.info(`cleaned up ${cleaned} old approval sessions`);
    } catch (err) {
      log.error('cleanup approval sessions failed', { error: String(err) });
    }
  }, 1000);

  // Catch-up on startup: run analytics immediately so latest.json is always available
  setTimeout(async () => {
    try {
      log.info('catch-up: running analytics on startup');
      await runDailyAnalytics(bot, todayMsk());
    } catch (err) {
      log.error('catch-up analytics failed', { error: String(err) });
    }
  }, 3000);

  // Catch-up: if bot started after 19:00 MSK and no approval sessions exist for tomorrow, run search now
  setTimeout(async () => {
    try {
      const date = tomorrowMsk();
      const db = (await import('./db')).getDb();
      const row = db.prepare('SELECT COUNT(*) as cnt FROM approval_sessions WHERE date = ?').get(date) as { cnt: number };
      if (row.cnt === 0) {
        if (moscowHour() >= 19) {
          log.info('catch-up: no approval sessions for tomorrow, running video search now');
          const packet = readCommunityPacket();
          await runApprovalFlow(bot, date, {
            stretching: packet.search_keywords?.stretching,
            strength: packet.search_keywords?.strength,
            mobility: packet.search_keywords?.mobility,
          });
        }
      }
    } catch (err) {
      log.error('catch-up check failed', { error: String(err) });
    }
  }, 5000);
}
