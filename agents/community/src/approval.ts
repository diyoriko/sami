import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import {
  upsertVideo,
  createApprovalSession,
  setApprovalMessageId,
  getApprovalSessionByMessageId,
  setApprovalStatus,
  VideoRow,
} from './db';
import { searchAllCategories, Category } from './youtube';

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

function formatApprovalMessage(
  video: Omit<VideoRow, 'id'>,
  index: number,
  total: number,
  category: Category
): string {
  const emoji = CATEGORY_EMOJI[category];
  let muscles = '';
  try {
    const arr = JSON.parse(video.muscles ?? '[]') as string[];
    muscles = arr.join(', ');
  } catch {
    muscles = video.muscles ?? '';
  }

  return [
    `${emoji} *Вариант ${index}/${total} — ${category}*`,
    '',
    `*${video.title}*`,
    `👤 ${video.channel_name}`,
    `▶️ ${video.video_url}`,
    '',
    `⏱ ${video.duration_label ?? '?'}  📊 ${DIFFICULTY_RU[video.difficulty] ?? video.difficulty}`,
    `💪 ${muscles}`,
  ].join('\n');
}

export async function runApprovalFlow(bot: Bot, date: string, customKeywords?: {
  stretching?: string;
  strength?: string;
  mobility?: string;
}): Promise<void> {
  const config = getConfig();
  const categories: Category[] = ['stretching', 'strength', 'mobility'];

  console.log('[approval] starting video search...');

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `🔍 Ищу видео на ${date}...`,
    { parse_mode: 'Markdown' }
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
        `⚠️ Не нашёл видео для *${category}* на ${date}. Попробуй выбрать вручную.`,
        { parse_mode: 'Markdown' }
      );
      continue;
    }

    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `\n━━━━━━━━━━━━━━━\n${CATEGORY_EMOJI[category]} *${category.toUpperCase()}* — выбери одно видео:`,
      { parse_mode: 'Markdown' }
    );

    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      const videoId = upsertVideo(v);
      const sessionId = createApprovalSession(date, category, videoId);

      const text = formatApprovalMessage(v, i + 1, videos.length, category);
      const keyboard = new InlineKeyboard()
        .text('✅ Выбрать это', `approve:${sessionId}`)
        .text('❌ Пропустить', `reject:${sessionId}`);

      try {
        const msg = await bot.api.sendMessage(
          config.TELEGRAM_ADMIN_USER_ID,
          text,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        setApprovalMessageId(sessionId, msg.message_id);
        totalFound++;
      } catch (err) {
        console.error(`[approval] failed to send approval message for ${category}:`, err);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  }

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `\n━━━━━━━━━━━━━━━\n✅ Готово! ${totalFound} вариантов отправлено. Выбери по одному на каждую категорию.\n\n⏰ Посты выйдут: 08:00 (стретчинг), 12:00 (силовая), 17:00 (мобильность).`,
    { parse_mode: 'Markdown' }
  );
}

export function registerApprovalCallbacks(bot: Bot): void {
  bot.callbackQuery(/^(approve|reject):(\d+)$/, async (ctx) => {
    const action = ctx.match[1] as 'approve' | 'reject';
    const sessionId = parseInt(ctx.match[2]);

    const session = getApprovalSessionByMessageId(ctx.callbackQuery.message?.message_id ?? -1);
    if (!session) {
      await ctx.answerCallbackQuery('Сессия не найдена');
      return;
    }

    setApprovalStatus(session.id, action === 'approve' ? 'approved' : 'rejected');

    const statusText = action === 'approve' ? '✅ Выбрано' : '❌ Пропущено';
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(statusText, 'noop') });
    await ctx.answerCallbackQuery(action === 'approve' ? 'Видео выбрано!' : 'Пропущено');
  });

  // No-op callback for already-decided buttons
  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
