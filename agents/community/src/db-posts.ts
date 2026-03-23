/**
 * Post-related DB helpers: posts, completions, check-ins, analytics queries.
 *
 * Split out of db.ts to reduce file size while keeping the same public API
 * (db.ts re-exports everything from here).
 */

import { getDb } from './db';
import { createLogger } from './logger';
import type { VideoRow } from './db-videos';

const log = createLogger('db-posts');

// --- Post helpers ---

export interface RecentPost {
  date: string;
  category: string;
  title: string;
  post_type: string;
  completions: number;
}

export function getRecentPosts(days: number = 7): RecentPost[] {
  return getDb().prepare(`
    SELECT p.date, p.category, v.title, p.post_type,
      (SELECT COUNT(*) FROM completions c WHERE c.post_id = p.id) as completions
    FROM posts p
    JOIN videos v ON v.id = p.video_id
    WHERE p.date >= date('now', '-' || ? || ' days')
    ORDER BY p.date DESC, p.category
  `).all(days) as RecentPost[];
}

export function recordPost(
  date: string, category: string, videoId: number, channelMessageId: number,
  postType: 'video' | 'link' = 'video',
  challengeId?: number, challengeDay?: number,
): number {
  // Check for existing post first (handles case where UNIQUE index may not exist)
  const existing = getDb().prepare(
    `SELECT id FROM posts WHERE date = ? AND category = ? AND video_id = ?`
  ).get(date, category, videoId) as { id: number } | undefined;

  if (existing) {
    getDb().prepare(
      `UPDATE posts SET channel_message_id = ?, post_type = ?, challenge_id = ?, challenge_day = ? WHERE id = ?`
    ).run(channelMessageId, postType, challengeId ?? null, challengeDay ?? null, existing.id);
    return existing.id;
  }

  const result = getDb().prepare(`
    INSERT INTO posts (date, category, video_id, channel_message_id, post_type, challenge_id, challenge_day)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(date, category, videoId, channelMessageId, postType, challengeId ?? null, challengeDay ?? null);
  return Number(result.lastInsertRowid);
}

/** Get the most recent post overall (for health dashboard) */
export function getLatestPost(): { date: string; category: string; posted_at: string } | null {
  return (getDb().prepare(
    `SELECT date, category, posted_at FROM posts ORDER BY posted_at DESC LIMIT 1`
  ).get() as { date: string; category: string; posted_at: string } | undefined) ?? null;
}

export function getLatestPostForDate(date: string): { category: string; channel_message_id: number } | null {
  const row = getDb().prepare(`
    SELECT category, channel_message_id FROM posts
    WHERE date = ? AND channel_message_id IS NOT NULL
    ORDER BY posted_at DESC LIMIT 1
  `).get(date) as { category: string; channel_message_id: number } | undefined;
  return row ?? null;
}

export function wasPostedToday(date: string, category: string): boolean {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM posts WHERE date = ? AND category = ?
  `).get(date, category) as { cnt: number };
  return row.cnt > 0;
}

/** Get recent posts by category with channel links (for recommendation DMs). */
export function getRecentPostsByCategory(category: string, limit: number = 3): { title: string; channel_message_id: number }[] {
  return getDb().prepare(`
    SELECT v.title, p.channel_message_id
    FROM posts p
    JOIN videos v ON v.id = p.video_id
    WHERE p.category = ? AND p.channel_message_id IS NOT NULL
    ORDER BY p.date DESC, p.posted_at DESC
    LIMIT ?
  `).all(category, limit) as { title: string; channel_message_id: number }[];
}

