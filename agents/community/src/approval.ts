import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import {
  upsertVideo,
  createApprovalSession,
  setApprovalMessageId,
  getApprovalSessionByMessageId,
  getApprovalSessionById,
  setApprovalStatus,
  softDeletePendingSessions,
  recordRejection,
  setWeekSlotVideo,
  storeChallengeContext,
  getChallengeContext,
  clearChallengeContext,
  getChallengeSeries,
  setChallengeSeriesDayVideo,
  getDb,
} from './db';
import { searchAllCategories, searchVideos, detectEquipment, Category, ScoredVideo } from './youtube';
import { rewriteTitle, formatChannelName } from './translate';
import { createLogger, generateCorrelationId } from './logger';
import { CATEGORIES, CATEGORY_RU, DIFFICULTY_RU, CATEGORY_EMOJI, escV2, parseMuscles } from './shared';

const log = createLogger('approval');

const APPROVAL_SEND_DELAY_MS = 300; // Telegram rate-limit safety

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

async function formatApprovalMessage(video: ScoredVideo, category: Category): Promise<string> {
  const emoji = CATEGORY_EMOJI[category];
  const rawCategoryRu = CATEGORY_RU[category] ?? category;
  const categoryRu = rawCategoryRu.charAt(0).toUpperCase() + rawCategoryRu.slice(1);
  const muscles = parseMuscles(video.muscles);

  const equipmentLine = video.equipment.length > 0
    ? `Нужна экипировка: ${escV2(video.equipment.join(', '))}`
    : `Только коврик`;

  // rewriteTitle/formatChannelName already return MarkdownV2-escaped text
  const title = await rewriteTitle(video.title);
  const channel = await formatChannelName(video.channel_name);
  const linkUrl = video.video_url.replace(/[)\\]/g, '\\$&');
  const diffLabel = escV2((DIFFICULTY_RU[video.difficulty] ?? video.difficulty).replace(/^./, c => c.toUpperCase()));

  return [
    `${emoji} *${escV2(categoryRu)}*`,
    '',
    `*${title}*`,
    `${channel}`,
    `[YouTube](${linkUrl})`,
    '',
    `${escV2(video.duration_label ?? '—')}  \\·  ${diffLabel}`,
    `${escV2(muscles)}`,
    equipmentLine,
    `${escV2(formatViews(video.view_count))} просмотров`,
    '',
    `Рейтинг поиска: ${escV2(String((video.total_score / 10).toFixed(1)))}/10 _\\(бренд: ${escV2(String((video.brand_score / 10).toFixed(1)))}\\)_`,
  ].join('\n');
}

// Send approval card with Markdown fallback to plain text
async function sendApprovalCard(
  api: { sendPhoto: Function; sendMessage: Function },
  chatId: number, thumbnailUrl: string | null, text: string, keyboard: InlineKeyboard
) {
  for (const parseMode of ['MarkdownV2', undefined] as const) {
    try {
      if (thumbnailUrl) {
        return await api.sendPhoto(chatId, thumbnailUrl, {
          caption: text, parse_mode: parseMode, reply_markup: keyboard,
        });
      } else {
        return await api.sendMessage(chatId, text, {
          parse_mode: parseMode, reply_markup: keyboard,
        });
      }
    } catch (err: any) {
      if (parseMode === 'MarkdownV2' && err?.description?.includes("can't parse entities")) {
        log.warn('MarkdownV2 parse failed, retrying plain text');
        continue;
      }
      throw err;
    }
  }
  throw new Error('sendApprovalCard: all attempts failed');
}

