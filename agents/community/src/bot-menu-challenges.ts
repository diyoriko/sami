/**
 * Bot menu handlers: challenge series CRUD, day fill, publish.
 * Extracted from bot-menu.ts.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { sendChallengeView } from './bot-menu-views';
import {
  deleteUgcState,
  saveUgcState,
  getUgcState,
  getDb,
  createChallengeSeries,
  getChallengeSeries,
  listChallengeSeries,
  getActiveChallengeSeriesList,
  updateChallengeSeriesStatus,
  getChallengeSeriesDaysStatus,
  setChallengeSeriesDayVideo,
  clearChallengeSeriesDaySlot,
  getChallengeParticipantCount,
  type ChallengeSeriesRow,
} from './db';
import {
  type Category,
  CATEGORIES,
  CATEGORY_RU,
  CATEGORY_BUTTONS,
  escV2,
} from './shared';

const log = createLogger('bot-menu-challenges');

export function registerChallengeHandlers(
  bot: Bot,
  config: ReturnType<typeof getConfig>,
  isAdmin: (userId: number) => boolean,
): void {
  // ─── CHALLENGE SERIES ──────────────────────────────────────────────────────

  bot.hears('🏆 Челлендж', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from?.id ?? 0)) return;
    deleteUgcState(ctx.from!.id);

    const active = getActiveChallengeSeriesList();
    const drafts = listChallengeSeries(['draft']);

    const kb = new InlineKeyboard();
    kb.text('➕ Создать челлендж', 'cs_create').row();

    for (const s of [...active, ...drafts]) {
      const statusIcon = s.status === 'active' ? '🟢' : '📝';
      const pCount = getChallengeParticipantCount(s.id);
      kb.text(`${statusIcon} ${s.name} (${pCount} уч.)`, `cs_view:${s.id}`).row();
    }

    const completedCount = listChallengeSeries(['completed']).length;
    if (completedCount > 0) {
      kb.text(`📦 Завершённые (${completedCount})`, 'cs_completed').row();
    }

    const text = active.length > 0 || drafts.length > 0
      ? '*🏆 Челленджи*\n\nВыбери челлендж или создай новый:'
      : '*🏆 Челленджи*\n\nНет активных челленджей\\. Создай первый\\!';

    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  });

  // Create challenge: step 1 — name
  bot.callbackQuery('cs_create', async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery();
    saveUgcState(ctx.from!.id, 'cs_name');
    try {
      await ctx.editMessageText('Как назвать челлендж? Например: «Здоровая спина» или «7 дней стретчинга»');
    } catch (err) { log.debug('editMessageText failed, falling back to reply', { error: String(err) });
      await ctx.reply('Как назвать челлендж?');
    }
  });

  // Create challenge: step 2 — duration (after name is typed in text handler below)
  bot.callbackQuery(/^cs_dur:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    const days = parseInt(ctx.match[1]);
    await ctx.answerCallbackQuery();

    // Store in UGC state temporarily
    const state = getUgcState(ctx.from!.id);
    if (!state) return;

    const meta = JSON.parse(state.submission_id ? String(state.submission_id) : '{}');
    meta.duration = days;
    saveUgcState(ctx.from!.id, 'cs_category', undefined);
    getDb().prepare(`UPDATE ugc_conversation_state SET submission_id = ? WHERE telegram_user_id = ?`)
      .run(JSON.stringify(meta), ctx.from!.id);

    const kb = new InlineKeyboard();
    CATEGORY_BUTTONS.forEach((btn, i) => {
      kb.text(btn.label, `cs_cat:${btn.value}`);
      if (i % 2 === 1) kb.row();
    });
    if (CATEGORY_BUTTONS.length % 2 === 1) kb.row();
    kb.text('🔀 Без привязки', 'cs_cat:mixed').row();
    kb.text('❌ Отмена', 'cs_cancel');

    try {
      await ctx.editMessageText(`Длительность: ${days} дней\n\nКатегория по умолчанию (можно менять для каждого дня):`, { reply_markup: kb });
    } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
  });

  // Create challenge: step 3 — default category
  const csCatPattern = new RegExp(`^cs_cat:(${CATEGORIES.join('|')}|mixed)$`);
  bot.callbackQuery(csCatPattern, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    const category = ctx.match[1] === 'mixed' ? null : ctx.match[1];
    await ctx.answerCallbackQuery();

    const state = getUgcState(ctx.from!.id);
    if (!state) return;
    const meta = JSON.parse(String(state.submission_id ?? '{}'));
    meta.category = category;

    // Create the challenge with start = tomorrow MSK
    const { tomorrowMsk } = await import('./dates');
    const startDate = tomorrowMsk();

    const seriesId = createChallengeSeries(meta.name, meta.duration, startDate, {
      defaultCategory: category ?? undefined,
      publishTime: '09:00',
    });

    deleteUgcState(ctx.from!.id);

    const series = getChallengeSeries(seriesId)!;
    const catLabel = category ? (CATEGORY_RU[category as Category] ?? category) : 'смешанная';

    try {
      await ctx.editMessageText(
        `✅ Челлендж создан!\n\n` +
        `Название: ${series.name}\n` +
        `Дней: ${series.duration_days}\n` +
        `Категория: ${catLabel}\n` +
        `Старт: ${series.start_date}\n` +
        `Статус: черновик\n\n` +
        `Теперь заполни расписание и активируй.`
      );
    } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }

    // Show challenge view
    await sendChallengeView(ctx, seriesId);
  });

  bot.callbackQuery('cs_cancel', async (ctx) => {
    deleteUgcState(ctx.from!.id);
    await ctx.answerCallbackQuery('Отменено');
    try { await ctx.editMessageText('Создание челленджа отменено.'); } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
  });

  // View a specific challenge series
  bot.callbackQuery(/^cs_view:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery();
    await sendChallengeView(ctx, parseInt(ctx.match[1]));
  });

  // Completed challenges list
  bot.callbackQuery('cs_completed', async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery();
    const completed = listChallengeSeries(['completed']);
    if (completed.length === 0) {
      try { await ctx.editMessageText('Нет завершённых челленджей.'); } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of completed.slice(0, 10)) {
      const pCount = getChallengeParticipantCount(s.id);
      kb.text(`📦 ${s.name} (${pCount} уч.)`, `cs_view:${s.id}`).row();
    }
    try {
      await ctx.editMessageText('*Завершённые челленджи:*', { parse_mode: 'MarkdownV2', reply_markup: kb });
    } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
  });

  // Activate / Complete / Cancel a challenge
  bot.callbackQuery(/^cs_activate:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery('Активирован');
    updateChallengeSeriesStatus(parseInt(ctx.match[1]), 'active');
    await sendChallengeView(ctx, parseInt(ctx.match[1]));
  });

  bot.callbackQuery(/^cs_complete:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery('Завершён');
    updateChallengeSeriesStatus(parseInt(ctx.match[1]), 'completed');
    await sendChallengeView(ctx, parseInt(ctx.match[1]));
  });

  bot.callbackQuery(/^cs_cancel_series:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery('Отменён');
    updateChallengeSeriesStatus(parseInt(ctx.match[1]), 'cancelled');
    try { await ctx.editMessageText('Челлендж отменён.'); } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
  });

  // Fill a day in challenge series — run approval flow
  bot.callbackQuery(/^fill_series_day:(\d+):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery('Ищу видео...');

    const seriesId = parseInt(ctx.match[1]);
    const dayNumber = parseInt(ctx.match[2]);

    const series = getChallengeSeries(seriesId);
    if (!series) return;

    const { getChallengeSeriesDaySlot } = await import('./db');
    const slot = getChallengeSeriesDaySlot(seriesId, dayNumber);
    if (slot?.status === 'queued') {
      clearChallengeSeriesDaySlot(seriesId, dayNumber);
    }

    const category = (slot?.category ?? series.default_category ?? 'stretching') as Category;

    // Use approval flow with series context
    const { runApprovalFlow } = await import('./approval');
    const { todayMsk } = await import('./dates');

    await runApprovalFlow(bot, todayMsk(), category, { challengeId: seriesId, dayNumber, type: 'series' }, undefined, undefined);
  });

  // Publish a specific challenge series day
  bot.callbackQuery(/^cs_pub:(\d+):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    await ctx.answerCallbackQuery('Публикую...');

    const seriesId = parseInt(ctx.match[1]);
    const dayNumber = parseInt(ctx.match[2]);
    const series = getChallengeSeries(seriesId);
    if (!series || series.status !== 'active') {
      try { await ctx.editMessageText('Челлендж не активен.'); } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
      return;
    }

    const { postChallengeSeriesVideo } = await import('./poster');
    const result = await postChallengeSeriesVideo(bot, series, dayNumber);
    if (result === 'posted') {
      try { await ctx.editMessageText('✅ Опубликовано!'); } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
    } else {
      try { await ctx.editMessageText(`Ошибка: ${result}`); } catch (err) { log.debug('editMessageText failed (message may be deleted)', { error: String(err) }); }
    }
  });

  log.info('challenge handlers registered');
}
