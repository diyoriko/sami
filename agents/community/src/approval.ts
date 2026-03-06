import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import {
  upsertVideo,
  createApprovalSession,
  setApprovalMessageId,
  getApprovalSessionByMessageId,
  setApprovalStatus,
} from './db';
import { searchAllCategories, Category, ScoredVideo } from './youtube';

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

function formatApprovalMessage(video: ScoredVideo, index: number, total: number, category: Category): string {
  const emoji = CATEGORY_EMOJI[category];
  let muscles = '';
  try {
    const arr = JSON.parse(video.muscles ?? '[]') as string[];
    muscles = arr.join(', ');
  } catch {
    muscles = video.muscles ?? '';
  }

  return [
    `${emoji} *${index}/${total} — ${category.toUpperCase()}*`,
    '',
    `*${video.title}*`,
    `👤 ${video.channel_name}`,
    `▶️ ${video.video_url}`,
    '',
    `⏱ ${video.duration_label}  •  📊 ${DIFFICULTY_RU[video.difficulty] ?? video.difficulty}`,
    `💪 ${muscles}`,
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

    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `\n━━━━━━━━━━━━━━━\n${CATEGORY_EMOJI[category]} *${category.toUpperCase()}* — выбери одно:`,
      { parse_mode: 'Markdown' }
    );

    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      const videoId = upsertVideo(v);
      const sessionId = createApprovalSession(date, category, videoId);
      const text = formatApprovalMessage(v, i + 1, videos.length, category);
      const keyboard = new InlineKeyboard()
        .text('✅ Выбрать', `approve:${sessionId}`)
        .text('❌ Пропустить', `reject:${sessionId}`);

      try {
        // Show thumbnail if available for a richer preview
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
  }

  await bot.api.sendMessage(
    config.TELEGRAM_ADMIN_USER_ID,
    `\n━━━━━━━━━━━━━━━\n✅ ${totalFound} вариантов. Выбери по одному на каждую категорию.\n\n⏰ Посты: 08:00 стретч • 12:00 сила • 17:00 мобильность`
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
      .text('❌ Пропустить', `reject:${sessionId}`);

    await editKeyboard(ctx as any, keyboard);
    await ctx.answerCallbackQuery('Возвращено в пул');
  });

  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