export async function runApprovalFlow(
  bot: Bot,
  date: string,
  singleCategory?: Category,
  challengeContext?: { challengeId: number; dayNumber: number },
  customKeywords?: { stretching?: string; strength?: string; mobility?: string },
  correlationId?: string,
): Promise<void> {
  const cid = correlationId ?? generateCorrelationId();
  const flowLog = log.withCorrelation(cid);
  const config = getConfig();
  const categories: Category[] = singleCategory ? [singleCategory] : [...CATEGORIES];

  const challengeLabel = challengeContext
    ? ` (Челлендж, день ${challengeContext.dayNumber})`
    : '';

  flowLog.info('starting approval flow', { date, categories: categories.length, challenge: !!challengeContext });

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `🔍 Ищу видео${challengeLabel}...`,
  );

  // Search: single category or all
  let allVideos: Awaited<ReturnType<typeof searchAllCategories>>;
  try {
    if (singleCategory) {
      const videos = await searchVideos(singleCategory, undefined, undefined, cid);
      allVideos = { [singleCategory]: videos } as any;
    } else {
      allVideos = await searchAllCategories(customKeywords, cid);
    }
  } catch (err) {
    flowLog.error('search failed', { error: String(err) });
    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `❌ Ошибка поиска видео: ${String(err)}`
    );
    return;
  }

  let totalFound = 0;

  for (const category of categories) {
    const videos = allVideos[category];

    if (!videos || videos.length === 0) {
      const retryKb = new InlineKeyboard()
        .text('🔄 Повторить', `retry_search:${date}:${category}`)
        .text('📅 Назад к неделе', 'show_week_status');
      await bot.api.sendMessage(
        config.TELEGRAM_ADMIN_USER_ID,
        `⚠️ Не нашёл видео для ${CATEGORY_RU[category] ?? category}${challengeLabel}.\nНет результатов по запросу.`,
        { reply_markup: retryKb }
      );
      continue;
    }

    const v = videos[0];
    const videoId = upsertVideo(v);
    const sessionId = createApprovalSession(date, category, videoId);

    // Store challenge context in session metadata for use on approve callback
    if (challengeContext) {
      storeChallengeContext(sessionId, challengeContext.challengeId, challengeContext.dayNumber);
    }

    const text = await formatApprovalMessage(v, category);
    const keyboard = new InlineKeyboard()
      .text('✅ Выбрать', `approve:${sessionId}`)
      .text('🔄 Другое', `refresh:${sessionId}`);

    try {
      const msg = await sendApprovalCard(bot.api, config.TELEGRAM_ADMIN_USER_ID, v.thumbnail_url, text, keyboard);
      setApprovalMessageId(sessionId, msg.message_id);
      totalFound++;
    } catch (err) {
      flowLog.error(`failed to send for ${category}`, { error: String(err) });
    }

    await new Promise(r => setTimeout(r, APPROVAL_SEND_DELAY_MS));
  }

  if (singleCategory) {
    // Single category mode — no summary needed, approval card is the UI
    return;
  }

  const total = categories.length;
  const failed = total - totalFound;
  const summary = totalFound === total
    ? `Нашёл по одному видео на каждую категорию (${totalFound}/${total}).`
    : `Нашёл ${totalFound} из ${total} категорий.${failed > 0 ? ` ${failed} не удалось отправить — проверь логи.` : ''}`;

  const summaryKb = new InlineKeyboard()
    .text('Опубликовать', 'btn_publish')
    .text('Сбросить выбор', 'btn_reset');

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `${summary} Выбери или нажми Другое.`,
    { reply_markup: summaryKb },
  );
}

