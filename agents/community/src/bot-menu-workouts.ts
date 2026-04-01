/**
 * Bot menu handlers: workouts, profile, filters, /start, /cancel.
 * Extracted from bot-menu.ts.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { sendMyWorkouts, sendFilterResults } from './bot-menu-views';
import { mainKeyboard } from './bot-menu';
import {
  deleteUgcState,
  getUgcState,
  saveUgcState,
  getUgcSubmission,
  deleteUgcSubmission,
  getMemberProfile,
  getMemberLevel,
  getUserStreak,
  getUserSubmissionTotal,
  filterVideos,
  type UgcStep,
} from './db';
import {
  type Category,
  CATEGORIES,
  CATEGORY_RU,
  CATEGORY_BUTTONS,
  DIFFICULTY_BUTTONS,
  DURATION_BUTTONS,
  EQUIPMENT_BUTTONS,
  formatDurationLabel,
  escV2,
  decodeHtmlEntities,
} from './shared';

const log = createLogger('bot-menu-workouts');

// --- Local keyboard builders (same logic as bot-menu-ugc.ts, needed by resume flow) ---

function buildCategoryKeyboard(subId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  CATEGORY_BUTTONS.forEach((btn, i) => {
    kb.text(btn.label, `ugc_cat:${subId}:${btn.value}`);
    if (i % 2 === 1) kb.row();
  });
  if (CATEGORY_BUTTONS.length % 2 === 1) kb.row();
  kb.text('❌ Отмена', 'ugc_cancel');
  return kb;
}

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

function buildEquipmentKeyboard(subId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  EQUIPMENT_BUTTONS.forEach((btn, i) => {
    kb.text(btn.label, `ugc_equip:${subId}:${btn.value}`);
    if (i % 2 === 1) kb.row();
  });
  if (EQUIPMENT_BUTTONS.length % 2 === 1) kb.row();
  kb.text('← Назад', `ugc_back:${subId}:waiting_equipment`).text('❌ Отмена', 'ugc_cancel');
  return kb;
}

export function registerWorkoutHandlers(
  bot: Bot,
  config: ReturnType<typeof getConfig>,
  isAdmin: (userId: number) => boolean,
): void {
  // /start in private chat — clean slate + show menu
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);

    // Clear previous messages in this chat for a fresh start
    const msgId = ctx.message?.message_id;
    if (msgId) {
      for (let id = msgId; id > msgId - 200 && id > 0; id--) {
        try { await ctx.api.deleteMessage(ctx.chat.id, id); } catch { /* TG API: too old or already deleted */
          break; // stop on first failure
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
    } catch { /* TG API: message may be deleted */ }
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

  // Resume draft workout — re-enter UGC flow from where user left off
  bot.callbackQuery(/^ugc_resume:(\d+):(\d+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const offset = parseInt(ctx.match[2]);
    const userId = ctx.from!.id;
    const sub = getUgcSubmission(subId);
    if (!sub || sub.telegram_user_id !== userId) {
      await ctx.answerCallbackQuery('Не найдено');
      return;
    }
    if (sub.status !== 'draft') {
      await ctx.answerCallbackQuery('Эта тренировка уже не черновик');
      return;
    }
    await ctx.answerCallbackQuery();

    const config = getConfig();
    const isAdminUser = userId === config.TELEGRAM_ADMIN_USER_ID;

    // Determine which step to resume based on filled fields
    let resumeStep: UgcStep;
    let prompt: string;
    let kb: InlineKeyboard;

    if (!sub.category) {
      resumeStep = 'waiting_category';
      prompt = 'Какой тип тренировки?';
      kb = buildCategoryKeyboard(subId);
    } else if (!sub.difficulty) {
      resumeStep = 'waiting_difficulty';
      prompt = 'Уровень сложности?';
      kb = new InlineKeyboard();
      DIFFICULTY_BUTTONS.forEach((btn, i) => {
        if (i > 0) kb.row();
        kb.text(btn.label, `ugc_diff:${subId}:${btn.value}`);
      });
      kb.row().text('← Назад', `ugc_back:${subId}:waiting_difficulty`).text('❌ Отмена', 'ugc_cancel');
    } else if (!sub.duration_seconds) {
      resumeStep = 'waiting_duration';
      prompt = 'Сколько длится тренировка?';
      kb = buildDurationKeyboard(subId);
    } else if (!sub.equipment) {
      resumeStep = 'waiting_equipment';
      prompt = 'Нужен ли инвентарь?';
      kb = buildEquipmentKeyboard(subId);
    } else if (isAdminUser && sub.rubric === null) {
      // Admin rubric step (rubric is null = not yet set)
      resumeStep = 'waiting_rubric';
      prompt = 'Рубрика поста:';
      kb = new InlineKeyboard()
        .text('📅 Челлендж', `ugc_rubric:${subId}:challenge`)
        .text('👤 От участника', `ugc_rubric:${subId}:ugc`)
        .row()
        .text('✏️ Своя рубрика', `ugc_rubric:${subId}:custom`)
        .row()
        .text('← Назад', `ugc_back:${subId}:waiting_rubric`)
        .text('❌ Отмена', 'ugc_cancel');
    } else {
      // All fields filled except title, or title is default — go to title step
      resumeStep = 'waiting_title';
      prompt = 'Как назвать тренировку? Напиши короткое название (до 200 символов).';
      kb = new InlineKeyboard()
        .text('← Назад', `ugc_back:${subId}:waiting_title`)
        .text('❌ Отмена', 'ugc_cancel');
    }

    saveUgcState(userId, resumeStep, subId);

    try {
      await ctx.editMessageText(prompt, { reply_markup: kb });
    } catch { /* TG API: message may be deleted, fallback to reply */
      await ctx.reply(prompt, { reply_markup: kb });
    }
  });

  // /cancel command
  bot.command('cancel', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const state = getUgcState(ctx.from!.id);
    if (state?.submission_id) {
      deleteUgcSubmission(state.submission_id);
    }
    deleteUgcState(ctx.from!.id);
    await ctx.reply('Отменено.', { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) });
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

  log.info('workout handlers registered');
}
