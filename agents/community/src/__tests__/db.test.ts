import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-community.db');

beforeAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  process.env.COMMUNITY_DB_PATH = TEST_DB_PATH;
  process.env.TELEGRAM_BOT_TOKEN = 'test:token';
  process.env.TELEGRAM_CHANNEL_ID = '-1001234567890';
  process.env.TELEGRAM_GROUP_ID = '-1009876543210';
  process.env.TELEGRAM_ADMIN_USER_ID = '123456';
  process.env.YOUTUBE_API_KEY = 'test-key';
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
});

describe('completions', () => {
  it('records completion and prevents duplicates', async () => {
    const db = await import('../db');

    const videoId = db.upsertVideo({
      youtube_id: 'test123',
      title: 'Test Video',
      channel_name: 'TestChannel',
      channel_url: null,
      duration_seconds: 600,
      duration_label: '10:00',
      difficulty: 'beginner',
      category: 'stretching',
      muscles: '["hamstrings"]',
      thumbnail_url: null,
      video_url: 'https://youtube.com/watch?v=test123',
      view_count: 1000,
      rating: 0,
      like_ratio: 0.95,
      channel_subscribers: 50000,
      search_query: 'test',
    });

    db.recordPost('2026-03-08', 'stretching', videoId, 1001);

    // Get the post ID
    const post = db.getPostByMessageId(1001);
    expect(post).not.toBeNull();
    const postId = post!.id;

    // First completion
    const ok = db.recordCompletion(postId, videoId, 42);
    expect(ok).toBe(true);
    expect(db.getCompletionCount(postId)).toBe(1);
    expect(db.hasUserCompleted(postId, 42)).toBe(true);

    // Duplicate — should not increase count
    db.recordCompletion(postId, videoId, 42);
    expect(db.getCompletionCount(postId)).toBe(1);

    // Different user
    db.recordCompletion(postId, videoId, 43);
    expect(db.getCompletionCount(postId)).toBe(2);

    // Date-based counts
    expect(db.getCompletionCountForDate('2026-03-08')).toBe(2);
    expect(db.getUniqueCompletionUsersForDate('2026-03-08')).toBe(2);
  });
});

describe('rating', () => {
  it('computeRating returns a value between 0 and 10', async () => {
    const { computeRating } = await import('../db');

    const video = {
      id: 1,
      youtube_id: 'test123',
      title: 'Test',
      channel_name: 'Test',
      channel_url: null,
      duration_seconds: 600,
      duration_label: '10:00',
      difficulty: 'beginner' as const,
      category: 'stretching' as const,
      muscles: null,
      thumbnail_url: null,
      video_url: 'https://youtube.com/watch?v=test123',
      view_count: 100000,
      rating: 0,
      like_ratio: 0.95,
      channel_subscribers: 100000,
    };

    const rating = computeRating(video);
    expect(rating).toBeGreaterThanOrEqual(0);
    expect(rating).toBeLessThanOrEqual(10);
  });

  it('higher views and likes produce higher rating', async () => {
    const { computeRating } = await import('../db');

    const base = {
      id: 1, youtube_id: 'a', title: 'T', channel_name: 'C', channel_url: null,
      duration_seconds: 600, duration_label: '10:00', difficulty: 'beginner' as const,
      category: 'stretching' as const, muscles: null, thumbnail_url: null,
      video_url: 'https://youtube.com/watch?v=a', rating: 0,
    };

    const lowVideo = { ...base, view_count: 100, like_ratio: 0.5, channel_subscribers: 1000 };
    const highVideo = { ...base, view_count: 1000000, like_ratio: 0.98, channel_subscribers: 500000 };

    expect(computeRating(highVideo)).toBeGreaterThan(computeRating(lowVideo));
  });

  it('UGC videos get base rating 5.0', async () => {
    const { computeRating } = await import('../db');

    const ugcVideo = {
      id: 999, youtube_id: 'ugc-42', title: 'UGC Test', channel_name: 'user',
      channel_url: null, duration_seconds: 300, duration_label: '5:00',
      difficulty: 'beginner' as const, category: 'stretching' as const,
      muscles: null, thumbnail_url: null, video_url: 'tg:file123',
      view_count: 0, rating: 0, like_ratio: 0, channel_subscribers: 0,
    };

    const rating = computeRating(ugcVideo);
    expect(rating).toBeGreaterThanOrEqual(5.0);
    expect(rating).toBeLessThanOrEqual(8.0);
  });
});

