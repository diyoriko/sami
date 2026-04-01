/**
 * Video-related DB helpers.
 *
 * Split out of db.ts to reduce file size while keeping the same public API
 * (db.ts re-exports everything from here).
 */

import { getDb } from './db';
import { getConfig } from './config';
import { type Category, type Difficulty } from './shared';

// --- Video helpers ---

export interface VideoRow {
  id: number;
  youtube_id: string;
  title: string;
  display_title: string | null;
  channel_name: string;
  channel_url: string | null;
  duration_seconds: number | null;
  duration_label: string | null;
  difficulty: Difficulty;
  category: Category;
  muscles: string | null;
  thumbnail_url: string | null;
  video_url: string;
  view_count: number;
  rating: number;
  like_ratio: number;
  channel_subscribers: number;
}

export function getVideoById(id: number): VideoRow | null {
  return getDb().prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | null;
}

export function upsertVideo(v: Omit<VideoRow, 'id' | 'display_title'> & { search_query?: string }): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO videos (youtube_id, title, channel_name, channel_url, duration_seconds,
      duration_label, difficulty, category, muscles, thumbnail_url, video_url, search_query,
      view_count, like_ratio, channel_subscribers)
    VALUES (@youtube_id, @title, @channel_name, @channel_url, @duration_seconds,
      @duration_label, @difficulty, @category, @muscles, @thumbnail_url, @video_url, @search_query,
      @view_count, @like_ratio, @channel_subscribers)
    ON CONFLICT(youtube_id) DO UPDATE SET
      title = excluded.title,
      channel_name = excluded.channel_name,
      duration_label = excluded.duration_label,
      difficulty = excluded.difficulty,
      muscles = excluded.muscles,
      view_count = excluded.view_count,
      like_ratio = excluded.like_ratio,
      channel_subscribers = excluded.channel_subscribers
    RETURNING id
  `);
  const row = stmt.get({ search_query: null, ...v }) as { id: number };
  // Auto-compute rating from YouTube metrics (views, likes, subscribers)
  updateVideoRating(row.id);
  return row.id;
}

export function wasPostedEver(youtubeId: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM posts p
    JOIN videos v ON v.id = p.video_id
    WHERE v.youtube_id = ?
  `).get(youtubeId) as { cnt: number };
  return row.cnt > 0;
}

// --- Rating ---

/**
 * Normalize like_ratio (typically 0.02-0.08) to 0..1 score.
 * 2% = mediocre (0.3), 4% = good (0.6), 6%+ = excellent (0.9+)
 */
function normalizeLikeRatio(ratio: number): number {
  if (ratio <= 0) return 0;
  // Map 0-0.06 range to 0-1 with diminishing returns
  // 3% = 0.71, 5% = 0.91, 6%+ = 1.0
  return Math.min(Math.sqrt(ratio / 0.06), 1);
}

/**
 * Normalize view count to 0..1 score.
 * 10K = 0.57, 50K = 0.77, 100K = 0.86, 500K = 0.97, 1M+ = 1.0
 */
function normalizeViews(viewCount: number): number {
  if (viewCount <= 0) return 0;
  const log = Math.log10(viewCount);
  return Math.min(Math.max((log - 2) / 3.5, 0), 1);
}

/**
 * Rating formula: YouTube metrics only.
 *
 * Completions removed — always 0 at post time, score never recalculated.
 *
 * Weights:
 *  40% view count (YouTube reach)
 *  35% like ratio (YouTube quality signal)
 *  25% channel authority
 */
export function computeRating(video: VideoRow): number {
  // UGC Telegram files — no YouTube metrics, flat score
  if (video.youtube_id?.startsWith('ugc-')) {
    return 7.0;
  }

  const config = getConfig();
  const viewScore = normalizeViews(video.view_count);
  const likeScore = normalizeLikeRatio(video.like_ratio ?? 0);
  const channelScore = video.channel_subscribers > 0
    ? Math.min(Math.log10(video.channel_subscribers) / 5.5, 1) // 300K subs ≈ 1.0, 1M = 1.0
    : 0.5; // unknown channel — neutral estimate

  const raw =
    config.RATING_VIEW_WEIGHT * viewScore +
    config.RATING_LIKE_WEIGHT * likeScore +
    config.RATING_CHANNEL_WEIGHT * channelScore;
  return Math.round(Math.min(raw * 10, 10) * 10) / 10; // 0.0 .. 10.0
}