export function getPostCountForDate(date: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) as cnt FROM posts WHERE date = ?`).get(date) as { cnt: number };
  return row.cnt;
}

export function getPostByMessageId(channelMessageId: number): { id: number; video_id: number; category: string; date: string; challenge_series_id: number | null; challenge_series_day: number | null } | null {
  return (getDb().prepare(
    `SELECT id, video_id, category, date, challenge_series_id, challenge_series_day FROM posts WHERE channel_message_id = ?`
  ).get(channelMessageId) as { id: number; video_id: number; category: string; date: string; challenge_series_id: number | null; challenge_series_day: number | null } | undefined) ?? null;
}

/** Fallback: find most recent post by video_id (for when message_id lookup fails, e.g. forwarded messages) */
export function getLatestPostByVideoId(videoId: number): { id: number; video_id: number; category: string; date: string; challenge_series_id: number | null; challenge_series_day: number | null } | null {
  return (getDb().prepare(
    `SELECT id, video_id, category, date, challenge_series_id, challenge_series_day FROM posts WHERE video_id = ? ORDER BY posted_at DESC LIMIT 1`
  ).get(videoId) as { id: number; video_id: number; category: string; date: string; challenge_series_id: number | null; challenge_series_day: number | null } | undefined) ?? null;
}

/** Save the bot's comment message_id in the discussion group */
export function setGroupCommentId(postId: number, groupCommentId: number): void {
  getDb().prepare('UPDATE posts SET group_comment_id = ? WHERE id = ?').run(groupCommentId, postId);
}

/** Find post by its group comment message_id */
export function getPostByGroupCommentId(commentId: number): { id: number; video_id: number; category: string; date: string; challenge_series_id: number | null; challenge_series_day: number | null } | null {
  return (getDb().prepare(
    `SELECT id, video_id, category, date, challenge_series_id, challenge_series_day FROM posts WHERE group_comment_id = ?`
  ).get(commentId) as { id: number; video_id: number; category: string; date: string; challenge_series_id: number | null; challenge_series_day: number | null } | undefined) ?? null;
}

export interface PostTypeBreakdown {
  post_type: string;
  count: number;
}

export function getPostTypeBreakdown(date: string): PostTypeBreakdown[] {
  return getDb().prepare(`
    SELECT post_type, COUNT(*) as count FROM posts WHERE date = ? GROUP BY post_type
  `).all(date) as PostTypeBreakdown[];
}

// --- Check-in helpers ---

export function recordCheckin(date: string, userId: number, result: 'did' | 'partial' | 'didnt'): boolean {
  try {
    getDb().prepare(`
      INSERT INTO checkins (date, telegram_user_id, result) VALUES (?, ?, ?)
      ON CONFLICT(date, telegram_user_id) DO UPDATE SET result = excluded.result
    `).run(date, userId, result);
    return true;
  } catch (err) {
    log.error('failed to record checkin', { date, userId, result, error: String(err) });
    return false;
  }
}

export function getCheckinStats(date: string): { did: number; partial: number; didnt: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN result = 'did' THEN 1 ELSE 0 END) as did,
      SUM(CASE WHEN result = 'partial' THEN 1 ELSE 0 END) as partial,
      SUM(CASE WHEN result = 'didnt' THEN 1 ELSE 0 END) as didnt
    FROM checkins WHERE date = ?
  `).get(date) as { did: number; partial: number; didnt: number };
  return { did: row.did || 0, partial: row.partial || 0, didnt: row.didnt || 0 };
}

export function recordCheckinPost(date: string, messageId: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO checkin_posts (date, channel_message_id) VALUES (?, ?)
  `).run(date, messageId);
}

// --- Completion helpers ("Сделано" button) ---

export function recordCompletion(postId: number, videoId: number, userId: number): boolean {
  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO completions (post_id, video_id, telegram_user_id)
      VALUES (?, ?, ?)
      ON CONFLICT(post_id, telegram_user_id) DO NOTHING
    `).run(postId, videoId, userId);

    // Update member activity tracking (only if actually inserted)
    if (result.changes > 0) {
      db.prepare(`
        UPDATE members SET
          last_activity_at = datetime('now'),
          completions_total = COALESCE(completions_total, 0) + 1
        WHERE telegram_user_id = ?
      `).run(userId);
    }

    return true;
  } catch (err) {
    log.error('failed to record completion', { userId, error: String(err) });
    return false;
  }
}

