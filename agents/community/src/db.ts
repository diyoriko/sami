import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config';
import { type Category, type Difficulty, CATEGORIES_SQL, DIFFICULTIES_SQL } from './shared';

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

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Run multiple DB operations atomically. Rolls back on error. */
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}

/**
 * Rebuild videos + ugc_submissions tables to update CHECK constraints.
 * Needed when new categories (yoga, breathing, recovery, cardio) are added
 * to an existing DB that was created with only 3 categories.
 */
function migrateCheckConstraints(db: Database.Database): void {
  // Test if current CHECK allows new categories
  try {
    const stmt = db.prepare(
      `INSERT INTO videos (youtube_id, title, channel_name, video_url, category) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run('__constraint_test__', '__test__', '__test__', '__test__', 'yoga');
    db.exec(`DELETE FROM videos WHERE youtube_id = '__constraint_test__'`);
    return; // CHECK already supports new categories
  } catch {
    // CHECK rejects 'yoga' → need to rebuild tables
  }

  // Disable FK checks so DROP TABLE doesn't fail on referencing tables
  db.pragma('foreign_keys = OFF');

  try {
    db.exec('BEGIN');

    // Rebuild videos table
    db.exec(`
      CREATE TABLE videos_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        youtube_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        channel_url TEXT,
        duration_seconds INTEGER,
        duration_label TEXT,
        difficulty TEXT CHECK(difficulty IN (${DIFFICULTIES_SQL})),
        category TEXT CHECK(category IN (${CATEGORIES_SQL})) NOT NULL,
        muscles TEXT,
        thumbnail_url TEXT,
        video_url TEXT NOT NULL,
        search_query TEXT,
        view_count INTEGER DEFAULT 0,
        rating REAL DEFAULT 0,
        like_ratio REAL DEFAULT 0,
        channel_subscribers INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO videos_v2 SELECT
        id, youtube_id, title, channel_name, channel_url,
        duration_seconds, duration_label, difficulty, category, muscles,
        thumbnail_url, video_url, search_query,
        view_count, rating, like_ratio, channel_subscribers, created_at
      FROM videos;
      DROP TABLE videos;
      ALTER TABLE videos_v2 RENAME TO videos;
    `);

    // Rebuild ugc_submissions table
    db.exec(`
      CREATE TABLE ugc_submissions_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        username TEXT,
        video_url TEXT NOT NULL,
        youtube_id TEXT,
        title TEXT,
        category TEXT CHECK(category IN (${CATEGORIES_SQL})),
        difficulty TEXT CHECK(difficulty IN (${DIFFICULTIES_SQL})),
        status TEXT CHECK(status IN ('draft','pending','approved','rejected')) DEFAULT 'draft',
        admin_message_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT,
        deleted_at TEXT
      );
      INSERT INTO ugc_submissions_v2 SELECT
        id, telegram_user_id, username, video_url, youtube_id, title,
        category, difficulty, status, admin_message_id, created_at, decided_at, deleted_at
      FROM ugc_submissions;
      DROP TABLE ugc_submissions;
      ALTER TABLE ugc_submissions_v2 RENAME TO ugc_submissions;
    `);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // Verify FK integrity after rebuild
  const fkErrors = db.pragma('foreign_key_check');
  if ((fkErrors as unknown[]).length > 0) {
    throw new Error(`FK integrity broken after constraint migration: ${JSON.stringify(fkErrors)}`);
  }
}

function migrate(db: Database.Database): void {
  // Migrations for older schemas
  try { db.exec('ALTER TABLE videos ADD COLUMN view_count INTEGER DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE videos ADD COLUMN rating REAL DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE videos ADD COLUMN like_ratio REAL DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE videos ADD COLUMN channel_subscribers INTEGER DEFAULT 0'); } catch { /* already exists */ }
  // Add post_type to posts table (video|link)
  try { db.exec(`ALTER TABLE posts ADD COLUMN post_type TEXT DEFAULT 'video'`); } catch { /* already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      channel_url TEXT,
      duration_seconds INTEGER,
      duration_label TEXT,
      difficulty TEXT CHECK(difficulty IN (${DIFFICULTIES_SQL})),
      category TEXT CHECK(category IN (${CATEGORIES_SQL})) NOT NULL,
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
      status TEXT DEFAULT 'pending',
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
      post_type TEXT DEFAULT 'video',
      posted_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, category, video_id)
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
      muted_until TEXT,
      last_activity_at TEXT,
      completions_total INTEGER DEFAULT 0,
      buddy_invite_sent INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ugc_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      username TEXT,
      video_url TEXT NOT NULL,
      youtube_id TEXT,
      title TEXT,
      category TEXT CHECK(category IN (${CATEGORIES_SQL})),
      difficulty TEXT CHECK(difficulty IN (${DIFFICULTIES_SQL})),
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

    -- Captcha state: survives bot restarts
    CREATE TABLE IF NOT EXISTS pending_captchas (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      answer INTEGER NOT NULL,
      first_name TEXT NOT NULL,
      captcha_message_id INTEGER,
      expires_at TEXT NOT NULL
    );

    -- UGC conversation state: survives bot restarts
    CREATE TABLE IF NOT EXISTS ugc_conversation_state (
      telegram_user_id INTEGER PRIMARY KEY,
      step TEXT NOT NULL,
      submission_id INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Index for expired captcha cleanup
    CREATE INDEX IF NOT EXISTS idx_captcha_expires ON pending_captchas(expires_at);
  `);

  // Post-create migrations for existing DBs (columns added in CREATE TABLE for new DBs)
  try { db.exec('ALTER TABLE members ADD COLUMN last_activity_at TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE members ADD COLUMN completions_total INTEGER DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE members ADD COLUMN buddy_invite_sent INTEGER DEFAULT 0'); } catch { /* already exists */ }

  // Discussion comment message ID (bot's reply in group thread)
  try { db.exec('ALTER TABLE posts ADD COLUMN group_comment_id INTEGER'); } catch { /* already exists */ }

  // Soft delete columns
  try { db.exec('ALTER TABLE ugc_submissions ADD COLUMN deleted_at TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE approval_sessions ADD COLUMN deleted_at TEXT'); } catch { /* already exists */ }

  // Migration: rebuild tables with updated CHECK constraints (added yoga, breathing, recovery, cardio)
  migrateCheckConstraints(db);

  // Video rejections (blocklist): tracks admin "Другое" clicks
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_id TEXT NOT NULL,
      category TEXT NOT NULL,
      rejected_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rejections_youtube_id ON video_rejections(youtube_id);
  `);

  // User favorites (saved videos)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL REFERENCES videos(id),
      post_id INTEGER REFERENCES posts(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(telegram_user_id, video_id)
    );
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON user_favorites(telegram_user_id);
  `);

  // Deploy history
  db.exec(`
    CREATE TABLE IF NOT EXISTS deploy_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_sha TEXT,
      commit_message TEXT,
      version TEXT,
      deployed_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Moderation log — tracks all automated moderation actions
  db.exec(`
    CREATE TABLE IF NOT EXISTS moderation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,  -- 'warn' | 'mute' | 'ban' | 'delete' | 'antiflood' | 'cooldown'
      reason TEXT,
      message_snippet TEXT,  -- first 200 chars of deleted message
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_modlog_user ON moderation_log(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_modlog_created ON moderation_log(created_at);
  `);

  // Dynamic stop-phrases — strategist can update via actions
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_phrases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phrase TEXT NOT NULL UNIQUE,
      added_by TEXT DEFAULT 'manual',  -- 'manual' | 'strategist'
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Implementor agent tasks
  db.exec(`
    CREATE TABLE IF NOT EXISTS impl_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT DEFAULT 'P2',
      branch TEXT,
      commit_sha TEXT,
      result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_impl_tasks_status ON impl_tasks(status);
  `);

  // Rubrics: weekly ritual challenges, mechanics breakdowns, progress digests
  db.exec(`
    CREATE TABLE IF NOT EXISTS rubric_rituals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,  -- ISO date of Monday
      title TEXT NOT NULL,
      description TEXT,
      category TEXT,
      channel_message_id INTEGER,
      participants INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ritual_week ON rubric_rituals(week_start);

    CREATE TABLE IF NOT EXISTS rubric_ritual_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ritual_id INTEGER NOT NULL REFERENCES rubric_rituals(id),
      telegram_user_id INTEGER NOT NULL,
      day_number INTEGER NOT NULL,  -- 1-7
      completed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(ritual_id, telegram_user_id, day_number)
    );
    CREATE INDEX IF NOT EXISTS idx_ritual_part_user ON rubric_ritual_participants(telegram_user_id);
  `);
}

// --- Captcha state (persistent) ---

export interface CaptchaRow {
  telegram_user_id: number;
  chat_id: string;
  answer: number;
  first_name: string;
  captcha_message_id: number | null;
  expires_at: string;
}

export function saveCaptcha(userId: number, chatId: number | string, answer: number, firstName: string, captchaMessageId: number, expiresAt: Date): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO pending_captchas (telegram_user_id, chat_id, answer, first_name, captcha_message_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, String(chatId), answer, firstName, captchaMessageId, expiresAt.toISOString());
}

export function getCaptcha(userId: number): CaptchaRow | null {
  return getDb().prepare(`SELECT * FROM pending_captchas WHERE telegram_user_id = ?`).get(userId) as CaptchaRow | null;
}

export function deleteCaptcha(userId: number): void {
  getDb().prepare(`DELETE FROM pending_captchas WHERE telegram_user_id = ?`).run(userId);
}

export function getExpiredCaptchas(): CaptchaRow[] {
  return getDb().prepare(`SELECT * FROM pending_captchas WHERE expires_at <= datetime('now')`).all() as CaptchaRow[];
}

// --- UGC conversation state (persistent) ---

export type UgcStep = 'waiting_link' | 'waiting_category' | 'waiting_difficulty' | 'waiting_title';

export interface UgcConversationRow {
  telegram_user_id: number;
  step: UgcStep;
  submission_id: number | null;
}

export function saveUgcState(userId: number, step: UgcStep, submissionId?: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO ugc_conversation_state (telegram_user_id, step, submission_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(userId, step, submissionId ?? null);
}

export function getUgcState(userId: number): UgcConversationRow | null {
  return getDb().prepare(`SELECT * FROM ugc_conversation_state WHERE telegram_user_id = ?`).get(userId) as UgcConversationRow | null;
}

export function deleteUgcState(userId: number): void {
  getDb().prepare(`DELETE FROM ugc_conversation_state WHERE telegram_user_id = ?`).run(userId);
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
    WHERE a.date = ? AND a.category = ? AND a.status = 'approved' AND a.deleted_at IS NULL
    ORDER BY a.decided_at DESC LIMIT 1
  `).get(date, category) as VideoRow | null;
}

