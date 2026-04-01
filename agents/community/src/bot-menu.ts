/**
 * Bot private chat: persistent menu, UGC flow, orchestration.
 *
 * Split into modules (ARCH-080):
 * - bot-menu-workouts.ts — /start, my workouts, /cancel, profile, filters
 * - bot-menu-admin.ts — dashboard, weekly schedule, publish, invites, clear channel
 * - bot-menu-challenges.ts — challenge series CRUD
 * - bot-menu.ts (this file) — shared helpers, UGC flow, orchestration
 */

import { Bot, Keyboard, InlineKeyboard, InputFile } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { downloadVideo, isYtDlpAvailable } from './downloader';
import { todayMsk } from './dates';
import { sendUgcToAdmin } from './bot-menu-views';

const log = createLogger('bot-menu');
import {
  createUgcSubmission,
  updateUgcSubmission,
  getUgcSubmission,
  deleteUgcSubmission,
  isUgcDuplicate,
  saveUgcState,
  getUgcState,
  deleteUgcState,
  getDb,
  upsertVideo,
  recordPost,
  withTransaction,
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
import { registerWorkoutHandlers } from './bot-menu-workouts';
import { registerAdminHandlers } from './bot-menu-admin';
import { registerChallengeHandlers } from './bot-menu-challenges';

// --- Shared helpers (exported for sub-modules) ---

export function mainKeyboard(isAdmin = false): Keyboard {
  const kb = new Keyboard()
    .text('🏋️ Мои тренировки')
    .text('💡 Предложить тренировку');
  if (isAdmin) {
    kb.row()
      .text('📊 Дашборд').text('📅 Неделя')
      .row()
      .text('🏆 Челлендж');
  }
  return kb.resized().persistent();
}

export function extractYoutubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// --- UGC keyboard builders ---

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

// --- UGC handler registration ---

function registerUgcHandlers(
  bot: Bot,
  config: ReturnType<typeof getConfig>,
  isAdmin: (userId: number) => boolean,
): void {

  // "Предложить тренировку" button
  bot.hears('💡 Предложить тренировку', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    saveUgcState(ctx.from!.id, 'waiting_link');

    if (isAdmin(ctx.from!.id)) {
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

  // Admin: YouTube search in UGC flow
  bot.callbackQuery('ugc_yt_search', async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    await ctx.answerCallbackQuery();
    deleteUgcState(ctx.from!.id);

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

  const ugcSearchCatPattern = new RegExp(`^ugc_search_cat:(${CATEGORIES.join('|')})$`);
  bot.callbackQuery(ugcSearchCatPattern, async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    const category = ctx.match[1] as Category;
    await ctx.answerCallbackQuery('Ищу...');
    try { await ctx.editMessageText(`🔍 Ищу видео для ${CATEGORY_RU[category]}...`); } catch { /* TG API */ }

    const { runApprovalFlow } = await import('./approval');
    const { todayMsk } = await import('./dates');
    await runApprovalFlow(bot, todayMsk(), category);
  });

  // Cancel UGC flow
  bot.callbackQuery('ugc_cancel', async (ctx) => {
    const state = getUgcState(ctx.from.id);
    if (state?.submission_id) {
      deleteUgcSubmission(state.submission_id);
    }
    deleteUgcState(ctx.from.id);
    await ctx.answerCallbackQuery('Отменено');
    try { await ctx.editMessageText('Отменено.'); } catch { /* TG API */ }
  });

  // Back button in UGC flow
  bot.callbackQuery(/^ugc_back:(\d+):(.+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const currentStep = ctx.match[2] as UgcStep;
    const userId = ctx.from!.id;
    await ctx.answerCallbackQuery();

    const sub = getUgcSubmission(subId);
    if (!sub) {
      deleteUgcState(userId);
      try { await ctx.editMessageText('Сессия устарела.'); } catch { /* TG API */ }
      return;
    }

    if (currentStep === 'waiting_difficulty') {
      saveUgcState(userId, 'waiting_category', subId);
      const kb = buildCategoryKeyboard(subId);
      try { await ctx.editMessageText('Какой тип тренировки?', { reply_markup: kb }); } catch { /* TG API */ }
    } else if (currentStep === 'waiting_duration') {
      saveUgcState(userId, 'waiting_difficulty', subId);
      const kb = new InlineKeyboard();
      DIFFICULTY_BUTTONS.forEach((btn, i) => {
        if (i > 0) kb.row();
        kb.text(btn.label, `ugc_diff:${subId}:${btn.value}`);
      });
      kb.row().text('← Назад', `ugc_back:${subId}:waiting_difficulty`).text('❌ Отмена', 'ugc_cancel');
      try { await ctx.editMessageText('Уровень сложности?', { reply_markup: kb }); } catch { /* TG API */ }
    } else if (currentStep === 'waiting_equipment') {
      if (sub.duration_seconds) {
        saveUgcState(userId, 'waiting_difficulty', subId);
        const kb = new InlineKeyboard();
        DIFFICULTY_BUTTONS.forEach((btn, i) => {
          if (i > 0) kb.row();
          kb.text(btn.label, `ugc_diff:${subId}:${btn.value}`);
        });
        kb.row().text('← Назад', `ugc_back:${subId}:waiting_difficulty`).text('❌ Отмена', 'ugc_cancel');
        try { await ctx.editMessageText('Уровень сложности?', { reply_markup: kb }); } catch { /* TG API */ }
      } else {
        saveUgcState(userId, 'waiting_duration', subId);
        const kb = buildDurationKeyboard(subId);
        try { await ctx.editMessageText('Сколько длится тренировка?', { reply_markup: kb }); } catch { /* TG API */ }
      }
    } else if (currentStep === 'waiting_rubric') {
      saveUgcState(userId, 'waiting_equipment', subId);
      const kb = buildEquipmentKeyboard(subId);
      try { await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb }); } catch { /* TG API */ }
    } else if (currentStep === 'waiting_title') {
      if (isAdmin(userId)) {
        saveUgcState(userId, 'waiting_rubric', subId);
        const rubricKb = new InlineKeyboard()
          .text('📅 Челлендж', `ugc_rubric:${subId}:challenge`)
          .text('👤 От участника', `ugc_rubric:${subId}:ugc`)
          .row()
          .text('✏️ Своя рубрика', `ugc_rubric:${subId}:custom`)
          .row()
          .text('← Назад', `ugc_back:${subId}:waiting_rubric`)
          .text('❌ Отмена', 'ugc_cancel');
        try { await ctx.editMessageText('Рубрика поста:', { reply_markup: rubricKb }); } catch { /* TG API */ }
      } else {
        saveUgcState(userId, 'waiting_equipment', subId);
        const kb = buildEquipmentKeyboard(subId);
        try { await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb }); } catch { /* TG API */ }
      }
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

  // Accept video file
  bot.on('message:video', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    log.info('video message in private chat', { userId, step: state?.step ?? 'none', hasVideo: !!ctx.message.video });
    if (!state || state.step !== 'waiting_link') return next();

    const video = ctx.message.video;
    const fileId = video.file_id;
    const duration = video.duration;

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

  // Accept video as document
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

  // Text handler — UGC steps + challenge creation (MUST be last on() handler)
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const userId = ctx.from!.id;
    const state = getUgcState(userId);
    if (!state) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    // Title editing from approval flow
    if (state.step === 'edit_title') {
      deleteUgcState(userId);
      if (!text || !state.submission_id) {
        await ctx.reply('Заголовок не может быть пустым.');
        return;
      }
      const { setVideoDisplayTitle } = await import('./db-videos');
      setVideoDisplayTitle(state.submission_id, text);
      const { escV2: esc } = await import('./shared');
      await ctx.reply(`✅ Заголовок: *${esc(text)}*`, { parse_mode: 'MarkdownV2' });
      return;
    }

    // Challenge series creation: name
    if (state.step === ('cs_name')) {
      if (text.length < 2 || text.length > 100) {
        await ctx.reply('Название от 2 до 100 символов.');
        return;
      }
      const meta = JSON.stringify({ name: text });
      saveUgcState(userId, 'cs_duration');
      getDb().prepare(`UPDATE ugc_conversation_state SET submission_id = ? WHERE telegram_user_id = ?`)
        .run(meta, userId);

      const kb = new InlineKeyboard()
        .text('3 дня', 'cs_dur:3').text('5 дней', 'cs_dur:5').row()
        .text('7 дней', 'cs_dur:7').text('14 дней', 'cs_dur:14').row()
        .text('21 день', 'cs_dur:21').text('30 дней', 'cs_dur:30').row()
        .text('❌ Отмена', 'cs_cancel');

      await ctx.reply(`Название: ${text}\n\nСколько дней длится челлендж?`, { reply_markup: kb });
      return;
    }

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

      try {
        const { fetchVideoDuration } = await import('./youtube');
        const dur = await fetchVideoDuration(ytId);
        if (dur) {
          updateUgcSubmission(subId, { duration_seconds: dur.seconds, duration_label: dur.label });
        }
      } catch { /* non-critical */ }

      saveUgcState(userId, 'waiting_category', subId);
      const kb = buildCategoryKeyboard(subId);
      await ctx.reply('Какой тип тренировки?', { reply_markup: kb });
      return;
    }

    // Custom rubric text (admin only)
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
      await ctx.reply('Как назвать тренировку? Напиши короткое название (до 200 символов).', { reply_markup: titleKb });
      return;
    }

    // Title step — last step before submission
    if (state.step === 'waiting_title') {
      if (text.length < 3 || text.length > 200) {
        await ctx.reply(`Название слишком ${text.length < 3 ? 'короткое' : 'длинное'} (${text.length}/200)`);
        return;
      }

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

      await sendUgcToAdmin(bot, sub);

      const muscleHint = detectedMuscles.length > 0
        ? `\nОбнаружены мышцы: ${muscles}`
        : '';
      await ctx.reply(
        `Спасибо! Тренировка отправлена на модерацию.${muscleHint}\nТы получишь уведомление, когда она будет опубликована.`,
        { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) }
      );
      return;
    }

    return next();
  });

  // UGC category callback
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

  // UGC difficulty callback
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

    const sub = getUgcSubmission(subId);
    if (sub?.duration_seconds) {
      saveUgcState(userId, 'waiting_equipment', subId);
      const kb = buildEquipmentKeyboard(subId);
      try { await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb }); }
      catch { await ctx.reply('Нужен ли инвентарь?', { reply_markup: kb }); }
    } else {
      saveUgcState(userId, 'waiting_duration', subId);
      const kb = buildDurationKeyboard(subId);
      try { await ctx.editMessageText('Сколько длится тренировка?', { reply_markup: kb }); }
      catch { await ctx.reply('Сколько длится тренировка?', { reply_markup: kb }); }
    }
  });

  // UGC duration callback
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
    try { await ctx.editMessageText('Нужен ли инвентарь?', { reply_markup: kb }); }
    catch { await ctx.reply('Нужен ли инвентарь?', { reply_markup: kb }); }
  });

  // UGC equipment callback
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
      saveUgcState(userId, 'waiting_rubric', subId);
      const rubricKb = new InlineKeyboard()
        .text('📅 Челлендж', `ugc_rubric:${subId}:challenge`)
        .text('👤 От участника', `ugc_rubric:${subId}:ugc`)
        .row()
        .text('✏️ Своя рубрика', `ugc_rubric:${subId}:custom`)
        .row()
        .text('← Назад', `ugc_back:${subId}:waiting_rubric`)
        .text('❌ Отмена', 'ugc_cancel');
      try { await ctx.editMessageText('Рубрика поста:', { reply_markup: rubricKb }); }
      catch { await ctx.reply('Рубрика поста:', { reply_markup: rubricKb }); }
    } else {
      saveUgcState(userId, 'waiting_title', subId);
      const titleKb = new InlineKeyboard()
        .text('← Назад', `ugc_back:${subId}:waiting_title`)
        .text('❌ Отмена', 'ugc_cancel');
      try { await ctx.editMessageText('Как назвать тренировку? Напиши короткое название (до 200 символов).', { reply_markup: titleKb }); }
      catch { await ctx.reply('Как назвать тренировку? Напиши короткое название (до 200 символов).', { reply_markup: titleKb }); }
    }
  });

  // UGC rubric callback (admin only)
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
      saveUgcState(userId, 'waiting_rubric', subId);
      const backKb = new InlineKeyboard()
        .text('← Назад', `ugc_back:${subId}:waiting_rubric`)
        .text('❌ Отмена', 'ugc_cancel');
      try { await ctx.editMessageText('Напиши название рубрики (будет первой строкой поста):', { reply_markup: backKb }); }
      catch { await ctx.reply('Напиши название рубрики:', { reply_markup: backKb }); }
      return;
    }

    const rubricLabel = rubricType === 'challenge' ? null : 'Тренировка от участника';
    updateUgcSubmission(subId, { rubric: rubricLabel });
    saveUgcState(userId, 'waiting_title', subId);

    const titleKb = new InlineKeyboard()
      .text('← Назад', `ugc_back:${subId}:waiting_title`)
      .text('❌ Отмена', 'ugc_cancel');
    try { await ctx.editMessageText('Как назвать тренировку? Напиши короткое название (до 200 символов).', { reply_markup: titleKb }); }
    catch { await ctx.reply('Как назвать тренировку? Напиши короткое название (до 200 символов).', { reply_markup: titleKb }); }
  });

  // Admin UGC approve/reject
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

        let samiScoreLine: string | null = null;
        if (ytStats) {
          const { getVideoById } = await import('./db');
          const video = getVideoById(videoId);
          const scorePercent = video && video.rating > 0 ? Math.round(video.rating * 10) : 0;
          if (scorePercent > 0) {
            samiScoreLine = `\`Sami Score: ${scorePercent}% (тон, формат, просмотры, лайки, длительность)\``;
          }
        }

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
                    width: download.meta.width,
                    height: download.meta.height,
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
        } catch { /* TG API */ }
      }

      const statusText = published ? 'Одобрено и опубликовано' : `Одобрено (публикация не удалась: ${publishError})`;
      try {
        const origText = escV2(ctx.callbackQuery.message?.text ?? '');
        await ctx.editMessageText(
          `${origText}\n\n_${escV2(statusText)}_ \\· Предложил\\(а\\): ${escV2(author)}`,
          { parse_mode: 'MarkdownV2' }
        );
      } catch { /* TG API */ }

      try {
        const notifyText = published
          ? `Твоя тренировка «${sub.title}» одобрена и опубликована в канале!`
          : `Твоя тренировка «${sub.title}» одобрена и будет опубликована!`;
        await bot.api.sendMessage(sub.telegram_user_id, notifyText);
      } catch { /* TG API */ }
    } else {
      updateUgcSubmission(subId, { status: 'rejected' });
      await ctx.answerCallbackQuery('Отклонено');
      try {
        await ctx.editMessageText(
          escV2(ctx.callbackQuery.message?.text ?? '') + '\n\n_Отклонено_',
          { parse_mode: 'MarkdownV2' }
        );
      } catch { /* TG API */ }

      try {
        await bot.api.sendMessage(
          sub.telegram_user_id,
          `К сожалению, тренировка «${sub.title}» не прошла модерацию. Обычно причина — качество видео или несоответствие формату. Попробуй предложить другую!`
        );
      } catch { /* TG API */ }
    }
  });
}

// --- Main orchestrator ---

export function registerBotMenu(bot: Bot): void {
  const config = getConfig();
  const isAdmin = (userId: number) => userId === config.TELEGRAM_ADMIN_USER_ID;

  // Order matters: commands first, then hears, callbacks, on() handlers last
  registerWorkoutHandlers(bot, config, isAdmin);
  registerAdminHandlers(bot, config, isAdmin);
  registerChallengeHandlers(bot, config, isAdmin);
  registerUgcHandlers(bot, config, isAdmin); // LAST — has on('message:text') catch-all

  log.info('handlers registered');
}