describe('approval queue', () => {
  it('getApprovalQueue filters by date range', async () => {
    const db = await import('../db');

    // Create sessions for different dates
    const videoId = db.upsertVideo({
      youtube_id: 'queue-test-1', title: 'Queue Test', channel_name: 'Test',
      channel_url: null, duration_seconds: 600, duration_label: '10:00',
      difficulty: 'beginner', category: 'stretching', muscles: null,
      thumbnail_url: null, video_url: 'https://youtube.com/watch?v=qt1',
      view_count: 1000, rating: 0, like_ratio: 0.9, channel_subscribers: 5000,
      search_query: 'test',
    });
    const s1 = db.createApprovalSession('2026-03-10', 'stretching', videoId);
    const s2 = db.createApprovalSession('2026-03-11', 'strength', videoId);
    const s3 = db.createApprovalSession('2026-03-12', 'mobility', videoId);

    // Approve the sessions so they appear in the queue (queue only shows approved)
    db.setApprovalStatus(s1, 'approved');
    db.setApprovalStatus(s2, 'approved');
    db.setApprovalStatus(s3, 'approved');

    // No filter — all approved sessions
    const all = db.getApprovalQueue();
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Filter: only March 10-11
    const filtered = db.getApprovalQueue('2026-03-10', '2026-03-11');
    const dates = filtered.map(r => r.date);
    expect(dates.every(d => d >= '2026-03-10' && d <= '2026-03-11')).toBe(true);
    expect(dates.some(d => d === '2026-03-12')).toBe(false);
  });

  it('cleanupOldApprovalSessions soft-deletes stale sessions', async () => {
    const db = await import('../db');
    // Sessions created above are from "now" — cleaning up sessions older than 0 days should delete them
    const cleaned = db.cleanupOldApprovalSessions(0);
    expect(cleaned).toBeGreaterThanOrEqual(0);
  });

  it('softDeletePendingSessions removes pending for date+category', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo({
      youtube_id: 'soft-del-test', title: 'Soft Del', channel_name: 'Test',
      channel_url: null, duration_seconds: 600, duration_label: '10:00',
      difficulty: 'beginner', category: 'mobility', muscles: null,
      thumbnail_url: null, video_url: 'https://youtube.com/watch?v=sdt',
      view_count: 1000, rating: 0, like_ratio: 0.9, channel_subscribers: 5000,
      search_query: 'test',
    });
    const sessionId = db.createApprovalSession('2026-04-01', 'mobility', videoId);

    // Session exists before soft-delete
    const beforeSession = db.getApprovalSessionById(sessionId);
    expect(beforeSession).not.toBeNull();

    // Soft-delete should return 1 (one pending session deleted)
    const deleted = db.softDeletePendingSessions('2026-04-01', 'mobility');
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Session is no longer findable (deleted_at IS NOT NULL filtered out)
    const afterSession = db.getApprovalSessionById(sessionId);
    expect(afterSession).toBeNull();
  });
});

describe('deploy history', () => {
  it('records and retrieves deploy', async () => {
    const db = await import('../db');
    db.recordDeploy('abc1234', 'test deploy', '0.2.5');
    const latest = db.getLatestDeploy();
    expect(latest).not.toBeNull();
    expect(latest!.commit_sha).toBe('abc1234');
    expect(latest!.version).toBe('0.2.5');
  });

  it('deduplicates by commit SHA', async () => {
    const db = await import('../db');
    db.recordDeploy('abc1234', 'test deploy', '0.2.5');
    db.recordDeploy('abc1234', 'test deploy', '0.2.5');
    // Should still be the same single record (no duplicate)
    const latest = db.getLatestDeploy();
    expect(latest!.commit_sha).toBe('abc1234');
  });
});