export function updateVideoRating(videoId: number): number {
  const db = getDb();
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as VideoRow | undefined;
  if (!video) return 0;
  const rating = computeRating(video);
  db.prepare('UPDATE videos SET rating = ? WHERE id = ?').run(rating, videoId);
  return rating;
}

// --- Display title (admin-curated override) ---

export function setVideoDisplayTitle(videoId: number, title: string): void {
  getDb().prepare('UPDATE videos SET display_title = ? WHERE id = ?').run(title, videoId);
}

// --- Video rejections (blocklist) ---

export function recordRejection(youtubeId: string, category: string): void {
  getDb().prepare(`
    INSERT INTO video_rejections (youtube_id, category) VALUES (?, ?)
  `).run(youtubeId, category);
}

export function isVideoRejected(youtubeId: string): boolean {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM video_rejections WHERE youtube_id = ?`
  ).get(youtubeId) as { cnt: number };
  return row.cnt > 0;
}

export function getRejectionCount(sinceDays: number = 7): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM video_rejections WHERE rejected_at > datetime('now', '-' || ? || ' days')`
  ).get(sinceDays) as { cnt: number };
  return row.cnt;
}

// --- User favorites ---

export function toggleFavorite(userId: number, videoId: number, postId?: number): boolean {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id FROM user_favorites WHERE telegram_user_id = ? AND video_id = ?`
  ).get(userId, videoId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`DELETE FROM user_favorites WHERE id = ?`).run(existing.id);
    return false; // removed
  }

  db.prepare(`
    INSERT INTO user_favorites (telegram_user_id, video_id, post_id) VALUES (?, ?, ?)
  `).run(userId, videoId, postId ?? null);
  return true; // added
}

export function isUserFavorite(userId: number, videoId: number): boolean {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM user_favorites WHERE telegram_user_id = ? AND video_id = ?`
  ).get(userId, videoId) as { cnt: number };
  return row.cnt > 0;
}

export interface FavoriteVideo {
  video_id: number;
  title: string;
  category: string;
  channel_message_id: number | null;
  created_at: string;
}

export function getUserFavorites(userId: number, limit: number, offset: number): FavoriteVideo[] {
  return getDb().prepare(`
    SELECT f.video_id, v.title, v.category,
           (SELECT p.channel_message_id FROM posts p WHERE p.video_id = v.id ORDER BY p.posted_at DESC LIMIT 1) as channel_message_id,
           f.created_at
    FROM user_favorites f
    JOIN videos v ON v.id = f.video_id
    WHERE f.telegram_user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as FavoriteVideo[];
}

export function getUserFavoriteTotal(userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM user_favorites WHERE telegram_user_id = ?`
  ).get(userId) as { cnt: number };
  return row.cnt;
}

// --- Video filter/search ---

export interface FilteredVideo {
  id: number;
  title: string;
  category: string;
  difficulty: string;
  duration_seconds: number | null;
  duration_label: string | null;
  rating: number;
  channel_message_id: number | null;
}

export function filterVideos(opts: {
  category?: string;
  difficulty?: string;
  maxDuration?: number;
  minDuration?: number;
  limit?: number;
}): FilteredVideo[] {
  const conditions = ['1=1'];
  const params: (string | number)[] = [];

  if (opts.category) {
    conditions.push('v.category = ?');
    params.push(opts.category);
  }
  if (opts.difficulty) {
    conditions.push('v.difficulty = ?');
    params.push(opts.difficulty);
  }
  if (opts.minDuration) {
    conditions.push('v.duration_seconds >= ?');
    params.push(opts.minDuration);
  }
  if (opts.maxDuration) {
    conditions.push('v.duration_seconds <= ?');
    params.push(opts.maxDuration);
  }
  params.push(opts.limit ?? 5);

  return getDb().prepare(`
    SELECT v.id, v.title, v.category, v.difficulty, v.duration_seconds, v.duration_label, v.rating,
           (SELECT p.channel_message_id FROM posts p WHERE p.video_id = v.id ORDER BY p.posted_at DESC LIMIT 1) as channel_message_id
    FROM videos v
    WHERE ${conditions.join(' AND ')}
    ORDER BY v.rating DESC, v.created_at DESC
    LIMIT ?
  `).all(...params) as FilteredVideo[];
}
