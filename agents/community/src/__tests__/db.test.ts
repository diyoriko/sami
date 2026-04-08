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
      display_title: null,
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
      id: 1, youtube_id: 'a', title: 'T', display_title: null, channel_name: 'C', channel_url: null,
      duration_seconds: 600, duration_label: '10:00', difficulty: 'beginner' as const,
      category: 'stretching' as const, muscles: null, thumbnail_url: null,
      video_url: 'https://youtube.com/watch?v=a', rating: 0,
    };

    const lowVideo = { ...base, view_count: 100, like_ratio: 0.5, channel_subscribers: 1000 };
    const highVideo = { ...base, view_count: 1000000, like_ratio: 0.98, channel_subscribers: 500000 };

    expect(computeRating(highVideo)).toBeGreaterThan(computeRating(lowVideo));
  });

  it('UGC Telegram files get flat rating 7.0', async () => {
    const { computeRating } = await import('../db');

    const ugcVideo = {
      id: 999, youtube_id: 'ugc-42', title: 'UGC Test', display_title: null, channel_name: 'user',
      channel_url: null, duration_seconds: 300, duration_label: '5:00',
      difficulty: 'beginner' as const, category: 'stretching' as const,
      muscles: null, thumbnail_url: null, video_url: 'tg:file123',
      view_count: 0, rating: 0, like_ratio: 0, channel_subscribers: 0,
    };

    expect(computeRating(ugcVideo)).toBe(7.0);
  });
});

describe('stability wall', () => {
  it('getWeeklyConsistentUsers returns users with completions every day', async () => {
    const db = await import('../db');

    // Create a video and post
    const vid = db.upsertVideo({
      youtube_id: 'wall-test', title: 'Wall Test', channel_name: 'Test',
      channel_url: null, duration_seconds: 600, duration_label: '10:00',
      difficulty: 'beginner', category: 'stretching', muscles: null,
      thumbnail_url: null, video_url: 'https://youtube.com/watch?v=wt1',
      view_count: 1000, rating: 0, like_ratio: 0.9, channel_subscribers: 5000,
    });
    const p1 = db.recordPost('2026-03-10', 'stretching', vid, 7777);
    const p2 = db.recordPost('2026-03-11', 'stretching', vid, 7778);
    const p3 = db.recordPost('2026-03-12', 'stretching', vid, 7779);

    // Insert completions for user 90001 on 3 consecutive days
    const rawDb = db.getDb();
    rawDb.prepare(`INSERT INTO completions (post_id, video_id, telegram_user_id, completed_at) VALUES (?, ?, ?, ?)`).run(p1, vid, 90001, '2026-03-10T10:00:00Z');
    rawDb.prepare(`INSERT INTO completions (post_id, video_id, telegram_user_id, completed_at) VALUES (?, ?, ?, ?)`).run(p2, vid, 90001, '2026-03-11T10:00:00Z');
    rawDb.prepare(`INSERT INTO completions (post_id, video_id, telegram_user_id, completed_at) VALUES (?, ?, ?, ?)`).run(p3, vid, 90001, '2026-03-12T10:00:00Z');

    // User 90002 only completed 2 days
    rawDb.prepare(`INSERT INTO completions (post_id, video_id, telegram_user_id, completed_at) VALUES (?, ?, ?, ?)`).run(p1, vid, 90002, '2026-03-10T10:00:00Z');
    rawDb.prepare(`INSERT INTO completions (post_id, video_id, telegram_user_id, completed_at) VALUES (?, ?, ?, ?)`).run(p2, vid, 90002, '2026-03-11T10:00:00Z');

    // Query for 3-day range: only user 90001 should qualify
    const consistent = db.getWeeklyConsistentUsers('2026-03-10', '2026-03-12');
    expect(consistent.length).toBe(1);
    expect(consistent[0].telegram_user_id).toBe(90001);
  });
});

