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
      created_at TEXT DEFAULT (datetime('now'))
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
}

export function upsertVideo(v: Omit<VideoRow, 'id'> & { search_query?: string }): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO videos (youtube_id, title, channel_name, channel_url, duration_seconds,
      duration_label, difficulty, category, muscles, thumbnail_url, video_url, search_query)
    VALUES (@youtube_id, @title, @channel_name, @channel_url, @duration_seconds,
      @duration_label, @difficulty, @category, @muscles, @thumbnail_url, @video_url, @search_query)
    ON CONFLICT(youtube_id) DO UPDATE SET
      title = excluded.title,
      channel_name = excluded.channel_name,
      duration_label = excluded.duration_label,
      difficulty = excluded.difficulty,
      muscles = excluded.muscles
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

export function setApprovalStatus(sessionId: number, status: 'approved' | 'rejected'): void {
  getDb().prepare(`
    UPDATE approval_sessions SET status = ?, decided_at = datetime('now') WHERE id = ?
  `).run(status, sessionId);
}

export function getApprovalSessionByMessageId(messageId: number): { id: number; video_id: number; category: string } | null {
  return getDb().prepare(`
    SELECT id, video_id, category FROM approval_sessions WHERE message_id = ?
  `).get(messageId) as { id: number; video_id: number; category: string } | null;
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