export function setApprovalStatus(sessionId: number, status: 'approved' | 'rejected' | 'pending'): void {
  getDb().prepare(`
    UPDATE approval_sessions SET status = ?, decided_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
  `).run(status, sessionId);
}

export function getApprovalSessionByMessageId(messageId: number): { id: number; video_id: number; category: string; date: string } | null {
  return getDb().prepare(`
    SELECT id, video_id, category, date FROM approval_sessions WHERE message_id = ? AND deleted_at IS NULL
  `).get(messageId) as { id: number; video_id: number; category: string; date: string } | null;
}

export function getApprovalSessionById(sessionId: number): { id: number; video_id: number; category: string; date: string } | null {
  return getDb().prepare(`
    SELECT id, video_id, category, date FROM approval_sessions WHERE id = ? AND deleted_at IS NULL
  `).get(sessionId) as { id: number; video_id: number; category: string; date: string } | null;
}

export function resetApprovalSessions(date: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date = ? AND deleted_at IS NULL
  `).run(date);
  return result.changes;
}

export function setApprovalMessageId(sessionId: number, messageId: number): void {
  getDb().prepare(`UPDATE approval_sessions SET message_id = ? WHERE id = ? AND deleted_at IS NULL`).run(messageId, sessionId);
}

export function markApprovalPosted(date: string, category: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET status = 'posted', decided_at = datetime('now')
    WHERE date = ? AND category = ? AND status = 'approved' AND deleted_at IS NULL
  `).run(date, category);
  return result.changes;
}

