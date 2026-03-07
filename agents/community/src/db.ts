import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const config = getConfig();
  const dbPath = path.resolve(__dirname, '..', config.COMMUNITY_DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  // Migrations for older schemas
  try { db.exec('ALTER TABLE videos ADD COLUMN view_count INTEGER DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE videos ADD COLUMN rating REAL DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE videos ADD COLUMN like_ratio REAL DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE videos ADD COLUMN channel_subscribers INTEGER DEFAULT 0'); } catch { /* already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      channel_url TEXT,
      duration_seconds INTEGER,
      duration_label TEXT,
      difficulty TEXT CHECK(difficulty IN ('beginner','intermediate','advanced')),
      category TEXT CHECK(category IN ('stretching','strength','mobility')) NOT NULL,
      muscles TEXT,  -- JSON array as string
      thumbnail_url TEXT,
      video_url TEXT NOT NULL,
      search_query TEXT,
      view_count INTEGER DEFAULT 0,
      rating REAL DEFAULT 0,
      like_ratio REAL DEFAULT 0,
      channel_subscribers INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL REFERENCES videos(id),
      post_id INTEGER NOT NULL REFERENCES posts(id),
      telegram_user_id INTEGER NOT NULL,
      completed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(post_id, telegram_user_id)
    );

    CREATE TABLE IF NOT EXISTS approval_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,  -- YYYY-MM-DD
      category TEXT NOT NULL,
      video_id INTEGER REFERENCES videos(id),
      status TEXT CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
      message_id INTEGER,  -- Telegram message ID in admin DM
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      video_id INTEGER REFERENCES videos(id),
      channel_message_id INTEGER,
      posted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      telegram_user_id INTEGER NOT NULL,
      result TEXT CHECK(result IN ('did','partial','didnt')) NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, telegram_user_id)
    );

    CREATE TABLE IF NOT EXISTS checkin_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      channel_message_id INTEGER,
      posted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      fitness_goal TEXT,  -- from welcome quiz
      joined_at TEXT DEFAULT (datetime('now')),
      first_action_at TEXT,
      warning_count INTEGER DEFAULT 0,
      is_muted INTEGER DEFAULT 0,
      muted_until TEXT
    );

    CREATE TABLE IF NOT EXISTS ugc_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      username TEXT,
      video_url TEXT NOT NULL,
      youtube_id TEXT,
      title TEXT,
      category TEXT CHECK(category IN ('stretching','strength','mobility')),
      difficulty TEXT CHECK(difficulty IN ('beginner','intermediate','advanced')),
      status TEXT CHECK(status IN ('draft','pending','approved','rejected')) DEFAULT 'draft',
      admin_message_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      checkin_did INTEGER DEFAULT 0,
      checkin_partial INTEGER DEFAULT 0,
      checkin_didnt INTEGER DEFAULT 0,
      new_members INTEGER DEFAULT 0,
      top_category TEXT,
      waitlist_new INTEGER DEFAULT 0,
      written_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      subscriber_count INTEGER DEFAULT 0,
      group_member_count INTEGER DEFAULT 0,
      posts_today INTEGER DEFAULT 0,
      collected_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// --- Video helpers ---

export interface VideoRow {
  id: number;
  youtube_id: string;
  title: string;
  channel_name: string;
  channel_url: string | null;
  duration_seconds: number | null;
  duration_label: string | null;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  category: 'stretching' | 'strength' | 'mobility';
  muscles: string | null;
  thumbnail_url: string | null;
  video_url: string;
  view_count: number;
  rating: number;
  like_ratio: number;
  channel_subscribers: number;
}

export function upsertVideo(v: Omit<VideoRow, 'id'> & { search_query?: string }): number {
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
  const row = stmt.get(v) as { id: number };
  return row.id;
}

export function wasPostedRecently(youtubeId: string, withinDays = 30): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM posts p
    JOIN videos v ON v.id = p.video_id
    WHERE v.youtube_id = ? AND p.posted_at > datetime('now', ?)
  `).get(youtubeId, `-${withinDays} days`) as { cnt: number };
  return row.cnt > 0;
}

// --- Approval helpers ---

export function createApprovalSession(date: string, category: string, videoId: number): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO approval_sessions (date, category, video_id, status)
    VALUES (?, ?, ?, 'pending')
  `);
  return Number(stmt.run(date, category, videoId).lastInsertRowid);
}

export function getApprovedVideo(date: string, category: string): VideoRow | null {
  const db = getDb();
  return db.prepare(`
    SELECT v.* FROM approval_sessions a
    JOIN videos v ON v.id = a.video_id
    WHERE a.date = ? AND a.category = ? AND a.status = 'approved'
    ORDER BY a.decided_at DESC LIMIT 1
  `).get(date, category) as VideoRow | null;
}

export function setApprovalStatus(sessionId: number, status: 'approved' | 'rejected' | 'pending'): void {
  getDb().prepare(`
    UPDATE approval_sessions SET status = ?, decided_at = datetime('now') WHERE id = ?
  `).run(status, sessionId);
}

export function getApprovalSessionByMessageId(messageId: number): { id: number; video_id: number; category: string; date: string } | null {
  return getDb().prepare(`
    SELECT id, video_id, category, date FROM approval_sessions WHERE message_id = ?
  `).get(messageId) as { id: number; video_id: number; category: string; date: string } | null;
}

export function getApprovalSessionById(sessionId: number): { id: number; video_id: number; category: string; date: string } | null {
  return getDb().prepare(`
    SELECT id, video_id, category, date FROM approval_sessions WHERE id = ?
  `).get(sessionId) as { id: number; video_id: number; category: string; date: string } | null;
}

export function resetApprovalSessions(date: string): number {
  const result = getDb().prepare(`
    DELETE FROM approval_sessions WHERE date = ?
  `).run(date);
  return result.changes;
}

export function setApprovalMessageId(sessionId: number, messageId: number): void {
  getDb().prepare(`UPDATE approval_sessions SET message_id = ? WHERE id = ?`).run(messageId, sessionId);
}

// --- Post helpers ---

export function recordPost(date: string, category: string, videoId: number, channelMessageId: number): void {
  getDb().prepare(`
    INSERT INTO posts (date, category, video_id, channel_message_id) VALUES (?, ?, ?, ?)
  `).run(date, category, videoId, channelMessageId);
}

export function wasPostedToday(date: string, category: string): boolean {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM posts WHERE date = ? AND category = ?
  `).get(date, category) as { cnt: number };
  return row.cnt > 0;
}

// --- Check-in helpers ---

export function recordCheckin(date: string, userId: number, result: 'did' | 'partial' | 'didnt'): boolean {
  try {
    getDb().prepare(`
      INSERT INTO checkins (date, telegram_user_id, result) VALUES (?, ?, ?)
      ON CONFLICT(date, telegram_user_id) DO UPDATE SET result = excluded.result
    `).run(date, userId, result);
    return true;
  } catch {
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

// --- Member helpers ---

export function upsertMember(userId: number, username: string | null, firstName: string | null): void {
  getDb().prepare(`
    INSERT INTO members (telegram_user_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(userId, username, firstName);
}

export function setMemberGoal(userId: number, goal: string): void {
  getDb().prepare(`
    UPDATE members SET fitness_goal = ?, first_action_at = COALESCE(first_action_at, datetime('now'))
    WHERE telegram_user_id = ?
  `).run(goal, userId);
}

export function addWarning(userId: number): number {
  const db = getDb();
  db.prepare(`UPDATE members SET warning_count = warning_count + 1 WHERE telegram_user_id = ?`).run(userId);
  const row = db.prepare(`SELECT warning_count FROM members WHERE telegram_user_id = ?`).get(userId) as { warning_count: number } | undefined;
  return row?.warning_count ?? 1;
}

export function muteMember(userId: number, hours: number): void {
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  getDb().prepare(`
    UPDATE members SET is_muted = 1, muted_until = ? WHERE telegram_user_id = ?
  `).run(until, userId);
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
  return getDb().prepare(`SELECT subscriber_count, group_member_count, posts_today FROM channel_stats WHERE date = ?`).get(date) as any;
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
  `).all(startDate, endDate) as any[];
}

export function getPostCountForDate(date: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) as cnt FROM posts WHERE date = ?`).get(date) as { cnt: number };
  return row.cnt;
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

// --- Completion helpers ("Сделано" button) ---

export function recordCompletion(postId: number, videoId: number, userId: number): boolean {
  try {
    getDb().prepare(`
      INSERT INTO completions (post_id, video_id, telegram_user_id)
      VALUES (?, ?, ?)
      ON CONFLICT(post_id, telegram_user_id) DO NOTHING
    `).run(postId, videoId, userId);
    return true;
  } catch {
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

export function getPostByMessageId(channelMessageId: number): { id: number; video_id: number; category: string; date: string } | null {
  return getDb().prepare(
    `SELECT id, video_id, category, date FROM posts WHERE channel_message_id = ?`
  ).get(channelMessageId) as any ?? null;
}

// --- Rating ---

export function computeRating(video: VideoRow): number {
  const viewScore = video.view_count > 0 ? Math.log10(video.view_count) / 7 : 0; // normalize: 10M views = 1.0
  const likeScore = video.like_ratio ?? 0; // 0..1
  const channelScore = video.channel_subscribers > 0
    ? Math.min(Math.log10(video.channel_subscribers) / 7, 1)
    : 0.3;
  const completionRate = getVideoCompletionRate(video.id);

  const raw = 0.4 * viewScore + 0.3 * likeScore + 0.2 * channelScore + 0.1 * completionRate;
  return Math.round(Math.min(raw * 10, 10) * 10) / 10; // 0.0 .. 10.0
}

function getVideoCompletionRate(videoId: number): number {
  // ratio of completions to total posts of this video
  const row = getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM completions WHERE video_id = ?) as completions,
      (SELECT COUNT(*) FROM posts WHERE video_id = ?) as posts
  `).get(videoId, videoId) as { completions: number; posts: number };
  if (row.posts === 0) return 0;
  return Math.min(row.completions / Math.max(row.posts, 1), 1);
}

export function updateVideoRating(videoId: number): number {
  const db = getDb();
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as VideoRow | undefined;
  if (!video) return 0;
  const rating = computeRating(video);
  db.prepare('UPDATE videos SET rating = ? WHERE id = ?').run(rating, videoId);
  return rating;
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

// --- UGC submissions ---

export interface UgcSubmission {
  id: number;
  telegram_user_id: number;
  username: string | null;
  video_url: string;
  youtube_id: string | null;
  title: string | null;
  category: string | null;
  difficulty: string | null;
  status: string;
  admin_message_id: number | null;
  created_at: string;
  decided_at: string | null;
}

export function createUgcSubmission(userId: number, username: string | null, videoUrl: string, youtubeId: string | null): number {
  const result = getDb().prepare(`
    INSERT INTO ugc_submissions (telegram_user_id, username, video_url, youtube_id)
    VALUES (?, ?, ?, ?)
  `).run(userId, username, videoUrl, youtubeId);
  return Number(result.lastInsertRowid);
}

export function updateUgcSubmission(id: number, fields: Partial<Pick<UgcSubmission, 'title' | 'category' | 'difficulty' | 'status' | 'admin_message_id'>>): void {
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (sets.length === 0) return;
  if (fields.status === 'approved' || fields.status === 'rejected') {
    sets.push(`decided_at = datetime('now')`);
  }
  values.push(id);
  getDb().prepare(`UPDATE ugc_submissions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getUgcSubmission(id: number): UgcSubmission | null {
  return (getDb().prepare(`SELECT * FROM ugc_submissions WHERE id = ?`).get(id) as UgcSubmission | undefined) ?? null;
}

export function getUserDraftSubmission(userId: number): UgcSubmission | null {
  return getDb().prepare(
    `SELECT * FROM ugc_submissions WHERE telegram_user_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`
  ).get(userId) as UgcSubmission | null;
}

export function deleteUgcSubmission(id: number): void {
  getDb().prepare(`DELETE FROM ugc_submissions WHERE id = ?`).run(id);
}
