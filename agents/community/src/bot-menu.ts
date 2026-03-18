/**
 * Bot private chat: persistent menu, "Мои тренировки", UGC flow.
 *
 * Persistent keyboard buttons (ReplyKeyboard) shown in private chat:
 * - "Мои тренировки" — completed workouts list
 * - "Предложить тренировку" — UGC submission flow
 *
 * NOTE: ReplyKeyboard (persistent menu) is per-chat and only appears after
 * the user sends /start. This is a Telegram platform limitation — there is
 * no API to push a ReplyKeyboard to all users proactively. Bot commands
 * (the "/" menu) are registered globally via setMyCommands in index.ts.
 */

import { Bot, Keyboard, InlineKeyboard, InputFile } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { downloadVideo, isYtDlpAvailable } from './downloader';
import { todayMsk, yesterdayMsk } from './dates';

const log = createLogger('bot-menu');
import {
  getUserSubmissions, getUserSubmissionTotal,
  createUgcSubmission,
  updateUgcSubmission,
  getUgcSubmission,
  deleteUgcSubmission,
  isUgcDuplicate,
  saveUgcState,
  getUgcState,
  deleteUgcState,
  getPendingUgcCount,
  getLastStrategistTimestamp,
  getChannelStats,
  getRetention,
  getCumulativeStats,
  getPostCountForDate,
  getCompletionCountForDate,
  getUniqueCompletionUsersForDate,
  getMemberProfile,
  getMemberLevel,
  getUserStreak,
  filterVideos,
  getNewMembersToday,
  upsertVideo,
  recordPost,
  withTransaction,
  type UgcSubmission,
  type UgcStep,
} from './db';
import {
  type Category, type Difficulty, type EquipmentValue,
  CATEGORIES, DIFFICULTIES,
  CATEGORY_RU, CATEGORY_EMOJI, DIFFICULTY_RU, DIFFICULTY_EMOJI,
  CATEGORY_BUTTONS, DIFFICULTY_BUTTONS,
  EQUIPMENT_BUTTONS, EQUIPMENT_VALUES, EQUIPMENT_VALUE_RU, EQUIPMENT_NO_GEAR,
  DURATION_BUTTONS, formatDurationLabel,
  MUSCLE_PATTERNS, MUSCLE_DEFAULTS,
  escV2, decodeHtmlEntities,
} from './shared';

const PAGE_SIZE = 5;

// --- Persistent keyboard ---

function mainKeyboard(isAdmin = false): Keyboard {
  const kb = new Keyboard()
    .text('🏋️ Мои тренировки')
    .text('💡 Предложить тренировку');
  if (isAdmin) {
    kb.row()
      .text('📊 Дашборд').text('📅 Неделя');
  }
  return kb.resized().persistent();
}

// UGC conversation state is persisted in SQLite (survives bot restarts).
// See db.ts: saveUgcState, getUgcState, deleteUgcState

function extractYoutubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/** Build category inline keyboard: 2 buttons per row so labels are readable */
function buildCategoryKeyboard(subId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  CATEGORY_BUTTONS.forEach((btn, i) => {
    kb.text(btn.label, `ugc_cat:${subId}:${btn.value}`);
    if (i % 2 === 1) kb.row(); // 2 per row
  });
  if (CATEGORY_BUTTONS.length % 2 === 1) kb.row();
  kb.text('❌ Отмена', 'ugc_cancel');
  return kb;
}

/** Build duration inline keyboard: 2 buttons per row */
function buildDurationKeyboard(subId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  DURATION_BUTTONS.forEach((btn, i) => {
    kb.text(btn.label, `ugc_dur:${subId}:${btn.seconds}`);
    if (i % 2 === 1) kb.row();
  });
  if (DURATION_BUTTONS.length % 2 === 1) kb.row();
  kb.text('← Назад', `ugc_back:${subId}:waiting_duration`).text('❌ Отмена', 'ugc_cancel');
  return kb;
}

/** Build equipment inline keyboard: 2 buttons per row */
function buildEquipmentKeyboard(subId: number, skippedDuration: boolean = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  EQUIPMENT_BUTTONS.forEach((btn, i) => {
    kb.text(btn.label, `ugc_equip:${subId}:${btn.value}`);
    if (i % 2 === 1) kb.row();
  });
  if (EQUIPMENT_BUTTONS.length % 2 === 1) kb.row();
  kb.text('← Назад', `ugc_back:${subId}:waiting_equipment`).text('❌ Отмена', 'ugc_cancel');
  return kb;
}

// --- Register handlers ---