export interface QueueItem {
  date: string;
  category: string;
  status: string;
  title: string;
  video_url: string;
}

export function getApprovalQueue(fromDate?: string, toDate?: string): QueueItem[] {
  const conditions = [`a.status IN ('approved', 'pending')`, `a.deleted_at IS NULL`];
  const params: string[] = [];

  if (fromDate) {
    conditions.push(`a.date >= ?`);
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push(`a.date <= ?`);
    params.push(toDate);
  }

  return getDb().prepare(`
    SELECT a.date, a.category, a.status, v.title, v.video_url
    FROM approval_sessions a
    JOIN videos v ON v.id = a.video_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.date ASC, CASE a.category
      WHEN 'stretching' THEN 1
      WHEN 'strength' THEN 2
      WHEN 'mobility' THEN 3
      ELSE 4 END
  `).all(...params) as QueueItem[];
}

/** Soft-delete old pending/approved sessions older than N days. */
export function cleanupOldApprovalSessions(olderThanDays: number = 2): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date < date('now', '-' || ? || ' days')
      AND status IN ('pending', 'approved')
      AND deleted_at IS NULL
  `).run(olderThanDays);
  return result.changes;
}

/** Soft-delete all non-posted sessions for a date — called after /post to clean up queue. */
export function cleanupUnpostedSessions(date: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date = ? AND status IN ('pending', 'approved') AND deleted_at IS NULL
  `).run(date);
  return result.changes;
}

