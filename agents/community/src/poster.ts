import { Bot, InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy';
import { getConfig } from './config';
import {
  getApprovedVideo, recordPost, wasPostedToday, VideoRow,
  updateVideoRating, markApprovalPosted, withTransaction,
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

  const tagLines = [
    `\`🏷 ${categoryRu}\``,
    `\`⏱ ${video.duration_label ?? '?'}\``,
    `\`💪 ${muscles}\``,
    `\`📊 ${difficultyRu}\``,
    `\`🎒 ${equipmentTag}\``,
  ];

  const lines = [
    `*${title}*`,
    '',
    ...tagLines,
    ...(ratingStr ? [`★ ${ratingStr}`] : []),
    '',
    `Автор: [${channelName}](${video.video_url})`,
  ];

  return lines.join('\n');
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
    .text('Я сделаль', `done:${video.id}`);

  // Try to download and post as video file
  if (isYtDlpAvailable()) {
    let videoSent = false;
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
        videoSent = true;
        download.cleanup();

        // Record in DB — separate try so DB failure doesn't trigger text fallback
        try {
          withTransaction(() => {
            recordPost(date, category, video.id, msg.message_id, 'video');
            markApprovalPosted(date, category);
          });
        } catch (dbErr) {
          console.error(`[poster] DB WRITE FAILED for ${category} (video already sent, msgId=${msg.message_id}):`, dbErr);
        }

        console.log(`[poster] posted ${category} as VIDEO file, msgId=${msg.message_id}`);
        return 'posted';
      } catch (uploadErr) {
        download.cleanup();
        if (videoSent) {
          console.error(`[poster] POST-UPLOAD ERROR for ${category} (video already sent):`, uploadErr);
          return 'posted';
        }
        console.error(`[poster] VIDEO UPLOAD FAILED for ${category} (${video.youtube_id}):`, uploadErr);
        // Fall through to link fallback
      }
    } catch (downloadErr) {
      console.error(`[poster] DOWNLOAD FAILED for ${category} (${video.youtube_id}):`, downloadErr);
      // Fall through to link fallback
    }
  } else {
    console.warn(`[poster] yt-dlp not available, falling back to link for ${category}`);
  }

  // Fallback: post as text + YouTube link
  try {
    console.warn(`[poster] FALLBACK: posting ${category} as TEXT LINK (video upload failed)`);
    const msg = await bot.api.sendMessage(
      config.TELEGRAM_CHANNEL_ID,
      await formatCaption(video),
      {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      }
    );

    // Atomic: record as link post + mark approval
    withTransaction(() => {
      recordPost(date, category, video.id, msg.message_id, 'link');
      markApprovalPosted(date, category);
    });

    console.warn(`[poster] posted ${category} as LINK (degraded), msgId=${msg.message_id}`);
    return 'posted';
  } catch (err) {
    console.error(`[poster] COMPLETE FAILURE for ${category} on ${date}:`, err);
    return 'error';
  }
}