export function registerBotMenu(bot: Bot): void {
  const config = getConfig();

  const isAdmin = (userId: number) => userId === config.TELEGRAM_ADMIN_USER_ID;

  // /start in private chat — clean slate + show menu
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);

    // Clear previous messages in this chat for a fresh start
    const msgId = ctx.message?.message_id;
    if (msgId) {
      for (let id = msgId; id > msgId - 200 && id > 0; id--) {
        try { await ctx.api.deleteMessage(ctx.chat.id, id); } catch {
          break; // stop on first failure (too old or already deleted)
        }
      }
    }

    const firstName = ctx.from?.first_name ?? '';
    const greeting = firstName ? `Привет, ${firstName}!` : 'Привет!';
    await ctx.reply(
      `${greeting} Я Ботик Сами — твой помощник в мире ежедневных тренировок.\n\n` +
      `Тренировки выходят каждый день в канале @sami_workouts.\n\n` +
      `Что умею:\n` +
      `• Показать твои тренировки и статистику\n` +
      `• Принять предложение новой тренировки\n\n` +
      `Выбирай:`,
      { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) }
    );
  });

  // --- "Мои тренировки" button ---
  bot.hears('🏋️ Мои тренировки', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);
    await sendMyWorkouts(ctx, ctx.from!.id, 0);
  });

  // Pagination callback
  bot.callbackQuery(/^mywk:(\d+)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await sendMyWorkouts(ctx, ctx.from!.id, offset, ctx.callbackQuery.message?.message_id);
  });

  // Delete workout — confirmation prompt
  bot.callbackQuery(/^ugc_del:(\d+):(\d+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const offset = parseInt(ctx.match[2]);
    const sub = getUgcSubmission(subId);
    if (!sub || sub.telegram_user_id !== ctx.from!.id) {
      await ctx.answerCallbackQuery('Не найдено');
      return;
    }
    await ctx.answerCallbackQuery();
    const title = sub.title ? decodeHtmlEntities(sub.title) : 'Без названия';
    const kb = new InlineKeyboard()
      .text('Да, удалить', `ugc_del_yes:${subId}:${offset}`)
      .text('Отмена', `mywk:${offset}`);
    try {
      await ctx.editMessageText(`Удалить тренировку «${title}»?`, { reply_markup: kb });
    } catch {}
  });

  // Delete workout — confirmed
  bot.callbackQuery(/^ugc_del_yes:(\d+):(\d+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const offset = parseInt(ctx.match[2]);
    const sub = getUgcSubmission(subId);
    if (!sub || sub.telegram_user_id !== ctx.from!.id) {
      await ctx.answerCallbackQuery('Не найдено');
      return;
    }
    deleteUgcSubmission(subId);
    await ctx.answerCallbackQuery('Удалено');
    await sendMyWorkouts(ctx, ctx.from!.id, offset, ctx.callbackQuery.message?.message_id);
  });

  // --- Admin buttons ---
  bot.hears('📊 Дашборд', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk, yesterdayMsk, thisMondayMsk } = await import('./dates');
    const {
      ensureActiveChallenge, getChallengeDay, initWeekSlots, getWeekStatus,
    } = await import('./db');
    const { DAY_CATEGORY_MAP, CATEGORY_EMOJI, CATEGORY_RU: CR, CHALLENGE_DURATION } = await import('./shared');

    const date = todayMsk();
    const yesterday = yesterdayMsk();
    const posts = getPostCountForDate(date);
    const completions = getCompletionCountForDate(date);
    const users = getUniqueCompletionUsersForDate(date);

    // Subscriber & group member counts + delta
    let subscriberCount = 0;
    let groupMemberCount = 0;
    try {
      subscriberCount = await ctx.api.getChatMemberCount(config.TELEGRAM_CHANNEL_ID);
    } catch { /* API error */ }
    try {
      groupMemberCount = await ctx.api.getChatMemberCount(config.TELEGRAM_GROUP_ID);
    } catch { /* API error */ }

    const yesterdayStats = getChannelStats(yesterday);
    const subDelta = yesterdayStats ? subscriberCount - yesterdayStats.subscriber_count : 0;
    const subDeltaStr = subDelta > 0 ? ` (+${subDelta})` : subDelta < 0 ? ` (${subDelta})` : '';

    // Pending UGC
    const pendingUgc = getPendingUgcCount();

    // Date display: "17 марта 2026, среда"
    const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const DAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    const dateObj = new Date(date + 'T00:00:00');
    const dateDisplay = `${dateObj.getDate()} ${MONTHS_RU[dateObj.getMonth()]} ${dateObj.getFullYear()}, ${DAYS_RU[dateObj.getDay()]}`;

    // Week schedule
    let weekQueueText = '';
    let dashKb: InlineKeyboard | undefined;
    try {
      const challenge = ensureActiveChallenge(date, thisMondayMsk());
      if (challenge.status === 'active') {
        const sDay = getChallengeDay(challenge.start_date, date);
        if (sDay >= 1 && sDay <= CHALLENGE_DURATION) {
          const wk = 1 as 1 | 2 | 3;
          initWeekSlots(challenge.id, wk);
          const slots = getWeekStatus(challenge.id, wk);

          const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
          const lines = slots.map(slot => {
            const d = ((slot.day_number - 1) % 7) + 1;
            const jd = d === 7 ? 0 : d;
            const slotCat = DAY_CATEGORY_MAP[jd];
            const slotCatRu = slotCat ? CR[slotCat] : '?';
            const slotEmoji = slotCat ? CATEGORY_EMOJI[slotCat] : '❓';
            const dayLabel = DAY_LABELS[jd];
            const isToday = slot.day_number === sDay;
            const icon = slot.status === 'posted' ? '✅'
              : slot.status === 'queued' ? '📋'
              : '⬜';
            const title = slot.title ? ` — ${decodeHtmlEntities(slot.title).slice(0, 30)}` : '';
            const marker = isToday ? ' 👈' : '';
            return `${icon} ${dayLabel} ${slotEmoji} ${slotCatRu}${title}${marker}`;
          });
          weekQueueText = `\n*Расписание:*\n${lines.map(l => escV2(l)).join('\n')}`;

          // Show publish button if today's slot is queued
          const todaySlot = slots.find(s => s.day_number === sDay);
          if (todaySlot && todaySlot.status === 'queued') {
            dashKb = new InlineKeyboard().text('📤 Опубликовать сегодня', `challenge_pub:${challenge.id}:${sDay}`);
          }
        }
      }
    } catch { /* no challenge yet */ }

    // Retention
    const retention = getRetention(date, yesterday);
    const retPct = retention.yesterday_active > 0
      ? Math.round(retention.returned_today / retention.yesterday_active * 100) : 0;

    // Cumulative
    const cumulative = getCumulativeStats();

    // Strategist + uptime
    const lastStrategist = getLastStrategistTimestamp();
    const stratLine = lastStrategist
      ? `Стратег: ${lastStrategist.replace('T', ' ').slice(0, 16).slice(5)}`
      : 'Стратег: нет данных';
    const uptimeStr = formatUptime(process.uptime());

    await ctx.reply(
      [
        `*Sami — дашборд*`,
        ``,
        `📅 ${escV2(dateDisplay)}`,
        ``,
        `👥 Подписчики: ${escV2(String(subscriberCount))}${escV2(subDeltaStr)}  ·  Группа: ${escV2(String(groupMemberCount))}`,
        `📝 Постов: ${escV2(String(posts))}  ·  Выполнений: ${escV2(String(completions))} \\(${escV2(String(users))} чел\\.\\)`,
        `📋 На модерации: ${escV2(String(pendingUgc))}`,
        weekQueueText,
        ``,
        `_✅ опубликовано · 📋 в очереди · ⬜ пусто · 👈 сегодня_`,
        ``,
        `Retention: ${escV2(String(retention.returned_today))}/${escV2(String(retention.yesterday_active))} \\(${escV2(String(retPct))}%\\)`,
        `Всего: ${escV2(String(cumulative.total_completions))} выполнений · ${escV2(String(cumulative.total_active_users))} активных`,
        ``,
        `${escV2(stratLine)}  ·  Аптайм: ${escV2(uptimeStr)}`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2', ...(dashKb ? { reply_markup: dashKb } : {}) }
    );
  });

  // Inline publish button from status message
  bot.callbackQuery('btn_publish', async (ctx) => {
    if (ctx.from!.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    await ctx.answerCallbackQuery('Публикую...');
    const { todayMsk, tomorrowMsk } = await import('./dates');
    const { postVideoToChannel } = await import('./poster');
    const { getApprovedVideo } = await import('./db');

    const today = todayMsk();
    const tomorrow = tomorrowMsk();
    const hasTomorrow = CATEGORIES.some(c => getApprovedVideo(tomorrow, c) !== null);
    const hasToday = CATEGORIES.some(c => getApprovedVideo(today, c) !== null);
    const date = hasTomorrow ? tomorrow : hasToday ? today : null;

    if (!date) {
      try { await ctx.editMessageText('Нет одобренных видео.'); } catch {}
      return;
    }

    const report: string[] = [];
    for (const cat of CATEGORIES) {
      const approved = getApprovedVideo(date, cat);
      if (!approved) continue;
      const result = await postVideoToChannel(bot, date, cat, { force: true });
      const label = `${CATEGORY_EMOJI[cat]} ${CATEGORY_RU[cat]}`;
      if (result === 'posted') report.push(`${label} — ${approved.title}`);
      else if (result === 'error') report.push(`${label} — ошибка`);
      else report.push(`${label} — пропущено`);
    }
    try {
      await ctx.editMessageText(report.length > 0 ? report.join('\n') : 'Нет одобренных видео.');
    } catch {}
  });

  // Inline reset button from status message
  bot.callbackQuery('btn_reset', async (ctx) => {
    if (ctx.from!.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    await ctx.answerCallbackQuery('Сброшено');
    const { todayMsk, tomorrowMsk } = await import('./dates');
    const { resetApprovalSessions } = await import('./db');
    const today = todayMsk();
    const tomorrow = tomorrowMsk();
    const total = resetApprovalSessions(today) + resetApprovalSessions(tomorrow);
    try {
      await ctx.editMessageText(`Сброшено ${total} сессий. Нажми «Неделя» для нового поиска.`);
    } catch {}
  });

  bot.hears('📅 Неделя', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk, thisMondayMsk } = await import('./dates');
    const {
      ensureActiveChallenge, getChallengeDay,
      initWeekSlots, getWeekStatus,
    } = await import('./db');
    const { DAY_CATEGORY_MAP, CATEGORY_RU, CATEGORY_EMOJI, CHALLENGE_DURATION } = await import('./shared');

    const today = todayMsk();
    const challenge = ensureActiveChallenge(today, thisMondayMsk());

    if (challenge.status === 'completed') {
      await ctx.reply(`Неделя завершена. Новый цикл стартует в понедельник.`);
      return;
    }

    // Always week 1 (7-day cycles)
    let challengeDay: number;
    const weekNum = 1 as 1 | 2 | 3;

    if (challenge.status === 'upcoming') {
      challengeDay = 0;
    } else {
      challengeDay = getChallengeDay(challenge.start_date, today);
      if (challengeDay > CHALLENGE_DURATION) {
        await ctx.reply(`Неделя завершена. Новый цикл стартует в понедельник.`);
        return;
      }
    }
    initWeekSlots(challenge.id, weekNum);
    const slots = getWeekStatus(challenge.id, weekNum);

    const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const lines = slots.map(slot => {
      const dow = ((slot.day_number - 1) % 7) + 1;
      const jsDow = dow === 7 ? 0 : dow;
      const cat = DAY_CATEGORY_MAP[jsDow];
      const catRu = cat ? CATEGORY_RU[cat] : '?';
      const emoji = cat ? CATEGORY_EMOJI[cat] : '❓';
      const dayLabel = DAY_LABELS[jsDow];
      const isToday = slot.day_number === challengeDay;
      const icon = slot.status === 'posted' ? '✅' : slot.status === 'queued' ? '📋' : '⬜';
      const title = slot.title ? ` — ${slot.title.slice(0, 35)}` : '';
      const marker = isToday ? ' 👈' : '';
      return `${icon} ${dayLabel} ${emoji} ${catRu}${title}${marker}`;
    });

    const filledCount = slots.filter(s => s.status !== 'empty').length;

    const planTag = challenge.status === 'upcoming' ? ` · стартует ${escV2(challenge.start_date)}` : '';
    const msg = [
      `📅 *Расписание недели*${planTag}`,
      ``,
      ...lines.map(l => escV2(l)),
      ``,
      `_✅ опубликовано · 📋 в очереди · ⬜ пусто · 👈 сегодня_`,
      ``,
      `Заполнено: ${filledCount}/7`,
    ].join('\n');

    const kb = new InlineKeyboard();

    // Publish button if today's slot is queued
    if (challenge.status === 'active' && challengeDay >= 1) {
      const todaySlot = slots.find(s => s.day_number === challengeDay);
      if (todaySlot && todaySlot.status === 'queued') {
        kb.text('📤 Опубликовать сегодня', `challenge_pub:${challenge.id}:${challengeDay}`);
        kb.row();
      }
    }

    // Per-day buttons: fill empty / replace queued
    const DAY_LABELS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    let buttonsInRow = 0;
    for (const slot of slots) {
      const dow = ((slot.day_number - 1) % 7) + 1;
      const jsDow = dow === 7 ? 0 : dow;
      const dl = DAY_LABELS_SHORT[jsDow];
      if (slot.status === 'empty') {
        kb.text(`＋ ${dl}`, `fill_day:${challenge.id}:${slot.day_number}`);
        buttonsInRow++;
      } else if (slot.status === 'queued') {
        kb.text(`↻ ${dl}`, `fill_day:${challenge.id}:${slot.day_number}`);
        buttonsInRow++;
      }
      if (buttonsInRow === 4) { kb.row(); buttonsInRow = 0; }
    }

    await ctx.reply(msg, { parse_mode: 'MarkdownV2', reply_markup: kb });
  });

  // Fill or replace a specific day slot
  bot.callbackQuery(/^fill_day:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.from!.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    await ctx.answerCallbackQuery();

    const challengeId = Number(ctx.match![1]);
    const dayNumber = Number(ctx.match![2]);
    const { getWeekSlotForDay, clearWeekSlot } = await import('./db');
    const { DAY_CATEGORY_MAP } = await import('./shared');
    const { runApprovalFlow } = await import('./approval');
    const { tomorrowMsk } = await import('./dates');

    const slot = getWeekSlotForDay(challengeId, dayNumber);
    if (!slot) return;

    // If slot is queued, clear it first (replace)
    if (slot.status === 'queued') {
      clearWeekSlot(challengeId, dayNumber);
    }

    // Determine category for this day
    const dow = ((dayNumber - 1) % 7) + 1;
    const jsDow = dow === 7 ? 0 : dow;
    const category = DAY_CATEGORY_MAP[jsDow];
    if (!category) return;

    const date = tomorrowMsk();
    await runApprovalFlow(bot, date, category, { challengeId, dayNumber });
  });

  // Manual challenge publish for today
  bot.callbackQuery(/^challenge_pub:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.from!.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    await ctx.answerCallbackQuery('Публикую...');

    const challengeId = Number(ctx.match![1]);
    const dayNumber = Number(ctx.match![2]);
    const { getActiveChallenge } = await import('./db');
    const { postChallengeVideo } = await import('./poster');

    const challenge = getActiveChallenge();
    if (!challenge || challenge.id !== challengeId) {
      try { await ctx.editMessageText('Нет активного расписания.'); } catch {}
      return;
    }

    const result = await postChallengeVideo(bot, challenge, dayNumber);
    if (result === 'posted') {
      try { await ctx.editMessageText('✅ Опубликовано!'); } catch {}
    } else {
      try { await ctx.editMessageText(`Ошибка публикации: ${result}`); } catch {}
    }
  });

  bot.hears('Опубликовать', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk, tomorrowMsk } = await import('./dates');
    const { postVideoToChannel } = await import('./poster');
    const { getApprovedVideo } = await import('./db');

    const today = todayMsk();
    const tomorrow = tomorrowMsk();
    const hasTomorrow = CATEGORIES.some(c => getApprovedVideo(tomorrow, c) !== null);
    const hasToday = CATEGORIES.some(c => getApprovedVideo(today, c) !== null);
    const date = hasTomorrow ? tomorrow : hasToday ? today : null;

    if (!date) {
      await ctx.reply('Нет одобренных видео. Сначала «Неделя».');
      return;
    }

    await ctx.reply(`Публикую видео на ${date}...`);
    const report: string[] = [];
    for (const cat of CATEGORIES) {
      const approved = getApprovedVideo(date, cat);
      if (!approved) continue; // skip categories without approved videos
      const result = await postVideoToChannel(bot, date, cat, { force: true });
      const label = `${CATEGORY_EMOJI[cat]} ${CATEGORY_RU[cat]}`;
      if (result === 'posted') report.push(`${label} — ${approved.title}`);
      else if (result === 'error') report.push(`${label} — ошибка`);
      else report.push(`${label} — пропущено`);
    }
    if (report.length === 0) {
      await ctx.reply('Нет одобренных видео на эту дату.');
    } else {
      await ctx.reply(report.join('\n'));
    }
  });

  bot.hears('Сбросить выбор', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk, tomorrowMsk } = await import('./dates');
    const { resetApprovalSessions } = await import('./db');
    const today = todayMsk();
    const tomorrow = tomorrowMsk();
    const countToday = resetApprovalSessions(today);
    const countTomorrow = resetApprovalSessions(tomorrow);
    const total = countToday + countTomorrow;
    await ctx.reply(`Сброшено ${total} сессий (${today}: ${countToday}, ${tomorrow}: ${countTomorrow}). Нажми «Неделя» для нового поиска.`);
  });

  // --- "Очистить" button (admin only) — clear channel posts ---
  bot.hears('🧹 Очистить канал', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const kb = new InlineKeyboard()
      .text('Да, удалить все посты', 'clear_channel_confirm')
      .text('❌ Отмена', 'clear_channel_cancel');
    await ctx.reply('Удалить все посты из канала @sami_workouts?\nЭто действие необратимо.', { reply_markup: kb });
  });

  bot.callbackQuery('clear_channel_confirm', async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    await ctx.answerCallbackQuery('Удаляю...');

    const channelId = config.TELEGRAM_CHANNEL_ID;
    const { getDb, withTransaction } = await import('./db');
    const posts = getDb().prepare(
      `SELECT channel_message_id FROM posts WHERE channel_message_id IS NOT NULL ORDER BY channel_message_id DESC`
    ).all() as { channel_message_id: number }[];

    let deleted = 0;
    for (const post of posts) {
      try {
        await ctx.api.deleteMessage(channelId, post.channel_message_id);
        deleted++;
      } catch { /* already deleted or too old */ }
    }

    withTransaction(() => {
      getDb().prepare(`DELETE FROM posts`).run();
    });

    try {
      await ctx.editMessageText(`🧹 Удалено ${deleted} постов из канала. БД постов очищена.`);
    } catch {}
  });

  bot.callbackQuery('clear_channel_cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Отменено');
    try { await ctx.editMessageText('Очистка канала отменена.'); } catch {}
  });

  // --- "Профиль" button ---
  bot.hears('Профиль', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);
    const userId = ctx.from!.id;
    const profile = getMemberProfile(userId);
    const { level, completions } = getMemberLevel(userId);
    const streak = getUserStreak(userId);

    const GOAL_LABELS: Record<string, string> = {
      rhythm: 'ритм и дисциплина',
      mobility: 'гибкость и мобильность',
      strength: 'сила',
      observer: 'исследователь',
    };

    const subTotal = getUserSubmissionTotal(userId);

    const lines = [
      `*Профиль*`,
      '',
      `Имя: ${escV2(profile?.first_name ?? 'не указано')}`,
      `Уровень: ${escV2(level)}`,
      `Тренировок: ${escV2(String(completions))}`,
      `Предложено: ${escV2(String(subTotal))}`,
    ];
    if (streak > 0) {
      lines.splice(5, 0, `Серия: ${escV2(String(streak))} дн\\. 🔥`);
    }

    if (profile?.fitness_goal) {
      lines.push(`Цель: ${escV2(GOAL_LABELS[profile.fitness_goal] ?? profile.fitness_goal)}`);
    }
    if (profile?.joined_at) {
      lines.push(`Участник с: ${escV2(profile.joined_at.slice(0, 10))}`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
  });

  // --- "Фильтры" button ---
  bot.hears('Фильтры', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);

    const kb = new InlineKeyboard();
    CATEGORY_BUTTONS.forEach((btn, i) => {
      kb.text(btn.label, `filter:cat:${btn.value}`);
      if (i % 2 === 1) kb.row();
    });
    // Ensure last odd category gets its own row before presets
    if (CATEGORY_BUTTONS.length % 2 === 1) kb.row();
    kb.text('💎 Новичок', 'filter:preset:beginner')
      .text('☀️ Утро (до 15м)', 'filter:preset:morning')
      .row()
      .text('🌙 После работы', 'filter:preset:afterwork')
      .text('⚡ Быстрая (до 10м)', 'filter:preset:quick');

    await ctx.reply('Выбери фильтр или пресет:', { reply_markup: kb });
  });

  const filterCatPattern = new RegExp(`^filter:cat:(${CATEGORIES.join('|')})$`);
  bot.callbackQuery(filterCatPattern, async (ctx) => {
    const category = ctx.match[1];
    await ctx.answerCallbackQuery();
    const videos = filterVideos({ category, limit: 5 });
    await sendFilterResults(ctx, videos, CATEGORY_RU[category as Category] ?? category);
  });

  bot.callbackQuery(/^filter:preset:(beginner|morning|afterwork|quick)$/, async (ctx) => {
    const preset = ctx.match[1];
    await ctx.answerCallbackQuery();

    const presetConfig: Record<string, { label: string; opts: Parameters<typeof filterVideos>[0] }> = {
      beginner: { label: 'Новичок', opts: { difficulty: 'beginner', limit: 5 } },
      morning: { label: 'Утро', opts: { maxDuration: 900, limit: 5 } },
      afterwork: { label: 'После работы', opts: { category: 'strength', minDuration: 900, limit: 5 } },
      quick: { label: 'Быстрая', opts: { maxDuration: 600, limit: 5 } },
    };

    const { label, opts } = presetConfig[preset] ?? { label: preset, opts: { limit: 5 } };
    const videos = filterVideos(opts);
    await sendFilterResults(ctx, videos, label);
  });

  // --- "Предложить тренировку" button ---
  bot.hears('💡 Предложить тренировку', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    saveUgcState(ctx.from!.id, 'waiting_link');

    if (isAdmin(ctx.from!.id)) {
      // Admin sees extra option: YouTube search
      const kb = new InlineKeyboard()
        .text('🔍 Поиск YouTube', 'ugc_yt_search')
        .row()
        .text('❌ Отмена', 'ugc_cancel');
      await ctx.reply(
        'Отправь ссылку на YouTube, загрузи видеофайл или найди через поиск.',
        { reply_markup: kb }
      );
    } else {
      const cancelKb = new InlineKeyboard().text('❌ Отмена', 'ugc_cancel');
      await ctx.reply(
        'Предложи тренировку:\n\n• Ссылку на YouTube-видео любимого автора\n• Или загрузи свой видеофайл напрямую',
        { reply_markup: cancelKb }
      );
    }
  });

  // Admin: YouTube search in UGC flow — pick category then run approval-style search
  bot.callbackQuery('ugc_yt_search', async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    await ctx.answerCallbackQuery();
    deleteUgcState(ctx.from!.id);

    // Show category picker for search
    const kb = new InlineKeyboard();
    CATEGORY_BUTTONS.forEach((btn, i) => {
      kb.text(btn.label, `ugc_search_cat:${btn.value}`);
      if (i % 2 === 1) kb.row();
    });
    if (CATEGORY_BUTTONS.length % 2 === 1) kb.row();
    kb.text('❌ Отмена', 'ugc_cancel');

    try {
      await ctx.editMessageText('Какую категорию ищем?', { reply_markup: kb });
    } catch {
      await ctx.reply('Какую категорию ищем?', { reply_markup: kb });
    }
  });

  // Admin: run search for selected category (standalone, not challenge)
  const ugcSearchCatPattern = new RegExp(`^ugc_search_cat:(${CATEGORIES.join('|')})$`);
  bot.callbackQuery(ugcSearchCatPattern, async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    const category = ctx.match[1] as Category;
    await ctx.answerCallbackQuery('Ищу...');
    try { await ctx.editMessageText(`🔍 Ищу видео для ${CATEGORY_RU[category]}...`); } catch {}

    const { runApprovalFlow } = await import('./approval');
    const { todayMsk } = await import('./dates');
    await runApprovalFlow(bot, todayMsk(), category);
  });

  // Cancel UGC flow — inline button or /cancel command
  bot.callbackQuery('ugc_cancel', async (ctx) => {
    const state = getUgcState(ctx.from.id);
    if (state?.submission_id) {
      deleteUgcSubmission(state.submission_id);
    }
    deleteUgcState(ctx.from.id);
    await ctx.answerCallbackQuery('Отменено');
    try {
      await ctx.editMessageText('Отменено.');
    } catch {}
  });

  // Back button in UGC flow — return to previous step
  bot.callbackQuery(/^ugc_back:(\d+):(.+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const currentStep = ctx.match[2] as UgcStep;
    const userId = ctx.from!.id;
    await ctx.answerCallbackQuery();

    const sub = getUgcSubmission(subId);
    if (!sub) {
      deleteUgcState(userId);
      try { await ctx.editMessageText('Сессия устарела.'); } catch {}
      return;
    }

    if (currentStep === 'waiting_difficulty') {
      // Back to category
      saveUgcState(userId, 'waiting_category', subId);
      const kb = buildCategoryKeyboard(subId);
      try { await ctx.editMessageText('Какой тип тренировки?', { reply_markup: kb }); } catch {}
    } else if (currentStep === 'waiting_duration') {
      // Back to difficulty
      saveUgcState(userId, 'waiting_difficulty', subId);
      const kb = new InlineKeyboard();
      DIFFICULTY_BUTTONS.forEach((btn, i) => {
        if (i > 0) kb.row();
        kb.text(btn.label, `ugc_diff:${subId}:${btn.value}`);
      });
      kb.row().text('← Назад', `ugc_back:${subId}:waiting_difficulty`).text('❌ Отмена', 'ugc_cancel');
      try { await ctx.editMessageText('Уровень сложности?', { reply_markup: kb }); } catch {}
    } else if (currentStep === 'waiting_equipment') {
      // Back to duration or difficulty (if duration was auto-detected)
      if (sub.duration_seconds) {
        // Duration was auto-detected, go back to difficulty
        saveUgcState(userId, 'waiting_difficulty', subId);
        const kb = new InlineKeyboard();
        DIFFICULTY_BUTTONS.forEach((btn, i) => {
          if (i > 0) kb.row();
          kb.text(btn.label, `ugc_diff:${subId}:${btn.value}`);
        });
        kb.row().text('← Назад', `ugc_back:${subId}:waiting_difficulty`).text('❌ Отмена', 'ugc_cancel');
        try { await ctx.editMessageText('Уровень сложности?', { reply_markup: kb }); } catch {}
      } else {
        saveUgcState(userId, 'waiting_duration', subId);
        const kb = buildDurationKeyboard(subId);
        try { await ctx.editMessageText('Сколько длится тренировка?', { reply_markup: kb }); } catch {}
      }
    } else if (currentStep === 'waiting_rubric') {
      // Back to equipment
      saveUgcState(userId, 'waiting_equipment', subId);
      const kb = buildEquipmentKeyboard(subId);
      try { await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb }); } catch {}
    } else if (currentStep === 'waiting_title') {
      if (isAdmin(userId)) {
        // Admin: back to rubric
        saveUgcState(userId, 'waiting_rubric', subId);
        const rubricKb = new InlineKeyboard()
          .text('📅 Челлендж', `ugc_rubric:${subId}:challenge`)
          .text('👤 От участника', `ugc_rubric:${subId}:ugc`)
          .row()
          .text('✏️ Своя рубрика', `ugc_rubric:${subId}:custom`)
          .row()
          .text('← Назад', `ugc_back:${subId}:waiting_rubric`)
          .text('❌ Отмена', 'ugc_cancel');
        try { await ctx.editMessageText('Рубрика поста:', { reply_markup: rubricKb }); } catch {}
      } else {
        // Regular user: back to equipment
        saveUgcState(userId, 'waiting_equipment', subId);
        const kb = buildEquipmentKeyboard(subId);
        try { await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb }); } catch {}
      }
    }
  });

  bot.command('cancel', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const state = getUgcState(ctx.from!.id);
    if (state?.submission_id) {
      deleteUgcSubmission(state.submission_id);
    }
    deleteUgcState(ctx.from!.id);
    await ctx.reply('Отменено.', { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) });
  });

  // --- UGC: accept video file directly ---
  bot.on('message:video', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    log.info('video message in private chat', { userId, step: state?.step ?? 'none', hasVideo: !!ctx.message.video });
    if (!state || state.step !== 'waiting_link') return next();

    // User sent a video file instead of a YouTube link
    const video = ctx.message.video;
    const fileId = video.file_id;
    const duration = video.duration;

    // Create UGC submission with file_id as video_url (bot can re-send by file_id)
    const subId = createUgcSubmission(userId, ctx.from!.username ?? null, `tg:${fileId}`, null);
    if (duration) {
      updateUgcSubmission(subId, {
        title: `Видео (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')})`,
        duration_seconds: duration,
        duration_label: formatDurationLabel(duration),
      });
    }
    saveUgcState(userId, 'waiting_category', subId);

    const kb = buildCategoryKeyboard(subId);

    await ctx.reply('Видео получено! Какой тип тренировки?', { reply_markup: kb });
  });

  // --- UGC: accept video sent as document (e.g. .mov, .mp4 files Telegram treats as documents) ---
  const VIDEO_MIME_PREFIXES = ['video/'];
  bot.on('message:document', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? '';
    if (!state || state.step !== 'waiting_link') return next();
    if (!VIDEO_MIME_PREFIXES.some(p => mime.startsWith(p))) {
      await ctx.reply('Отправь видеофайл или ссылку на YouTube.');
      return;
    }

    log.info('video-as-document in private chat', { userId, mime, fileName: doc.file_name });

    const fileId = doc.file_id;
    const subId = createUgcSubmission(userId, ctx.from!.username ?? null, `tg:${fileId}`, null);
    if (doc.file_name) {
      updateUgcSubmission(subId, { title: doc.file_name.replace(/\.[^.]+$/, '') });
    }
    saveUgcState(userId, 'waiting_category', subId);

    const kb = buildCategoryKeyboard(subId);

    await ctx.reply('Видео получено! Какой тип тренировки?', { reply_markup: kb });
  });

  // --- UGC conversation handler (private chat text) ---
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    if (!state) return next();

    const text = ctx.message.text.trim();

    // Don't intercept bot commands — let them pass through
    if (text.startsWith('/')) return next();

    // Step 1: waiting for YouTube link
    if (state.step === 'waiting_link') {
      const ytId = extractYoutubeId(text);
      if (!ytId) {
        await ctx.reply('Не могу распознать ссылку. Отправь ссылку на YouTube-видео или загрузи видеофайл.');
        return;
      }
      if (isUgcDuplicate(ytId)) {
        await ctx.reply('Это видео уже было предложено. Попробуй другое.');
        return;
      }
      const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;
      const subId = createUgcSubmission(userId, ctx.from!.username ?? null, videoUrl, ytId);

      // Auto-fetch duration from YouTube API
      try {
        const { fetchVideoDuration } = await import('./youtube');
        const dur = await fetchVideoDuration(ytId);
        if (dur) {
          updateUgcSubmission(subId, { duration_seconds: dur.seconds, duration_label: dur.label });
        }
      } catch { /* non-critical, user will be asked manually */ }

      saveUgcState(userId, 'waiting_category', subId);

      const kb = buildCategoryKeyboard(subId);

      await ctx.reply('Какой тип тренировки?', { reply_markup: kb });
      return;
    }

    // Step: custom rubric text (admin only)
    if (state.step === 'waiting_rubric') {
      if (text.length < 2 || text.length > 100) {
        await ctx.reply('Рубрика от 2 до 100 символов.');
        return;
      }
      updateUgcSubmission(state.submission_id!, { rubric: text });
      saveUgcState(userId, 'waiting_title', state.submission_id!);

      const titleKb = new InlineKeyboard()
        .text('← Назад', `ugc_back:${state.submission_id!}:waiting_title`)
        .text('❌ Отмена', 'ugc_cancel');
      await ctx.reply('Как назвать тренировку? Напиши короткое название.', { reply_markup: titleKb });
      return;
    }

    // Step 5: waiting for title (free text) — last step before submission
    if (state.step === 'waiting_title') {
      if (text.length < 3 || text.length > 200) {
        await ctx.reply('Название должно быть от 3 до 200 символов.');
        return;
      }

      // Auto-detect muscles from title using shared patterns
      const detectedMuscles = MUSCLE_PATTERNS
        .filter(([re]) => re.test(text))
        .map(([, label]) => label);

      const subBeforeTitle = getUgcSubmission(state.submission_id!);
      const category = subBeforeTitle?.category ?? 'stretching';
      const muscles = detectedMuscles.length > 0
        ? detectedMuscles.join(', ')
        : (MUSCLE_DEFAULTS[category]?.join(', ') ?? 'всё тело');

      updateUgcSubmission(state.submission_id!, { title: text, muscles, status: 'pending' });
      deleteUgcState(userId);

      const sub = getUgcSubmission(state.submission_id!);
      if (!sub) return;

      // Send to admin for review
      await sendUgcToAdmin(bot, sub);

      await ctx.reply(
        'Спасибо! Тренировка отправлена на модерацию. Ты получишь уведомление, когда она будет опубликована.',
        { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) }
      );
      return;
    }

    return next();
  });

  // --- UGC category callback ---
  const catPattern = new RegExp(`^ugc_cat:(\\d+):(${CATEGORIES.join('|')})$`);
  bot.callbackQuery(catPattern, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const category = ctx.match[2];
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    if (!state || state.submission_id !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();
    updateUgcSubmission(subId, { category });
    saveUgcState(userId, 'waiting_difficulty', subId);

    const kb = new InlineKeyboard();
    DIFFICULTY_BUTTONS.forEach((btn, i) => {
      if (i > 0) kb.row();
      kb.text(btn.label, `ugc_diff:${subId}:${btn.value}`);
    });
    kb.row().text('← Назад', `ugc_back:${subId}:waiting_difficulty`).text('❌ Отмена', 'ugc_cancel');

    try {
      await ctx.editMessageText('Уровень сложности?', { reply_markup: kb });
    } catch {
      await ctx.reply('Уровень сложности?', { reply_markup: kb });
    }
  });

  // --- UGC difficulty callback ---
  const diffPattern = new RegExp(`^ugc_diff:(\\d+):(${DIFFICULTIES.join('|')})$`);
  bot.callbackQuery(diffPattern, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const difficulty = ctx.match[2];
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    if (!state || state.submission_id !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();
    updateUgcSubmission(subId, { difficulty });

    // Check if duration was auto-detected from video file metadata
    const sub = getUgcSubmission(subId);
    if (sub?.duration_seconds) {
      // Skip duration step — go directly to equipment
      saveUgcState(userId, 'waiting_equipment', subId);
      const kb = buildEquipmentKeyboard(subId);
      try {
        await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb });
      } catch {
        await ctx.reply('Нужен ли инвентарь?', { reply_markup: kb });
      }
    } else {
      saveUgcState(userId, 'waiting_duration', subId);
      const kb = buildDurationKeyboard(subId);
      try {
        await ctx.editMessageText('Сколько длится тренировка?', { reply_markup: kb });
      } catch {
        await ctx.reply('Сколько длится тренировка?', { reply_markup: kb });
      }
    }
  });

  // --- UGC duration callback ---
  bot.callbackQuery(/^ugc_dur:(\d+):(\d+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const seconds = parseInt(ctx.match[2]);
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    if (!state || state.submission_id !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();
    const label = formatDurationLabel(seconds);
    updateUgcSubmission(subId, { duration_seconds: seconds, duration_label: label });
    saveUgcState(userId, 'waiting_equipment', subId);

    const kb = buildEquipmentKeyboard(subId);
    try {
      await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb });
    } catch {
      await ctx.reply('Нужен ли инвентарь?', { reply_markup: kb });
    }
  });

  // --- UGC equipment callback ---
  const equipPattern = new RegExp(`^ugc_equip:(\\d+):(${EQUIPMENT_VALUES.join('|')})$`);
  bot.callbackQuery(equipPattern, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const equipValue = ctx.match[2] as EquipmentValue;
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    if (!state || state.submission_id !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();
    updateUgcSubmission(subId, { equipment: EQUIPMENT_VALUE_RU[equipValue] ?? equipValue });

    if (isAdmin(userId)) {
      // Admin: rubric selection before title
      saveUgcState(userId, 'waiting_rubric', subId);
      const rubricKb = new InlineKeyboard()
        .text('📅 Челлендж', `ugc_rubric:${subId}:challenge`)
        .text('👤 От участника', `ugc_rubric:${subId}:ugc`)
        .row()
        .text('✏️ Своя рубрика', `ugc_rubric:${subId}:custom`)
        .row()
        .text('← Назад', `ugc_back:${subId}:waiting_rubric`)
        .text('❌ Отмена', 'ugc_cancel');
      try {
        await ctx.editMessageText('Рубрика поста:', { reply_markup: rubricKb });
      } catch {
        await ctx.reply('Рубрика поста:', { reply_markup: rubricKb });
      }
    } else {
      saveUgcState(userId, 'waiting_title', subId);
      const titleKb = new InlineKeyboard()
        .text('← Назад', `ugc_back:${subId}:waiting_title`)
        .text('❌ Отмена', 'ugc_cancel');
      try {
        await ctx.editMessageText('Как назвать тренировку? Напиши короткое название.', { reply_markup: titleKb });
      } catch {
        await ctx.reply('Как назвать тренировку? Напиши короткое название.', { reply_markup: titleKb });
      }
    }
  });

  // --- UGC rubric callback (admin only) ---
  bot.callbackQuery(/^ugc_rubric:(\d+):(challenge|ugc|custom)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const rubricType = ctx.match[2];
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    if (!state || state.submission_id !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();

    if (rubricType === 'custom') {
      // Ask admin to type custom rubric
      saveUgcState(userId, 'waiting_rubric', subId);
      const backKb = new InlineKeyboard()
        .text('← Назад', `ugc_back:${subId}:waiting_rubric`)
        .text('❌ Отмена', 'ugc_cancel');
      try {
        await ctx.editMessageText('Напиши название рубрики (будет первой строкой поста):', { reply_markup: backKb });
      } catch {
        await ctx.reply('Напиши название рубрики:', { reply_markup: backKb });
      }
      return;
    }

    // Predefined rubrics
    const rubricLabel = rubricType === 'challenge' ? null : 'Тренировка от участника';
    updateUgcSubmission(subId, { rubric: rubricLabel });
    saveUgcState(userId, 'waiting_title', subId);

    const titleKb = new InlineKeyboard()
      .text('← Назад', `ugc_back:${subId}:waiting_title`)
      .text('❌ Отмена', 'ugc_cancel');
    try {
      await ctx.editMessageText('Как назвать тренировку? Напиши короткое название.', { reply_markup: titleKb });
    } catch {
      await ctx.reply('Как назвать тренировку? Напиши короткое название.', { reply_markup: titleKb });
    }
  });

  // --- Admin UGC approve/reject ---
  bot.callbackQuery(/^ugc_decide:(\d+):(approve|reject)$/, async (ctx) => {
    if (ctx.from!.id !== config.TELEGRAM_ADMIN_USER_ID) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }
    const subId = parseInt(ctx.match[1]);
    const decision = ctx.match[2];
    const sub = getUgcSubmission(subId);
    if (!sub) {
      await ctx.answerCallbackQuery('Не найдено');
      return;
    }

    if (decision === 'approve') {
      updateUgcSubmission(subId, { status: 'approved' });
      await ctx.answerCallbackQuery('Одобрено');

      const author = sub.username ? `@${sub.username}` : (sub.telegram_user_id ? `id:${sub.telegram_user_id}` : '');
      const submitterDisplay = sub.username ? `@${sub.username}` : 'участник';

      // --- Publish to channel ---
      let published = false;
      let publishError = '';
      try {
        const cat = sub.category as Category;
        const catEmoji = CATEGORY_EMOJI[cat] ?? '🏷';
        const categoryRu = CATEGORY_RU[cat] ?? sub.category ?? '—';
        const difficultyRu = DIFFICULTY_RU[sub.difficulty as Difficulty] ?? sub.difficulty ?? '—';
        const title = escV2(sub.title ?? 'Тренировка');
        const equipmentTag = sub.equipment ?? EQUIPMENT_NO_GEAR;

        const tagLines = [
          `\`${catEmoji} ${categoryRu}\``,
          ...(sub.duration_label ? [`\`⏱️ ${sub.duration_label}\``] : []),
          ...(sub.muscles ? [`\`🦴 ${sub.muscles}\``] : []),
          `\`💎 ${difficultyRu}\``,
          `\`🎾 ${equipmentTag}\``,
        ];

        const isTgFileId = sub.video_url.startsWith('tg:');
        const isYouTubeUrl = /youtube\.com|youtu\.be/.test(sub.video_url);

        // For YouTube UGC: fetch real channel name, stats, and show YouTube link
        let authorLine: string;
        let ytStats: { viewCount: number; likeRatio: number; channelSubscribers: number } | null = null;
        if (isYouTubeUrl && sub.youtube_id) {
          const { fetchYouTubeVideoInfo, fetchYouTubeVideoStats } = await import('./youtube');
          const { formatChannelName } = await import('./translate');
          const [info, stats] = await Promise.all([
            fetchYouTubeVideoInfo(sub.youtube_id),
            fetchYouTubeVideoStats(sub.youtube_id),
          ]);
          ytStats = stats;
          const channelName = info ? await formatChannelName(info.channelTitle) : escV2(submitterDisplay);
          const safeUrl = sub.video_url.replace(/[)\\]/g, '\\$&');
          authorLine = `Автор: ${channelName}, 📎 [YouTube](${safeUrl})\nПредложиль: ${escV2(submitterDisplay)}`;
        } else {
          authorLine = `Автор: ${escV2(submitterDisplay)}`;
        }

        // Create a video record in DB for tracking (completions, favorites)
        const syntheticYoutubeId = isTgFileId
          ? `ugc-${subId}`
          : (sub.youtube_id ?? `ugc-${subId}`);

        const videoId = upsertVideo({
          youtube_id: syntheticYoutubeId,
          title: sub.title ?? 'Тренировка',
          channel_name: submitterDisplay,
          channel_url: null,
          duration_seconds: sub.duration_seconds ?? null,
          duration_label: sub.duration_label ?? null,
          difficulty: (sub.difficulty as Difficulty) ?? 'beginner',
          category: (sub.category as Category) ?? 'stretching',
          muscles: sub.muscles ?? null,
          thumbnail_url: null,
          video_url: sub.video_url,
          view_count: ytStats?.viewCount ?? 0,
          rating: 0,
          like_ratio: ytStats?.likeRatio ?? 0,
          channel_subscribers: ytStats?.channelSubscribers ?? 0,
        });

        // Sami Score for YouTube UGC (has real metrics, rating auto-computed by upsertVideo)
        let samiScoreLine: string | null = null;
        if (ytStats) {
          const { getVideoById } = await import('./db');
          const video = getVideoById(videoId);
          const scorePercent = video && video.rating > 0 ? Math.round(video.rating * 10) : 0;
          if (scorePercent > 0) {
            samiScoreLine = `\`Sami Score: ${scorePercent}% (тон, формат, просмотры, лайки, длительность)\``;
          }
        }

        // Rubric: custom text, default "Тренировка от участника", or omit for challenge
        const rubricLine = sub.rubric ? `*${escV2(sub.rubric)}*` : null;
        const caption = [
          ...(rubricLine ? [rubricLine, ''] : []),
          `*${title}*`,
          '',
          ...tagLines,
          ...(samiScoreLine ? [samiScoreLine] : []),
          '',
          authorLine,
        ].join('\n');

        let channelMsg: { message_id: number };

        if (isTgFileId) {
          const fileId = sub.video_url.slice(3);
          channelMsg = await bot.api.sendVideo(
            config.TELEGRAM_CHANNEL_ID,
            fileId,
            { caption, parse_mode: 'MarkdownV2', supports_streaming: true }
          );
        } else if (isYouTubeUrl && isYtDlpAvailable()) {
          // Download with retry (2 attempts) + text fallback
          const MAX_UGC_ATTEMPTS = 2;
          let videoSent = false;

          for (let attempt = 1; attempt <= MAX_UGC_ATTEMPTS; attempt++) {
            try {
              log.info(`UGC download attempt ${attempt}/${MAX_UGC_ATTEMPTS}`, { subId, url: sub.video_url });
              const download = await downloadVideo(sub.video_url, syntheticYoutubeId);
              try {
                channelMsg = await bot.api.sendVideo(
                  config.TELEGRAM_CHANNEL_ID,
                  new InputFile(download.filePath),
                  {
                    caption,
                    parse_mode: 'MarkdownV2',
                    supports_streaming: true,
                    duration: download.meta.duration ?? undefined,
                    width: download.meta.width ?? undefined,
                    height: download.meta.height ?? undefined,
                  }
                );
                videoSent = true;
              } finally {
                download.cleanup();
              }
              if (videoSent) break;
            } catch (dlErr) {
              log.error(`UGC download failed (attempt ${attempt})`, { subId, error: String(dlErr) });
              if (attempt < MAX_UGC_ATTEMPTS) {
                await new Promise(r => setTimeout(r, 3000));
              }
            }
          }

          // Fallback: post as text + YouTube link if video download/upload failed
          if (!videoSent) {
            log.warn('UGC: all download attempts failed, falling back to text+link', { subId });
            const safeUrl = sub.video_url.replace(/[)\\]/g, '\\$&');
            const linkCaption = caption + `\n📎 [Смотреть на YouTube](${safeUrl})`;
            channelMsg = await bot.api.sendMessage(
              config.TELEGRAM_CHANNEL_ID,
              linkCaption,
              { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
            );
          }
        } else {
          // Fallback: post as text with link
          const safeUrl = sub.video_url.replace(/[)\\]/g, '\\$&');
          const linkCaption = isYouTubeUrl
            ? caption + `\n📎 [Смотреть на YouTube](${safeUrl})`
            : caption;
          channelMsg = await bot.api.sendMessage(
            config.TELEGRAM_CHANNEL_ID,
            linkCaption,
            { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
          );
        }

        // Record post in DB
        try {
          const date = todayMsk();
          const postType = (isTgFileId || (isYouTubeUrl && isYtDlpAvailable())) ? 'video' as const : 'link' as const;
          withTransaction(() => {
            recordPost(date, sub.category ?? 'stretching', videoId, channelMsg.message_id, postType);
          });
        } catch (dbErr) {
          log.error('UGC publish: DB write failed (video already sent)', { subId, error: String(dbErr) });
        }

        published = true;
        updateUgcSubmission(subId, { status: 'published', published_at: new Date().toISOString() });
        log.info('UGC published to channel', { subId, videoId });
      } catch (err) {
        publishError = String(err);
        log.error('UGC publish to channel failed', { subId, videoUrl: sub.video_url, error: publishError });
        try {
          const isTg = sub.video_url.startsWith('tg:');
          const details = [
            `Не удалось опубликовать тренировку #${subId}`,
            `Тип: ${isTg ? 'видеофайл' : 'YouTube'}`,
            `Видео: ${isTg ? '(file_id)' : sub.video_url}`,
            `Ошибка: ${publishError.slice(0, 300)}`,
          ].join('\n');
          await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, details);
        } catch {}
      }

      // Update admin message
      const statusText = published ? 'Одобрено и опубликовано' : `Одобрено (публикация не удалась: ${publishError})`;
      try {
        const origText = escV2(ctx.callbackQuery.message?.text ?? '');
        await ctx.editMessageText(
          `${origText}\n\n_${escV2(statusText)}_ \\· Предложил\\(а\\): ${escV2(author)}`,
          { parse_mode: 'MarkdownV2' }
        );
      } catch {}

      // Notify author
      try {
        const notifyText = published
          ? `Твоя тренировка «${sub.title}» одобрена и опубликована в канале!`
          : `Твоя тренировка «${sub.title}» одобрена и будет опубликована!`;
        await bot.api.sendMessage(sub.telegram_user_id, notifyText);
      } catch {}
    } else {
      updateUgcSubmission(subId, { status: 'rejected' });
      await ctx.answerCallbackQuery('Отклонено');
      try {
        await ctx.editMessageText(
          escV2(ctx.callbackQuery.message?.text ?? '') + '\n\n_Отклонено_',
          { parse_mode: 'MarkdownV2' }
        );
      } catch {}

      try {
        await bot.api.sendMessage(
          sub.telegram_user_id,
          `К сожалению, тренировка «${sub.title}» не прошла модерацию. Обычно причина — качество видео или несоответствие формату. Попробуй предложить другую!`
        );
      } catch {}
    }
  });

  log.info('handlers registered');
}