/** Soft-delete pending sessions for a (date, category) pair — used before creating replacement. */
export function softDeletePendingSessions(date: string, category: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date = ? AND category = ? AND status = 'pending' AND deleted_at IS NULL
  `).run(date, category);
  return result.changes;
}

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

// --- Post helpers ---

export function recordPost(date: string, category: string, videoId: number, channelMessageId: number, postType: 'video' | 'link' = 'video'): number {
  const result = getDb().prepare(`
    INSERT INTO posts (date, category, video_id, channel_message_id, post_type) VALUES (?, ?, ?, ?, ?)
  `).run(date, category, videoId, channelMessageId, postType);
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

export interface PostTypeBreakdown {
  post_type: string;
  count: number;
}

export function getPostTypeBreakdown(date: string): PostTypeBreakdown[] {
  return getDb().prepare(`
    SELECT post_type, COUNT(*) as count FROM posts WHERE date = ? GROUP BY post_type
  `).all(date) as PostTypeBreakdown[];
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

export function getLastCompletionTime(userId: number): string | null {
  const row = getDb().prepare(
    `SELECT completed_at FROM completions WHERE telegram_user_id = ? ORDER BY completed_at DESC LIMIT 1`
  ).get(userId) as { completed_at: string } | undefined;
  return row?.completed_at ?? null;
}

export function getPostByMessageId(channelMessageId: number): { id: number; video_id: number; category: string; date: string } | null {
  return (getDb().prepare(
    `SELECT id, video_id, category, date FROM posts WHERE channel_message_id = ?`
  ).get(channelMessageId) as { id: number; video_id: number; category: string; date: string } | undefined) ?? null;
}

/** Fallback: find most recent post by video_id (for when message_id lookup fails, e.g. forwarded messages) */
export function getLatestPostByVideoId(videoId: number): { id: number; video_id: number; category: string; date: string } | null {
  return (getDb().prepare(
    `SELECT id, video_id, category, date FROM posts WHERE video_id = ? ORDER BY posted_at DESC LIMIT 1`
  ).get(videoId) as { id: number; video_id: number; category: string; date: string } | undefined) ?? null;
}

/** Save the bot's comment message_id in the discussion group */
export function setGroupCommentId(postId: number, groupCommentId: number): void {
  getDb().prepare('UPDATE posts SET group_comment_id = ? WHERE id = ?').run(groupCommentId, postId);
}

/** Find post by its group comment message_id */
export function getPostByGroupCommentId(commentId: number): { id: number; video_id: number; category: string; date: string } | null {
  return (getDb().prepare(
    `SELECT id, video_id, category, date FROM posts WHERE group_comment_id = ?`
  ).get(commentId) as { id: number; video_id: number; category: string; date: string } | undefined) ?? null;
}

// --- Rating ---

/**
 * Normalize like_ratio (typically 0.02-0.08) to 0..1 score.
 * 2% = mediocre (0.3), 4% = good (0.6), 6%+ = excellent (0.9+)
 */
function normalizeLikeRatio(ratio: number): number {
  if (ratio <= 0) return 0;
  // Map 0-0.08 range to 0-1 with diminishing returns
  return Math.min(Math.sqrt(ratio / 0.06), 1);
}

/**
 * Normalize view count to 0..1 score.
 * 10K = decent (0.5), 100K = good (0.75), 1M+ = excellent (1.0)
 */
function normalizeViews(viewCount: number): number {
  if (viewCount <= 0) return 0;
  // log10(10K)=4, log10(1M)=6 → map 4..6 to 0.5..1.0
  const log = Math.log10(viewCount);
  return Math.min(Math.max((log - 2) / 4, 0), 1); // 100 views = 0, 1M = 1.0
}

/**
 * Normalize completion count to 0..1 score.
 * 0 = 0, 3 = 0.5, 10+ = 1.0 (diminishing returns via sqrt)
 */
function normalizeCompletions(count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.sqrt(count / 10), 1);
}

/**
 * Get total completions across all posts for a given video.
 */
function getVideoCompletionCount(videoId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM completions WHERE video_id = ?`
  ).get(videoId) as { cnt: number };
  return row.cnt;
}

