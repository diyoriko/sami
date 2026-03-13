import { Bot } from 'grammy';
import { InputFile } from 'grammy';
import { getConfig } from './config';
import {
  getApprovedVideo, recordPost, wasPostedToday, VideoRow,
  updateVideoRating, markApprovalPosted, withTransaction,
  getSeasonQueueForDay, markSeasonQueuePosted, getVideoById,
  type SeasonRow,
} from './db';
import { downloadVideo, isYtDlpAvailable } from './downloader';
import { detectEquipment } from './youtube';
import { rewriteTitle, formatChannelName } from './translate';
import { createLogger, type Logger } from './logger';
import {
  type Category, type Difficulty,
  CATEGORY_RU, DIFFICULTY_RU, CATEGORY_EMOJI, EQUIPMENT_NO_GEAR,
  escV2, seasonHeader, buildSeasonHashtags,
} from './shared';

const log = createLogger('poster');

function formatRating(rating: number): string {
  if (rating <= 0) return '';
  return `${rating.toFixed(1)}`;
}

export interface SeasonInfo {
  seasonNumber: number;
  seasonDay: number;
  category: Category;
}

async function formatCaption(video: VideoRow, seasonInfo?: SeasonInfo): Promise<string> {
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
  const equipmentTag = equipment.length > 0 ? equipment.join(', ') : EQUIPMENT_NO_GEAR;

  const title = await rewriteTitle(video.title);
  const channelName = await formatChannelName(video.channel_name);

  const rating = updateVideoRating(video.id);
  const ratingStr = formatRating(rating);

  const catEmoji = CATEGORY_EMOJI[video.category] ?? '🏷';

  const tagLines = [
    `\`${catEmoji} ${categoryRu}\``,
    `\`⏱️ ${video.duration_label ?? '?'}\``,
    `\`🦴 ${muscles}\``,
    `\`💎 ${difficultyRu}\``,
    `\`🎾 ${equipmentTag}\``,
  ];

  // URL: escape only ) and \ which break MarkdownV2 link syntax
  const safeUrl = video.video_url.replace(/[)\\]/g, '\\$&');

  // Season header: «Сезон 1, День 3 — 🤸 Мобильность»
  const header = seasonInfo
    ? `*${escV2(seasonHeader(seasonInfo.seasonNumber, seasonInfo.seasonDay, seasonInfo.category))}*`
    : null;

  // Hashtags at the bottom
  const hashtags = seasonInfo
    ? buildSeasonHashtags({
        category: video.category as Category,
        difficulty: video.difficulty as Difficulty | undefined,
        muscles,
        seasonNumber: seasonInfo.seasonNumber,
        seasonDay: seasonInfo.seasonDay,
      })
    : '';

  const lines = [
    ...(header ? [header, ''] : []),
    `*${title}*`,
    '',
    ...tagLines,
    ...(ratingStr ? [`\`⭐ ${ratingStr} из 10\``] : []),
    ...(hashtags ? ['', escV2(hashtags)] : []),
    '',
    `Автор: ${channelName}, 📎 [YouTube](${safeUrl})`,
  ];

  return lines.join('\n');
}

export type PostResult = 'posted' | 'skipped' | 'no_video' | 'error';

export async function postVideoToChannel(
  bot: Bot,
  date: string,
  category: Category,
  options?: { force?: boolean; correlationId?: string; seasonInfo?: SeasonInfo }
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

  const caption = await formatCaption(video, options?.seasonInfo);

  // No inline keyboard on channel posts — Telegram hides "Comments" button when reply_markup is present.
  // Bot posts "Я сделаль" button as a comment in the discussion group instead (see moderation.ts).

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
              parse_mode: 'MarkdownV2',
              supports_streaming: true,
              duration: download.meta.duration ?? video.duration_seconds ?? undefined,
              width: download.meta.width ?? undefined,
              height: download.meta.height ?? undefined,
              thumbnail: video.thumbnail_url ? new InputFile(new URL(video.thumbnail_url)) : undefined,
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
      await formatCaption(video, options?.seasonInfo),
      {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
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

// ─── SEASON AUTO-PUBLISH ────────────────────────────────────────────────────

import { SEASON_DAY_MAP } from './shared';
import { todayMsk } from './dates';

/**
 * Post the season video for a given day. Called by the auto-publish cron.
 * Returns 'posted' | 'no_video' | 'error'.
 */
export async function postSeasonVideo(
  bot: Bot,
  season: SeasonRow,
  dayNumber: number,
): Promise<PostResult> {
  const slot = getSeasonQueueForDay(season.id, dayNumber);
  if (!slot || !slot.video_id || slot.status !== 'queued') {
    log.warn(`no queued video for season ${season.number} day ${dayNumber}`);
    return 'no_video';
  }

  const video = getVideoById(slot.video_id);
  if (!video) {
    log.error(`video ${slot.video_id} not found for season queue`);
    return 'error';
  }

  const date = todayMsk();
  const dayOfWeek = new Date(date + 'T00:00:00').getDay();
  const category = SEASON_DAY_MAP[dayOfWeek] ?? video.category;

  const result = await postVideoToChannel(bot, date, category as Category, {
    force: true,
    seasonInfo: { seasonNumber: season.number, seasonDay: dayNumber, category: category as Category },
  });

  if (result === 'posted') {
    markSeasonQueuePosted(season.id, dayNumber);
    log.info(`season ${season.number} day ${dayNumber} posted`);
  }

  return result;
}