// --- Helpers ---

async function sendMyWorkouts(
  ctx: any,
  userId: number,
  offset: number,
  editMessageId?: number
): Promise<void> {
  const config = getConfig();
  const total = getUserSubmissionTotal(userId);

  if (total === 0) {
    const text = 'У тебя пока нет тренировок.\n\nНажми «Предложить тренировку» чтобы добавить свою.';
    if (editMessageId) {
      try { await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text); } catch {}
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const items = getUserSubmissions(userId, PAGE_SIZE, offset);

  const STATUS_LABEL: Record<string, string> = {
    draft: '\u270F\uFE0F черновик',
    pending: '\u23F3 на модерации',
    approved: '\u2705 одобрено',
    published: '\u2705 опубликовано',
    rejected: '\u274C отклонено',
  };

  const lines = items.map((item, i) => {
    const num = offset + i + 1;
    const catEmoji = item.category ? (CATEGORY_EMOJI[item.category as Category] ?? '') : '';
    const catRu = item.category ? (CATEGORY_RU[item.category as Category] ?? item.category) : '—';
    const title = item.title ? decodeHtmlEntities(item.title) : 'Без названия';
    const status = item.published_at ? '\u2705 опубликовано' : (STATUS_LABEL[item.status] ?? item.status);
    // Build info line: category · duration · difficulty
    const infoParts: string[] = [`${catEmoji} ${catRu}`];
    if (item.duration_seconds) infoParts.push(formatDurationLabel(item.duration_seconds));
    if (item.difficulty) infoParts.push(DIFFICULTY_EMOJI[item.difficulty as Difficulty] ?? item.difficulty);
    if (item.equipment && item.equipment !== 'none') infoParts.push(EQUIPMENT_VALUE_RU[item.equipment as EquipmentValue] ?? item.equipment);
    return `${escV2(String(num))}\\. *${escV2(title)}*\n   ${escV2(infoParts.join(' · '))}\n   ${escV2(status)}`;
  });

  const header = `*Мои тренировки* \\(${escV2(String(total))}\\)\n`;
  const text = header + '\n' + lines.join('\n\n');

  const kb = new InlineKeyboard();
  // Delete buttons for each item
  items.forEach((item, i) => {
    const title = item.title ? decodeHtmlEntities(item.title) : 'Без названия';
    const shortTitle = title.length > 15 ? title.slice(0, 12) + '…' : title;
    kb.text(`🗑 ${shortTitle}`, `ugc_del:${item.id}:${offset}`);
    if (i % 2 === 1) kb.row();
  });
  if (items.length % 2 === 1) kb.row();
  // Pagination
  if (offset > 0) {
    kb.text('← Назад', `mywk:${Math.max(0, offset - PAGE_SIZE)}`);
  }
  if (offset + PAGE_SIZE < total) {
    kb.text('Дальше →', `mywk:${offset + PAGE_SIZE}`);
  }

  const opts: any = {
    parse_mode: 'MarkdownV2',
    reply_markup: kb,
  };

  if (editMessageId) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, opts);
    } catch {}
  } else {
    await ctx.reply(text, opts);
  }
}

