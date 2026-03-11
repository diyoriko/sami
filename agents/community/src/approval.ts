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
  getDb,
} from './db';
import { searchAllCategories, searchVideos, detectEquipment, Category, ScoredVideo } from './youtube';
import { rewriteTitle, formatChannelName } from './translate';
import { createLogger, generateCorrelationId } from './logger';

const log = createLogger('approval');

const CATEGORY_EMOJI: Record<Category, string> = {
  stretching: '🧘',
  strength: '💪',
  mobility: '🔄',
};

const CATEGORY_RU: Record<Category, string> = {
  stretching: 'Стретчинг',
  strength: 'Силовая',
  mobility: 'Мобильность',
};

const DIFFICULTY_RU: Record<string, string> = {
  beginner: 'Начинающий',
  intermediate: 'Средний',
  advanced: 'Продвинутый',
};

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function escMd(text: string): string {
  return text.replace(/([*_`\[\]()~>#+\-=|{}.!])/g, '\\$1');
}

async function formatApprovalMessage(video: ScoredVideo, category: Category): Promise<string> {
  const emoji = CATEGORY_EMOJI[category];
  const categoryRu = CATEGORY_RU[category];
  let muscles = '';
  try {
    const arr = JSON.parse(video.muscles ?? '[]') as string[];
    muscles = arr.join(', ');
  } catch {
    muscles = video.muscles ?? '';
  }

  const equipmentLine = video.equipment.length > 0
    ? `Нужна экипировка: ${escMd(video.equipment.join(', '))}`
    : `Только коврик`;

  const title = escMd(await rewriteTitle(video.title));
  const channel = escMd(await formatChannelName(video.channel_name));

  return [
    `${emoji} *${categoryRu}*`,
    '',
    `*${title}*`,
    `${channel}`,
    `${video.video_url}`,
    '',
    `${video.duration_label}  •  ${DIFFICULTY_RU[video.difficulty] ?? video.difficulty}`,
    `${escMd(muscles)}`,
    equipmentLine,
    `${formatViews(video.view_count)} просмотров`,
    '',
    `Рейтинг: ${video.total_score}/100 _(бренд: ${video.brand_score})_`,
  ].join('\n');
}

// Send approval card with Markdown fallback to plain text
async function sendApprovalCard(
  api: { sendPhoto: Function; sendMessage: Function },
  chatId: number, thumbnailUrl: string | null, text: string, keyboard: InlineKeyboard
) {
  for (const parseMode of ['Markdown', undefined] as const) {
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
      if (parseMode === 'Markdown' && err?.description?.includes("can't parse entities")) {
        log.warn('Markdown parse failed, retrying plain text');
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
  customKeywords?: { stretching?: string; strength?: string; mobility?: string },
  correlationId?: string,
): Promise<void> {
  const cid = correlationId ?? generateCorrelationId();
  const flowLog = log.withCorrelation(cid);
  const config = getConfig();
  const categories: Category[] = ['stretching', 'strength', 'mobility'];

  flowLog.info('starting approval flow', { date, hasCustomKeywords: !!customKeywords });

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `🔍 Ищу видео на ${date}...`,
  );

  let allVideos: Awaited<ReturnType<typeof searchAllCategories>>;
  try {
    allVideos = await searchAllCategories(customKeywords, cid);
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

    if (videos.length === 0) {
      await bot.api.sendMessage(
        config.TELEGRAM_ADMIN_USER_ID,
        `⚠️ Не нашёл видео для ${category} на ${date}.`
      );
      continue;
    }

    const v = videos[0];
    const videoId = upsertVideo(v);
    const sessionId = createApprovalSession(date, category, videoId);
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

    await new Promise(r => setTimeout(r, 300));
  }

  const total = categories.length;
  const failed = total - totalFound;
  const summary = totalFound === total
    ? `Нашёл по одному видео на каждую категорию (${totalFound}/${total}).`
    : `Нашёл ${totalFound} из ${total} категорий.${failed > 0 ? ` ${failed} не удалось отправить — проверь логи.` : ''}`;

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `${summary} Выбери или нажми Другое.\n\nКогда выберешь — нажми «Опубликовать».`
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
      await ctx.editMessageCaption({ caption, parse_mode: 'Markdown', reply_markup: keyboard });
    } catch { /* ignore */ }
  }
}

export function registerApprovalCallbacks(bot: Bot): void {
  bot.callbackQuery(/^(approve|reject):(\d+)$/, async (ctx) => {
    const action = ctx.match[1] as 'approve' | 'reject';

    const session = getApprovalSessionByMessageId(ctx.callbackQuery.message?.message_id ?? -1);
    if (!session) {
      await ctx.answerCallbackQuery('Сессия не найдена');
      return;
    }

    setApprovalStatus(session.id, action === 'approve' ? 'approved' : 'rejected');

    const newKeyboard = action === 'approve'
      ? new InlineKeyboard().text('✅ Выбрано', 'noop').text('↩️ Отменить', `unapprove:${session.id}`)
      : new InlineKeyboard().text('❌ Пропущено', 'noop').text('↩️ Вернуть', `unapprove:${session.id}`);

    await editKeyboard(ctx as any, newKeyboard);
    await ctx.answerCallbackQuery(action === 'approve' ? 'Выбрано!' : 'Пропущено');
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

    const session = getApprovalSessionById(sessionId);
    if (!session) {
      await ctx.answerCallbackQuery('Сессия не найдена');
      return;
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
      await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, `❌ Ошибка поиска замены для ${session.category}: ${String(err)}`);
      return;
    }

    if (videos.length === 0) {
      await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, `⚠️ Не нашёл другого видео для *${session.category}*`, { parse_mode: 'Markdown' });
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
            parse_mode: 'Markdown',
          }, { reply_markup: keyboard });
        } else {
          await ctx.api.editMessageText(config.TELEGRAM_ADMIN_USER_ID, messageId, text, {
            parse_mode: 'Markdown',
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

  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
