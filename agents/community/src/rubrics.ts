/**
 * Rubrics: weekly content series.
 *
 * #ритуал_недели (Mon) — one focus practice per week, 7-day challenge with participant counter
 * #механика (Wed) — exercise breakdown (content-only, strategist proposes)
 * #прогресс_пятницы (Fri) — weekly stats, top active members recognition
 */

import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import {
  getCurrentRitual, createRitual, setRitualMessageId,
  recordRitualParticipation, getRitualProgress,
  getRitualParticipantCount, getWeeklyTopMembers,
} from './db';
import { type Category, CATEGORY_RU, CATEGORY_EMOJI } from './shared';

const log = createLogger('rubrics');

// ─── RITUAL CHALLENGE ───────────────────────────────────────────────────────

/**
 * Post a new ritual challenge for the week.
 * Called by strategist action or admin command.
 */
export async function postRitualChallenge(
  bot: Bot,
  title: string,
  description: string,
  category?: Category,
): Promise<number> {
  const config = getConfig();

  // Calculate week start (Monday)
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + mondayOffset);
  const weekStart = monday.toISOString().slice(0, 10);

  const ritualId = createRitual(weekStart, title, description, category);

  const catLabel = category ? `${CATEGORY_EMOJI[category]} ${CATEGORY_RU[category]}` : '';
  const keyboard = new InlineKeyboard()
    .text('Участвую', `ritual_join:${ritualId}`);

  const text =
    `*#ритуал\\_недели*\n\n` +
    `*${title}*\n\n` +
    `${description}\n\n` +
    (catLabel ? `Категория: ${catLabel}\n` : '') +
    `7 дней подряд — одна практика. Нажми кнопку, чтобы присоединиться.\n\n` +
    `Участников: 0`;

  const msg = await bot.api.sendMessage(
    config.TELEGRAM_GROUP_ID,
    text,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );

  setRitualMessageId(ritualId, msg.message_id);
  log.info('posted ritual challenge', { ritualId, title, weekStart });

  return ritualId;
}

// ─── FRIDAY PROGRESS ─────────────────────────────────────────────────────────

/**
 * Post weekly progress digest: stats + top active members.
 */
export async function postWeeklyProgress(bot: Bot): Promise<void> {
  const config = getConfig();

  // Calculate week start
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + mondayOffset);
  const weekStart = monday.toISOString().slice(0, 10);

  const topMembers = getWeeklyTopMembers(weekStart, 5);

  let leaderboard = '';
  if (topMembers.length > 0) {
    const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
    leaderboard = topMembers.map((m, i) => {
      const name = m.first_name || (m.username ? `@${m.username}` : `user ${m.telegram_user_id}`);
      return `${medals[i]} ${name} — ${m.count} тренировок`;
    }).join('\n');
  } else {
    leaderboard = 'На этой неделе пока нет выполненных тренировок.';
  }

  // Current ritual progress
  const ritual = getCurrentRitual();
  let ritualSection = '';
  if (ritual && ritual.week_start === weekStart) {
    const participants = getRitualParticipantCount(ritual.id);
    ritualSection = `\n*Ритуал недели:* ${ritual.title}\nУчастников: ${participants}\n`;
  }

  const text =
    `*#прогресс\\_пятницы*\n\n` +
    `Итоги недели (${weekStart}):\n\n` +
    `*Самые активные:*\n${leaderboard}\n` +
    ritualSection +
    `\nСпасибо всем, кто практикует. Каждая тренировка считается.`;

  await bot.api.sendMessage(
    config.TELEGRAM_GROUP_ID,
    text,
    { parse_mode: 'Markdown' }
  );

  log.info('posted weekly progress', { weekStart, topCount: topMembers.length });
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

export function registerRubricHandlers(bot: Bot): void {
  const config = getConfig();

  // Ritual join button
  bot.callbackQuery(/^ritual_join:(\d+)$/, async (ctx) => {
    const ritualId = parseInt(ctx.match[1]);
    const userId = ctx.from?.id;
    if (!userId) return;

    const ritual = getCurrentRitual();
    if (!ritual || ritual.id !== ritualId) {
      await ctx.answerCallbackQuery('Этот ритуал уже завершён');
      return;
    }

    // Calculate current day number (1-7 based on week_start)
    const weekStart = new Date(ritual.week_start + 'T00:00:00Z');
    const now = new Date();
    const dayDiff = Math.floor((now.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const dayNumber = Math.max(1, Math.min(7, dayDiff));

    const added = recordRitualParticipation(ritualId, userId, dayNumber);
    if (!added) {
      const progress = getRitualProgress(ritualId, userId);
      await ctx.answerCallbackQuery(`Ты уже отметил(а) день ${dayNumber}. Прогресс: ${progress}/7`);
      return;
    }

    const progress = getRitualProgress(ritualId, userId);
    const participants = getRitualParticipantCount(ritualId);

    // Update message with new participant count
    try {
      const keyboard = new InlineKeyboard()
        .text(`Участвую · ${participants}`, `ritual_join:${ritualId}`);
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    } catch { /* message too old */ }

    if (progress === 7) {
      await ctx.answerCallbackQuery('7/7 — ритуал выполнен! Ты молодец.');
    } else {
      await ctx.answerCallbackQuery(`День ${dayNumber} записан. Прогресс: ${progress}/7`);
    }
  });

  // Ritual daily mark (from discussion group)
  bot.callbackQuery(/^ritual_day:(\d+)$/, async (ctx) => {
    const ritualId = parseInt(ctx.match[1]);
    const userId = ctx.from?.id;
    if (!userId) return;

    const ritual = getCurrentRitual();
    if (!ritual || ritual.id !== ritualId) {
      await ctx.answerCallbackQuery('Ритуал завершён');
      return;
    }

    const weekStart = new Date(ritual.week_start + 'T00:00:00Z');
    const dayDiff = Math.floor((Date.now() - weekStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const dayNumber = Math.max(1, Math.min(7, dayDiff));

    recordRitualParticipation(ritualId, userId, dayNumber);
    const progress = getRitualProgress(ritualId, userId);

    await ctx.answerCallbackQuery(`День ${dayNumber}: записано. ${progress}/7`);
  });

  log.info('rubric handlers registered');
}
