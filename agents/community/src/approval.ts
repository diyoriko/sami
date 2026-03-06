import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import {
  upsertVideo,
  createApprovalSession,
  setApprovalMessageId,
  getApprovalSessionByMessageId,
  getApprovalSessionById,
  setApprovalStatus,
} from './db';
import { searchAllCategories, searchVideos, detectEquipment, Category, ScoredVideo } from './youtube';

const CATEGORY_EMOJI: Record<Category, string> = {
  stretching: '🧘',
  strength: '💪',
  mobility: '🔄',
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

function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${score}`;
}

function formatApprovalMessage(video: ScoredVideo, category: Category): string {
  const emoji = CATEGORY_EMOJI[category];
  let muscles = '';
  try {
    const arr = JSON.parse(video.muscles ?? '[]') as string[];
    muscles = arr.join(', ');
  } catch {
    muscles = video.muscles ?? '';
  }

  const equipmentLine = video.equipment.length > 0
    ? `⚠️ Нужна экипировка: ${video.equipment.join(', ')}`
    : `🧘 Только коврик`;

  return [
    `${emoji} *${category.toUpperCase()}*`,
    '',
    `*${video.title}*`,
    `👤 ${video.channel_name}`,
    `▶️ ${video.video_url}`,
    '',
    `⏱ ${video.duration_label}  •  📊 ${DIFFICULTY_RU[video.difficulty] ?? video.difficulty}`,
    `💪 ${muscles}`,
    equipmentLine,
    `👁 ${formatViews(video.view_count)} просмотров`,
    '',
    `Рейтинг: \`${scoreBar(video.total_score)}\``,
    `_(бренд: ${video.brand_score} • аудитория: ${Math.round(video.view_count / 1000)}K)_`,
  ].join('\n');
}

export async function runApprovalFlow(
  bot: Bot,
  date: string,
  customKeywords?: { stretching?: string; strength?: string; mobility?: string }
): Promise<void> {
  const config = getConfig();
  const categories: Category[] = ['stretching', 'strength', 'mobility'];

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `🔍 Ищу видео на ${date}...`,
  );

  let allVideos: Awaited<ReturnType<typeof searchAllCategories>>;
  try {
    allVideos = await searchAllCategories(customKeywords);
  } catch (err) {
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
    const text = formatApprovalMessage(v, category);
    const keyboard = new InlineKeyboard()
      .text('✅ Выбрать', `approve:${sessionId}`)
      .text('🔄 Другое', `refresh:${sessionId}`);

    try {
      let msg;
      if (v.thumbnail_url) {
        msg = await bot.api.sendPhoto(
          config.TELEGRAM_ADMIN_USER_ID,
          v.thumbnail_url,
          { caption: text, parse_mode: 'Markdown', reply_markup: keyboard }
        );
      } else {
        msg = await bot.api.sendMessage(
          config.TELEGRAM_ADMIN_USER_ID,
          text,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }
      setApprovalMessageId(sessionId, msg.message_id);
      totalFound++;
    } catch (err) {
      console.error(`[approval] failed to send for ${category}:`, err);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  if (totalFound > 0) {
    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `✅ Нашёл по одному видео на каждую категорию. Выбери или нажми 🔄 Другое.\n\n⏰ Посты: 08:00 стретч • 08:05 сила • 08:10 мобильность`
    );
  }
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

    let videos: ScoredVideo[];
    try {
      videos = await searchVideos(session.category as Category, 1);
    } catch (err) {
      await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, `❌ Ошибка поиска замены для ${session.category}: ${String(err)}`);
      return;
    }

    if (videos.length === 0) {
      await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, `⚠️ Не нашёл другого видео для *${session.category}*`, { parse_mode: 'Markdown' });
      return;
    }

    const v = videos[0];
    const videoId = upsertVideo(v);
    const newSessionId = createApprovalSession(session.date, session.category as Category, videoId);
    const text = formatApprovalMessage(v, session.category as Category);
    const keyboard = new InlineKeyboard()
      .text('✅ Выбрать', `approve:${newSessionId}`)
      .text('🔄 Другое', `refresh:${newSessionId}`);

    try {
      let msg;
      if (v.thumbnail_url) {
        msg = await ctx.api.sendPhoto(config.TELEGRAM_ADMIN_USER_ID, v.thumbnail_url, {
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
      } else {
        msg = await ctx.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
      }
      setApprovalMessageId(newSessionId, msg.message_id);
    } catch (err) {
      console.error('[approval] refresh send failed:', err);
    }
  });

  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
