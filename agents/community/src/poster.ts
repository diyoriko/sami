import { Bot, InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy';
import { getConfig } from './config';
import {
  getApprovedVideo, recordPost, wasPostedToday, VideoRow,
  updateVideoRating, markApprovalPosted, withTransaction, getCompletionCount,
} from './db';
import { downloadVideo, isYtDlpAvailable } from './downloader';
import { detectEquipment } from './youtube';
import { rewriteTitle, formatChannelName } from './translate';
import { createLogger, type Logger } from './logger';
import { CATEGORY_RU, DIFFICULTY_RU } from './shared';

const log = createLogger('poster');

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
    `Сделали: 0`,
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
  options?: { force?: boolean; correlationId?: string }
): Promise<PostResult> {
  const postLog = options?.correlationId ? log.withCorrelation(options.correlationId) : log;
  const config = getConfig();
  const force = options?.force ?? false;

  if (!force && wasPostedToday(date, category)) {
    postLog.info(`${category} already posted for ${date}, skipping`);
    return 'skipped';
  }

  const video = getApprovedVideo(date, category);
  if (!video) {
    postLog.warn(`no approved video for ${category} on ${date}`);
    return 'no_video';
  }

  const caption = await formatCaption(video);
  const rating = updateVideoRating(video.id);
  const ratingLabel = formatRating(rating);
  const keyboard = new InlineKeyboard()
    .text('Я сделаль', `done:${video.id}`)
    .text('Сохранить', `fav:${video.id}`);
  if (ratingLabel) {
    keyboard.row().text(`★ ${ratingLabel}`, `rating_info`);
  }

  // Try to download and post as video file (with 1 retry)
  const MAX_VIDEO_ATTEMPTS = 2;
  if (isYtDlpAvailable()) {
    for (let attempt = 1; attempt <= MAX_VIDEO_ATTEMPTS; attempt++) {
      let videoSent = false;
      try {
        postLog.info(`downloading ${category} video (attempt ${attempt}/${MAX_VIDEO_ATTEMPTS}): ${video.video_url}`);
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
            postLog.error(`DB WRITE FAILED for ${category} (video already sent)`, { msgId: msg.message_id, error: String(dbErr) });
          }

          postLog.info(`posted ${category} as VIDEO file`, { msgId: msg.message_id });
          return 'posted';
        } catch (uploadErr) {
          download.cleanup();
          if (videoSent) {
            postLog.error(`POST-UPLOAD ERROR for ${category} (video already sent)`, { error: String(uploadErr) });
            return 'posted';
          }
          postLog.error(`VIDEO UPLOAD FAILED for ${category} (attempt ${attempt})`, { youtubeId: video.youtube_id, error: String(uploadErr) });
        }
      } catch (downloadErr) {
        postLog.error(`DOWNLOAD FAILED for ${category} (attempt ${attempt})`, { youtubeId: video.youtube_id, error: String(downloadErr) });
      }

      // Wait before retry
      if (attempt < MAX_VIDEO_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    // All attempts exhausted — fall through to link fallback
  } else {
    postLog.warn(`yt-dlp not available, falling back to link for ${category}`);
  }

  // Fallback: post as text + YouTube link
  try {
    postLog.warn(`FALLBACK: posting ${category} as TEXT LINK (video upload failed)`);
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

    postLog.warn(`posted ${category} as LINK (degraded)`, { msgId: msg.message_id });
    return 'posted';
  } catch (err) {
    postLog.error(`COMPLETE FAILURE for ${category} on ${date}`, { error: String(err) });
    return 'error';
  }
}
