import { Bot } from 'grammy';
import { InputFile } from 'grammy';
import { getConfig } from './config';
import {
  getApprovedVideo, recordPost, wasPostedToday, VideoRow,
  markApprovalPosted, withTransaction, getDb,
  getWeekSlotForDay, markWeekSlotPosted, getVideoById,
  getActiveChallenge, getChallengeDay,
  type ChallengeRow,
} from './db';
import { downloadVideo, isYtDlpAvailable } from './downloader';
import { detectEquipment } from './youtube';
import { rewriteTitle, formatChannelName } from './translate';
import { sendStoryToAdmin, type StoryData } from './story';
import { createLogger, type Logger } from './logger';
import {
  type Category, type Difficulty,
  CATEGORY_RU, DIFFICULTY_RU, CATEGORY_EMOJI, EQUIPMENT_NO_GEAR,
  escV2, parseMuscles,
} from './shared';

const log = createLogger('poster');

const POST_RETRY_DELAY_MS = 3000; // delay between video upload retries



export interface ChallengeInfo {
  challengeNumber: number;
  challengeDay: number;
  category: Category;
}

export interface SeriesInfo {
  name: string;
  dayNumber: number;
  totalDays: number;
  participants: number;
}

export async function formatCaption(video: VideoRow, challengeInfo?: ChallengeInfo, seriesInfo?: SeriesInfo, overrideCategory?: Category): Promise<string> {
  const displayCategory = overrideCategory ?? video.category as Category;
  const categoryRu = CATEGORY_RU[displayCategory] ?? displayCategory;
  const difficultyRu = DIFFICULTY_RU[video.difficulty] ?? video.difficulty;

  const muscles = parseMuscles(video.muscles);

  const equipment = detectEquipment(video.title, '');
  const equipmentTag = equipment.length > 0 ? equipment.join(', ') : EQUIPMENT_NO_GEAR;

  const title = video.display_title
    ? escV2(video.display_title)
    : await rewriteTitle(video.title);
  const channelName = await formatChannelName(video.channel_name);

  const catEmoji = CATEGORY_EMOJI[displayCategory] ?? '🏷';

  const tagLines = [
    `\`${catEmoji} ${categoryRu}\``,
    `\`⏱️ ${video.duration_label ?? '?'}\``,
    `\`🦴 ${muscles}\``,
    `\`💎 ${difficultyRu}\``,
    `\`🎾 ${equipmentTag}\``,
  ];

  // URL: escape only ) and \ which break MarkdownV2 link syntax
  const safeUrl = video.video_url.replace(/[)\\]/g, '\\$&');

  // Sami Score line: Sami Score: 84% (качество и популярность)
  const scorePercent = video.rating > 0 ? Math.round(video.rating * 10) : 0;
  const samiScoreLine = scorePercent > 0
    ? `\`Sami Score: ${scorePercent}% (качество и популярность)\``
    : null;

  const header: string[] = [];
  if (seriesInfo) {
    header.push(`🏆 *${escV2(seriesInfo.name)}* · День ${seriesInfo.dayNumber}/${seriesInfo.totalDays}`);
    header.push(`👥 ${seriesInfo.participants} участник${seriesInfo.participants === 1 ? '' : seriesInfo.participants < 5 ? 'а' : 'ов'}`);
    header.push('');
  }

  const lines = [
    ...header,
    `*${title}*`,
    '',
    ...tagLines,
    ...(samiScoreLine ? [samiScoreLine] : []),
    '',
    `Автор: ${channelName}, 📎 [YouTube](${safeUrl})`,
  ];

  return lines.join('\n');
}

export type PostResult = 'posted' | 'skipped' | 'no_video' | 'error';

/** Fire-and-forget: generate story image and send to admin DM */
function fireStory(bot: Bot, video: VideoRow, category: Category, postMessageId?: number): void {
  // Resolve title: display_title → rewriteTitle → raw title
  const titlePromise = video.display_title
    ? Promise.resolve(video.display_title)
    : rewriteTitle(video.title).then(t => t.replace(/\\(.)/g, '$1')); // unescape MarkdownV2

  titlePromise.then(title => {
    const storyData: StoryData = {
      title,
      category,
      durationLabel: video.duration_label ?? '—',
      difficulty: video.difficulty,
      rawTitle: video.title,
    };
    return sendStoryToAdmin(bot, storyData, postMessageId);
  }).catch(() => {});
}

