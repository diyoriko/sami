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
let newMembersDate = todayMsk();

export function incrementNewMembers(): void {
  const today = todayMsk();
  if (today !== newMembersDate) {
    newMembersToday = 0;
    newMembersDate = today;
  }
  newMembersToday++;
}

export function startScheduler(bot: Bot): void {
  const config = getConfig();

  log.info('starting cron jobs...');

  // ---- Challenge auto-publish ----

  cron.schedule(config.CRON_CHALLENGE_PUBLISH, async () => {
    log.info('challenge auto-publish cron triggered');
    try {
      const { ensureActiveChallenge, getChallengeDay, completeChallenge, getWeekSlotForDay } = require('./db') as typeof import('./db');
      const { postChallengeVideo } = require('./poster') as typeof import('./poster');
      const { thisMondayMsk } = require('./dates') as typeof import('./dates');
      const { DAY_CATEGORY_MAP, CATEGORY_RU, CHALLENGE_DURATION } = require('./shared') as typeof import('./shared');

      const today = todayMsk();
      const challenge = ensureActiveChallenge(today, thisMondayMsk());
      if (challenge.status !== 'active') {
        log.info(`challenge ${challenge.number} not active yet (starts ${challenge.start_date})`);
        return;
      }

      const dayNumber = getChallengeDay(challenge.start_date, today);
      if (dayNumber > CHALLENGE_DURATION) {
        log.info(`challenge ${challenge.number} ended (day ${dayNumber}), completing`);
        completeChallenge(challenge.id);
        // Next challenge will be created on next trigger
        return;
      }

      const slot = getWeekSlotForDay(challenge.id, dayNumber);
      if (!slot || slot.status === 'posted') {
        log.info(`challenge ${challenge.number} day ${dayNumber}: already posted or no slot`);
        return;
      }
      if (slot.status !== 'queued' || !slot.video_id) {
        // Unfilled day — normal when admin fills only 2-3 days per week. Silent skip.
        const dow = new Date(today + 'T00:00:00').getDay();
        const cat = DAY_CATEGORY_MAP[dow];
        const catRu = cat ? CATEGORY_RU[cat] : '?';
        log.info(`challenge ${challenge.number} day ${dayNumber} (${catRu}): no video queued, skipping`);
        return;
      }

      const result = await postChallengeVideo(bot, challenge, dayNumber);
      if (result === 'posted') {
        log.info(`challenge auto-publish: day ${dayNumber} posted`);
      } else {
        await notifyAdmin(bot, 'Challenge', `Автопубликация провалилась: день ${dayNumber}, результат: ${result}`);
      }
    } catch (err) {
      log.error('challenge auto-publish failed', { error: String(err) });
      await notifyAdmin(bot, 'Challenge', `Автопубликация упала:\n\`${String(err)}\``);
    }
  }, { timezone: 'Europe/Moscow' });

  // ---- Challenge series auto-publish ----
  // Runs every minute at :00 to check if any active series has a slot to publish at this time
  cron.schedule('* * * * *', async () => {
    try {
      const { getActiveChallengeSeriesList, getChallengeSeriesDaySlot } = require('./db') as typeof import('./db');
      const { postChallengeSeriesVideo } = require('./poster') as typeof import('./poster');
      const { moscowNow } = require('./dates') as typeof import('./dates');

      const now = moscowNow();
      const currentHH = String(now.getHours()).padStart(2, '0');
      const currentMM = String(now.getMinutes()).padStart(2, '0');
      const currentTime = `${currentHH}:${currentMM}`;
      const today = todayMsk();

      const activeSeries = getActiveChallengeSeriesList();
      for (const series of activeSeries) {
        // Check if publish_time matches current minute
        if (series.publish_time !== currentTime) continue;

        // Determine which day of the series today is
        const startMs = new Date(series.start_date + 'T00:00:00').getTime();
        const todayMs = new Date(today + 'T00:00:00').getTime();
        const dayNumber = Math.floor((todayMs - startMs) / 86400000) + 1;

        if (dayNumber < 1 || dayNumber > series.duration_days) continue;

        const slot = getChallengeSeriesDaySlot(series.id, dayNumber);
        if (!slot || slot.status !== 'queued' || !slot.video_id) continue;

        log.info(`series auto-publish: "${series.name}" day ${dayNumber}`);
        const result = await postChallengeSeriesVideo(bot, series, dayNumber);
        if (result !== 'posted') {
          await notifyAdmin(bot, 'Challenge Series', `Автопубликация "${series.name}" день ${dayNumber}: ${result}`);
        }
      }
    } catch (err) {
      log.error('challenge series auto-publish failed', { error: String(err) });
    }
  }, { timezone: 'Europe/Moscow' });

  // ---- 22:00 MSK — notify admin if tomorrow has no video ----
  cron.schedule('0 22 * * *', async () => {
    try {
      const { ensureActiveChallenge, getChallengeDay, getWeekSlotForDay } = require('./db') as typeof import('./db');
      const { thisMondayMsk, addDaysMsk } = require('./dates') as typeof import('./dates');
      const { DAY_CATEGORY_MAP, CATEGORY_RU, CATEGORY_EMOJI, CHALLENGE_DURATION } = require('./shared') as typeof import('./shared');

      const tomorrow = addDaysMsk(todayMsk(), 1);
      const tomorrowMonday = thisMondayMsk(); // may shift if tomorrow is Monday
      const challenge = ensureActiveChallenge(tomorrow, tomorrowMonday);
      if (challenge.status !== 'active') return;

      const dayNumber = getChallengeDay(challenge.start_date, tomorrow);
      if (dayNumber < 1 || dayNumber > CHALLENGE_DURATION) return;

      const slot = getWeekSlotForDay(challenge.id, dayNumber);
      if (slot && (slot.status === 'queued' || slot.status === 'posted')) return; // video ready

      const dow = new Date(tomorrow + 'T00:00:00').getDay();
      const cat = DAY_CATEGORY_MAP[dow];
      const catRu = cat ? CATEGORY_RU[cat] : '?';
      const catEmoji = cat ? CATEGORY_EMOJI[cat] : '❓';

      await bot.api.sendMessage(
        config.TELEGRAM_ADMIN_USER_ID,
        `⚠️ На завтра (${catEmoji} ${catRu}) нет тренировки.\nВыбери видео через «📅 Неделя»!`
      );
      log.info(`notified admin: no video for tomorrow (${catRu})`);
    } catch (err) {
      log.error('tomorrow video check failed', { error: String(err) });
    }
  }, { timezone: 'Europe/Moscow' });

  // 23:55 — write daily report for strategist
  cron.schedule('55 23 * * *', () => {
    log.info('writing daily community report');
    writeCommunityReport(todayMsk(), newMembersToday);
    newMembersToday = 0;
    newMembersDate = todayMsk();
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

  // ---- S5: Weekly progress poll (Sunday 12:00 MSK) ----
  cron.schedule('0 9 * * 0', async () => {
    log.info('posting weekly progress poll');
    try {
      const { ensureActiveChallenge } = require('./db') as typeof import('./db');
      const { thisMondayMsk } = require('./dates') as typeof import('./dates');

      const today = todayMsk();
      const challenge = ensureActiveChallenge(today, thisMondayMsk());
      if (challenge.status !== 'active') return;

      const question = `Неделя позади! Сколько тренировок удалось сделать?`;

      await bot.api.sendPoll(config.TELEGRAM_CHANNEL_ID, question, [
        { text: `Все 7` },
        { text: `4–6` },
        { text: `1–3` },
        { text: `Пропустил(а) неделю` },
      ], { is_anonymous: true });

      log.info('weekly poll posted');
    } catch (err) {
      log.error('weekly poll failed', { error: String(err) });
    }
  }, { timezone: 'Europe/Moscow' });

  // ---- S6: Stability wall (Friday 19:00 MSK) ----
  cron.schedule('0 16 * * 5', async () => {
    log.info('posting stability wall');
    try {
      const { getWeeklyConsistentUsers, ensureActiveChallenge } = require('./db') as typeof import('./db');
      const { thisMondayMsk } = require('./dates') as typeof import('./dates');

      const today = todayMsk();
      const challenge = ensureActiveChallenge(today, thisMondayMsk());
      if (challenge.status !== 'active') return;

      // Get the last 7 days range
      const endDate = today;
      const startMs = new Date(today + 'T00:00:00').getTime() - 6 * 86_400_000;
      const startDate = new Date(startMs).toISOString().slice(0, 10);

      const users = getWeeklyConsistentUsers(startDate, endDate);
      if (users.length === 0) {
        log.info('no consistent users this week');
        return;
      }

      const names = users.map(u => u.first_name).join('\n• ');
      const text = [
        `🧱 *Стена стабильности*`,
        ``,
        `Эти люди не пропустили ни дня за последнюю неделю:`,
        ``,
        `• ${names}`,
      ].join('\n');

      await bot.api.sendMessage(config.TELEGRAM_CHANNEL_ID, text, { parse_mode: 'Markdown' });
      log.info(`stability wall posted (${users.length} users)`);
    } catch (err) {
      log.error('stability wall failed', { error: String(err) });
    }
  }, { timezone: 'Europe/Moscow' });

  // ---- 48h inactivity reminder (daily 10:00 MSK) ----
  cron.schedule('0 10 * * *', async () => {
    log.info('checking for inactive users (48h reminder)');
    try {
      const { getInactiveUsers, markReminderSent, getLatestPost } = require('./db') as typeof import('./db');

      const inactiveUsers = getInactiveUsers(48);
      if (inactiveUsers.length === 0) {
        log.info('no inactive users to remind');
        return;
      }

      const latestPost = getLatestPost();
      const channelHandle = config.TELEGRAM_CHANNEL_ID.startsWith('@')
        ? config.TELEGRAM_CHANNEL_ID.slice(1)
        : `c/${config.TELEGRAM_CHANNEL_ID.replace(/^-100/, '')}`;

      let postLink = 'https://t.me/sami_workouts';
      if (latestPost) {
        const { getLatestPostForDate: getLP } = require('./db') as typeof import('./db');
        const todayPost = getLP(todayMsk());
        if (todayPost) {
          postLink = `https://t.me/${channelHandle}/${todayPost.channel_message_id}`;
        }
      }

      let sent = 0;
      for (const user of inactiveUsers) {
        try {
          await bot.api.sendMessage(
            user.telegram_user_id,
            `Давно не виделись! Пропустил тренировку? Ничего страшного — вот свежая, можно начать прямо сейчас:\n\n${postLink}\n\nОдна тренировка — уже победа.`
          );
          markReminderSent(user.telegram_user_id);
          sent++;
        } catch {
          // User blocked DMs — that's ok
        }
      }
      log.info(`48h reminders sent: ${sent}/${inactiveUsers.length}`);
    } catch (err) {
      log.error('48h reminder failed', { error: String(err) });
    }
  }, { timezone: 'Europe/Moscow' });

  // ---- Owner reminder: no posts today (15:00 MSK) ----
  cron.schedule('0 15 * * *', async () => {
    log.info('checking if owner posted today (15:00 reminder)');
    try {
      const { getPostCountForDate } = require('./db') as typeof import('./db');

      const today = todayMsk();
      const postCount = getPostCountForDate(today);

      if (postCount > 0) {
        log.info(`owner reminder skipped — ${postCount} post(s) already today`);
        return;
      }

      const { InlineKeyboard } = require('grammy');
      const kb = new InlineKeyboard().text('📅 Искать тренировку', 'show_week_status');

      await bot.api.sendMessage(
        config.TELEGRAM_ADMIN_USER_ID,
        'Сегодня ещё не было постов в канале. Найди тренировку и опубликуй — канал не должен молчать.',
        { reply_markup: kb }
      );
      log.info('owner reminder sent — no posts today');
    } catch (err) {
      log.error('owner reminder failed', { error: String(err) });
    }
  }, { timezone: 'Europe/Moscow' });

  // ---- Stories reminder — DISABLED (admin request 2026-04-03) ----

  // Strategist runs on Mac (claude --print, Max subscription) and POSTs packet to /packet endpoint.
  // If ANTHROPIC_API_KEY is set, can also run locally on Railway (future option).

  log.info('all cron jobs registered (community + analytics + poll + stability + reminder + owner)');

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

  // Catch-up on startup: publish today's challenge video if queued but not yet posted
  setTimeout(async () => {
    try {
      const { ensureActiveChallenge, getChallengeDay, getWeekSlotForDay } = require('./db') as typeof import('./db');
      const { postChallengeVideo } = require('./poster') as typeof import('./poster');
      const { thisMondayMsk } = require('./dates') as typeof import('./dates');
      const { CHALLENGE_DURATION } = require('./shared') as typeof import('./shared');

      const today = todayMsk();
      const challenge = ensureActiveChallenge(today, thisMondayMsk());
      if (challenge.status !== 'active') return;

      const dayNumber = getChallengeDay(challenge.start_date, today);
      if (dayNumber < 1 || dayNumber > CHALLENGE_DURATION) return;

      const slot = getWeekSlotForDay(challenge.id, dayNumber);
      if (!slot || slot.status !== 'queued' || !slot.video_id) return;

      log.info(`catch-up: publishing challenge ${challenge.number} day ${dayNumber}`);
      const result = await postChallengeVideo(bot, challenge, dayNumber);
      log.info(`catch-up: challenge publish result: ${result}`);
      if (result !== 'posted') {
        await notifyAdmin(bot, 'Challenge', `Catch-up публикация: день ${dayNumber}, результат: ${result}`);
      }
    } catch (err) {
      log.error('catch-up challenge publish failed', { error: String(err) });
    }
  }, 5000);

  // Catch-up on startup: publish queued challenge series slots for today
  setTimeout(async () => {
    try {
      const { getActiveChallengeSeriesList, getChallengeSeriesDaySlot } = require('./db') as typeof import('./db');
      const { postChallengeSeriesVideo } = require('./poster') as typeof import('./poster');

      const today = todayMsk();
      const activeSeries = getActiveChallengeSeriesList();
      for (const series of activeSeries) {
        const startMs = new Date(series.start_date + 'T00:00:00').getTime();
        const todayMs = new Date(today + 'T00:00:00').getTime();
        const dayNumber = Math.floor((todayMs - startMs) / 86400000) + 1;
        if (dayNumber < 1 || dayNumber > series.duration_days) continue;

        const slot = getChallengeSeriesDaySlot(series.id, dayNumber);
        if (!slot || slot.status !== 'queued' || !slot.video_id) continue;

        log.info(`catch-up: publishing series "${series.name}" day ${dayNumber}`);
        const result = await postChallengeSeriesVideo(bot, series, dayNumber);
        if (result !== 'posted') {
          await notifyAdmin(bot, 'Challenge Series', `Catch-up "${series.name}" день ${dayNumber}: ${result}`);
        }
      }
    } catch (err) {
      log.error('catch-up challenge series publish failed', { error: String(err) });
    }
  }, 7000);

  // Auto-search catch-up disabled — admin uses "Неделя" button manually
}
