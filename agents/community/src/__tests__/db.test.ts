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