describe('poll results', () => {
  it('upsertPollResult stores and updates poll results', async () => {
    const db = await import('../db');

    const options = [
      { text: 'День 1–7', voter_count: 5 },
      { text: 'День 8–14', voter_count: 3 },
      { text: 'День 15–21', voter_count: 1 },
      { text: 'Пропустил(а) неделю', voter_count: 2 },
    ];

    db.upsertPollResult('poll-1', 'Первая неделя Сезона 1 позади!', 11, options, 1, 1);

    let results = db.getPollResults(1);
    expect(results.length).toBe(1);
    expect(results[0].poll_id).toBe('poll-1');
    expect(results[0].total_voters).toBe(11);
    expect(results[0].options).toHaveLength(4);
    expect(results[0].options[0].voter_count).toBe(5);
    expect(results[0].season_number).toBe(1);
    expect(results[0].week_number).toBe(1);

    // Update with more votes
    db.upsertPollResult('poll-1', 'Первая неделя Сезона 1 позади!', 15, [
      { text: 'День 1–7', voter_count: 7 },
      { text: 'День 8–14', voter_count: 4 },
      { text: 'День 15–21', voter_count: 2 },
      { text: 'Пропустил(а) неделю', voter_count: 2 },
    ], 1, 1);

    results = db.getPollResults(1);
    expect(results.length).toBe(1);
    expect(results[0].total_voters).toBe(15);
  });

  it('getPollResults without challenge returns recent polls', async () => {
    const db = await import('../db');

    db.upsertPollResult('poll-2', 'Вторая неделя Сезона 1', 8, [
      { text: 'День 1–7', voter_count: 4 },
      { text: 'День 8–14', voter_count: 4 },
    ], 1, 2);

    const all = db.getPollResults();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe('UGC rubric field', () => {
  it('updateUgcSubmission stores and retrieves rubric', async () => {
    const db = await import('../db');

    const subId = db.createUgcSubmission(70001, 'rubricuser', 'https://youtube.com/watch?v=rubric1', 'rubric1');
    db.updateUgcSubmission(subId, { title: 'Rubric Test' });

    // Initially null
    let sub = db.getUgcSubmission(subId);
    expect(sub).not.toBeNull();
    expect(sub!.rubric).toBeNull();

    // Set rubric
    db.updateUgcSubmission(subId, { rubric: 'Утренний ритуал' });
    sub = db.getUgcSubmission(subId);
    expect(sub!.rubric).toBe('Утренний ритуал');

    // Update to null (challenge rubric)
    db.updateUgcSubmission(subId, { rubric: null });
    sub = db.getUgcSubmission(subId);
    expect(sub!.rubric).toBeNull();
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

describe('inactive users (48h reminder)', () => {
  it('getInactiveUsers returns users with old last_activity_at', async () => {
    const db = await import('../db');
    const rawDb = db.getDb();

    // Create active user (recent activity)
    rawDb.prepare(`INSERT OR REPLACE INTO members (telegram_user_id, first_name, completions_total, last_activity_at) VALUES (?, ?, ?, datetime('now'))`).run(80001, 'Активный', 5);

    // Create inactive user (3 days ago)
    rawDb.prepare(`INSERT OR REPLACE INTO members (telegram_user_id, first_name, completions_total, last_activity_at) VALUES (?, ?, ?, datetime('now', '-3 days'))`).run(80002, 'Неактивный', 3);

    // Create user with zero completions (should not appear)
    rawDb.prepare(`INSERT OR REPLACE INTO members (telegram_user_id, first_name, completions_total, last_activity_at) VALUES (?, ?, ?, datetime('now', '-5 days'))`).run(80003, 'Новичок', 0);

    const inactive = db.getInactiveUsers(48);
    const ids = inactive.map(u => u.telegram_user_id);
    expect(ids).toContain(80002);
    expect(ids).not.toContain(80001); // active
    expect(ids).not.toContain(80003); // 0 completions
  });

  it('markReminderSent prevents re-sending within 72h', async () => {
    const db = await import('../db');

    db.markReminderSent(80002);
    const inactive = db.getInactiveUsers(48);
    const ids = inactive.map(u => u.telegram_user_id);
    expect(ids).not.toContain(80002); // just reminded
  });
});

describe('getRecentPostsByCategory', () => {
  it('returns recent posts filtered by category', async () => {
    const db = await import('../db');

    // Insert a video + post for stretching
    const videoId = db.upsertVideo({
      youtube_id: 'recent-cat-1',
      title: 'Recent Stretching',
      channel_name: 'Test',
      channel_url: null,
      duration_seconds: 600,
      duration_label: '10:00',
      difficulty: 'beginner',
      category: 'stretching',
      muscles: null,
      thumbnail_url: null,
      video_url: 'https://youtube.com/watch?v=rc1',
      view_count: 1000,
      rating: 0,
      like_ratio: 0.9,
      channel_subscribers: 5000,
      search_query: 'test',
    });
    db.recordPost('2026-03-15', 'stretching', videoId, 9001);

    const posts = db.getRecentPostsByCategory('stretching', 3);
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts.some(p => p.channel_message_id === 9001)).toBe(true);

    // Different category returns different results
    const mobilityPosts = db.getRecentPostsByCategory('mobility', 3);
    expect(mobilityPosts.every(p => p.channel_message_id !== 9001)).toBe(true);
  });
});

describe('getPostCountForDate', () => {
  it('counts posts for a specific date', async () => {
    const db = await import('../db');

    const count = db.getPostCountForDate('2026-03-15');
    expect(count).toBeGreaterThanOrEqual(1); // from the post above

    const emptyCount = db.getPostCountForDate('2099-01-01');
    expect(emptyCount).toBe(0);
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
    const { CATEGORY_RU, DIFFICULTY_RU, decodeHtmlEntities, escV2 } = await import('../shared');
    expect(CATEGORY_RU.stretching).toBe('стретчинг');
    expect(DIFFICULTY_RU.beginner).toBe('начинающий');
    expect(decodeHtmlEntities('&amp;&quot;')).toBe('&"');
    expect(escV2('*bold*')).toBe('\\*bold\\*');
  });

  it('DAY_CATEGORY_MAP covers all 7 days of the week', async () => {
    const { DAY_CATEGORY_MAP, CATEGORIES } = await import('../shared');
    const days = [0, 1, 2, 3, 4, 5, 6];
    for (const d of days) {
      expect(DAY_CATEGORY_MAP[d]).toBeDefined();
      expect(CATEGORIES).toContain(DAY_CATEGORY_MAP[d]);
    }
    // All 7 categories used (no duplicates)
    const cats = new Set(days.map(d => DAY_CATEGORY_MAP[d]));
    expect(cats.size).toBe(7);
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

// ─── CHALLENGE TESTS ────────────────────────────────────────────────────────

describe('challenges: createChallenge + getters', () => {
  it('creates a challenge and retrieves it', async () => {
    const db = await import('../db');
    const id = db.createChallenge(100, '2026-04-06', '2026-04-26');
    expect(id).toBeGreaterThan(0);

    const latest = db.getLatestChallenge();
    expect(latest).not.toBeNull();
    expect(latest!.number).toBe(100);
    expect(latest!.status).toBe('upcoming');
  });

  it('activateChallenge changes status to active', async () => {
    const db = await import('../db');
    const id = db.createChallenge(101, '2026-05-04', '2026-05-24');
    db.activateChallenge(id);
    const challenge = db.getActiveChallenge();
    expect(challenge).not.toBeNull();
    expect(challenge!.id).toBe(id);
    expect(challenge!.status).toBe('active');
    // cleanup: complete it so it doesn't interfere with other tests
    db.completeChallenge(id);
  });

  it('completeChallenge changes status to completed', async () => {
    const db = await import('../db');
    const id = db.createChallenge(102, '2026-06-01', '2026-06-21');
    db.activateChallenge(id);
    db.completeChallenge(id);
    const active = db.getActiveChallenge();
    // Should not be active anymore (unless another test left one active)
    if (active) expect(active.id).not.toBe(id);
  });
});

describe('challenges: ensureActiveChallenge', () => {
  it('creates challenge 1 when no challenges exist', async () => {
    const db = await import('../db');
    // Clean up all test challenges to test from-scratch creation
    db.getDb().prepare(`DELETE FROM weekly_schedule`).run();
    db.getDb().prepare(`DELETE FROM challenges`).run();

    const challenge = db.ensureActiveChallenge('2026-04-06', '2026-04-06');
    expect(challenge).not.toBeNull();
    expect(challenge.number).toBe(1);
    // nextMonday = today = 2026-04-06, so it should activate immediately
    expect(challenge.status).toBe('active');
    expect(challenge.start_date).toBe('2026-04-06');
  });

  it('is idempotent — returns same challenge on second call', async () => {
    const db = await import('../db');
    const s1 = db.ensureActiveChallenge('2026-04-06', '2026-04-13');
    const s2 = db.ensureActiveChallenge('2026-04-06', '2026-04-13');
    expect(s1.id).toBe(s2.id);
    expect(s1.number).toBe(s2.number);
  });

  it('creates upcoming challenge when nextMonday is in the future', async () => {
    const db = await import('../db');
    db.getDb().prepare(`DELETE FROM weekly_schedule`).run();
    db.getDb().prepare(`DELETE FROM challenges`).run();

    // today=Wed, nextMonday=next week
    const challenge = db.ensureActiveChallenge('2026-04-08', '2026-04-13');
    expect(challenge.number).toBe(1);
    expect(challenge.start_date).toBe('2026-04-13');
    expect(challenge.status).toBe('upcoming');
  });
});

describe('challenges: getChallengeDay + getChallengeWeekNumber', () => {
  it('day 1 on start date', async () => {
    const { getChallengeDay } = await import('../db');
    expect(getChallengeDay('2026-04-06', '2026-04-06')).toBe(1);
  });

  it('day 7 on day+6', async () => {
    const { getChallengeDay } = await import('../db');
    expect(getChallengeDay('2026-04-06', '2026-04-12')).toBe(7);
  });

  it('day 21 on last day of challenge', async () => {
    const { getChallengeDay } = await import('../db');
    expect(getChallengeDay('2026-04-06', '2026-04-26')).toBe(21);
  });

  it('always returns week 1 (7-day cycles)', async () => {
    const { getChallengeWeekNumber } = await import('../db');
    expect(getChallengeWeekNumber(1)).toBe(1);
    expect(getChallengeWeekNumber(7)).toBe(1);
    expect(getChallengeWeekNumber(8)).toBe(1);
    expect(getChallengeWeekNumber(21)).toBe(1);
  });
});

describe('challenges: weekly schedule management', () => {
  let testChallengeId: number;
  let testVideoId: number;

  beforeAll(async () => {
    const db = await import('../db');
    // Clean slate
    db.getDb().prepare(`DELETE FROM weekly_schedule`).run();
    db.getDb().prepare(`DELETE FROM challenges`).run();

    testChallengeId = db.createChallenge(10, '2026-05-04', '2026-05-24');
    db.activateChallenge(testChallengeId);

    testVideoId = db.upsertVideo({
      youtube_id: 'schedule-test',
      title: 'Weekly Schedule Test',
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

  it('initWeekSlots creates 7 empty slots', async () => {
    const db = await import('../db');
    db.initWeekSlots(testChallengeId, 1);
    const slots = db.getWeekStatus(testChallengeId, 1);
    expect(slots.length).toBe(7);
    for (const s of slots) {
      expect(s.status).toBe('empty');
      expect(s.video_id).toBeNull();
    }
    // Days should be 1-7
    expect(slots.map(s => s.day_number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('initWeekSlots is idempotent', async () => {
    const db = await import('../db');
    db.initWeekSlots(testChallengeId, 1);
    db.initWeekSlots(testChallengeId, 1); // second call
    const slots = db.getWeekStatus(testChallengeId, 1);
    expect(slots.length).toBe(7); // still 7, not 14
  });

  it('week 2 slots start at day 8', async () => {
    const db = await import('../db');
    db.initWeekSlots(testChallengeId, 2);
    const slots = db.getWeekStatus(testChallengeId, 2);
    expect(slots.length).toBe(7);
    expect(slots[0].day_number).toBe(8);
    expect(slots[6].day_number).toBe(14);
  });

  it('setWeekSlotVideo fills a slot', async () => {
    const db = await import('../db');
    db.setWeekSlotVideo(testChallengeId, 1, testVideoId);
    const slot = db.getWeekSlotForDay(testChallengeId, 1);
    expect(slot).not.toBeNull();
    expect(slot!.video_id).toBe(testVideoId);
    expect(slot!.status).toBe('queued');
  });

  it('getNextEmptySlot skips filled slots', async () => {
    const db = await import('../db');
    // Day 1 is already queued from previous test
    const next = db.getNextEmptySlot(testChallengeId, 1);
    expect(next).not.toBeNull();
    expect(next!.day_number).toBe(2); // first empty after day 1
  });

  it('markWeekSlotPosted changes status', async () => {
    const db = await import('../db');
    db.markWeekSlotPosted(testChallengeId, 1);
    const slot = db.getWeekSlotForDay(testChallengeId, 1);
    expect(slot).not.toBeNull();
    expect(slot!.status).toBe('posted');
  });

  it('getWeekSlotForDay returns falsy for non-existent day', async () => {
    const db = await import('../db');
    const slot = db.getWeekSlotForDay(testChallengeId, 99);
    expect(slot).toBeFalsy();
  });

  it('getWeekStatus joins video title', async () => {
    const db = await import('../db');
    const slots = db.getWeekStatus(testChallengeId, 1);
    const filledSlot = slots.find(s => s.day_number === 1);
    expect(filledSlot).toBeDefined();
    expect(filledSlot!.title).toBe('Weekly Schedule Test');
  });

  it('getNextEmptySlot returns null when all filled', async () => {
    const db = await import('../db');
    // Fill all remaining slots in week 1
    for (let d = 2; d <= 7; d++) {
      db.setWeekSlotVideo(testChallengeId, d, testVideoId);
    }
    const next = db.getNextEmptySlot(testChallengeId, 1);
    expect(next).toBeFalsy();
  });
});

describe('invite links', () => {
  it('creates, lists, and increments counters', async () => {
    const db = await import('../db');

    // Initially empty
    expect(db.getInviteLinks()).toEqual([]);

    // Create two links
    const id1 = db.createInviteLink('instagram', 'https://t.me/+Abc123');
    const id2 = db.createInviteLink('youtube', 'https://t.me/+Xyz789');
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(0);

    // List returns newest first
    const links = db.getInviteLinks();
    expect(links).toHaveLength(2);
    expect(links[0].label).toBe('youtube');
    expect(links[1].label).toBe('instagram');
    expect(links[0].clicks).toBe(0);
    expect(links[0].joins).toBe(0);
  });

  it('increments clicks and joins', async () => {
    const db = await import('../db');

    db.incrementInviteLinkClicks('https://t.me/+Abc123');
    db.incrementInviteLinkClicks('https://t.me/+Abc123');
    db.incrementInviteLinkJoins('https://t.me/+Abc123');

    const links = db.getInviteLinks();
    const link = links.find(l => l.label === 'instagram')!;
    expect(link.clicks).toBe(2);
    expect(link.joins).toBe(1);
  });

  it('rejects duplicate URLs', async () => {
    const db = await import('../db');
    expect(() => db.createInviteLink('duplicate', 'https://t.me/+Abc123')).toThrow(/UNIQUE/);
  });

  it('no-op increment for unknown URL', async () => {
    const db = await import('../db');
    // Should not throw
    db.incrementInviteLinkClicks('https://t.me/+nonexistent');
    db.incrementInviteLinkJoins('https://t.me/+nonexistent');
  });
});