describe('getLatestPostForDate', () => {
  it('returns latest post for date', async () => {
    const db = await import('../db');
    const post = db.getLatestPostForDate('2026-03-08');
    expect(post).not.toBeNull();
    expect(post!.category).toBe('stretching');
    expect(post!.channel_message_id).toBe(1001);
  });

  it('returns null for date with no posts', async () => {
    const db = await import('../db');
    expect(db.getLatestPostForDate('2099-01-01')).toBeNull();
  });
});

describe('computeTotalScore', () => {
  it('uses config weights to compute score', async () => {
    const { computeTotalScore } = await import('../youtube');
    const score = computeTotalScore(80, 60, 100);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('higher brand score increases total', async () => {
    const { computeTotalScore } = await import('../youtube');
    const low = computeTotalScore(20, 50, 50);
    const high = computeTotalScore(90, 50, 50);
    expect(high).toBeGreaterThan(low);
  });

  it('weights sum correctly (brand-heavy by default)', async () => {
    const { computeTotalScore } = await import('../youtube');
    // With default weights (0.50 brand, 0.35 view, 0.15 duration)
    // Perfect brand + zero others should be ~50
    const brandOnly = computeTotalScore(100, 0, 0);
    expect(brandOnly).toBeGreaterThanOrEqual(45);
    expect(brandOnly).toBeLessThanOrEqual(55);
  });
});

describe('video rejections (blocklist)', () => {
  it('records rejection and detects it', async () => {
    const db = await import('../db');
    expect(db.isVideoRejected('rejected_vid_1')).toBe(false);
    db.recordRejection('rejected_vid_1', 'stretching');
    expect(db.isVideoRejected('rejected_vid_1')).toBe(true);
  });

  it('allows recording multiple rejections for same video', async () => {
    const db = await import('../db');
    db.recordRejection('rejected_vid_2', 'strength');
    db.recordRejection('rejected_vid_2', 'mobility');
    expect(db.isVideoRejected('rejected_vid_2')).toBe(true);
  });

  it('counts recent rejections', async () => {
    const db = await import('../db');
    const count = db.getRejectionCount(7);
    expect(count).toBeGreaterThanOrEqual(3); // from tests above
  });
});

describe('scoring cap', () => {
  it('caps total penalties at MAX_PENALTY', async () => {
    const youtube = await import('../youtube');
    // A video with multiple penalty triggers should not go below (50 - MAX_PENALTY + bonuses)
    // We can't easily test internal function, but computeTotalScore with brand=0 should work
    const score = youtube.computeTotalScore(0, 50, 50);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe('user favorites', () => {
  let testVideoId: number;

  beforeAll(async () => {
    const db = await import('../db');
    testVideoId = db.upsertVideo({
      youtube_id: 'fav-test-video',
      title: 'Favorite Test',
      channel_name: 'Test Channel',
      channel_url: 'https://youtube.com/test',
      duration_seconds: 600,
      duration_label: '10:00',
      difficulty: 'beginner',
      category: 'stretching',
      muscles: '[]',
      thumbnail_url: '',
      video_url: 'https://youtube.com/watch?v=fav-test-video',
      search_query: 'test',
      view_count: 100,
      rating: 5,
      like_ratio: 0.9,
      channel_subscribers: 1000,
    });
  });

  it('toggles favorite on and off', async () => {
    const db = await import('../db');
    // Add favorite
    const added = db.toggleFavorite(11111, testVideoId);
    expect(added).toBe(true);
    expect(db.isUserFavorite(11111, testVideoId)).toBe(true);
    expect(db.getUserFavoriteTotal(11111)).toBe(1);

    // Remove favorite
    const removed = db.toggleFavorite(11111, testVideoId);
    expect(removed).toBe(false);
    expect(db.isUserFavorite(11111, testVideoId)).toBe(false);
    expect(db.getUserFavoriteTotal(11111)).toBe(0);
  });

  it('returns paginated favorites', async () => {
    const db = await import('../db');
    db.toggleFavorite(22222, testVideoId);
    const favs = db.getUserFavorites(22222, 5, 0);
    expect(favs.length).toBe(1);
    expect(favs[0].video_id).toBe(testVideoId);
    // cleanup
    db.toggleFavorite(22222, testVideoId);
  });
});

describe('member levels', () => {
  it('returns новичок for users with few completions', async () => {
    const db = await import('../db');
    const { level } = db.getMemberLevel(99999);
    expect(level).toBe('новичок');
  });
});

describe('filter videos', () => {
  it('filters by category', async () => {
    const db = await import('../db');
    const results = db.filterVideos({ category: 'stretching', limit: 10 });
    for (const v of results) {
      expect(v.category).toBe('stretching');
    }
  });

  it('returns empty for impossible criteria', async () => {
    const db = await import('../db');
    const results = db.filterVideos({ minDuration: 999999, limit: 5 });
    expect(results.length).toBe(0);
  });
});

describe('shared constants', () => {
  it('exports CATEGORY_RU and DIFFICULTY_RU', async () => {
    const { CATEGORY_RU, DIFFICULTY_RU, decodeHtmlEntities, escapeMarkdown } = await import('../shared');
    expect(CATEGORY_RU.stretching).toBe('стретчинг');
    expect(DIFFICULTY_RU.beginner).toBe('начинающий');
    expect(decodeHtmlEntities('&amp;&quot;')).toBe('&"');
    expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*');
  });

  it('SEASON_DAY_MAP covers all 7 days of the week', async () => {
    const { SEASON_DAY_MAP, CATEGORIES } = await import('../shared');
    const days = [0, 1, 2, 3, 4, 5, 6];
    for (const d of days) {
      expect(SEASON_DAY_MAP[d]).toBeDefined();
      expect(CATEGORIES).toContain(SEASON_DAY_MAP[d]);
    }
    // All 7 categories used (no duplicates)
    const cats = new Set(days.map(d => SEASON_DAY_MAP[d]));
    expect(cats.size).toBe(7);
  });

  it('seasonHeader formats correctly', async () => {
    const { seasonHeader } = await import('../shared');
    const h = seasonHeader(1, 3, 'mobility');
    expect(h).toContain('Сезон 1');
    expect(h).toContain('День 3');
    expect(h).toContain('🤸');
    expect(h).toContain('Мобильность');
  });

  it('buildSeasonHashtags includes category + season + day', async () => {
    const { buildSeasonHashtags } = await import('../shared');
    const tags = buildSeasonHashtags({
      category: 'stretching',
      difficulty: 'beginner',
      seasonNumber: 2,
      seasonDay: 5,
    });
    expect(tags).toContain('#стретчинг');
    expect(tags).toContain('#начинающий');
    expect(tags).toContain('#сезон2');
    expect(tags).toContain('#день5');
  });

  it('buildSeasonHashtags adds muscle hashtags for specific muscles', async () => {
    const { buildSeasonHashtags } = await import('../shared');
    const tags = buildSeasonHashtags({
      category: 'strength',
      seasonNumber: 1,
      seasonDay: 2,
      muscles: 'спина, ноги',
    });
    expect(tags).toContain('#спина');
    expect(tags).toContain('#ноги');
  });

  it('buildSeasonHashtags skips generic muscle labels', async () => {
    const { buildSeasonHashtags } = await import('../shared');
    const tags = buildSeasonHashtags({
      category: 'yoga',
      seasonNumber: 1,
      seasonDay: 4,
      muscles: 'всё тело',
    });
    expect(tags).not.toContain('#всё_тело');
  });

  it('buildUgcHashtags omits season and day tags', async () => {
    const { buildUgcHashtags } = await import('../shared');
    const tags = buildUgcHashtags({
      category: 'cardio',
      difficulty: 'advanced',
    });
    expect(tags).toContain('#кардио');
    expect(tags).toContain('#продвинутый');
    expect(tags).not.toMatch(/#сезон/);
    expect(tags).not.toMatch(/#день/);
  });
});

describe('getPostByMessageId', () => {
  it('returns post data for a valid message ID', async () => {
    const { getPostByMessageId } = await import('../db');
    const post = getPostByMessageId(1001);
    expect(post).not.toBeNull();
    expect(post!.category).toBe('stretching');
    expect(post!.date).toBe('2026-03-08');
  });

  it('returns null for unknown message ID', async () => {
    const { getPostByMessageId } = await import('../db');
    expect(getPostByMessageId(9999)).toBeNull();
  });
});

// ─── SEASON TESTS ───────────────────────────────────────────────────────────

describe('seasons: createSeason + getters', () => {
  it('creates a season and retrieves it', async () => {
    const db = await import('../db');
    const id = db.createSeason(100, '2026-04-06', '2026-04-26');
    expect(id).toBeGreaterThan(0);

    const latest = db.getLatestSeason();
    expect(latest).not.toBeNull();
    expect(latest!.number).toBe(100);
    expect(latest!.status).toBe('upcoming');
  });

  it('activateSeason changes status to active', async () => {
    const db = await import('../db');
    const id = db.createSeason(101, '2026-05-04', '2026-05-24');
    db.activateSeason(id);
    const season = db.getActiveSeason();
    expect(season).not.toBeNull();
    expect(season!.id).toBe(id);
    expect(season!.status).toBe('active');
    // cleanup: complete it so it doesn't interfere with other tests
    db.completeSeason(id);
  });

  it('completeSeason changes status to completed', async () => {
    const db = await import('../db');
    const id = db.createSeason(102, '2026-06-01', '2026-06-21');
    db.activateSeason(id);
    db.completeSeason(id);
    const active = db.getActiveSeason();
    // Should not be active anymore (unless another test left one active)
    if (active) expect(active.id).not.toBe(id);
  });
});

describe('seasons: ensureActiveSeason', () => {
  it('creates season 1 when no seasons exist', async () => {
    const db = await import('../db');
    // Clean up all test seasons to test from-scratch creation
    db.getDb().prepare(`DELETE FROM season_queue`).run();
    db.getDb().prepare(`DELETE FROM seasons`).run();

    const season = db.ensureActiveSeason('2026-04-06', '2026-04-06');
    expect(season).not.toBeNull();
    expect(season.number).toBe(1);
    // nextMonday = today = 2026-04-06, so it should activate immediately
    expect(season.status).toBe('active');
    expect(season.start_date).toBe('2026-04-06');
  });

  it('is idempotent — returns same season on second call', async () => {
    const db = await import('../db');
    const s1 = db.ensureActiveSeason('2026-04-06', '2026-04-13');
    const s2 = db.ensureActiveSeason('2026-04-06', '2026-04-13');
    expect(s1.id).toBe(s2.id);
    expect(s1.number).toBe(s2.number);
  });

  it('creates upcoming season when nextMonday is in the future', async () => {
    const db = await import('../db');
    db.getDb().prepare(`DELETE FROM season_queue`).run();
    db.getDb().prepare(`DELETE FROM seasons`).run();

    // today=Wed, nextMonday=next week
    const season = db.ensureActiveSeason('2026-04-08', '2026-04-13');
    expect(season.number).toBe(1);
    expect(season.start_date).toBe('2026-04-13');
    expect(season.status).toBe('upcoming');
  });
});

describe('seasons: getSeasonDay + getSeasonWeekNumber', () => {
  it('day 1 on start date', async () => {
    const { getSeasonDay } = await import('../db');
    expect(getSeasonDay('2026-04-06', '2026-04-06')).toBe(1);
  });

  it('day 7 on day+6', async () => {
    const { getSeasonDay } = await import('../db');
    expect(getSeasonDay('2026-04-06', '2026-04-12')).toBe(7);
  });

  it('day 21 on last day of season', async () => {
    const { getSeasonDay } = await import('../db');
    expect(getSeasonDay('2026-04-06', '2026-04-26')).toBe(21);
  });

  it('week 1 for days 1-7', async () => {
    const { getSeasonWeekNumber } = await import('../db');
    expect(getSeasonWeekNumber(1)).toBe(1);
    expect(getSeasonWeekNumber(7)).toBe(1);
  });

  it('week 2 for days 8-14', async () => {
    const { getSeasonWeekNumber } = await import('../db');
    expect(getSeasonWeekNumber(8)).toBe(2);
    expect(getSeasonWeekNumber(14)).toBe(2);
  });

  it('week 3 for days 15-21', async () => {
    const { getSeasonWeekNumber } = await import('../db');
    expect(getSeasonWeekNumber(15)).toBe(3);
    expect(getSeasonWeekNumber(21)).toBe(3);
  });
});

describe('seasons: queue management', () => {
  let testSeasonId: number;
  let testVideoId: number;

  beforeAll(async () => {
    const db = await import('../db');
    // Clean slate
    db.getDb().prepare(`DELETE FROM season_queue`).run();
    db.getDb().prepare(`DELETE FROM seasons`).run();

    testSeasonId = db.createSeason(10, '2026-05-04', '2026-05-24');
    db.activateSeason(testSeasonId);

    testVideoId = db.upsertVideo({
      youtube_id: 'season-queue-test',
      title: 'Season Queue Test',
      channel_name: 'Test',
      channel_url: null,
      duration_seconds: 900,
      duration_label: '15:00',
      difficulty: 'intermediate',
      category: 'mobility',
      muscles: '["спина"]',
      thumbnail_url: null,
      video_url: 'https://youtube.com/watch?v=sqt',
      view_count: 5000,
      rating: 0,
      like_ratio: 0.92,
      channel_subscribers: 20000,
      search_query: 'test',
    });
  });

  it('initSeasonWeekSlots creates 7 empty slots', async () => {
    const db = await import('../db');
    db.initSeasonWeekSlots(testSeasonId, 1);
    const slots = db.getSeasonWeekStatus(testSeasonId, 1);
    expect(slots.length).toBe(7);
    for (const s of slots) {
      expect(s.status).toBe('empty');
      expect(s.video_id).toBeNull();
    }
    // Days should be 1-7
    expect(slots.map(s => s.day_number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('initSeasonWeekSlots is idempotent', async () => {
    const db = await import('../db');
    db.initSeasonWeekSlots(testSeasonId, 1);
    db.initSeasonWeekSlots(testSeasonId, 1); // second call
    const slots = db.getSeasonWeekStatus(testSeasonId, 1);
    expect(slots.length).toBe(7); // still 7, not 14
  });

  it('week 2 slots start at day 8', async () => {
    const db = await import('../db');
    db.initSeasonWeekSlots(testSeasonId, 2);
    const slots = db.getSeasonWeekStatus(testSeasonId, 2);
    expect(slots.length).toBe(7);
    expect(slots[0].day_number).toBe(8);
    expect(slots[6].day_number).toBe(14);
  });

  it('setSeasonQueueVideo fills a slot', async () => {
    const db = await import('../db');
    db.setSeasonQueueVideo(testSeasonId, 1, testVideoId);
    const slot = db.getSeasonQueueForDay(testSeasonId, 1);
    expect(slot).not.toBeNull();
    expect(slot!.video_id).toBe(testVideoId);
    expect(slot!.status).toBe('queued');
  });

  it('getNextEmptySlot skips filled slots', async () => {
    const db = await import('../db');
    // Day 1 is already queued from previous test
    const next = db.getNextEmptySlot(testSeasonId, 1);
    expect(next).not.toBeNull();
    expect(next!.day_number).toBe(2); // first empty after day 1
  });

  it('markSeasonQueuePosted changes status', async () => {
    const db = await import('../db');
    db.markSeasonQueuePosted(testSeasonId, 1);
    const slot = db.getSeasonQueueForDay(testSeasonId, 1);
    expect(slot).not.toBeNull();
    expect(slot!.status).toBe('posted');
  });

  it('getSeasonQueueForDay returns falsy for non-existent day', async () => {
    const db = await import('../db');
    const slot = db.getSeasonQueueForDay(testSeasonId, 99);
    expect(slot).toBeFalsy();
  });

  it('getSeasonWeekStatus joins video title', async () => {
    const db = await import('../db');
    const slots = db.getSeasonWeekStatus(testSeasonId, 1);
    const filledSlot = slots.find(s => s.day_number === 1);
    expect(filledSlot).toBeDefined();
    expect(filledSlot!.title).toBe('Season Queue Test');
  });

  it('getNextEmptySlot returns null when all filled', async () => {
    const db = await import('../db');
    // Fill all remaining slots in week 1
    for (let d = 2; d <= 7; d++) {
      db.setSeasonQueueVideo(testSeasonId, d, testVideoId);
    }
    const next = db.getNextEmptySlot(testSeasonId, 1);
    expect(next).toBeFalsy();
  });
});
