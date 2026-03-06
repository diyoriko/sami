import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { getConfig } from './config';
import { postVideoToChannel, postCheckin } from './poster';
import { runApprovalFlow } from './approval';
import { readCommunityPacket, writeCommunityReport } from './strategist-sync';
import { runDailyAnalytics, runWeeklyAnalytics } from './analytics';
import { runContentCuration } from './content-curator';
import { notifyAdmin } from './notify-admin';

let newMembersToday = 0;

export function incrementNewMembers(): void {
  newMembersToday++;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function currentWeek(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now.getTime() - start.getTime() + (start.getTimezoneOffset() - now.getTimezoneOffset()) * 60000;
  const week = Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function startScheduler(bot: Bot): void {
  const config = getConfig();

  console.log('[scheduler] starting cron jobs...');

  // 19:00 — search videos for TOMORROW & send approval to admin
  cron.schedule(config.CRON_SEARCH_VIDEOS, async () => {
    console.log('[scheduler] running video search & approval flow');
    try {
      const packet = readCommunityPacket();
      const date = tomorrowDate();
      await runApprovalFlow(bot, date, {
        stretching: packet.search_keywords?.stretching,
        strength: packet.search_keywords?.strength,
        mobility: packet.search_keywords?.mobility,
      });
    } catch (err) {
      console.error('[scheduler] video search failed:', err);
      await notifyAdmin(bot, 'Community', `Поиск видео упал:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // 08:00 — post all 3 videos simultaneously
  cron.schedule(config.CRON_POST_ALL, async () => {
    console.log('[scheduler] posting all 3 videos');
    try {
      const date = todayDate();
      await Promise.all([
        postVideoToChannel(bot, date, 'stretching'),
        postVideoToChannel(bot, date, 'strength'),
        postVideoToChannel(bot, date, 'mobility'),
      ]);
    } catch (err) {
      console.error('[scheduler] posting failed:', err);
      await notifyAdmin(bot, 'Community', `Публикация видео упала:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // 22:00 — post evening check-in
  cron.schedule(config.CRON_CHECKIN, async () => {
    console.log('[scheduler] posting check-in');
    try {
      await postCheckin(bot, todayDate());
    } catch (err) {
      console.error('[scheduler] checkin failed:', err);
      await notifyAdmin(bot, 'Community', `Чекин упал:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // 23:55 — write daily report for strategist
  cron.schedule('55 23 * * *', () => {
    console.log('[scheduler] writing daily community report');
    writeCommunityReport(todayDate(), newMembersToday);
    newMembersToday = 0;
  }, { timezone: 'Europe/Moscow' });

  // ---- Analytics agent ----

  // 00:30 — daily analytics: collect Telegram stats, DM admin
  cron.schedule(config.CRON_ANALYTICS_DAILY, async () => {
    console.log('[scheduler] running daily analytics');
    try {
      await runDailyAnalytics(bot, todayDate());
    } catch (err) {
      console.error('[scheduler] daily analytics failed:', err);
      await notifyAdmin(bot, 'Analytics', `Ежедневная аналитика упала:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // Sunday 10:00 — weekly analytics dashboard
  cron.schedule(config.CRON_ANALYTICS_WEEKLY, async () => {
    console.log('[scheduler] running weekly analytics');
    try {
      await runWeeklyAnalytics(bot, currentWeek());
    } catch (err) {
      console.error('[scheduler] weekly analytics failed:', err);
      await notifyAdmin(bot, 'Analytics', `Недельный дашборд упал:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // ---- Content Curator agent ----

  // Monday 09:00 — weekly content plan
  cron.schedule(config.CRON_CONTENT_CURATOR, async () => {
    console.log('[scheduler] running content curation');
    try {
      await runContentCuration(bot, currentWeek());
    } catch (err) {
      console.error('[scheduler] content curation failed:', err);
      await notifyAdmin(bot, 'Content Curator', `Контент-план упал:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  console.log('[scheduler] all cron jobs registered (community + analytics + content-curator)');

  // Catch-up: if bot started after 19:00 MSK and no approval sessions exist for tomorrow, run search now
  setTimeout(async () => {
    try {
      const date = tomorrowDate();
      const db = (await import('./db')).getDb();
      const row = db.prepare('SELECT COUNT(*) as cnt FROM approval_sessions WHERE date = ?').get(date) as { cnt: number };
      if (row.cnt === 0) {
        const nowMsk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
        const hour = nowMsk.getHours();
        if (hour >= 19) {
          console.log('[scheduler] catch-up: no approval sessions for tomorrow, running video search now');
          const packet = readCommunityPacket();
          await runApprovalFlow(bot, date, {
            stretching: packet.search_keywords?.stretching,
            strength: packet.search_keywords?.strength,
            mobility: packet.search_keywords?.mobility,
          });
        }
      }
    } catch (err) {
      console.error('[scheduler] catch-up check failed:', err);
    }
  }, 5000);
}
