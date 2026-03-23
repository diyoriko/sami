import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config';
import { createLogger } from './logger';
import { type Category, type Difficulty, CATEGORIES_SQL, DIFFICULTIES_SQL } from './shared';

const log = createLogger('db');

/** Safe ALTER TABLE ADD COLUMN — silences "duplicate column" only, logs real errors */
function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column')) {
      log.error(`migration failed: ALTER TABLE ${table} ADD COLUMN ${column}`, { error: msg });
    }
  }
}

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
        status TEXT CHECK(status IN ('draft','pending','approved','rejected','published')) DEFAULT 'draft',
        admin_message_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT,
        deleted_at TEXT,
        published_at TEXT
      );
      INSERT INTO ugc_submissions_v2 SELECT
        id, telegram_user_id, username, video_url, youtube_id, title,
        category, difficulty, status, admin_message_id, created_at, decided_at, deleted_at,
        CASE WHEN status = 'approved' THEN decided_at ELSE NULL END
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

function migrateUgcPublishedStatus(db: Database.Database): void {
  // Test if CHECK allows 'published' status
  try {
    db.exec(`INSERT INTO ugc_submissions (telegram_user_id, username, video_url, status) VALUES (0, '__test__', '__test__', 'published')`);
    db.exec(`DELETE FROM ugc_submissions WHERE username = '__test__'`);
    return; // Already supports 'published'
  } catch {
    // Need to rebuild
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`ALTER TABLE ugc_submissions RENAME TO ugc_submissions_old`);
    db.exec(`
      CREATE TABLE ugc_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        username TEXT,
        video_url TEXT NOT NULL,
        youtube_id TEXT,
        title TEXT,
        category TEXT CHECK(category IN (${CATEGORIES_SQL})),
        difficulty TEXT CHECK(difficulty IN (${DIFFICULTIES_SQL})),
        status TEXT CHECK(status IN ('draft','pending','approved','rejected','published')) DEFAULT 'draft',
        admin_message_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT,
        deleted_at TEXT,
        published_at TEXT,
        duration_seconds INTEGER,
        duration_label TEXT,
        muscles TEXT,
        equipment TEXT
      )
    `);
    db.exec(`INSERT INTO ugc_submissions SELECT * FROM ugc_submissions_old`);
    db.exec(`DROP TABLE ugc_submissions_old`);
    // Auto-fix: mark items with published_at as 'published'
    db.exec(`UPDATE ugc_submissions SET status = 'published' WHERE published_at IS NOT NULL AND status = 'approved'`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateApprovalPostedStatus(db: Database.Database): void {
  // Test if CHECK allows 'posted' status
  try {
    db.exec(`INSERT INTO approval_sessions (date, category, video_id, status) VALUES ('__test__', '__test__', NULL, 'posted')`);
    db.exec(`DELETE FROM approval_sessions WHERE date = '__test__'`);
    return; // Already supports 'posted'
  } catch {
    // Need to rebuild
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`ALTER TABLE approval_sessions RENAME TO approval_sessions_old`);
    db.exec(`
      CREATE TABLE approval_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        category TEXT NOT NULL,
        video_id INTEGER REFERENCES videos(id),
        status TEXT CHECK(status IN ('pending','approved','rejected','posted')) DEFAULT 'pending',
        message_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT,
        deleted_at TEXT,
        challenge_context TEXT
      )
    `);
    db.exec(`INSERT INTO approval_sessions SELECT * FROM approval_sessions_old`);
    db.exec(`DROP TABLE approval_sessions_old`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrate(db: Database.Database): void {
  // Migrations for older schemas
  addColumn(db, 'videos', 'view_count', 'INTEGER DEFAULT 0');
  addColumn(db, 'videos', 'rating', 'REAL DEFAULT 0');
  addColumn(db, 'videos', 'like_ratio', 'REAL DEFAULT 0');
  addColumn(db, 'videos', 'channel_subscribers', 'INTEGER DEFAULT 0');
  addColumn(db, 'posts', 'post_type', "TEXT DEFAULT 'video'");
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

    CREATE INDEX IF NOT EXISTS idx_completions_video_id ON completions(video_id);
    CREATE INDEX IF NOT EXISTS idx_completions_user_date ON completions(telegram_user_id, completed_at);

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
      status TEXT CHECK(status IN ('draft','pending','approved','rejected','published')) DEFAULT 'draft',
      admin_message_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT,
      published_at TEXT
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
  addColumn(db, 'members', 'last_activity_at', 'TEXT');
  addColumn(db, 'members', 'completions_total', 'INTEGER DEFAULT 0');
  addColumn(db, 'members', 'buddy_invite_sent', 'INTEGER DEFAULT 0');
  addColumn(db, 'members', 'reminder_sent_at', 'TEXT');
  addColumn(db, 'posts', 'group_comment_id', 'INTEGER');
  addColumn(db, 'ugc_submissions', 'deleted_at', 'TEXT');
  addColumn(db, 'approval_sessions', 'deleted_at', 'TEXT');
  addColumn(db, 'ugc_submissions', 'published_at', 'TEXT');
  addColumn(db, 'ugc_submissions', 'duration_seconds', 'INTEGER');
  addColumn(db, 'ugc_submissions', 'duration_label', 'TEXT');
  addColumn(db, 'ugc_submissions', 'muscles', 'TEXT');
  addColumn(db, 'ugc_submissions', 'equipment', 'TEXT');
  addColumn(db, 'ugc_submissions', 'rubric', 'TEXT');
  addColumn(db, 'approval_sessions', 'challenge_context', 'TEXT');

  // Migration: rebuild tables with updated CHECK constraints (added yoga, breathing, recovery, cardio)
  migrateCheckConstraints(db);

  // Migration: allow 'published' status in ugc_submissions
  migrateUgcPublishedStatus(db);

  // Migration: allow 'posted' status in approval_sessions
  migrateApprovalPostedStatus(db);

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

  // Challenges — 21-day challenge cycles
  db.exec(`
    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER UNIQUE NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT CHECK(status IN ('active','completed','upcoming')) DEFAULT 'upcoming',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);

    CREATE TABLE IF NOT EXISTS weekly_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id),
      day_number INTEGER NOT NULL,
      video_id INTEGER REFERENCES videos(id),
      status TEXT CHECK(status IN ('empty','queued','posted')) DEFAULT 'empty',
      queued_at TEXT,
      posted_at TEXT,
      UNIQUE(challenge_id, day_number)
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_schedule_lookup ON weekly_schedule(challenge_id, status);
  `);

  // Challenge columns on posts
  addColumn(db, 'posts', 'challenge_id', 'INTEGER REFERENCES challenges(id)');
  addColumn(db, 'posts', 'challenge_day', 'INTEGER');

  // Migration: rename old tables/columns if they exist (idempotent)
  try { db.exec(`ALTER TABLE seasons RENAME TO challenges`); } catch { /* already renamed */ }
  try { db.exec(`ALTER TABLE season_queue RENAME TO weekly_schedule`); } catch { /* already renamed */ }
  try { db.exec(`ALTER TABLE posts RENAME COLUMN season_id TO challenge_id`); } catch { /* already renamed */ }
  try { db.exec(`ALTER TABLE posts RENAME COLUMN season_day TO challenge_day`); } catch { /* already renamed */ }
  try { db.exec(`ALTER TABLE weekly_schedule RENAME COLUMN season_id TO challenge_id`); } catch { /* already renamed */ }

  // Named challenge series (parallel to weekly schedule)
  db.exec(`
    CREATE TABLE IF NOT EXISTS challenge_series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 90),
      default_category TEXT,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      publish_time TEXT DEFAULT '09:00',
      status TEXT CHECK(status IN ('draft','active','completed','cancelled')) DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_challenge_series_status ON challenge_series(status);

    CREATE TABLE IF NOT EXISTS challenge_series_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenge_series(id),
      day_number INTEGER NOT NULL CHECK(day_number >= 1),
      video_id INTEGER REFERENCES videos(id),
      category TEXT,
      status TEXT CHECK(status IN ('empty','queued','posted')) DEFAULT 'empty',
      queued_at TEXT,
      posted_at TEXT,
      UNIQUE(challenge_id, day_number)
    );
    CREATE INDEX IF NOT EXISTS idx_cs_days_lookup ON challenge_series_days(challenge_id, status);

    CREATE TABLE IF NOT EXISTS challenge_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenge_series(id),
      telegram_user_id INTEGER NOT NULL,
      joined_at TEXT DEFAULT (datetime('now')),
      UNIQUE(challenge_id, telegram_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_lookup ON challenge_participants(challenge_id);
    CREATE INDEX IF NOT EXISTS idx_cp_user ON challenge_participants(telegram_user_id);

    CREATE TABLE IF NOT EXISTS challenge_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenge_series(id),
      day_number INTEGER NOT NULL,
      telegram_user_id INTEGER NOT NULL,
      completed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(challenge_id, day_number, telegram_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cc_lookup ON challenge_completions(challenge_id, telegram_user_id);
  `);

  // Challenge series columns on posts
  addColumn(db, 'posts', 'challenge_series_id', 'INTEGER REFERENCES challenge_series(id)');
  addColumn(db, 'posts', 'challenge_series_day', 'INTEGER');

  // Ensure UNIQUE index exists on posts (may be missing if table was created before constraint was added)
  // Clean up any duplicate rows first to prevent index creation failure
  try {
    db.exec(`DELETE FROM posts WHERE id NOT IN (SELECT MIN(id) FROM posts GROUP BY date, category, video_id)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_date_cat_vid ON posts(date, category, video_id)`);
  } catch { /* index already exists via table constraint — ok */ }

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

  // Poll results — stores aggregated results from Telegram poll updates
  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id TEXT UNIQUE NOT NULL,
      question TEXT NOT NULL,
      total_voters INTEGER DEFAULT 0,
      options_json TEXT NOT NULL,  -- JSON: [{text, voter_count}]
      season_number INTEGER,
      week_number INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_poll_season ON poll_results(season_number);
  `);

  // Proposals — strategist backlog proposals with admin approval via Telegram buttons
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY,
      task_text TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
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

export type UgcStep = 'waiting_link' | 'waiting_category' | 'waiting_difficulty' | 'waiting_duration' | 'waiting_equipment' | 'waiting_rubric' | 'waiting_title' | 'cs_name' | 'cs_duration' | 'cs_category';

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

export function getVideoById(id: number): VideoRow | null {
  return getDb().prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | null;
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

// --- Approval helpers (moved to db-approval.ts, re-exported for backward compatibility) ---
export {
  createApprovalSession,
  getApprovedVideo,
  setApprovalStatus,
  getApprovalSessionByMessageId,
  getApprovalSessionById,
  resetApprovalSessions,
  setApprovalMessageId,
  markApprovalPosted,
  storeChallengeContext,
  getChallengeContext,
  clearChallengeContext,
  getApprovalQueue,
  cleanupOldApprovalSessions,
  cleanupUnpostedSessions,
  softDeletePendingSessions,
  type QueueItem,
} from './db-approval';

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
  duration_seconds: number | null;
  duration_label: string | null;
  muscles: string | null;
  equipment: string | null;
  rubric: string | null;
  status: string;
  admin_message_id: number | null;
  created_at: string;
  decided_at: string | null;
  published_at: string | null;
}

export function isUgcDuplicate(youtubeId: string): boolean {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM ugc_submissions WHERE youtube_id = ? AND deleted_at IS NULL`
  ).get(youtubeId) as { cnt: number };
  return row.cnt > 0;
}

export function createUgcSubmission(userId: number, username: string | null, videoUrl: string, youtubeId: string | null): number {
  const result = getDb().prepare(`
    INSERT INTO ugc_submissions (telegram_user_id, username, video_url, youtube_id)
    VALUES (?, ?, ?, ?)
  `).run(userId, username, videoUrl, youtubeId);
  return Number(result.lastInsertRowid);
}

export function updateUgcSubmission(id: number, fields: Partial<Pick<UgcSubmission, 'title' | 'category' | 'difficulty' | 'duration_seconds' | 'duration_label' | 'muscles' | 'equipment' | 'rubric' | 'status' | 'admin_message_id' | 'published_at'>>): void {
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
    WHERE telegram_user_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as UgcSubmission[];
}

export function getUserSubmissionTotal(userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM ugc_submissions WHERE telegram_user_id = ? AND deleted_at IS NULL`
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
  } catch (err) {
    log.warn('failed to get last strategist timestamp', { error: String(err) });
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

// --- Inactive users (48h reminder) ---

export interface InactiveUser {
  telegram_user_id: number;
  first_name: string;
  last_activity_at: string;
}

/**
 * Get users who completed at least 1 workout but haven't been active for `hours` hours.
 * Excludes users who were already reminded (reminder_sent_at within last 72h).
 */
export function getInactiveUsers(hours: number): InactiveUser[] {
  return getDb().prepare(`
    SELECT m.telegram_user_id, COALESCE(m.first_name, 'Участник') as first_name, m.last_activity_at
    FROM members m
    WHERE m.completions_total >= 1
      AND m.last_activity_at IS NOT NULL
      AND datetime(m.last_activity_at) < datetime('now', '-' || ? || ' hours')
      AND (m.reminder_sent_at IS NULL OR datetime(m.reminder_sent_at) < datetime('now', '-72 hours'))
  `).all(hours) as InactiveUser[];
}

export function markReminderSent(userId: number): void {
  getDb().prepare(
    `UPDATE members SET reminder_sent_at = datetime('now') WHERE telegram_user_id = ?`
  ).run(userId);
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

// ─── SEASONS ────────────────────────────────────────────────────────────────

export interface ChallengeRow {
  id: number;
  number: number;
  start_date: string;
  end_date: string;
  status: 'active' | 'completed' | 'upcoming';
  created_at: string;
}

export interface WeeklySlotRow {
  id: number;
  challenge_id: number;
  day_number: number;
  video_id: number | null;
  status: 'empty' | 'queued' | 'posted';
  queued_at: string | null;
  posted_at: string | null;
}

export function createChallenge(num: number, startDate: string, endDate: string): number {
  const info = getDb().prepare(
    `INSERT INTO challenges (number, start_date, end_date, status) VALUES (?, ?, ?, 'upcoming')`
  ).run(num, startDate, endDate);
  return Number(info.lastInsertRowid);
}

export function getActiveChallenge(): ChallengeRow | null {
  return getDb().prepare(`SELECT * FROM challenges WHERE status = 'active' LIMIT 1`).get() as ChallengeRow | null;
}

export function getUpcomingChallenge(): ChallengeRow | null {
  return getDb().prepare(`SELECT * FROM challenges WHERE status = 'upcoming' ORDER BY start_date LIMIT 1`).get() as ChallengeRow | null;
}

export function getLatestChallenge(): ChallengeRow | null {
  return getDb().prepare(`SELECT * FROM challenges ORDER BY number DESC LIMIT 1`).get() as ChallengeRow | null;
}

export function activateChallenge(challengeId: number): void {
  getDb().prepare(`UPDATE challenges SET status = 'active' WHERE id = ?`).run(challengeId);
}

export function completeChallenge(challengeId: number): void {
  getDb().prepare(`UPDATE challenges SET status = 'completed' WHERE id = ?`).run(challengeId);
}

/**
 * Ensure there is an active challenge covering today.
 * - If active challenge covers today → return it.
 * - If active challenge does NOT cover today → complete it, create new one.
 * - If upcoming.start_date === weekStart → activate or return it.
 * - Otherwise → create a new challenge for weekStart.
 */
export function ensureActiveChallenge(today: string, weekStart: string): ChallengeRow {
  const active = getActiveChallenge();
  if (active) {
    // Check if active challenge still covers today
    if (active.start_date <= today && active.end_date >= today) {
      return active;
    }
    // Active challenge no longer covers today — complete it
    completeChallenge(active.id);
  }

  const upcoming = getUpcomingChallenge();
  if (upcoming && upcoming.start_date === weekStart) {
    if (upcoming.start_date <= today) {
      activateChallenge(upcoming.id);
      return { ...upcoming, status: 'active' };
    }
    return upcoming; // not yet started
  }

  // Create new challenge for this week
  const latest = getLatestChallenge();
  const num = latest ? latest.number + 1 : 1;
  const start = weekStart;
  const end = addDaysStr(start, 6); // 7 days: day 0..6
  const id = createChallenge(num, start, end);
  const created: ChallengeRow = { id, number: num, start_date: start, end_date: end, status: 'upcoming', created_at: '' };
  if (start <= today) {
    activateChallenge(id);
    return { ...created, status: 'active' };
  }
  return created;
}

/** Simple date+days helper for DB layer (no dependency on dates.ts at module level) */
function addDaysStr(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Compute challenge day (1-21) from today's date and challenge start */
export function getChallengeDay(challengeStartDate: string, today: string): number {
  const start = new Date(challengeStartDate + 'T00:00:00');
  const now = new Date(today + 'T00:00:00');
  return Math.round((now.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** Which week of the challenge — always 1 now (7-day cycles) */
export function getChallengeWeekNumber(_challengeDay: number): 1 | 2 | 3 {
  return 1;
}

// --- Weekly schedule ---

/** Create 7 empty slots for a week (idempotent) */
export function initWeekSlots(challengeId: number, weekNumber: 1 | 2 | 3): void {
  const startDay = (weekNumber - 1) * 7 + 1;
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO weekly_schedule (challenge_id, day_number, status) VALUES (?, ?, 'empty')`
  );
  for (let d = startDay; d < startDay + 7; d++) {
    stmt.run(challengeId, d);
  }
}

/** Get all 7 slots for a week with video info */
export function getWeekStatus(challengeId: number, weekNumber: 1 | 2 | 3): (WeeklySlotRow & { title?: string })[] {
  const startDay = (weekNumber - 1) * 7 + 1;
  const endDay = startDay + 6;
  return getDb().prepare(`
    SELECT sq.*, v.title
    FROM weekly_schedule sq
    LEFT JOIN videos v ON v.id = sq.video_id
    WHERE sq.challenge_id = ? AND sq.day_number BETWEEN ? AND ?
    ORDER BY sq.day_number
  `).all(challengeId, startDay, endDay) as (WeeklySlotRow & { title?: string })[];
}

/** Fill a queue slot with a video */
export function setWeekSlotVideo(challengeId: number, dayNumber: number, videoId: number): void {
  getDb().prepare(`
    UPDATE weekly_schedule SET video_id = ?, status = 'queued', queued_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(videoId, challengeId, dayNumber);
}

/** Get queue entry for a specific day */
export function getWeekSlotForDay(challengeId: number, dayNumber: number): WeeklySlotRow | null {
  return getDb().prepare(
    `SELECT * FROM weekly_schedule WHERE challenge_id = ? AND day_number = ?`
  ).get(challengeId, dayNumber) as WeeklySlotRow | null;
}

/** Mark a queue slot as posted */
export function markWeekSlotPosted(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE weekly_schedule SET status = 'posted', posted_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(challengeId, dayNumber);
}

/** Reset a slot to empty (for replacing a queued video) */
export function clearWeekSlot(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE weekly_schedule SET video_id = NULL, status = 'empty', queued_at = NULL
    WHERE challenge_id = ? AND day_number = ? AND status = 'queued'
  `).run(challengeId, dayNumber);
}

/** Find first empty slot in a week */
export function getNextEmptySlot(challengeId: number, weekNumber: 1 | 2 | 3): WeeklySlotRow | null {
  const startDay = (weekNumber - 1) * 7 + 1;
  const endDay = startDay + 6;
  return getDb().prepare(`
    SELECT * FROM weekly_schedule
    WHERE challenge_id = ? AND day_number BETWEEN ? AND ? AND status = 'empty'
    ORDER BY day_number LIMIT 1
  `).get(challengeId, startDay, endDay) as WeeklySlotRow | null;
}

// ─── PROPOSALS (strategist → admin approval → backlog) ──────────────────────

export function saveProposal(taskText: string): number {
  return Number(getDb().prepare(`INSERT INTO proposals (task_text, status) VALUES (?, 'pending')`).run(taskText).lastInsertRowid);
}
export function getApprovedProposals(): { id: number; task_text: string }[] {
  return getDb().prepare(`SELECT id, task_text FROM proposals WHERE status = 'approved'`).all() as any[];
}
export function updateProposalStatus(id: number, status: 'approved' | 'rejected'): void {
  getDb().prepare(`UPDATE proposals SET status = ? WHERE id = ?`).run(status, id);
}
export function deleteProposals(ids: number[]): void {
  if (!ids.length) return;
  getDb().prepare(`DELETE FROM proposals WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

// ─── CHALLENGE SERIES (named challenges, parallel to weekly schedule) ────────

export interface ChallengeSeriesRow {
  id: number; name: string; duration_days: number; default_category: string | null;
  description: string | null; start_date: string; end_date: string;
  publish_time: string; status: 'draft' | 'active' | 'completed' | 'cancelled';
  created_at: string;
}

export interface ChallengeSeriesDayRow {
  id: number; challenge_id: number; day_number: number; video_id: number | null;
  category: string | null; status: 'empty' | 'queued' | 'posted';
  queued_at: string | null; posted_at: string | null;
}

export function createChallengeSeries(
  name: string, durationDays: number, startDate: string,
  opts?: { defaultCategory?: string; description?: string; publishTime?: string },
): number {
  const endDate = (() => {
    const d = new Date(startDate + 'T00:00:00');
    d.setDate(d.getDate() + durationDays - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const id = Number(getDb().prepare(`
    INSERT INTO challenge_series (name, duration_days, default_category, description, start_date, end_date, publish_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, durationDays, opts?.defaultCategory ?? null, opts?.description ?? null,
    startDate, endDate, opts?.publishTime ?? '09:00').lastInsertRowid);

  // Pre-create day slots
  const db = getDb();
  const stmt = db.prepare(`INSERT OR IGNORE INTO challenge_series_days (challenge_id, day_number, category) VALUES (?, ?, ?)`);
  for (let d = 1; d <= durationDays; d++) {
    stmt.run(id, d, opts?.defaultCategory ?? null);
  }
  return id;
}

export function getChallengeSeries(id: number): ChallengeSeriesRow | null {
  return (getDb().prepare(`SELECT * FROM challenge_series WHERE id = ?`).get(id) as ChallengeSeriesRow | undefined) ?? null;
}

export function getActiveChallengeSeriesList(): ChallengeSeriesRow[] {
  return getDb().prepare(`SELECT * FROM challenge_series WHERE status = 'active' ORDER BY start_date`).all() as ChallengeSeriesRow[];
}

export function listChallengeSeries(statuses?: string[]): ChallengeSeriesRow[] {
  if (!statuses?.length) return getDb().prepare(`SELECT * FROM challenge_series ORDER BY created_at DESC`).all() as ChallengeSeriesRow[];
  const placeholders = statuses.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM challenge_series WHERE status IN (${placeholders}) ORDER BY created_at DESC`).all(...statuses) as ChallengeSeriesRow[];
}

export function updateChallengeSeriesStatus(id: number, status: 'draft' | 'active' | 'completed' | 'cancelled'): void {
  getDb().prepare(`UPDATE challenge_series SET status = ? WHERE id = ?`).run(status, id);
}

export function getChallengeSeriesDaySlot(challengeId: number, dayNumber: number): (ChallengeSeriesDayRow & { title?: string }) | null {
  return (getDb().prepare(`
    SELECT d.*, v.title FROM challenge_series_days d
    LEFT JOIN videos v ON v.id = d.video_id
    WHERE d.challenge_id = ? AND d.day_number = ?
  `).get(challengeId, dayNumber) as (ChallengeSeriesDayRow & { title?: string }) | undefined) ?? null;
}

export function getChallengeSeriesDaysStatus(challengeId: number): (ChallengeSeriesDayRow & { title?: string })[] {
  return getDb().prepare(`
    SELECT d.*, v.title FROM challenge_series_days d
    LEFT JOIN videos v ON v.id = d.video_id
    WHERE d.challenge_id = ?
    ORDER BY d.day_number
  `).all(challengeId) as (ChallengeSeriesDayRow & { title?: string })[];
}

export function setChallengeSeriesDayVideo(challengeId: number, dayNumber: number, videoId: number, category?: string): void {
  getDb().prepare(`
    UPDATE challenge_series_days SET video_id = ?, category = COALESCE(?, category), status = 'queued', queued_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(videoId, category ?? null, challengeId, dayNumber);
}

export function markChallengeSeriesDayPosted(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE challenge_series_days SET status = 'posted', posted_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(challengeId, dayNumber);
}

export function clearChallengeSeriesDaySlot(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE challenge_series_days SET video_id = NULL, status = 'empty', queued_at = NULL
    WHERE challenge_id = ? AND day_number = ? AND status = 'queued'
  `).run(challengeId, dayNumber);
}

// --- Participants ---

export function joinChallengeSeries(challengeId: number, userId: number): boolean {
  try {
    getDb().prepare(`INSERT INTO challenge_participants (challenge_id, telegram_user_id) VALUES (?, ?)`).run(challengeId, userId);
    return true;
  } catch { return false; } // UNIQUE constraint = already joined
}

export function isChallengeParticipant(challengeId: number, userId: number): boolean {
  const row = getDb().prepare(`SELECT 1 FROM challenge_participants WHERE challenge_id = ? AND telegram_user_id = ?`).get(challengeId, userId);
  return !!row;
}

export function getChallengeParticipantCount(challengeId: number): number {
  return (getDb().prepare(`SELECT COUNT(*) as cnt FROM challenge_participants WHERE challenge_id = ?`).get(challengeId) as { cnt: number }).cnt;
}

// --- Completions ---

export function recordChallengeCompletion(challengeId: number, dayNumber: number, userId: number): boolean {
  try {
    getDb().prepare(`INSERT INTO challenge_completions (challenge_id, day_number, telegram_user_id) VALUES (?, ?, ?)`).run(challengeId, dayNumber, userId);
    return true;
  } catch { return false; } // UNIQUE constraint = already completed
}

export function hasChallengeCompletion(challengeId: number, dayNumber: number, userId: number): boolean {
  return !!getDb().prepare(`SELECT 1 FROM challenge_completions WHERE challenge_id = ? AND day_number = ? AND telegram_user_id = ?`).get(challengeId, dayNumber, userId);
}

export function removeChallengeCompletion(challengeId: number, dayNumber: number, userId: number): boolean {
  return getDb().prepare(`DELETE FROM challenge_completions WHERE challenge_id = ? AND day_number = ? AND telegram_user_id = ?`).run(challengeId, dayNumber, userId).changes > 0;
}

export function getChallengeCompletionCount(challengeId: number, dayNumber: number): number {
  return (getDb().prepare(`SELECT COUNT(*) as cnt FROM challenge_completions WHERE challenge_id = ? AND day_number = ?`).get(challengeId, dayNumber) as { cnt: number }).cnt;
}

export function getUserChallengeProgress(challengeId: number, userId: number): { completed: number; total: number } {
  const series = getChallengeSeries(challengeId);
  const total = series?.duration_days ?? 0;
  const completed = (getDb().prepare(
    `SELECT COUNT(*) as cnt FROM challenge_completions WHERE challenge_id = ? AND telegram_user_id = ?`
  ).get(challengeId, userId) as { cnt: number }).cnt;
  return { completed, total };
}

// ─── WIPE ALL DATA ──────────────────────────────────────────────────────────

/** Delete all user-generated data. Keeps schema, config, stop_phrases. */
export function wipeAllData(): { tables: string[]; deleted: Record<string, number> } {
  const db = getDb();
  const tables = [
    'videos', 'completions', 'approval_sessions', 'posts',
    'ugc_submissions', 'ugc_conversation_state',
    'challenges', 'weekly_schedule',
    'members', 'user_favorites',
    'pending_captchas', 'moderation_log', 'video_rejections',
    'channel_stats', 'daily_stats', 'deploy_history',
    'strategist_packets', 'strategist_actions',
    'impl_tasks', 'rubric_rituals', 'rubric_ritual_participants', 'proposals',
    'challenge_series', 'challenge_series_days', 'challenge_participants', 'challenge_completions',
  ];
  const deleted: Record<string, number> = {};
  db.transaction(() => {
    // Disable FK checks for clean delete order
    db.pragma('foreign_keys = OFF');
    for (const t of tables) {
      try {
        const info = db.prepare(`DELETE FROM ${t}`).run();
        deleted[t] = info.changes;
      } catch { /* table may not exist */ }
    }
    db.pragma('foreign_keys = ON');
  })();
  return { tables, deleted };
}