export function removeCompletion(postId: number, userId: number): boolean {
  const db = getDb();
  try {
    const result = db.prepare(
      `DELETE FROM completions WHERE post_id = ? AND telegram_user_id = ?`
    ).run(postId, userId);

    if (result.changes > 0) {
      db.prepare(`
        UPDATE members SET
          completions_total = MAX(COALESCE(completions_total, 0) - 1, 0)
        WHERE telegram_user_id = ?
      `).run(userId);
    }

    return result.changes > 0;
  } catch (err) {
    log.error('failed to remove completion', { userId, error: String(err) });
    return false;
  }
}

export function getCompletionCount(postId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM completions WHERE post_id = ?`
  ).get(postId) as { cnt: number };
  return row.cnt;
}

export function hasUserCompleted(postId: number, userId: number): boolean {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM completions WHERE post_id = ? AND telegram_user_id = ?`
  ).get(postId, userId) as { cnt: number };
  return row.cnt > 0;
}

export function getLastCompletionTime(userId: number): string | null {
  const row = getDb().prepare(
    `SELECT completed_at FROM completions WHERE telegram_user_id = ? ORDER BY completed_at DESC LIMIT 1`
  ).get(userId) as { completed_at: string } | undefined;
  return row?.completed_at ?? null;
}

/**
 * Count consecutive days with completions going back from today (MSK).
 * If the most recent completion is older than yesterday — streak is 0.
 */
export function getUserStreak(userId: number): number {
  const rows = getDb().prepare(`
    SELECT DISTINCT date(completed_at, '+3 hours') as d
    FROM completions
    WHERE telegram_user_id = ?
    ORDER BY d DESC
  `).all(userId) as { d: string }[];

  if (rows.length === 0) return 0;

  // Today in MSK (inline to avoid circular import)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const mostRecent = rows[0].d;
  const diffMs = new Date(todayStr + 'T00:00:00').getTime() - new Date(mostRecent + 'T00:00:00').getTime();
  const diffDays = Math.round(diffMs / 86_400_000);

  if (diffDays > 1) return 0;

  let streak = 1;
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].d + 'T00:00:00').getTime();
    const curr = new Date(rows[i].d + 'T00:00:00').getTime();
    if (prev - curr === 86_400_000) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Get users who completed workouts every day in a date range.
 * Returns list of {telegram_user_id, first_name} for users with completions on ALL days.
 */
export function getWeeklyConsistentUsers(startDate: string, endDate: string): { telegram_user_id: number; first_name: string }[] {
  // Count distinct days in the range
  const daysDiff = Math.round(
    (new Date(endDate + 'T00:00:00').getTime() - new Date(startDate + 'T00:00:00').getTime()) / 86_400_000
  ) + 1;

  return getDb().prepare(`
    SELECT c.telegram_user_id, COALESCE(m.first_name, 'Участник') as first_name
    FROM completions c
    LEFT JOIN members m ON m.telegram_user_id = c.telegram_user_id
    WHERE date(c.completed_at, '+3 hours') BETWEEN ? AND ?
    GROUP BY c.telegram_user_id
    HAVING COUNT(DISTINCT date(c.completed_at, '+3 hours')) >= ?
  `).all(startDate, endDate, daysDiff) as { telegram_user_id: number; first_name: string }[];
}

// --- "Мои тренировки" ---

export interface UserCompletion {
  video_title: string;
  category: string;
  channel_message_id: number;
  completed_at: string;
  date: string;
}

export function getUserCompletions(userId: number, limit: number, offset: number): UserCompletion[] {
  return getDb().prepare(`
    SELECT v.title as video_title, p.category, p.channel_message_id, c.completed_at, p.date
    FROM completions c
    JOIN videos v ON v.id = c.video_id
    JOIN posts p ON p.id = c.post_id
    WHERE c.telegram_user_id = ?
    ORDER BY c.completed_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as UserCompletion[];
}

export function getUserCompletionTotal(userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM completions WHERE telegram_user_id = ?`
  ).get(userId) as { cnt: number };
  return row.cnt;
}

// --- Daily stats ---

