import { Bot, InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy';
import { getConfig } from './config';
import { getApprovedVideo, recordPost, wasPostedToday, getCheckinStats, recordCheckinPost, VideoRow } from './db';
import { downloadVideo, isYtDlpAvailable } from './downloader';
import { detectEquipment } from './youtube';
import { rewriteTitle, formatChannelName } from './translate';

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

async function formatCaption(video: VideoRow): Promise<string> {
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

  const equipment = detectEquipment(video.title, '');
  const equipmentLine = equipment.length > 0
    ? `🎒 Понадобится: ${equipment.join(', ')}`
    : null;

  const title = await rewriteTitle(video.title);
  const channelName = await formatChannelName(video.channel_name);

  return [
    `${emoji} *${categoryRu}*`,
    '',
    `*${title}*`,
    `👤 ${channelName}`,
    '',
    `⏱ ${video.duration_label ?? '?'}  •  📊 ${difficultyRu}`,
    `💪 ${muscles}`,
    ...(equipmentLine ? [equipmentLine] : []),
    '',
    `#${video.category} #sami #ежедневнаяпрактика`,
  ].join('\n');
}

async function formatLinkPost(video: VideoRow): Promise<string> {
  return (await formatCaption(video)) + `\n\n▶️ [Смотреть](${video.video_url})`;
}

export type PostResult = 'posted' | 'skipped' | 'no_video' | 'error';

export async function postVideoToChannel(
  bot: Bot,
  date: string,
  category: 'stretching' | 'strength' | 'mobility',
  options?: { force?: boolean }
): Promise<PostResult> {
  const config = getConfig();
  const force = options?.force ?? false;

  if (!force && wasPostedToday(date, category)) {
    console.log(`[poster] ${category} already posted for ${date}, skipping`);
    return 'skipped';
  }

  const video = getApprovedVideo(date, category);
  if (!video) {
    console.warn(`[poster] no approved video for ${category} on ${date}`);
    return 'no_video';
  }

  const caption = await formatCaption(video);

  // Try to download and post as video file (works without VPN in Russia)
  if (isYtDlpAvailable()) {
    try {
      console.log(`[poster] downloading ${category} video: ${video.video_url}`);
      const download = await downloadVideo(video.video_url, video.youtube_id);

      try {
        const msg = await bot.api.sendVideo(
          config.TELEGRAM_CHANNEL_ID,
          new InputFile(download.filePath),
          {
            caption,
            parse_mode: 'Markdown',
            supports_streaming: true,
            duration: video.duration_seconds ?? undefined,
          }
        );
        download.cleanup();
        recordPost(date, category, video.id, msg.message_id);
        console.log(`[poster] posted ${category} as video file, msgId=${msg.message_id}`);
        return 'posted';
      } catch (uploadErr) {
        download.cleanup();
        console.warn(`[poster] video upload failed, falling back to link:`, uploadErr);
      }
    } catch (downloadErr) {
      console.warn(`[poster] download failed, falling back to link:`, downloadErr);
    }
  }

  // Fallback: post as text + YouTube link
  try {
    const msg = await bot.api.sendMessage(
      config.TELEGRAM_CHANNEL_ID,
      await formatLinkPost(video),
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: false } }
    );
    recordPost(date, category, video.id, msg.message_id);
    console.log(`[poster] posted ${category} as link, msgId=${msg.message_id}`);
    return 'posted';
  } catch (err) {
    console.error(`[poster] failed to post ${category}:`, err);
    return 'error';
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