async function editKeyboard(
  ctx: { editMessageReplyMarkup: Function; editMessageCaption: Function; callbackQuery: { message?: { caption?: string } } },
  keyboard: InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
  } catch {
    // Photo messages may require editMessageCaption to update the keyboard
    try {
      const caption = ctx.callbackQuery.message?.caption ?? '';
      await ctx.editMessageCaption({ caption, parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch { /* ignore */ }
  }
}

export function registerApprovalCallbacks(bot: Bot): void {
  bot.callbackQuery(/^approve:(\d+)$/, async (ctx) => {
    const sessionIdFromCallback = parseInt(ctx.match[1]);

    // Primary: lookup by message_id. Fallback: by session ID from callback data
    let session = getApprovalSessionByMessageId(ctx.callbackQuery.message?.message_id ?? -1);
    if (!session) {
      session = getApprovalSessionById(sessionIdFromCallback);
    }
    if (!session) {
      await ctx.answerCallbackQuery('Сессия не найдена');
      return;
    }

    setApprovalStatus(session.id, 'approved');

    // If this approval is for a challenge slot, fill the queue
    if (session.video_id) {
      const cctx = getChallengeContext(session.id);
      if (cctx) {
        // Check if challengeId refers to a challenge_series or weekly challenge
        const series = getChallengeSeries(cctx.challengeId);
        if (series) {
          setChallengeSeriesDayVideo(cctx.challengeId, cctx.dayNumber, session.video_id);
        } else {
          setWeekSlotVideo(cctx.challengeId, cctx.dayNumber, session.video_id);
        }
        clearChallengeContext(session.id);
      }
    }

    const newKeyboard = new InlineKeyboard()
      .text('✅ Выбрано', 'noop').text('↩️ Отменить', `unapprove:${session.id}`)
      .row()
      .text('📢 Опубликовать', `publish_card:${session.id}`);

    await editKeyboard(ctx as any, newKeyboard);
    await ctx.answerCallbackQuery('Выбрано!');
  });

  bot.callbackQuery(/^unapprove:(\d+)$/, async (ctx) => {
    const sessionId = parseInt(ctx.match[1]);
    setApprovalStatus(sessionId, 'pending');

    const keyboard = new InlineKeyboard()
      .text('✅ Выбрать', `approve:${sessionId}`)
      .text('🔄 Другое', `refresh:${sessionId}`);

    await editKeyboard(ctx as any, keyboard);
    await ctx.answerCallbackQuery('Возвращено в пул');
  });

  bot.callbackQuery(/^refresh:(\d+)$/, async (ctx) => {
    const sessionId = parseInt(ctx.match[1]);
    const config = getConfig();

    let session = getApprovalSessionById(sessionId);

    // Fallback: if session was already soft-deleted (e.g. double-click),
    // find the current active session for this message
    if (!session) {
      const msgId = ctx.callbackQuery.message?.message_id ?? -1;
      const byMsg = getApprovalSessionByMessageId(msgId);
      if (byMsg) {
        session = byMsg;
      } else {
        await ctx.answerCallbackQuery('Сессия не найдена');
        return;
      }
    }

    await ctx.answerCallbackQuery('Ищу другое...');

    const refreshLog = log.withCorrelation();
    refreshLog.info('refresh requested', { category: session.category, sessionId });

    // Record rejection: blocklist the old video so it won't appear again
    try {
      const oldVideo = getDb().prepare(
        `SELECT v.youtube_id FROM approval_sessions a JOIN videos v ON v.id = a.video_id WHERE a.id = ?`
      ).get(sessionId) as { youtube_id: string } | undefined;
      if (oldVideo) {
        recordRejection(oldVideo.youtube_id, session.category);
        refreshLog.info('recorded rejection', { youtubeId: oldVideo.youtube_id, category: session.category });
      }
    } catch (err) {
      refreshLog.warn('failed to record rejection', { error: String(err) });
    }

    let videos: ScoredVideo[];
    try {
      videos = await searchVideos(session.category as Category, 1, undefined, refreshLog.correlationId);
    } catch (err) {
      refreshLog.error('refresh search failed', { error: String(err) });
      await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, `❌ Ошибка поиска замены для ${escV2(session.category)}: ${escV2(String(err))}`, { parse_mode: 'MarkdownV2' });
      return;
    }

    if (videos.length === 0) {
      await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, `⚠️ Не нашёл другого видео для *${session.category}*`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const v = videos[0];
    const videoId = upsertVideo(v);
    // Soft-delete the old pending session before creating replacement
    softDeletePendingSessions(session.date, session.category);
    const newSessionId = createApprovalSession(session.date, session.category as Category, videoId);
    const text = await formatApprovalMessage(v, session.category as Category);
    const keyboard = new InlineKeyboard()
      .text('✅ Выбрать', `approve:${newSessionId}`)
      .text('🔄 Другое', `refresh:${newSessionId}`);

    // Edit existing message instead of sending a new one
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId) {
      try {
        if (v.thumbnail_url) {
          await ctx.api.editMessageMedia(config.TELEGRAM_ADMIN_USER_ID, messageId, {
            type: 'photo',
            media: v.thumbnail_url,
            caption: text,
            parse_mode: 'MarkdownV2',
          }, { reply_markup: keyboard });
        } else {
          await ctx.api.editMessageText(config.TELEGRAM_ADMIN_USER_ID, messageId, text, {
            parse_mode: 'MarkdownV2',
            reply_markup: keyboard,
          });
        }
        setApprovalMessageId(newSessionId, messageId);
      } catch (err) {
        // Fallback: send new message if edit fails (e.g. switching photo<->text)
        refreshLog.warn('edit failed, sending new message', { error: String(err) });
        try {
          const msg = await sendApprovalCard(ctx.api, config.TELEGRAM_ADMIN_USER_ID, v.thumbnail_url, text, keyboard);
          setApprovalMessageId(newSessionId, msg.message_id);
        } catch (err2) {
          refreshLog.error('refresh send failed', { error: String(err2) });
        }
      }
    } else {
      try {
        const msg = await sendApprovalCard(ctx.api, config.TELEGRAM_ADMIN_USER_ID, v.thumbnail_url, text, keyboard);
        setApprovalMessageId(newSessionId, msg.message_id);
      } catch (err) {
        refreshLog.error('refresh send failed', { error: String(err) });
      }
    }
  });

  // Publish single video directly from approval card
  bot.callbackQuery(/^publish_card:(\d+)$/, async (ctx) => {
    const sessionId = parseInt(ctx.match[1]);
    const config = getConfig();
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;

    const session = getApprovalSessionById(sessionId);
    if (!session || session.status !== 'approved') {
      await ctx.answerCallbackQuery('Сессия не найдена или не одобрена');
      return;
    }

    await ctx.answerCallbackQuery('Публикую...');

    const { postVideoToChannel } = await import('./poster');
    const result = await postVideoToChannel(bot, session.date, session.category as Category, { force: true });

    const label = `${CATEGORY_EMOJI[session.category as Category] ?? ''} ${CATEGORY_RU[session.category as Category] ?? session.category}`;
    if (result === 'posted') {
      const doneKeyboard = new InlineKeyboard().text('✅ Опубликовано', 'noop');
      await editKeyboard(ctx as any, doneKeyboard);
    } else {
      try {
        await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, `❌ ${label}: не удалось опубликовать (${result})`);
      } catch {}
    }
  });

  // Retry search for a specific category
  bot.callbackQuery(/^retry_search:(.+):(.+)$/, async (ctx) => {
    const date = ctx.match[1];
    const category = ctx.match[2] as Category;
    const config = getConfig();
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    await ctx.answerCallbackQuery('Ищу...');
    try { await ctx.editMessageText(`🔍 Повторный поиск для ${CATEGORY_RU[category] ?? category}...`); } catch {}
    await runApprovalFlow(bot, date, category);
  });

  // Show week status
  bot.callbackQuery('show_week_status', async (ctx) => {
    const config = getConfig();
    if (ctx.from?.id !== config.TELEGRAM_ADMIN_USER_ID) return;
    await ctx.answerCallbackQuery();
    const { todayMsk } = await import('./dates');
    const { getActiveChallenge, getChallengeDay, getChallengeWeekNumber, getWeekStatus } = await import('./db');
    const { DAY_CATEGORY_MAP } = await import('./shared');
    const challenge = getActiveChallenge();
    if (!challenge) {
      try { await ctx.editMessageText('Нет активного челленджа.'); } catch {}
      return;
    }
    const today = todayMsk();
    const dayNum = getChallengeDay(challenge.start_date, today);
    const weekNum = getChallengeWeekNumber(dayNum);
    const slots = getWeekStatus(challenge.id, weekNum);
    const lines = slots.map(s => {
      const dow = ((s.day_number - 1) % 7 + 1) % 7; // day_number to JS day of week
      const cat = DAY_CATEGORY_MAP[dow];
      const catLabel = cat ? `${CATEGORY_EMOJI[cat] ?? ''} ${CATEGORY_RU[cat] ?? cat}` : `День ${s.day_number}`;
      const emoji = s.status === 'posted' ? '✅' : s.status === 'queued' ? '📋' : '⬜';
      return `${emoji} ${catLabel}${(s as any).title ? ` — ${(s as any).title}` : ''}`;
    });
    try { await ctx.editMessageText(`Челлендж ${challenge.number}, Неделя ${weekNum}:\n\n${lines.join('\n')}`); } catch {}
  });

  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
