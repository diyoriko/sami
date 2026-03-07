/**
 * Bot private chat: persistent menu, "Мои тренировки", UGC flow.
 *
 * Persistent keyboard buttons (ReplyKeyboard) shown in private chat:
 * - "Мои тренировки" — completed workouts list
 * - "Предложить тренировку" — UGC submission flow
 */

import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import {
  getUserCompletions,
  getUserCompletionTotal,
  createUgcSubmission,
  updateUgcSubmission,
  getUgcSubmission,
  deleteUgcSubmission,
  type UgcSubmission,
} from './db';

const PAGE_SIZE = 5;

const CATEGORY_RU: Record<string, string> = {
  stretching: 'стретчинг',
  strength: 'силовая',
  mobility: 'мобильность',
};

// --- Persistent keyboard ---

function mainKeyboard(isAdmin = false): Keyboard {
  const kb = new Keyboard()
    .text('Мои тренировки')
    .text('Предложить тренировку');
  if (isAdmin) {
    kb.row()
      .text('Статус').text('Поиск видео').text('Опубликовать')
      .row()
      .text('Сбросить выбор').text('Аналитика');
  }
  return kb.resized().persistent();
}

// --- UGC conversation state (in-memory, keyed by userId) ---

interface UgcState {
  step: 'waiting_link' | 'waiting_category' | 'waiting_difficulty' | 'waiting_title';
  submissionId?: number;
}

const ugcStates = new Map<number, UgcState>();

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

// --- Register handlers ---