/**
 * Rating formula: YouTube metrics + Telegram engagement.
 *
 * Weights:
 *  35% view count (YouTube reach)
 *  30% like ratio (YouTube quality signal)
 *  20% channel authority
 *  15% completions (Telegram engagement — people who actually did the workout)
 */
export function computeRating(video: VideoRow): number {
  const viewScore = normalizeViews(video.view_count);
  const likeScore = normalizeLikeRatio(video.like_ratio ?? 0);
  const channelScore = video.channel_subscribers > 0
    ? Math.min(Math.log10(video.channel_subscribers) / 6, 1) // 1M subs = 1.0
    : 0.4;
  const completionScore = normalizeCompletions(getVideoCompletionCount(video.id));

  const raw =
    0.35 * viewScore +
    0.30 * likeScore +
    0.20 * channelScore +
    0.15 * completionScore;
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
  getDb().prepare(`UPDATE ugc_submissions SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values);
}

export function getUgcSubmission(id: number): UgcSubmission | null {
  return (getDb().prepare(`SELECT * FROM ugc_submissions WHERE id = ? AND deleted_at IS NULL`).get(id) as UgcSubmission | undefined) ?? null;
}

export function getUserDraftSubmission(userId: number): UgcSubmission | null {
  return getDb().prepare(
    `SELECT * FROM ugc_submissions WHERE telegram_user_id = ? AND status = 'draft' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`
  ).get(userId) as UgcSubmission | null;
}

export function deleteUgcSubmission(id: number): void {
  getDb().prepare(`UPDATE ugc_submissions SET deleted_at = datetime('now') WHERE id = ?`).run(id);
}

export function getUserSubmissions(userId: number, limit: number, offset: number): UgcSubmission[] {
  return getDb().prepare(`
    SELECT * FROM ugc_submissions
    WHERE telegram_user_id = ? AND status != 'draft' AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as UgcSubmission[];
}

export function getUserSubmissionTotal(userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM ugc_submissions WHERE telegram_user_id = ? AND status != 'draft' AND deleted_at IS NULL`
  ).get(userId) as { cnt: number };
  return row.cnt;
}

// --- Dashboard helpers ---

export function getPendingUgcCount(): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM ugc_submissions WHERE status = 'pending' AND deleted_at IS NULL`
  ).get() as { cnt: number };
  return row.cnt;
}