export async function postVideoToChannel(
  bot: Bot,
  date: string,
  category: Category,
  options?: { force?: boolean; correlationId?: string; challengeInfo?: ChallengeInfo; video?: VideoRow }
): Promise<PostResult> {
  const postLog = options?.correlationId ? log.withCorrelation(options.correlationId) : log;
  const config = getConfig();
  const force = options?.force ?? false;

  if (!force && wasPostedToday(date, category)) {
    postLog.info(`${category} already posted for ${date}, skipping`);
    return 'skipped';
  }

  const video = options?.video ?? getApprovedVideo(date, category);
  if (!video) {
    postLog.warn(`no approved video for ${category} on ${date}`);
    return 'no_video';
  }

  const caption = await formatCaption(video, options?.challengeInfo, undefined, category);

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
              width: download.meta.width,
              height: download.meta.height,
            }
          );
          videoSent = true;
          download.cleanup();

          // Record in DB — separate try so DB failure doesn't trigger text fallback
          try {
            withTransaction(() => {
              recordPost(date, category, video.id, msg.message_id, 'video');
              markApprovalPosted(date, category);
              // Weekly schedule slot is marked by the CALLER (publish_card, challenge_pub, auto-cron)
              // NOT here — postVideoToChannel doesn't know which day the video is for
            });
          } catch (dbErr) {
            postLog.error(`DB WRITE FAILED for ${category} (video already sent)`, { msgId: msg.message_id, error: String(dbErr) });
          }

          postLog.info(`posted ${category} as VIDEO file`, { msgId: msg.message_id });
          fireStory(bot, video, category, msg.message_id);
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
        await new Promise(r => setTimeout(r, POST_RETRY_DELAY_MS));
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
      await formatCaption(video, options?.challengeInfo, undefined, category),
      {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      }
    );

    // Record in DB — separate try so DB failure doesn't lose the already-sent post
    try {
      withTransaction(() => {
        recordPost(date, category, video.id, msg.message_id, 'link');
        markApprovalPosted(date, category);
        // Weekly schedule slot is marked by the CALLER, not here
      });
    } catch (dbErr) {
      postLog.error(`DB WRITE FAILED for ${category} (link already sent)`, { msgId: msg.message_id, error: String(dbErr) });
    }

    postLog.warn(`posted ${category} as LINK (degraded)`, { msgId: msg.message_id });
    fireStory(bot, video, category, msg.message_id);
    return 'posted';
  } catch (err) {
    postLog.error(`COMPLETE FAILURE for ${category} on ${date}`, { error: String(err) });
    return 'error';
  }
}

// ─── CHALLENGE AUTO-PUBLISH ──────────────────────────────────────────────────

import { DAY_CATEGORY_MAP } from './shared';
import { todayMsk } from './dates';

/**
 * Post the challenge video for a given day. Called by the auto-publish cron.
 * Returns 'posted' | 'no_video' | 'error'.
 */
export async function postChallengeVideo(
  bot: Bot,
  challenge: ChallengeRow,
  dayNumber: number,
): Promise<PostResult> {
  const slot = getWeekSlotForDay(challenge.id, dayNumber);
  if (!slot || !slot.video_id || slot.status !== 'queued') {
    log.warn(`no queued video for challenge ${challenge.number} day ${dayNumber}`);
    return 'no_video';
  }

  const video = getVideoById(slot.video_id);
  if (!video) {
    log.error(`video ${slot.video_id} not found for weekly schedule`);
    return 'error';
  }

  const date = todayMsk();
  const dayOfWeek = new Date(date + 'T00:00:00').getDay();
  const category = DAY_CATEGORY_MAP[dayOfWeek] ?? video.category;

  const result = await postVideoToChannel(bot, date, category as Category, {
    force: true,
    challengeInfo: { challengeNumber: challenge.number, challengeDay: dayNumber, category: category as Category },
    video,
  });

  if (result === 'posted') {
    markWeekSlotPosted(challenge.id, dayNumber);
    log.info(`challenge ${challenge.number} day ${dayNumber} posted`);
  }

  return result;
}

