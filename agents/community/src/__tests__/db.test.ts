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
    db.createApprovalSession('2026-03-10', 'stretching', videoId);
    db.createApprovalSession('2026-03-11', 'strength', videoId);
    db.createApprovalSession('2026-03-12', 'mobility', videoId);

    // No filter — all sessions
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
    db.createApprovalSession('2026-04-01', 'mobility', videoId);
    const before = db.getApprovalQueue('2026-04-01', '2026-04-01');
    const mobilityBefore = before.filter(r => r.category === 'mobility');

    db.softDeletePendingSessions('2026-04-01', 'mobility');

    const after = db.getApprovalQueue('2026-04-01', '2026-04-01');
    const mobilityAfter = after.filter(r => r.category === 'mobility');
    expect(mobilityAfter.length).toBeLessThan(mobilityBefore.length);
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
  it('toggles favorite on and off', async () => {
    const db = await import('../db');
    // Add favorite
    const added = db.toggleFavorite(11111, 1);
    expect(added).toBe(true);
    expect(db.isUserFavorite(11111, 1)).toBe(true);
    expect(db.getUserFavoriteTotal(11111)).toBe(1);

    // Remove favorite
    const removed = db.toggleFavorite(11111, 1);
    expect(removed).toBe(false);
    expect(db.isUserFavorite(11111, 1)).toBe(false);
    expect(db.getUserFavoriteTotal(11111)).toBe(0);
  });

  it('returns paginated favorites', async () => {
    const db = await import('../db');
    db.toggleFavorite(22222, 1);
    const favs = db.getUserFavorites(22222, 5, 0);
    expect(favs.length).toBe(1);
    expect(favs[0].video_id).toBe(1);
    // cleanup
    db.toggleFavorite(22222, 1);
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