export function getLastStrategistTimestamp(): string | null {
  try {
    const row = getDb().prepare(
      `SELECT created_at FROM strategist_packets ORDER BY created_at DESC LIMIT 1`
    ).get() as { created_at: string } | undefined;
    return row?.created_at ?? null;
  } catch {
    return null;
  }
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

// --- Member levels ---

export type MemberLevel = 'новичок' | 'практик' | 'наставник';

export function getMemberLevel(userId: number): { level: MemberLevel; completions: number } {
  const row = getDb().prepare(
    `SELECT COALESCE(completions_total, 0) as completions FROM members WHERE telegram_user_id = ?`
  ).get(userId) as { completions: number } | undefined;

  const completions = row?.completions ?? 0;
  let level: MemberLevel = 'новичок';
  if (completions >= 30) level = 'наставник';
  else if (completions >= 10) level = 'практик';

  return { level, completions };
}

// --- Buddy invite ---

export function wasBuddyInviteSent(userId: number): boolean {
  const row = getDb().prepare(
    `SELECT buddy_invite_sent FROM members WHERE telegram_user_id = ?`
  ).get(userId) as { buddy_invite_sent: number } | undefined;
  return (row?.buddy_invite_sent ?? 0) === 1;
}

export function markBuddyInviteSent(userId: number): void {
  getDb().prepare(
    `UPDATE members SET buddy_invite_sent = 1 WHERE telegram_user_id = ?`
  ).run(userId);
}

export interface MemberProfile {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  fitness_goal: string | null;
  joined_at: string;
  completions_total: number;
}

export function getMemberProfile(userId: number): MemberProfile | null {
  return getDb().prepare(`
    SELECT telegram_user_id, username, first_name, fitness_goal, joined_at,
           COALESCE(completions_total, 0) as completions_total
    FROM members WHERE telegram_user_id = ?
  `).get(userId) as MemberProfile | null;
}

// --- New members tracking in DB ---

export function getNewMembersToday(date: string): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM members WHERE date(joined_at) = ?`
  ).get(date) as { cnt: number };
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

// --- Moderation log ---

export type ModAction = 'warn' | 'mute' | 'ban' | 'delete' | 'antiflood' | 'cooldown';

export function logModAction(userId: number, action: ModAction, reason: string, messageSnippet?: string): void {
  getDb().prepare(`
    INSERT INTO moderation_log (telegram_user_id, action, reason, message_snippet)
    VALUES (?, ?, ?, ?)
  `).run(userId, action, reason, messageSnippet?.slice(0, 200) ?? null);
}

export function getModLogCount(sinceDays: number = 7): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM moderation_log WHERE created_at > datetime('now', '-' || ? || ' days')`
  ).get(sinceDays) as { cnt: number };
  return row.cnt;
}

export function getRecentModActions(limit: number = 20): Array<{
  telegram_user_id: number; action: string; reason: string; message_snippet: string | null; created_at: string;
}> {
  return getDb().prepare(`
    SELECT telegram_user_id, action, reason, message_snippet, created_at
    FROM moderation_log ORDER BY id DESC LIMIT ?
  `).all(limit) as Array<{
    telegram_user_id: number; action: string; reason: string; message_snippet: string | null; created_at: string;
  }>;
}

// --- Stop phrases (dynamic spam list) ---

export function getStopPhrases(): string[] {
  const rows = getDb().prepare(`SELECT phrase FROM stop_phrases`).all() as Array<{ phrase: string }>;
  return rows.map(r => r.phrase);
}

export function addStopPhrase(phrase: string, addedBy: 'manual' | 'strategist' = 'manual'): boolean {
  try {
    getDb().prepare(`INSERT INTO stop_phrases (phrase, added_by) VALUES (?, ?)`).run(phrase.toLowerCase(), addedBy);
    return true;
  } catch {
    return false; // duplicate
  }
}

export function removeStopPhrase(phrase: string): boolean {
  const result = getDb().prepare(`DELETE FROM stop_phrases WHERE phrase = ?`).run(phrase.toLowerCase());
  return result.changes > 0;
}

// --- Member joined_at helper ---

export function getMemberJoinedAt(userId: number): string | null {
  const row = getDb().prepare(
    `SELECT joined_at FROM members WHERE telegram_user_id = ?`
  ).get(userId) as { joined_at: string } | undefined;
  return row?.joined_at ?? null;
}

// --- Implementor tasks ---

export type ImplTaskStatus = 'pending' | 'approved' | 'in_progress' | 'review' | 'done' | 'failed';
export type ImplTaskSource = 'strategist' | 'manual';