export function registerBotMenu(bot: Bot): void {
  const config = getConfig();

  const isAdmin = (userId: number) => userId === config.TELEGRAM_ADMIN_USER_ID;

  // /start in private chat — show menu
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    ugcStates.delete(ctx.from!.id);
    await ctx.reply(
      'Привет! Я бот Sami.\n\nВыбери действие:',
      { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) }
    );
  });

  // --- "Мои тренировки" button ---
  bot.hears('Мои тренировки', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    ugcStates.delete(ctx.from!.id);
    await sendMyWorkouts(ctx, ctx.from!.id, 0);
  });

  // Pagination callback
  bot.callbackQuery(/^mywk:(\d+)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await sendMyWorkouts(ctx, ctx.from!.id, offset, ctx.callbackQuery.message?.message_id);
  });

  // --- Admin buttons ---
  bot.hears('Статус', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk } = await import('./dates');
    const { getPostCountForDate, getCompletionCountForDate, getUniqueCompletionUsersForDate } = await import('./db');
    const date = todayMsk();
    const posts = getPostCountForDate(date);
    const completions = getCompletionCountForDate(date);
    const users = getUniqueCompletionUsersForDate(date);
    await ctx.reply(
      `*Sami — статус*\n\nДата: ${date}\nПостов: ${posts}\nВыполнений: ${completions} (${users} чел.)`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('Поиск видео', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { tomorrowMsk } = await import('./dates');
    const { runApprovalFlow } = await import('./approval');
    const date = tomorrowMsk();
    await ctx.reply(`Ищу видео на ${date}...`);
    await runApprovalFlow(bot, date);
  });

  bot.hears('Опубликовать', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk, tomorrowMsk } = await import('./dates');
    const { postVideoToChannel } = await import('./poster');
    const { getApprovedVideo } = await import('./db');

    const today = todayMsk();
    const tomorrow = tomorrowMsk();
    const categories = ['stretching', 'strength', 'mobility'] as const;
    const hasTomorrow = categories.some(c => getApprovedVideo(tomorrow, c) !== null);
    const hasToday = categories.some(c => getApprovedVideo(today, c) !== null);
    const date = hasTomorrow ? tomorrow : hasToday ? today : null;

    if (!date) {
      await ctx.reply('Нет одобренных видео. Сначала «Поиск видео».');
      return;
    }

    await ctx.reply(`Публикую видео на ${date}...`);
    const report: string[] = [];
    for (const cat of categories) {
      const result = await postVideoToChannel(bot, date, cat, { force: true });
      const label = { stretching: 'Стретчинг', strength: 'Силовая', mobility: 'Мобильность' }[cat];
      if (result === 'posted') report.push(`${label} — ok`);
      else if (result === 'no_video') report.push(`${label} — не выбрано`);
      else if (result === 'error') report.push(`${label} — ошибка`);
      else report.push(`${label} — пропущено`);
    }
    await ctx.reply(report.join('\n'));
  });

  bot.hears('Сбросить выбор', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { tomorrowMsk } = await import('./dates');
    const { resetApprovalSessions } = await import('./db');
    const date = tomorrowMsk();
    const count = resetApprovalSessions(date);
    await ctx.reply(`Сброшено ${count} сессий на ${date}. Нажми «Поиск видео» для нового поиска.`);
  });

  bot.hears('Аналитика', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk } = await import('./dates');
    const { runDailyAnalytics } = await import('./analytics');
    await ctx.reply('Запускаю аналитику...');
    await runDailyAnalytics(bot, todayMsk());
  });

  // --- "Предложить тренировку" button ---
  bot.hears('Предложить тренировку', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    ugcStates.set(ctx.from!.id, { step: 'waiting_link' });
    await ctx.reply(
      'Отправь ссылку на YouTube-видео с тренировкой.\n\n_Отмена: /cancel_',
      { parse_mode: 'Markdown' }
    );
  });

  // /cancel — abort UGC flow
  bot.command('cancel', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const state = ugcStates.get(ctx.from!.id);
    if (state?.submissionId) {
      deleteUgcSubmission(state.submissionId);
    }
    ugcStates.delete(ctx.from!.id);
    await ctx.reply('Отменено.', { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) });
  });

  // --- UGC conversation handler (private chat text) ---
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const userId = ctx.from!.id;
    const state = ugcStates.get(userId);
    if (!state) return next();

    const text = ctx.message.text.trim();

    // Step 1: waiting for YouTube link
    if (state.step === 'waiting_link') {
      const ytId = extractYoutubeId(text);
      if (!ytId) {
        await ctx.reply('Не могу распознать ссылку. Отправь ссылку на YouTube-видео.');
        return;
      }
      const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;
      const subId = createUgcSubmission(userId, ctx.from!.username ?? null, videoUrl, ytId);
      state.submissionId = subId;
      state.step = 'waiting_category';

      const kb = new InlineKeyboard()
        .text('Стретчинг', `ugc_cat:${subId}:stretching`)
        .text('Силовая', `ugc_cat:${subId}:strength`)
        .text('Мобильность', `ugc_cat:${subId}:mobility`);

      await ctx.reply('Какой тип тренировки?', { reply_markup: kb });
      return;
    }

    // Step 3: waiting for title (free text)
    if (state.step === 'waiting_title') {
      if (text.length < 3 || text.length > 200) {
        await ctx.reply('Название должно быть от 3 до 200 символов.');
        return;
      }
      updateUgcSubmission(state.submissionId!, { title: text, status: 'pending' });
      ugcStates.delete(userId);

      const sub = getUgcSubmission(state.submissionId!);
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
  bot.callbackQuery(/^ugc_cat:(\d+):(stretching|strength|mobility)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const category = ctx.match[2];
    const userId = ctx.from!.id;
    const state = ugcStates.get(userId);
    if (!state || state.submissionId !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();
    updateUgcSubmission(subId, { category });
    state.step = 'waiting_difficulty';

    const kb = new InlineKeyboard()
      .text('Начинающий', `ugc_diff:${subId}:beginner`)
      .text('Средний', `ugc_diff:${subId}:intermediate`)
      .text('Продвинутый', `ugc_diff:${subId}:advanced`);

    try {
      await ctx.editMessageText('Уровень сложности?', { reply_markup: kb });
    } catch {
      await ctx.reply('Уровень сложности?', { reply_markup: kb });
    }
  });

  // --- UGC difficulty callback ---
  bot.callbackQuery(/^ugc_diff:(\d+):(beginner|intermediate|advanced)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1]);
    const difficulty = ctx.match[2];
    const userId = ctx.from!.id;
    const state = ugcStates.get(userId);
    if (!state || state.submissionId !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();
    updateUgcSubmission(subId, { difficulty });
    state.step = 'waiting_title';

    try {
      await ctx.editMessageText('Как назвать тренировку? Напиши короткое название.');
    } catch {
      await ctx.reply('Как назвать тренировку? Напиши короткое название.');
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
      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + '\n\n_Одобрено_',
          { parse_mode: 'Markdown' }
        );
      } catch {}

      // Notify author
      try {
        await bot.api.sendMessage(
          sub.telegram_user_id,
          `Твоя тренировка «${sub.title}» одобрена и будет опубликована!`
        );
      } catch {}
    } else {
      updateUgcSubmission(subId, { status: 'rejected' });
      await ctx.answerCallbackQuery('Отклонено');
      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + '\n\n_Отклонено_',
          { parse_mode: 'Markdown' }
        );
      } catch {}

      try {
        await bot.api.sendMessage(
          sub.telegram_user_id,
          'К сожалению, предложенная тренировка не прошла модерацию. Попробуй предложить другую!'
        );
      } catch {}
    }
  });

  console.log('[bot-menu] handlers registered');
}