export function writeDailyStats(date: string, newMembers: number): void {
  const stats = getCheckinStats(date);
  getDb().prepare(`
    INSERT INTO daily_stats (date, checkin_did, checkin_partial, checkin_didnt, new_members)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      checkin_did = excluded.checkin_did,
      checkin_partial = excluded.checkin_partial,
      checkin_didnt = excluded.checkin_didnt,
      new_members = excluded.new_members,
      written_at = datetime('now')
  `).run(date, stats.did, stats.partial, stats.didnt, newMembers);
}

// --- Channel stats (for analytics agent) ---

export function writeChannelStats(date: string, subscriberCount: number, groupMemberCount: number, postsToday: number): void {
  getDb().prepare(`
    INSERT INTO channel_stats (date, subscriber_count, group_member_count, posts_today)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      subscriber_count = excluded.subscriber_count,
      group_member_count = excluded.group_member_count,
      posts_today = excluded.posts_today,
      collected_at = datetime('now')
  `).run(date, subscriberCount, groupMemberCount, postsToday);
}

export function getChannelStats(date: string): { subscriber_count: number; group_member_count: number; posts_today: number } | null {
  return getDb().prepare(`SELECT subscriber_count, group_member_count, posts_today FROM channel_stats WHERE date = ?`).get(date) as { subscriber_count: number; group_member_count: number; posts_today: number } | undefined ?? null;
}

export function getWeeklyStats(startDate: string, endDate: string): Array<{
  date: string; checkin_did: number; checkin_partial: number; checkin_didnt: number;
  new_members: number; subscriber_count: number; group_member_count: number;
}> {
  return getDb().prepare(`
    SELECT d.date, d.checkin_did, d.checkin_partial, d.checkin_didnt, d.new_members,
           COALESCE(c.subscriber_count, 0) as subscriber_count,
           COALESCE(c.group_member_count, 0) as group_member_count
    FROM daily_stats d
    LEFT JOIN channel_stats c ON c.date = d.date
    WHERE d.date >= ? AND d.date <= ?
    ORDER BY d.date
  `).all(startDate, endDate) as Array<{
    date: string; checkin_did: number; checkin_partial: number; checkin_didnt: number;
    new_members: number; subscriber_count: number; group_member_count: number;
  }>;
}

export function getCompletionCountForDate(date: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM completions c
    JOIN posts p ON p.id = c.post_id
    WHERE p.date = ?
  `).get(date) as { cnt: number };
  return row.cnt;
}

export function getUniqueCompletionUsersForDate(date: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(DISTINCT c.telegram_user_id) as cnt FROM completions c
    JOIN posts p ON p.id = c.post_id
    WHERE p.date = ?
  `).get(date) as { cnt: number };
  return row.cnt;
}

// --- Extended analytics queries ---

export interface TopVideoByCompletions {
  video_id: number;
  title: string;
  category: string;
  completions: number;
}

export function getTopVideosByCompletions(date: string, limit: number = 5): TopVideoByCompletions[] {
  return getDb().prepare(`
    SELECT v.id as video_id, v.title, p.category, COUNT(c.id) as completions
    FROM completions c
    JOIN posts p ON p.id = c.post_id
    JOIN videos v ON v.id = p.video_id
    WHERE p.date = ?
    GROUP BY p.video_id
    ORDER BY completions DESC
    LIMIT ?
  `).all(date, limit) as TopVideoByCompletions[];
}

export function getRetention(todayDate: string, yesterdayDate: string): { yesterday_active: number; returned_today: number } {
  const row = getDb().prepare(`
    SELECT
      (SELECT COUNT(DISTINCT telegram_user_id) FROM completions c
       JOIN posts p ON p.id = c.post_id WHERE p.date = ?) as yesterday_active,
      (SELECT COUNT(DISTINCT c1.telegram_user_id) FROM completions c1
       JOIN posts p1 ON p1.id = c1.post_id
       WHERE p1.date = ?
       AND c1.telegram_user_id IN (
         SELECT DISTINCT c2.telegram_user_id FROM completions c2
         JOIN posts p2 ON p2.id = c2.post_id WHERE p2.date = ?
       )) as returned_today
  `).get(yesterdayDate, todayDate, yesterdayDate) as { yesterday_active: number; returned_today: number };
  return row;
}

export interface CompletionsByCategory {
  category: string;
  completions: number;
  users: number;
}