// ─── CHALLENGE SERIES PUBLISH ────────────────────────────────────────────────

import {
  type ChallengeSeriesRow,
  getChallengeSeriesDaySlot, markChallengeSeriesDayPosted,
  getChallengeParticipantCount,
} from './db';

export async function postChallengeSeriesVideo(
  bot: Bot,
  series: ChallengeSeriesRow,
  dayNumber: number,
): Promise<PostResult> {
  const slot = getChallengeSeriesDaySlot(series.id, dayNumber);
  if (!slot || !slot.video_id || slot.status !== 'queued') {
    log.warn(`no queued video for series "${series.name}" day ${dayNumber}`);
    return 'no_video';
  }

  const video = getVideoById(slot.video_id);
  if (!video) {
    log.error(`video ${slot.video_id} not found for series "${series.name}"`);
    return 'error';
  }

  const date = todayMsk();
  const category = (slot.category ?? series.default_category ?? video.category) as Category;
  const participants = getChallengeParticipantCount(series.id);

  const seriesInfo: SeriesInfo = {
    name: series.name,
    dayNumber,
    totalDays: series.duration_days,
    participants,
  };

  const caption = await formatCaption(video, undefined, seriesInfo, category);
  const config = getConfig();

  // Try video upload, then link fallback (same pattern as postVideoToChannel)
  const MAX_ATTEMPTS = 2;
  if (isYtDlpAvailable()) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let videoSent = false;
      try {
        const download = await downloadVideo(video.video_url, video.youtube_id);
        try {
          const msg = await bot.api.sendVideo(config.TELEGRAM_CHANNEL_ID, new InputFile(download.filePath), {
            caption, parse_mode: 'MarkdownV2', supports_streaming: true,
            duration: download.meta.duration ?? video.duration_seconds ?? undefined,
            width: download.meta.width,
            height: download.meta.height,
          });
          videoSent = true;
          download.cleanup();
          try {
            withTransaction(() => {
              recordPost(date, category, video.id, msg.message_id, 'video', undefined, undefined);
              // Update the post with series info
              getDb().prepare(`UPDATE posts SET challenge_series_id = ?, challenge_series_day = ? WHERE channel_message_id = ?`)
                .run(series.id, dayNumber, msg.message_id);
              markChallengeSeriesDayPosted(series.id, dayNumber);
            });
          } catch (dbErr) {
            log.error(`DB WRITE FAILED for series "${series.name}" day ${dayNumber}`, { error: String(dbErr) });
          }
          log.info(`series "${series.name}" day ${dayNumber} posted as VIDEO`, { msgId: msg.message_id });
          return 'posted';
        } catch (uploadErr) {
          download.cleanup();
          if (videoSent) return 'posted';
          log.error(`VIDEO UPLOAD FAILED for series day ${dayNumber} (attempt ${attempt})`, { error: String(uploadErr) });
        }
      } catch (dlErr) {
        log.error(`DOWNLOAD FAILED for series day ${dayNumber} (attempt ${attempt})`, { error: String(dlErr) });
      }
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Fallback: text + link
  try {
    const msg = await bot.api.sendMessage(config.TELEGRAM_CHANNEL_ID, caption, {
      parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true },
    });
    try {
      withTransaction(() => {
        recordPost(date, category, video.id, msg.message_id, 'link');
        getDb().prepare(`UPDATE posts SET challenge_series_id = ?, challenge_series_day = ? WHERE channel_message_id = ?`)
          .run(series.id, dayNumber, msg.message_id);
        markChallengeSeriesDayPosted(series.id, dayNumber);
      });
    } catch (dbErr) {
      log.error(`DB WRITE FAILED for series "${series.name}" day ${dayNumber} (link already sent)`, { msgId: msg.message_id, error: String(dbErr) });
    }
    log.warn(`series "${series.name}" day ${dayNumber} posted as LINK`);
    return 'posted';
  } catch (err) {
    log.error(`COMPLETE FAILURE for series "${series.name}" day ${dayNumber}`, { error: String(err) });
    return 'error';
  }
}
