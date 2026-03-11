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
import { todayMsk } from './dates';

const log = createLogger('bot-menu');
import {
  getUserSubmissions,
  getUserSubmissionTotal,
  createUgcSubmission,
  updateUgcSubmission,
  getUgcSubmission,
  deleteUgcSubmission,
  saveUgcState,
  getUgcState,
  deleteUgcState,
  getPendingUgcCount,
  getLastStrategistTimestamp,
  getUserFavorites,
  getUserFavoriteTotal,
  getMemberProfile,
  getMemberLevel,
  filterVideos,
  getNewMembersToday,
  upsertVideo,
  recordPost,
  withTransaction,
  type UgcSubmission,
  type UgcStep,
} from './db';
import { CATEGORY_RU, DIFFICULTY_RU, escapeMarkdown, decodeHtmlEntities } from './shared';

const PAGE_SIZE = 5;

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

// --- Register handlers ---

export function registerBotMenu(bot: Bot): void {
  const config = getConfig();

  const isAdmin = (userId: number) => userId === config.TELEGRAM_ADMIN_USER_ID;

  // /start in private chat — show menu
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);
    await ctx.reply(
      'Привет! Я бот Sami.\n\nВыбери действие:',
      { reply_markup: mainKeyboard(isAdmin(ctx.from!.id)) }
    );
  });

  // --- "Мои тренировки" button ---
  bot.hears('Мои тренировки', async (ctx) => {
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

  // --- Admin buttons ---
  bot.hears('Статус', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk, tomorrowMsk } = await import('./dates');
    const { getPostCountForDate, getCompletionCountForDate, getUniqueCompletionUsersForDate, getApprovalQueue } = await import('./db');
    const date = todayMsk();
    const tomorrow = tomorrowMsk();
    const posts = getPostCountForDate(date);
    const completions = getCompletionCountForDate(date);
    const users = getUniqueCompletionUsersForDate(date);

    // Subscriber & group member counts
    let subscriberCount = '?';
    let groupMemberCount = '?';
    try {
      subscriberCount = String(await ctx.api.getChatMemberCount(config.TELEGRAM_CHANNEL_ID));
    } catch { /* API error — show ? */ }
    try {
      groupMemberCount = String(await ctx.api.getChatMemberCount(config.TELEGRAM_GROUP_ID));
    } catch { /* API error — show ? */ }

    // Pending UGC
    const pendingUgc = getPendingUgcCount();

    // Last strategist report
    const lastStrategist = getLastStrategistTimestamp();
    const strategistLine = lastStrategist
      ? `Последний отчёт стратега: ${lastStrategist.replace('T', ' ').slice(0, 16)}`
      : 'Стратег: нет данных';

    // Uptime
    const uptimeStr = formatUptime(process.uptime());

    const STATUS_ICON: Record<string, string> = {
      approved: '✅',
      pending: '⏳',
    };

    const queue = getApprovalQueue(date, tomorrow);
    let queueText = '';
    if (queue.length > 0) {
      const grouped = new Map<string, typeof queue>();
      for (const item of queue) {
        const key = item.date;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(item);
      }
      const parts: string[] = [];
      for (const [qDate, items] of grouped) {
        const lines = items.map(item => {
          const cat = CATEGORY_RU[item.category] ?? item.category;
          const icon = STATUS_ICON[item.status] ?? item.status;
          const rawTitle = decodeHtmlEntities(item.title);
          const title = rawTitle.length > 40 ? rawTitle.slice(0, 37) + '...' : rawTitle;
          return `  ${icon} ${cat} — ${title}`;
        });
        parts.push(`*${qDate}:*\n${lines.join('\n')}`);
      }
      queueText = `\n\n*Очередь:*\n${parts.join('\n\n')}`;
    } else {
      queueText = '\n\nОчередь пуста.';
    }

    await ctx.reply(
      [
        `*Sami — статус*`,
        ``,
        `Дата: ${date}`,
        `Подписчиков: ${subscriberCount} | Группа: ${groupMemberCount}`,
        `Постов: ${posts}`,
        `Выполнений: ${completions} (${users} чел.)`,
        `UGC на модерации: ${pendingUgc}`,
        strategistLine,
        `Аптайм: ${uptimeStr}`,
        queueText,
      ].join('\n'),
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
    const { todayMsk, tomorrowMsk } = await import('./dates');
    const { resetApprovalSessions } = await import('./db');
    const today = todayMsk();
    const tomorrow = tomorrowMsk();
    const countToday = resetApprovalSessions(today);
    const countTomorrow = resetApprovalSessions(tomorrow);
    const total = countToday + countTomorrow;
    await ctx.reply(`Сброшено ${total} сессий (${today}: ${countToday}, ${tomorrow}: ${countTomorrow}). Нажми «Поиск видео» для нового поиска.`);
  });

  bot.hears('Аналитика', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isAdmin(ctx.from!.id)) return;
    const { todayMsk } = await import('./dates');
    const { runDailyAnalytics } = await import('./analytics');
    await ctx.reply('Запускаю аналитику...');
    await runDailyAnalytics(bot, todayMsk());
  });

  // --- "Сохранённое" button ---
  bot.hears('Сохранённое', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);
    await sendFavorites(ctx, ctx.from!.id, 0);
  });

  bot.callbackQuery(/^myfav:(\d+)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await sendFavorites(ctx, ctx.from!.id, offset, ctx.callbackQuery.message?.message_id);
  });

  // --- "Профиль" button ---
  bot.hears('Профиль', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);
    const userId = ctx.from!.id;
    const profile = getMemberProfile(userId);
    const { level, completions } = getMemberLevel(userId);

    const GOAL_LABELS: Record<string, string> = {
      rhythm: 'ритм и дисциплина',
      mobility: 'гибкость и мобильность',
      strength: 'сила',
      observer: 'исследователь',
    };

    const favTotal = getUserFavoriteTotal(userId);
    const subTotal = getUserSubmissionTotal(userId);

    const lines = [
      `*Профиль*`,
      '',
      `Имя: ${profile?.first_name ?? 'не указано'}`,
      `Уровень: ${level}`,
      `Тренировок: ${completions}`,
      `Сохранённых: ${favTotal}`,
      `Предложено: ${subTotal}`,
    ];

    if (profile?.fitness_goal) {
      lines.push(`Цель: ${GOAL_LABELS[profile.fitness_goal] ?? profile.fitness_goal}`);
    }
    if (profile?.joined_at) {
      lines.push(`Участник с: ${profile.joined_at.slice(0, 10)}`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // --- "Фильтры" button ---
  bot.hears('Фильтры', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    deleteUgcState(ctx.from!.id);

    const kb = new InlineKeyboard()
      .text('Стретчинг', 'filter:cat:stretching')
      .text('Сила', 'filter:cat:strength')
      .text('Мобильность', 'filter:cat:mobility')
      .row()
      .text('Новичок', 'filter:preset:beginner')
      .text('Утро (до 15 мин)', 'filter:preset:morning')
      .row()
      .text('После работы', 'filter:preset:afterwork')
      .text('Быстрая (до 10 мин)', 'filter:preset:quick');

    await ctx.reply('Выбери фильтр или пресет:', { reply_markup: kb });
  });

  bot.callbackQuery(/^filter:cat:(stretching|strength|mobility)$/, async (ctx) => {
    const category = ctx.match[1];
    await ctx.answerCallbackQuery();
    const videos = filterVideos({ category, limit: 5 });
    await sendFilterResults(ctx, videos, CATEGORY_RU[category] ?? category);
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
  bot.hears('Предложить тренировку', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    saveUgcState(ctx.from!.id, 'waiting_link');
    await ctx.reply(
      'Отправь ссылку на YouTube-видео или загрузи видеофайл напрямую.\n\n_Отмена: /cancel_',
      { parse_mode: 'Markdown' }
    );
  });

  // /cancel — abort UGC flow
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
    if (!state || state.step !== 'waiting_link') return next();

    // User sent a video file instead of a YouTube link
    const video = ctx.message.video;
    const fileId = video.file_id;
    const duration = video.duration;

    // Create UGC submission with file_id as video_url (bot can re-send by file_id)
    const subId = createUgcSubmission(userId, ctx.from!.username ?? null, `tg:${fileId}`, null);
    if (duration) {
      updateUgcSubmission(subId, { title: `Видео (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')})` });
    }
    saveUgcState(userId, 'waiting_category', subId);

    const kb = new InlineKeyboard()
      .text('Стретчинг', `ugc_cat:${subId}:stretching`)
      .text('Силовая', `ugc_cat:${subId}:strength`)
      .text('Мобильность', `ugc_cat:${subId}:mobility`);

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
        await ctx.reply('Не могу распознать ссылку. Отправь ссылку на YouTube-видео или загрузи видеофайл напрямую.');
        return;
      }
      const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;
      const subId = createUgcSubmission(userId, ctx.from!.username ?? null, videoUrl, ytId);
      saveUgcState(userId, 'waiting_category', subId);

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
      updateUgcSubmission(state.submission_id!, { title: text, status: 'pending' });
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
  bot.callbackQuery(/^ugc_cat:(\d+):(stretching|strength|mobility)$/, async (ctx) => {
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
    const state = getUgcState(userId);
    if (!state || state.submission_id !== subId) {
      await ctx.answerCallbackQuery('Сессия устарела');
      return;
    }
    await ctx.answerCallbackQuery();
    updateUgcSubmission(subId, { difficulty });
    saveUgcState(userId, 'waiting_title', subId);

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

      const author = sub.username ? `@${sub.username}` : (sub.telegram_user_id ? `id:${sub.telegram_user_id}` : '');
      const authorDisplay = sub.username ? `@${sub.username}` : 'участник';

      // --- Publish to channel ---
      let published = false;
      let publishError = '';
      try {
        const categoryRu = CATEGORY_RU[sub.category ?? ''] ?? sub.category ?? '—';
        const difficultyRu = DIFFICULTY_RU[sub.difficulty ?? ''] ?? sub.difficulty ?? '—';
        const title = escapeMarkdown(sub.title ?? 'Тренировка');

        const caption = [
          `*${title}*`,
          '',
          `\`🏷 ${categoryRu}\``,
          `\`📊 ${difficultyRu}\``,
          `Сделали: 0`,
          '',
          `Автор: ${authorDisplay}`,
        ].join('\n');

        const isTgFileId = sub.video_url.startsWith('tg:');
        const isYouTubeUrl = /youtube\.com|youtu\.be/.test(sub.video_url);

        // Create a video record in DB for tracking (completions, favorites)
        const syntheticYoutubeId = isTgFileId
          ? `ugc-${subId}`
          : (sub.youtube_id ?? `ugc-${subId}`);

        const videoId = upsertVideo({
          youtube_id: syntheticYoutubeId,
          title: sub.title ?? 'UGC Тренировка',
          channel_name: authorDisplay,
          channel_url: null,
          duration_seconds: null,
          duration_label: null,
          difficulty: (sub.difficulty as 'beginner' | 'intermediate' | 'advanced') ?? 'beginner',
          category: (sub.category as 'stretching' | 'strength' | 'mobility') ?? 'stretching',
          muscles: null,
          thumbnail_url: null,
          video_url: sub.video_url,
          view_count: 0,
          rating: 0,
          like_ratio: 0,
          channel_subscribers: 0,
        });

        // No inline keyboard — Telegram hides "Comments" button when reply_markup is present.
        // Bot posts "Я сделаль" button as a comment in the discussion group (see moderation.ts).

        let channelMsg: { message_id: number };

        if (isTgFileId) {
          // Re-send Telegram file_id directly
          const fileId = sub.video_url.slice(3); // strip "tg:" prefix
          channelMsg = await bot.api.sendVideo(
            config.TELEGRAM_CHANNEL_ID,
            fileId,
            {
              caption,
              parse_mode: 'Markdown',
              supports_streaming: true,
            }
          );
        } else if (isYouTubeUrl && isYtDlpAvailable()) {
          // Download via yt-dlp and upload
          const download = await downloadVideo(sub.video_url, syntheticYoutubeId);
          try {
            channelMsg = await bot.api.sendVideo(
              config.TELEGRAM_CHANNEL_ID,
              new InputFile(download.filePath),
              {
                caption,
                parse_mode: 'Markdown',
                supports_streaming: true,
                duration: download.meta.duration ?? undefined,
                width: download.meta.width ?? undefined,
                height: download.meta.height ?? undefined,
              }
            );
          } finally {
            download.cleanup();
          }
        } else {
          // Fallback: post as text with link
          channelMsg = await bot.api.sendMessage(
            config.TELEGRAM_CHANNEL_ID,
            caption,
            {
              parse_mode: 'Markdown',
              link_preview_options: { is_disabled: true },
            }
          );
        }

        // Record post in DB
        try {
          const date = todayMsk();
          const postType = isTgFileId || (isYouTubeUrl && isYtDlpAvailable()) ? 'video' as const : 'link' as const;
          withTransaction(() => {
            recordPost(date, sub.category ?? 'stretching', videoId, channelMsg.message_id, postType);
          });
        } catch (dbErr) {
          log.error('UGC publish: DB write failed (video already sent)', { subId, error: String(dbErr) });
        }

        published = true;
        log.info('UGC published to channel', { subId, videoId });
      } catch (err) {
        publishError = String(err);
        log.error('UGC publish to channel failed', { subId, error: publishError });
      }

      // Update admin message
      const statusText = published ? 'Одобрено и опубликовано' : `Одобрено (публикация не удалась: ${publishError})`;
      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + `\n\n_${escapeMarkdown(statusText)}_ · Предложил(а): ${author}`,
          { parse_mode: 'Markdown' }
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

  log.info('handlers registered');
}

// --- Helpers ---

const STATUS_RU: Record<string, string> = {
  pending: 'на модерации',
  approved: 'одобрена',
  rejected: 'отклонена',
};

async function sendMyWorkouts(
  ctx: any,
  userId: number,
  offset: number,
  editMessageId?: number
): Promise<void> {
  const total = getUserSubmissionTotal(userId);

  if (total === 0) {
    const text = 'У тебя пока нет загруженных тренировок.\n\nНажми «Предложить тренировку», чтобы добавить свою.';
    if (editMessageId) {
      try { await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text); } catch {}
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const items = getUserSubmissions(userId, PAGE_SIZE, offset);

  const lines = items.map((item, i) => {
    const num = offset + i + 1;
    const catRu = item.category ? (CATEGORY_RU[item.category] ?? item.category) : '—';
    const statusRu = STATUS_RU[item.status] ?? item.status;
    const title = item.title ? decodeHtmlEntities(item.title) : 'Без названия';
    const dateShort = item.created_at.slice(0, 10);
    return `${num}. *${escapeMarkdown(title)}*\n   ${catRu} · ${statusRu} · ${dateShort}`;
  });

  const header = `*Мои тренировки* (${total})\n`;
  const text = header + '\n' + lines.join('\n\n');

  const kb = new InlineKeyboard();
  if (offset > 0) {
    kb.text('← Назад', `mywk:${Math.max(0, offset - PAGE_SIZE)}`);
  }
  if (offset + PAGE_SIZE < total) {
    kb.text('Дальше →', `mywk:${offset + PAGE_SIZE}`);
  }

  const opts: any = {
    parse_mode: 'Markdown',
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
    log.error('failed to send UGC to admin', { error: String(err) });
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

async function sendFavorites(
  ctx: any,
  userId: number,
  offset: number,
  editMessageId?: number,
): Promise<void> {
  const total = getUserFavoriteTotal(userId);
  if (total === 0) {
    const text = 'У тебя пока нет сохранённых тренировок.\n\nНажми «Сохранить» под видео в канале, чтобы добавить.';
    if (editMessageId) {
      try { await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text); } catch {}
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const items = getUserFavorites(userId, PAGE_SIZE, offset);
  const config = getConfig();
  const channelHandle = config.TELEGRAM_CHANNEL_ID.startsWith('@')
    ? config.TELEGRAM_CHANNEL_ID.slice(1)
    : `c/${config.TELEGRAM_CHANNEL_ID.replace(/^-100/, '')}`;

  const lines = items.map((item, i) => {
    const num = offset + i + 1;
    const catRu = CATEGORY_RU[item.category] ?? item.category;
    const title = decodeHtmlEntities(item.title);
    const shortTitle = title.length > 40 ? title.slice(0, 37) + '...' : title;
    const link = item.channel_message_id
      ? `[${escapeMarkdown(shortTitle)}](https://t.me/${channelHandle}/${item.channel_message_id})`
      : escapeMarkdown(shortTitle);
    return `${num}. ${link}\n   ${catRu}`;
  });

  const text = `*Сохранённое* (${total})\n\n` + lines.join('\n\n');

  const kb = new InlineKeyboard();
  if (offset > 0) kb.text('← Назад', `myfav:${Math.max(0, offset - PAGE_SIZE)}`);
  if (offset + PAGE_SIZE < total) kb.text('Дальше →', `myfav:${offset + PAGE_SIZE}`);

  const opts: any = { parse_mode: 'Markdown', reply_markup: kb };
  if (editMessageId) {
    try { await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, opts); } catch {}
  } else {
    await ctx.reply(text, opts);
  }
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
    const catRu = CATEGORY_RU[v.category] ?? v.category;
    const dur = v.duration_label ?? '?';
    const link = v.channel_message_id
      ? `[${escapeMarkdown(shortTitle)}](https://t.me/${channelHandle}/${v.channel_message_id})`
      : escapeMarkdown(shortTitle);
    return `${i + 1}. ${link}\n   ${catRu} · ${dur} · ★${v.rating.toFixed(1)}`;
  });

  const text = `*${label}* (${videos.length})\n\n` + lines.join('\n\n');

  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  }
}