// --- Helpers ---

async function sendMyWorkouts(
  ctx: any,
  userId: number,
  offset: number,
  editMessageId?: number
): Promise<void> {
  const config = getConfig();
  const total = getUserCompletionTotal(userId);

  if (total === 0) {
    const text = 'У тебя пока нет выполненных тренировок.\n\nНажми «Я сделал(а)» под видео в канале, чтобы отметить тренировку.';
    if (editMessageId) {
      try { await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text); } catch {}
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const items = getUserCompletions(userId, PAGE_SIZE, offset);
  const channelId = config.TELEGRAM_CHANNEL_ID;

  const lines = items.map((item, i) => {
    const num = offset + i + 1;
    const catRu = CATEGORY_RU[item.category] ?? item.category;
    const dateShort = item.date;
    return `${num}. *${escapeMarkdown(item.video_title)}*\n   ${catRu} · ${dateShort}`;
  });

  const header = `*Мои тренировки* (${total})\n`;
  const text = header + '\n' + lines.join('\n\n');

  // Pagination buttons
  const kb = new InlineKeyboard();
  if (offset > 0) {
    kb.text('← Назад', `mywk:${Math.max(0, offset - PAGE_SIZE)}`);
  }
  if (offset + PAGE_SIZE < total) {
    kb.text('Дальше →', `mywk:${offset + PAGE_SIZE}`);
  }

  const opts: any = { parse_mode: 'Markdown', reply_markup: kb };

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
  const catRu = sub.category ? (CATEGORY_RU[sub.category] ?? sub.category) : '?';
  const diffRu: Record<string, string> = { beginner: 'начинающий', intermediate: 'средний', advanced: 'продвинутый' };
  const diff = sub.difficulty ? (diffRu[sub.difficulty] ?? sub.difficulty) : '?';
  const author = sub.username ? `@${sub.username}` : `id:${sub.telegram_user_id}`;

  const text = [
    `*UGC: предложенная тренировка*`,
    '',
    `Автор: ${author}`,
    `Название: ${sub.title}`,
    `Тип: ${catRu}`,
    `Уровень: ${diff}`,
    `Ссылка: ${sub.video_url}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('Одобрить', `ugc_decide:${sub.id}:approve`)
    .text('Отклонить', `ugc_decide:${sub.id}:reject`);

  try {
    const msg = await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    });
    updateUgcSubmission(sub.id, { admin_message_id: msg.message_id });
  } catch (err) {
    console.error('[bot-menu] failed to send UGC to admin:', err);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}