export interface ImplTask {
  id: number;
  title: string;
  spec: string;
  source: ImplTaskSource;
  status: ImplTaskStatus;
  priority: string;
  branch: string | null;
  commit_sha: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export function createImplTask(title: string, spec: string, source: ImplTaskSource = 'manual', priority: string = 'P2'): number {
  const result = getDb().prepare(`
    INSERT INTO impl_tasks (title, spec, source, priority)
    VALUES (?, ?, ?, ?)
  `).run(title, spec, source, priority);
  return Number(result.lastInsertRowid);
}

export function getImplTask(id: number): ImplTask | null {
  return (getDb().prepare(
    `SELECT * FROM impl_tasks WHERE id = ?`
  ).get(id) as ImplTask | undefined) ?? null;
}

/** Get the oldest approved task — next to be picked up by the implementor. */
export function getNextImplTask(): ImplTask | null {
  return (getDb().prepare(
    `SELECT * FROM impl_tasks WHERE status = 'approved' ORDER BY created_at ASC LIMIT 1`
  ).get() as ImplTask | undefined) ?? null;
}

export function updateImplTaskStatus(
  id: number,
  status: ImplTaskStatus,
  result?: string,
  branch?: string,
  commitSha?: string,
): void {
  getDb().prepare(`
    UPDATE impl_tasks
    SET status = ?, result = ?, branch = COALESCE(?, branch), commit_sha = COALESCE(?, commit_sha), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, result ?? null, branch ?? null, commitSha ?? null, id);
}

export function listImplTasks(status?: ImplTaskStatus): ImplTask[] {
  if (status) {
    return getDb().prepare(
      `SELECT * FROM impl_tasks WHERE status = ? ORDER BY created_at DESC`
    ).all(status) as ImplTask[];
  }
  return getDb().prepare(
    `SELECT * FROM impl_tasks ORDER BY created_at DESC`
  ).all() as ImplTask[];
}

// --- Rubrics ---

export interface RitualRow {
  id: number;
  week_start: string;
  title: string;
  description: string | null;
  category: string | null;
  channel_message_id: number | null;
  participants: number;
  created_at: string;
}

export function createRitual(weekStart: string, title: string, description?: string, category?: string): number {
  const result = getDb().prepare(
    `INSERT INTO rubric_rituals (week_start, title, description, category) VALUES (?, ?, ?, ?)`
  ).run(weekStart, title, description ?? null, category ?? null);
  return Number(result.lastInsertRowid);
}

export function getCurrentRitual(): RitualRow | null {
  return (getDb().prepare(
    `SELECT * FROM rubric_rituals ORDER BY week_start DESC LIMIT 1`
  ).get() as RitualRow | undefined) ?? null;
}

export function setRitualMessageId(ritualId: number, messageId: number): void {
  getDb().prepare('UPDATE rubric_rituals SET channel_message_id = ? WHERE id = ?').run(messageId, ritualId);
}

export function recordRitualParticipation(ritualId: number, userId: number, dayNumber: number): boolean {
  try {
    getDb().prepare(
      `INSERT INTO rubric_ritual_participants (ritual_id, telegram_user_id, day_number) VALUES (?, ?, ?)`
    ).run(ritualId, userId, dayNumber);
    // Update participant count
    const count = getDb().prepare(
      `SELECT COUNT(DISTINCT telegram_user_id) as cnt FROM rubric_ritual_participants WHERE ritual_id = ?`
    ).get(ritualId) as { cnt: number };
    getDb().prepare('UPDATE rubric_rituals SET participants = ? WHERE id = ?').run(count.cnt, ritualId);
    return true;
  } catch {
    return false; // duplicate
  }
}

export function getRitualProgress(ritualId: number, userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM rubric_ritual_participants WHERE ritual_id = ? AND telegram_user_id = ?`
  ).get(ritualId, userId) as { cnt: number };
  return row.cnt;
}

export function getRitualParticipantCount(ritualId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(DISTINCT telegram_user_id) as cnt FROM rubric_ritual_participants WHERE ritual_id = ?`
  ).get(ritualId) as { cnt: number };
  return row.cnt;
}

/** Get top active members for weekly progress digest */
export function getWeeklyTopMembers(weekStart: string, limit: number = 5): { telegram_user_id: number; username: string | null; first_name: string | null; count: number }[] {
  return getDb().prepare(`
    SELECT m.telegram_user_id, m.username, m.first_name, COUNT(*) as count
    FROM completions c
    JOIN members m ON m.telegram_user_id = c.telegram_user_id
    WHERE c.completed_at >= ?
    GROUP BY c.telegram_user_id
    ORDER BY count DESC
    LIMIT ?
  `).all(weekStart, limit) as { telegram_user_id: number; username: string | null; first_name: string | null; count: number }[];
}