async function sendUgcToAdmin(bot: Bot, sub: UgcSubmission): Promise<void> {
  const config = getConfig();
  const catRu = sub.category ? (CATEGORY_RU[sub.category as Category] ?? sub.category) : '?';
  const diff = sub.difficulty ? (DIFFICULTY_RU[sub.difficulty as Difficulty] ?? sub.difficulty) : '?';
  const author = sub.username ? `@${sub.username}` : `id:${sub.telegram_user_id}`;

  const safeTitle = escV2(sub.title ?? 'Без названия');
  const videoLink = sub.video_url.startsWith('tg:') ? '\\(видеофайл\\)' : escV2(sub.video_url);

  const text = [
    `*Предложенная тренировка*`,
    '',
    `Автор: ${escV2(author)}`,
    `Название: ${safeTitle}`,
    `Тип: ${escV2(catRu)}`,
    `Уровень: ${escV2(diff)}`,
    ...(sub.duration_label ? [`Длительность: ${escV2(sub.duration_label)}`] : []),
    ...(sub.muscles ? [`Мышцы: ${escV2(sub.muscles)}`] : []),
    ...(sub.equipment ? [`Инвентарь: ${escV2(sub.equipment)}`] : []),
    `Видео: ${videoLink}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('Одобрить', `ugc_decide:${sub.id}:approve`)
    .text('Отклонить', `ugc_decide:${sub.id}:reject`);

  try {
    log.info('sending UGC to admin', { subId: sub.id, adminId: config.TELEGRAM_ADMIN_USER_ID });
    const msg = await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
    });
    updateUgcSubmission(sub.id, { admin_message_id: msg.message_id });
    log.info('UGC sent to admin', { subId: sub.id, msgId: msg.message_id });
  } catch (err) {
    log.error('FAILED to send UGC to admin', { subId: sub.id, adminId: config.TELEGRAM_ADMIN_USER_ID, error: String(err) });
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}д`);
  if (h > 0) parts.push(`${h}ч`);
  parts.push(`${m}м`);
  return parts.join(' ');
}

