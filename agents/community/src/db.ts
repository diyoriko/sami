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

  // Invite links
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      clicks INTEGER DEFAULT 0,
      joins INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Join source column on members
  addColumn(db, 'members', 'join_source', 'TEXT');

  // Schema version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_info (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed initial schema version if table is empty
  const row = db.prepare('SELECT MAX(version) as v FROM schema_info').get() as { v: number | null } | undefined;
  if (!row || row.v === null) {
    db.prepare('INSERT INTO schema_info (version, name) VALUES (?, ?)').run(1, 'initial schema');
  }
}

// ─── Schema version helpers ─────────────────────────────────────────────────

/** Record a migration version. Idempotent — duplicate versions are ignored. */
export function recordMigration(version: number, name: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO schema_info (version, name) VALUES (?, ?)'
  ).run(version, name);
}

/** Return the highest applied schema version, or 0 if none. */
export function getSchemaVersion(): number {
  const row = getDb().prepare('SELECT MAX(version) as v FROM schema_info').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
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

// ─── Re-exports for backward compatibility ──────────────────────────────────
// All functions moved to sub-modules are re-exported here so that
// existing `import { ... } from './db'` statements continue to work.

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

export {
  type VideoRow,
  getVideoById,
  upsertVideo,
  wasPostedEver,
  computeRating,
  updateVideoRating,
  recordRejection,
  isVideoRejected,
  getRejectionCount,
  toggleFavorite,
  isUserFavorite,
  type FavoriteVideo,
  getUserFavorites,
  getUserFavoriteTotal,
  type FilteredVideo,
  filterVideos,
} from './db-videos';

export {
  type RecentPost,
  getRecentPosts,
  recordPost,
  getLatestPost,
  getLatestPostForDate,
  wasPostedToday,
  getRecentPostsByCategory,
  getPostCountForDate,
  getPostByMessageId,
  getLatestPostByVideoId,
  setGroupCommentId,
  getPostByGroupCommentId,
  type PostTypeBreakdown,
  getPostTypeBreakdown,
  recordCheckin,
  getCheckinStats,
  recordCheckinPost,
  recordCompletion,
  removeCompletion,
  getCompletionCount,
  hasUserCompleted,
  getLastCompletionTime,
  getUserStreak,
  getWeeklyConsistentUsers,
  type UserCompletion,
  getUserCompletions,
  getUserCompletionTotal,
  writeDailyStats,
  writeChannelStats,
  getChannelStats,
  getWeeklyStats,
  getCompletionCountForDate,
  getUniqueCompletionUsersForDate,
  type TopVideoByCompletions,
  getTopVideosByCompletions,
  getRetention,
  type CompletionsByCategory,
  getCompletionsByCategory,
  type CumulativeStats,
  getCumulativeStats,
  type PollOption,
  upsertPollResult,
  getPollResults,
  type DeployRecord,
  recordDeploy,
  getLatestDeploy,
  getDeployStats,
} from './db-posts';

export {
  upsertMember,
  setMemberGoal,
  addWarning,
  muteMember,
  type MemberLevel,
  getMemberLevel,
  wasBuddyInviteSent,
  markBuddyInviteSent,
  type MemberProfile,
  getMemberProfile,
  getNewMembersToday,
  getMemberJoinedAt,
  type InactiveUser,
  getInactiveUsers,
  markReminderSent,
  getWeeklyTopMembers,
  type CaptchaRow,
  saveCaptcha,
  getCaptcha,
  deleteCaptcha,
  getExpiredCaptchas,
  type UgcStep,
  type UgcConversationRow,
  saveUgcState,
  getUgcState,
  deleteUgcState,
  type UgcSubmission,
  isUgcDuplicate,
  createUgcSubmission,
  updateUgcSubmission,
  getUgcSubmission,
  getUserDraftSubmission,
  deleteUgcSubmission,
  getUserSubmissions,
  getUserSubmissionTotal,
  getPendingUgcCount,
  getLastStrategistTimestamp,
  type ModAction,
  logModAction,
  getModLogCount,
  getRecentModActions,
  getStopPhrases,
  addStopPhrase,
  removeStopPhrase,
  type ImplTaskStatus,
  type ImplTaskSource,
  type ImplTask,
  createImplTask,
  getImplTask,
  getNextImplTask,
  updateImplTaskStatus,
  listImplTasks,
  type RitualRow,
  createRitual,
  getCurrentRitual,
  setRitualMessageId,
  recordRitualParticipation,
  getRitualProgress,
  getRitualParticipantCount,
  setMemberJoinSource,
  type InviteLink,
  createInviteLink,
  getInviteLinks,
  incrementInviteLinkClicks,
  incrementInviteLinkJoins,
} from './db-members';

export {
  type ChallengeRow,
  type WeeklySlotRow,
  createChallenge,
  getActiveChallenge,
  getUpcomingChallenge,
  getLatestChallenge,
  activateChallenge,
  completeChallenge,
  ensureActiveChallenge,
  getChallengeDay,
  getChallengeWeekNumber,
  initWeekSlots,
  getWeekStatus,
  setWeekSlotVideo,
  getWeekSlotForDay,
  markWeekSlotPosted,
  clearWeekSlot,
  getNextEmptySlot,
  saveProposal,
  getApprovedProposals,
  updateProposalStatus,
  deleteProposals,
  type ChallengeSeriesRow,
  type ChallengeSeriesDayRow,
  createChallengeSeries,
  getChallengeSeries,
  getActiveChallengeSeriesList,
  listChallengeSeries,
  updateChallengeSeriesStatus,
  getChallengeSeriesDaySlot,
  getChallengeSeriesDaysStatus,
  setChallengeSeriesDayVideo,
  markChallengeSeriesDayPosted,
  clearChallengeSeriesDaySlot,
  joinChallengeSeries,
  isChallengeParticipant,
  getChallengeParticipantCount,
  recordChallengeCompletion,
  hasChallengeCompletion,
  removeChallengeCompletion,
  getChallengeCompletionCount,
  getUserChallengeProgress,
} from './db-challenges';