export function getCompletionsByCategory(date: string): CompletionsByCategory[] {
  return getDb().prepare(`
    SELECT p.category, COUNT(c.id) as completions, COUNT(DISTINCT c.telegram_user_id) as users
    FROM completions c
    JOIN posts p ON p.id = c.post_id
    WHERE p.date = ?
    GROUP BY p.category
    ORDER BY p.category
  `).all(date) as CompletionsByCategory[];
}

export interface CumulativeStats {
  total_completions: number;
  total_active_users: number;
  total_posts: number;
}

export function getCumulativeStats(): CumulativeStats {
  return getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM completions) as total_completions,
      (SELECT COUNT(DISTINCT telegram_user_id) FROM completions) as total_active_users,
      (SELECT COUNT(*) FROM posts) as total_posts
  `).get() as CumulativeStats;
}

// --- Poll results ---

export interface PollOption {
  text: string;
  voter_count: number;
}

export function upsertPollResult(pollId: string, question: string, totalVoters: number, options: PollOption[], seasonNumber?: number, weekNumber?: number): void {
  getDb().prepare(`
    INSERT INTO poll_results (poll_id, question, total_voters, options_json, season_number, week_number, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(poll_id) DO UPDATE SET
      total_voters = excluded.total_voters,
      options_json = excluded.options_json,
      updated_at = datetime('now')
  `).run(pollId, question, totalVoters, JSON.stringify(options), seasonNumber ?? null, weekNumber ?? null);
}

export function getPollResults(seasonNumber?: number): { poll_id: string; question: string; total_voters: number; options: PollOption[]; season_number: number | null; week_number: number | null; updated_at: string }[] {
  const rows = seasonNumber != null
    ? getDb().prepare(`SELECT * FROM poll_results WHERE season_number = ? ORDER BY created_at DESC`).all(seasonNumber) as any[]
    : getDb().prepare(`SELECT * FROM poll_results ORDER BY created_at DESC LIMIT 10`).all() as any[];
  return rows.map(r => ({ ...r, options: JSON.parse(r.options_json) }));
}

// --- Deploy history ---

export interface DeployRecord {
  id: number;
  commit_sha: string | null;
  commit_message: string | null;
  version: string | null;
  deployed_at: string;
}

export function recordDeploy(commitSha?: string, commitMessage?: string, version?: string): void {
  // Deduplicate: skip if last deploy has the same commit SHA
  if (commitSha) {
    const last = getDb().prepare(
      `SELECT commit_sha FROM deploy_history ORDER BY id DESC LIMIT 1`
    ).get() as { commit_sha: string | null } | undefined;
    if (last?.commit_sha === commitSha) return;
  }

  getDb().prepare(`
    INSERT INTO deploy_history (commit_sha, commit_message, version)
    VALUES (?, ?, ?)
  `).run(commitSha ?? null, commitMessage ?? null, version ?? null);
}

export function getLatestDeploy(): DeployRecord | null {
  return getDb().prepare(
    `SELECT * FROM deploy_history ORDER BY id DESC LIMIT 1`
  ).get() as DeployRecord | null;
}

export function getDeployStats(): {
  totalMembers: number;
  totalVideos: number;
  totalPosts: number;
  totalCompletions: number;
  activeUsers: number;
  ugcPending: number;
  modActions7d: number;
  rejections7d: number;
} {
  return getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM members) as totalMembers,
      (SELECT COUNT(*) FROM videos) as totalVideos,
      (SELECT COUNT(*) FROM posts) as totalPosts,
      (SELECT COUNT(*) FROM completions) as totalCompletions,
      (SELECT COUNT(DISTINCT telegram_user_id) FROM completions) as activeUsers,
      (SELECT COUNT(*) FROM ugc_submissions WHERE status = 'pending' AND deleted_at IS NULL) as ugcPending,
      (SELECT COUNT(*) FROM moderation_log WHERE created_at > datetime('now', '-7 days')) as modActions7d,
      (SELECT COUNT(*) FROM video_rejections WHERE rejected_at > datetime('now', '-7 days')) as rejections7d
  `).get() as any;
}