async function sendFilterResults(ctx: any, videos: ReturnType<typeof filterVideos>, label: string): Promise<void> {
  if (videos.length === 0) {
    try {
      await ctx.editMessageText(`Фильтр: ${label}\n\nНичего не найдено. Попробуй другой фильтр.`);
    } catch {
      await ctx.reply(`Фильтр: ${label}\n\nНичего не найдено.`);
    }
    return;
  }

  const config = getConfig();
  const channelHandle = config.TELEGRAM_CHANNEL_ID.startsWith('@')
    ? config.TELEGRAM_CHANNEL_ID.slice(1)
    : `c/${config.TELEGRAM_CHANNEL_ID.replace(/^-100/, '')}`;

  const lines = videos.map((v, i) => {
    const title = decodeHtmlEntities(v.title);
    const shortTitle = title.length > 40 ? title.slice(0, 37) + '...' : title;
    const catRu = CATEGORY_RU[v.category as Category] ?? v.category;
    const dur = v.duration_label ?? '?';
    const link = v.channel_message_id
      ? `[${escV2(shortTitle)}](https://t.me/${channelHandle}/${v.channel_message_id})`
      : escV2(shortTitle);
    return `${escV2(String(i + 1))}\\. ${link}\n   ${escV2(catRu)} · ${escV2(dur)} · ⭐${escV2(v.rating.toFixed(1))}`;
  });

  const text = `*${escV2(label)}* \\(${escV2(String(videos.length))}\\)\n\n` + lines.join('\n\n');

  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2' });
  } catch {
    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  }
}

