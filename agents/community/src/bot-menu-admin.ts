/**
 * Bot menu handlers: admin dashboard, weekly schedule, publish, reset, clear channel, invites.
 * Extracted from bot-menu.ts.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { formatUptime } from './bot-menu-views';
import {
  getPendingUgcCount,
  getLastStrategistTimestamp,
  getChannelStats,
  getRetention,
  getCumulativeStats,
  getPostCountForDate,
  getCompletionCountForDate,
  getUniqueCompletionUsersForDate,
  getDb,
  withTransaction,
  createInviteLink,
  getInviteLinks,
} from './db';
import {
  type Category,
  CATEGORIES,
  CATEGORY_RU,
  CATEGORY_EMOJI,
  CATEGORY_BUTTONS,
  escV2,
  decodeHtmlEntities,
} from './shared';

const log = createLogger('bot-menu-admin');

export function registerAdminHandlers(
  bot: Bot,
  config: ReturnType<typeof getConfig>,
  isAdmin: (userId: number) => boolean,
): void {
  // --- "📊 Дашборд" button ---
  bot.hears('📊 Дашборд', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from?.id ?? 0)) return;
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
          // Schedule shown in «📅 Неделя», not in dashboard

          // Show publish button if today's slot is queued
          const todaySlot = slots.find(s => s.day_number === sDay);
          if (todaySlot && todaySlot.status === 'queued') {
            dashKb = new InlineKeyboard().text('📤 Опубликовать сейчас', `challenge_pub:${challenge.id}:${sDay}`);
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
      try { await ctx.editMessageText('Нет одобренных видео.'); } catch { /* TG API: message may be deleted */ }
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
    } catch { /* TG API: message may be deleted */ }
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
    } catch { /* TG API: message may be deleted */ }
  });

  // --- "📅 Неделя" button ---
  bot.hears('📅 Неделя', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from?.id ?? 0)) return;
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
      `Заполнено: ${filledCount}/7`,
    ].join('\n');

    const kb = new InlineKeyboard();

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
    await runApprovalFlow(bot, date, category, { challengeId, dayNumber, type: 'weekly' });
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
      try { await ctx.editMessageText('Нет активного расписания.'); } catch { /* TG API: message may be deleted */ }
      return;
    }

    const result = await postChallengeVideo(bot, challenge, dayNumber);
    if (result === 'posted') {
      try { await ctx.editMessageText('✅ Опубликовано!'); } catch { /* TG API: message may be deleted */ }
    } else {
      try { await ctx.editMessageText(`Ошибка публикации: ${result}`); } catch { /* TG API: message may be deleted */ }
    }
  });

  // --- "Опубликовать" button ---
  bot.hears('Опубликовать', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from?.id ?? 0)) return;
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

  // --- "Сбросить выбор" button ---
  bot.hears('Сбросить выбор', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from?.id ?? 0)) return;
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
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from?.id ?? 0)) return;
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
    } catch { /* TG API: message may be deleted */ }
  });

  bot.callbackQuery('clear_channel_cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Отменено');
    try { await ctx.editMessageText('Очистка канала отменена.'); } catch { /* TG API: message may be deleted */ }
  });

  // --- /invites command (admin only) — trackable invite links ---
  bot.command('invites', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from?.id ?? 0)) return;

    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/invites\s*/, '').trim();

    // /invites add <label> <url>
    if (args.startsWith('add ')) {
      const parts = args.slice(4).trim();
      const spaceIdx = parts.lastIndexOf(' ');
      if (spaceIdx === -1) {
        await ctx.reply('Формат: /invites add <label> <url>');
        return;
      }
      const label = parts.slice(0, spaceIdx).trim();
      const url = parts.slice(spaceIdx + 1).trim();
      if (!label || !url) {
        await ctx.reply('Формат: /invites add <label> <url>');
        return;
      }
      if (!url.startsWith('https://t.me/')) {
        await ctx.reply('URL должен начинаться с https://t.me/');
        return;
      }
      try {
        const id = createInviteLink(label, url);
        await ctx.reply(`Ссылка добавлена (id=${id}):\n${label} — ${url}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE constraint')) {
          await ctx.reply('Эта ссылка уже зарегистрирована.');
        } else {
          await ctx.reply(`Ошибка: ${msg}`);
        }
      }
      return;
    }

    // /invites — list all
    const links = getInviteLinks();
    if (links.length === 0) {
      await ctx.reply(
        'Нет зарегистрированных ссылок.\n\n' +
        'Добавить: /invites add <label> <url>\n' +
        'Пример: /invites add instagram https://t.me/+AbCdEf12345',
      );
      return;
    }

    const lines = links.map((l, i) => {
      const date = l.created_at.slice(0, 10);
      return `${i + 1}. *${escV2(l.label)}*\n` +
        `   ${escV2(l.url)}\n` +
        `   Клики: ${l.clicks} · Вступления: ${l.joins} · ${escV2(date)}`;
    });

    await ctx.reply(
      `*Инвайт\\-ссылки* \\(${links.length}\\)\n\n` +
      lines.join('\n\n') +
      `\n\n_Добавить: /invites add <label> <url>_`,
      { parse_mode: 'MarkdownV2' },
    );
  });

  log.info('admin handlers registered');
}
