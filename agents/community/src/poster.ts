import { Bot, InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy';
import { getConfig } from './config';
import {
  getApprovedVideo, recordPost, wasPostedToday,
  getCheckinStats, recordCheckinPost, VideoRow,
  updateVideoRating,
} from './db';
import { downloadVideo, isYtDlpAvailable } from './downloader';
import { detectEquipment } from './youtube';
import { rewriteTitle, formatChannelName } from './translate';

const CATEGORY_RU: Record<string, string> = {
  stretching: 'стретчинг',
  strength: 'сила',
  mobility: 'мобильность',
};

const DIFFICULTY_RU: Record<string, string> = {
  beginner: 'начинающий',
  intermediate: 'средний',
  advanced: 'продвинутый',
};

function formatRating(rating: number): string {
  if (rating <= 0) return '';
  return `${rating.toFixed(1)}`;
}

async function formatCaption(video: VideoRow): Promise<string> {
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
  const equipmentTag = equipment.length > 0 ? equipment.join(', ') : 'без инвентаря';

  const title = await rewriteTitle(video.title);
  const channelName = await formatChannelName(video.channel_name);

  const rating = updateVideoRating(video.id);
  const ratingStr = formatRating(rating);

  const tagParts = [
    `🏷 ${categoryRu}`,
    `⏱ ${video.duration_label ?? '?'}`,
    `💪 ${muscles}`,
    `📊 ${difficultyRu}`,
    `🎒 ${equipmentTag}`,
  ];

  const lines = [
    `*${title}*`,
    '',
    `\`${tagParts.join('  ')}\``,
    ...(ratingStr ? [`★ ${ratingStr}`] : []),
    '',
    `${channelName} · [оригинал](${video.video_url})`,
  ];

  return lines.join('\n');
}

async function formatLinkPost(video: VideoRow): Promise<string> {
  return await formatCaption(video);
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

  const keyboard = new InlineKeyboard()
    .text('Я сделал(а)', `done:${video.id}`);

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
            duration: download.meta.duration ?? video.duration_seconds ?? undefined,
            width: download.meta.width ?? undefined,
            height: download.meta.height ?? undefined,
            reply_markup: keyboard,
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
      {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      }
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
    '*Чекин дня*',
    '',
    'Как прошёл твой день движения?',
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('Сделал(а)', `checkin:did:${date}`)
    .text('Частично', `checkin:partial:${date}`)
    .text('Пропустил(а)', `checkin:didnt:${date}`);

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
    `*Результаты дня ${date}*`,
    '',
    `Сделал(а): ${stats.did}`,
    `Частично: ${stats.partial}`,
    `Пропустил(а): ${stats.didnt}`,
    '',
    `Всего: ${total} · Активность: ${Math.round((stats.did / total) * 100)}%`,
  ].join('\n');

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHANNEL_ID, summary, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`[poster] failed to post checkin results:`, err);
  }
}
