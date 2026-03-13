import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { writeCommunityReport } from './strategist-sync';
import { runDailyAnalytics, runWeeklyAnalytics } from './analytics';

import { notifyAdmin } from './notify-admin';
import { todayMsk, currentWeekMsk } from './dates';

const log = createLogger('scheduler');

let newMembersToday = 0;

export function incrementNewMembers(): void {
  newMembersToday++;
}

export function startScheduler(bot: Bot): void {
  const config = getConfig();

  log.info('starting cron jobs...');

  // ---- Season auto-publish ----

  cron.schedule(config.CRON_SEASON_PUBLISH, async () => {
    log.info('season auto-publish cron triggered');
    try {
      const { ensureActiveSeason, getSeasonDay, completeSeason, getSeasonQueueForDay } = require('./db') as typeof import('./db');
      const { postSeasonVideo } = require('./poster') as typeof import('./poster');
      const { nextMondayMsk } = require('./dates') as typeof import('./dates');
      const { SEASON_DAY_MAP, CATEGORY_RU, SEASON_DURATION } = require('./shared') as typeof import('./shared');

      const today = todayMsk();
      const season = ensureActiveSeason(today, nextMondayMsk());
      if (season.status !== 'active') {
        log.info(`season ${season.number} not active yet (starts ${season.start_date})`);
        return;
      }

      const dayNumber = getSeasonDay(season.start_date, today);
      if (dayNumber > SEASON_DURATION) {
        log.info(`season ${season.number} ended (day ${dayNumber}), completing`);
        completeSeason(season.id);
        // Next season will be created on next trigger
        return;
      }

      const slot = getSeasonQueueForDay(season.id, dayNumber);
      if (!slot || slot.status === 'posted') {
        log.info(`season ${season.number} day ${dayNumber}: already posted or no slot`);
        return;
      }
      if (slot.status === 'empty' || !slot.video_id) {
        const dow = new Date(today + 'T00:00:00').getDay();
        const cat = SEASON_DAY_MAP[dow];
        const catRu = cat ? CATEGORY_RU[cat] : '?';
        await notifyAdmin(bot, 'Season', `Нет видео на сегодня\\!\n\`День ${dayNumber}, ${catRu}\`\nНайди и добавь через «Поиск видео»`);
        return;
      }

      const result = await postSeasonVideo(bot, season, dayNumber);
      if (result === 'posted') {
        log.info(`season auto-publish: day ${dayNumber} posted`);
      } else {
        await notifyAdmin(bot, 'Season', `Автопубликация провалилась: день ${dayNumber}, результат: ${result}`);
      }
    } catch (err) {
      log.error('season auto-publish failed', { error: String(err) });
      await notifyAdmin(bot, 'Season', `Автопубликация упала:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

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

  // Auto-search catch-up disabled — admin uses "Поиск видео" button manually
}
