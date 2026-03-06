import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { getApprovedVideo, recordPost, wasPostedToday, getCheckinStats, recordCheckinPost, VideoRow } from './db';

const CATEGORY_EMOJI: Record<string, string> = {
  stretching: '🧘',
  strength: '💪',
  mobility: '🔄',
};

const CATEGORY_RU: Record<string, string> = {
  stretching: 'Стретчинг дня',
  strength: 'Силовая дня',
  mobility: 'Мобильность дня',
};

const DIFFICULTY_RU: Record<string, string> = {
  beginner: 'Начинающий',
  intermediate: 'Средний',
  advanced: 'Продвинутый',
};

function formatVideoPost(video: VideoRow): string {
  const emoji = CATEGORY_EMOJI[video.category] ?? '🏋️';
  const categoryRu = CATEGORY_RU[video.category] ?? video.category;
  const difficultyRu = DIFFICULTY_RU[video.difficulty] ?? video.difficulty;

  let muscles = '';
  try {
    const arr = JSON.parse(video.muscles ?? '[]') as string[];
    muscles = arr.join(', ');
  } catch {
    muscles = video.muscles ?? '';
  }

  return [
    `${emoji} *${categoryRu}*`,
    '',
    `*${video.title}*`,
    '',
    `▶️ [Смотреть на YouTube](${video.video_url})`,
    '',
    `💪 Мышцы: ${muscles}`,
    `⏱ Длительность: ${video.duration_label ?? '?'}`,
    `📊 Уровень: ${difficultyRu}`,
    `👤 Автор: [${video.channel_name}](${video.channel_url ?? video.video_url})`,
    '',
    `#${video.category} #sami #ежедневнаяпрактика`,
  ].join('\n');
}

export async function postVideoToChannel(
  bot: Bot,
  date: string,
  category: 'stretching' | 'strength' | 'mobility'
): Promise<void> {
  const config = getConfig();

  if (wasPostedToday(date, category)) {
    console.log(`[poster] ${category} already posted today (${date}), skipping`);
    return;
  }

  const video = getApprovedVideo(date, category);
  if (!video) {
    console.warn(`[poster] no approved video for ${category} on ${date}`);
    // Notify admin
    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `⚠️ Нет одобренного видео для *${category}* на ${date}. Пост пропущен.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const text = formatVideoPost(video);

  try {
    const msg = await bot.api.sendMessage(config.TELEGRAM_CHANNEL_ID, text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: false },
    });
    recordPost(date, category, video.id, msg.message_id);
    console.log(`[poster] posted ${category} (videoId=${video.id}) to channel, msgId=${msg.message_id}`);
  } catch (err) {
    console.error(`[poster] failed to post ${category}:`, err);
    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `❌ Ошибка публикации *${category}*: ${String(err)}`,
      { parse_mode: 'Markdown' }
    );
  }
}

export async function postCheckin(bot: Bot, date: string): Promise<void> {
  const config = getConfig();

  const text = [
    '📋 *Чекин дня*',
    '',
    'Как прошёл твой день движения?',
    'Нажми кнопку ниже 👇',
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('✅ Сделал(а)', `checkin:did:${date}`)
    .text('😅 Частично', `checkin:partial:${date}`)
    .text('❌ Не получилось', `checkin:didnt:${date}`);

  try {
    const msg = await bot.api.sendMessage(config.TELEGRAM_CHANNEL_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    recordCheckinPost(date, msg.message_id);
    console.log(`[poster] check-in posted for ${date}, msgId=${msg.message_id}`);
  } catch (err) {
    console.error(`[poster] failed to post checkin:`, err);
  }
}

export async function updateCheckinResults(bot: Bot, date: string): Promise<void> {
  const config = getConfig();
  const stats = getCheckinStats(date);
  const total = stats.did + stats.partial + stats.didnt;
  if (total === 0) return;

  // Find the checkin message to edit (optional, not critical)
  const summary = [
    `📊 *Результаты дня ${date}*`,
    '',
    `✅ Сделал(а): ${stats.did}`,
    `😅 Частично: ${stats.partial}`,
    `❌ Не получилось: ${stats.didnt}`,
    '',
    `👥 Всего ответили: ${total}`,
    `🔥 Активность: ${Math.round((stats.did / total) * 100)}%`,
  ].join('\n');

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHANNEL_ID, summary, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`[poster] failed to post checkin results:`, err);
  }
}
