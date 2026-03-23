/**
 * Approval module tests: DB-level approval queue operations,
 * state transitions, edge cases, formatViews helper,
 * formatApprovalMessage card format, and sendApprovalCard fallback.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock translate module to avoid HTTP calls in formatApprovalMessage tests.
// rewriteTitle and formatChannelName return MarkdownV2-escaped text.
vi.mock('../translate', () => ({
  rewriteTitle: vi.fn(async (title: string) => title.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$&')),
  formatChannelName: vi.fn(async (name: string) => name.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$&')),
}));

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-approval.db');

beforeAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  process.env.COMMUNITY_DB_PATH = TEST_DB_PATH;
  process.env.TELEGRAM_BOT_TOKEN = 'test:token';
  process.env.TELEGRAM_CHANNEL_ID = '-1001234567890';
  process.env.TELEGRAM_GROUP_ID = '-1009876543210';
  process.env.TELEGRAM_ADMIN_USER_ID = '123456';
  process.env.YOUTUBE_API_KEY = 'test-key';
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

/** Helper to create a video with sensible defaults */
function makeVideo(overrides: { youtube_id: string; [k: string]: any }) {
  return {
    title: 'Test Video',
    channel_name: 'TestChannel',
    channel_url: null,
    duration_seconds: 600,
    duration_label: '10:00',
    difficulty: 'beginner' as const,
    category: 'stretching' as const,
    muscles: '["hamstrings"]',
    thumbnail_url: null,
    video_url: `https://youtube.com/watch?v=${overrides.youtube_id}`,
    view_count: 10000,
    rating: 0,
    like_ratio: 0.95,
    channel_subscribers: 50000,
    search_query: 'test',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// APPROVAL SESSION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe('approval session lifecycle', () => {
  it('creates a session in pending state', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'approval-lc-1' }));
    const sessionId = db.createApprovalSession('2026-03-15', 'stretching', videoId);

    expect(sessionId).toBeGreaterThan(0);

    const session = db.getApprovalSessionById(sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('pending');
    expect(session!.category).toBe('stretching');
    expect(session!.date).toBe('2026-03-15');
    expect(session!.video_id).toBe(videoId);
  });

  it('transitions pending → approved', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'approval-lc-2' }));
    const sessionId = db.createApprovalSession('2026-03-15', 'strength', videoId);

    db.setApprovalStatus(sessionId, 'approved');

    const session = db.getApprovalSessionById(sessionId);
    expect(session!.status).toBe('approved');
  });

  it('transitions pending → rejected', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'approval-lc-3' }));
    const sessionId = db.createApprovalSession('2026-03-15', 'mobility', videoId);

    db.setApprovalStatus(sessionId, 'rejected');

    const session = db.getApprovalSessionById(sessionId);
    expect(session!.status).toBe('rejected');
  });

  it('transitions approved → posted via markApprovalPosted', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'approval-lc-4' }));
    db.createApprovalSession('2026-03-16', 'yoga', videoId);
    const sessionId2 = db.createApprovalSession('2026-03-16', 'yoga', videoId);

    // Only approved sessions get marked as posted
    db.setApprovalStatus(sessionId2, 'approved');
    const changed = db.markApprovalPosted('2026-03-16', 'yoga');
    expect(changed).toBeGreaterThanOrEqual(1);

    // The session is now 'posted', not 'approved'
    const session = db.getApprovalSessionById(sessionId2);
    expect(session!.status).toBe('posted');
  });

  it('can revert to pending via unapprove (approved → pending)', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'approval-lc-5' }));
    const sessionId = db.createApprovalSession('2026-03-15', 'cardio', videoId);

    db.setApprovalStatus(sessionId, 'approved');
    expect(db.getApprovalSessionById(sessionId)!.status).toBe('approved');

    // Unapprove = set back to pending
    db.setApprovalStatus(sessionId, 'pending');
    expect(db.getApprovalSessionById(sessionId)!.status).toBe('pending');
  });

  it('can revert to pending via unapprove (rejected → pending)', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'approval-lc-6' }));
    const sessionId = db.createApprovalSession('2026-03-15', 'breathing', videoId);

    db.setApprovalStatus(sessionId, 'rejected');
    expect(db.getApprovalSessionById(sessionId)!.status).toBe('rejected');

    db.setApprovalStatus(sessionId, 'pending');
    expect(db.getApprovalSessionById(sessionId)!.status).toBe('pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE ID TRACKING
// ═══════════════════════════════════════════════════════════════════════════

describe('approval message_id tracking', () => {
  it('sets and retrieves message_id for a session', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'msg-track-1' }));
    const sessionId = db.createApprovalSession('2026-03-17', 'stretching', videoId);

    db.setApprovalMessageId(sessionId, 5001);

    const session = db.getApprovalSessionByMessageId(5001);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
    expect(session!.category).toBe('stretching');
  });

  it('returns null for unknown message_id', async () => {
    const db = await import('../db');
    const session = db.getApprovalSessionByMessageId(999999);
    expect(session).toBeFalsy();
  });

  it('returns null for unknown session_id', async () => {
    const db = await import('../db');
    const session = db.getApprovalSessionById(999999);
    expect(session).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// APPROVAL QUEUE QUERIES
// ═══════════════════════════════════════════════════════════════════════════

describe('approval queue queries', () => {
  it('getApprovalQueue returns only approved sessions', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'queue-q-1' }));

    const s1 = db.createApprovalSession('2026-04-01', 'stretching', videoId);
    const s2 = db.createApprovalSession('2026-04-01', 'strength', videoId);
    const s3 = db.createApprovalSession('2026-04-01', 'mobility', videoId);

    db.setApprovalStatus(s1, 'approved');
    db.setApprovalStatus(s2, 'rejected');
    // s3 stays pending

    const queue = db.getApprovalQueue('2026-04-01', '2026-04-01');
    const categories = queue.map(q => q.category);

    // Only the approved session should appear
    expect(categories).toContain('stretching');
    expect(categories).not.toContain('strength');
    expect(categories).not.toContain('mobility');
  });

  it('getApprovalQueue filters by date range', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'queue-q-2' }));

    const s1 = db.createApprovalSession('2026-04-10', 'recovery', videoId);
    const s2 = db.createApprovalSession('2026-04-11', 'cardio', videoId);
    const s3 = db.createApprovalSession('2026-04-12', 'yoga', videoId);

    db.setApprovalStatus(s1, 'approved');
    db.setApprovalStatus(s2, 'approved');
    db.setApprovalStatus(s3, 'approved');

    // Only April 10-11
    const filtered = db.getApprovalQueue('2026-04-10', '2026-04-11');
    const dates = filtered.map(r => r.date);
    expect(dates).toContain('2026-04-10');
    expect(dates).toContain('2026-04-11');
    expect(dates).not.toContain('2026-04-12');
  });

  it('getApprovalQueue returns all when no date filter', async () => {
    const db = await import('../db');
    const all = db.getApprovalQueue();
    // Should include at least the approved sessions created above
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it('getApprovalQueue includes video title and url', async () => {
    const db = await import('../db');
    const queue = db.getApprovalQueue('2026-04-10', '2026-04-10');
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(queue[0].title).toBeTruthy();
    expect(queue[0].video_url).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SOFT DELETE
// ═══════════════════════════════════════════════════════════════════════════

describe('soft delete operations', () => {
  it('softDeletePendingSessions removes only pending sessions for date+category', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'soft-del-1' }));

    const s1 = db.createApprovalSession('2026-05-01', 'stretching', videoId);
    const s2 = db.createApprovalSession('2026-05-01', 'stretching', videoId);
    const s3 = db.createApprovalSession('2026-05-01', 'strength', videoId);

    // Approve s1 — it should NOT be soft-deleted
    db.setApprovalStatus(s1, 'approved');

    const deleted = db.softDeletePendingSessions('2026-05-01', 'stretching');
    // Only s2 (pending stretching) should be deleted, not s1 (approved) or s3 (strength)
    expect(deleted).toBe(1);

    // s1 is still accessible (approved)
    expect(db.getApprovalSessionById(s1)).not.toBeNull();
    // s2 is gone (soft-deleted)
    expect(db.getApprovalSessionById(s2)).toBeNull();
    // s3 is still there (different category)
    expect(db.getApprovalSessionById(s3)).not.toBeNull();
  });

  it('resetApprovalSessions soft-deletes all sessions for a date', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'reset-1' }));

    const s1 = db.createApprovalSession('2026-05-05', 'stretching', videoId);
    const s2 = db.createApprovalSession('2026-05-05', 'strength', videoId);
    db.setApprovalStatus(s1, 'approved');

    const reset = db.resetApprovalSessions('2026-05-05');
    expect(reset).toBe(2);

    expect(db.getApprovalSessionById(s1)).toBeNull();
    expect(db.getApprovalSessionById(s2)).toBeNull();
  });

  it('cleanupUnpostedSessions removes pending and approved but not posted', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'cleanup-1' }));

    const s1 = db.createApprovalSession('2026-05-10', 'stretching', videoId);
    const s2 = db.createApprovalSession('2026-05-10', 'strength', videoId);
    const s3 = db.createApprovalSession('2026-05-10', 'mobility', videoId);

    db.setApprovalStatus(s1, 'approved');
    // s2 stays pending
    db.setApprovalStatus(s3, 'approved');
    db.markApprovalPosted('2026-05-10', 'mobility'); // s3 → posted

    const cleaned = db.cleanupUnpostedSessions('2026-05-10');
    // s1 (approved) and s2 (pending) should be cleaned, not s3 (posted)
    expect(cleaned).toBe(2);

    expect(db.getApprovalSessionById(s1)).toBeNull();
    expect(db.getApprovalSessionById(s2)).toBeNull();
    expect(db.getApprovalSessionById(s3)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// APPROVED VIDEO RETRIEVAL
// ═══════════════════════════════════════════════════════════════════════════

describe('getApprovedVideo', () => {
  it('returns the approved video for a date+category', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({
      youtube_id: 'approved-vid-1',
      title: 'Approved Stretching',
    }));

    const sessionId = db.createApprovalSession('2026-06-01', 'stretching', videoId);
    db.setApprovalStatus(sessionId, 'approved');

    const video = db.getApprovedVideo('2026-06-01', 'stretching');
    expect(video).not.toBeNull();
    expect(video!.youtube_id).toBe('approved-vid-1');
    expect(video!.title).toBe('Approved Stretching');
  });

  it('returns null when no approved session exists', async () => {
    const db = await import('../db');
    const video = db.getApprovedVideo('2099-01-01', 'stretching');
    expect(video).toBeFalsy();
  });

  it('returns null for rejected sessions', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'rejected-vid-1' }));
    const sessionId = db.createApprovalSession('2026-06-02', 'strength', videoId);
    db.setApprovalStatus(sessionId, 'rejected');

    const video = db.getApprovedVideo('2026-06-02', 'strength');
    expect(video).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UPSERT VIDEO (used by approval flow)
// ═══════════════════════════════════════════════════════════════════════════

describe('upsertVideo for approval', () => {
  it('creates a new video and returns its id', async () => {
    const db = await import('../db');
    const id = db.upsertVideo(makeVideo({ youtube_id: 'upsert-new-1' }));
    expect(id).toBeGreaterThan(0);
  });

  it('returns same id for duplicate youtube_id (upsert)', async () => {
    const db = await import('../db');
    const id1 = db.upsertVideo(makeVideo({ youtube_id: 'upsert-dup-1', title: 'Original' }));
    const id2 = db.upsertVideo(makeVideo({ youtube_id: 'upsert-dup-1', title: 'Updated' }));
    expect(id1).toBe(id2);

    // Title should be updated
    const video = db.getVideoById(id1);
    expect(video!.title).toBe('Updated');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('handles multiple sessions for same date+category', async () => {
    const db = await import('../db');
    const v1 = db.upsertVideo(makeVideo({ youtube_id: 'edge-multi-1', title: 'First' }));
    const v2 = db.upsertVideo(makeVideo({ youtube_id: 'edge-multi-2', title: 'Second' }));

    const s1 = db.createApprovalSession('2026-07-01', 'stretching', v1);
    const s2 = db.createApprovalSession('2026-07-01', 'stretching', v2);

    // Both are pending — both accessible
    expect(db.getApprovalSessionById(s1)).not.toBeNull();
    expect(db.getApprovalSessionById(s2)).not.toBeNull();

    // Approve only the second
    db.setApprovalStatus(s2, 'approved');

    // getApprovedVideo should return the approved one
    const approved = db.getApprovedVideo('2026-07-01', 'stretching');
    expect(approved).not.toBeNull();
    expect(approved!.youtube_id).toBe('edge-multi-2');
  });

  it('empty queue returns empty array', async () => {
    const db = await import('../db');
    const queue = db.getApprovalQueue('2099-01-01', '2099-01-02');
    expect(queue).toEqual([]);
  });

  it('softDeletePendingSessions returns 0 when nothing to delete', async () => {
    const db = await import('../db');
    const deleted = db.softDeletePendingSessions('2099-01-01', 'stretching');
    expect(deleted).toBe(0);
  });

  it('setApprovalStatus on non-existent session does not throw', async () => {
    const db = await import('../db');
    // Should not throw, just no-op
    expect(() => db.setApprovalStatus(999999, 'approved')).not.toThrow();
  });

  it('setApprovalMessageId on non-existent session does not throw', async () => {
    const db = await import('../db');
    expect(() => db.setApprovalMessageId(999999, 1234)).not.toThrow();
  });

  it('soft-deleted sessions do not appear in getApprovalQueue', async () => {
    const db = await import('../db');
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'edge-softdel-q' }));
    const sessionId = db.createApprovalSession('2026-07-15', 'recovery', videoId);
    db.setApprovalStatus(sessionId, 'approved');

    // Verify it appears in queue
    let queue = db.getApprovalQueue('2026-07-15', '2026-07-15');
    expect(queue.some(q => q.category === 'recovery')).toBe(true);

    // Soft-delete it
    db.resetApprovalSessions('2026-07-15');

    // Should no longer appear
    queue = db.getApprovalQueue('2026-07-15', '2026-07-15');
    expect(queue.some(q => q.category === 'recovery')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REJECTION RECORDING (used by refresh flow)
// ═══════════════════════════════════════════════════════════════════════════

describe('rejection recording for approval refresh', () => {
  it('records rejection and checks blocklist', async () => {
    const db = await import('../db');
    expect(db.isVideoRejected('approval-rej-1')).toBe(false);

    db.recordRejection('approval-rej-1', 'stretching');

    expect(db.isVideoRejected('approval-rej-1')).toBe(true);
  });

  it('allows multiple rejections for same video in different categories', async () => {
    const db = await import('../db');
    db.recordRejection('approval-rej-2', 'stretching');
    db.recordRejection('approval-rej-2', 'mobility');
    expect(db.isVideoRejected('approval-rej-2')).toBe(true);
  });

  it('rejection count includes recent entries', async () => {
    const db = await import('../db');
    const countBefore = db.getRejectionCount(7);
    db.recordRejection('approval-rej-3', 'strength');
    const countAfter = db.getRejectionCount(7);
    expect(countAfter).toBe(countBefore + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REFRESH FLOW: soft-delete old → create new session
// ═══════════════════════════════════════════════════════════════════════════

describe('refresh flow (soft-delete + replace)', () => {
  it('replaces a pending session with a new one for same date+category', async () => {
    const db = await import('../db');
    const v1 = db.upsertVideo(makeVideo({ youtube_id: 'refresh-old' }));
    const v2 = db.upsertVideo(makeVideo({ youtube_id: 'refresh-new' }));

    const oldSession = db.createApprovalSession('2026-08-01', 'stretching', v1);
    db.setApprovalMessageId(oldSession, 8001);

    // Simulate refresh: soft-delete old, create new
    db.softDeletePendingSessions('2026-08-01', 'stretching');
    const newSession = db.createApprovalSession('2026-08-01', 'stretching', v2);
    db.setApprovalMessageId(newSession, 8001); // reuse same message_id

    // Old session is gone
    expect(db.getApprovalSessionById(oldSession)).toBeNull();

    // New session is accessible
    const session = db.getApprovalSessionById(newSession);
    expect(session).not.toBeNull();
    expect(session!.video_id).toBe(v2);

    // Message lookup returns the new session
    const byMsg = db.getApprovalSessionByMessageId(8001);
    expect(byMsg).not.toBeNull();
    expect(byMsg!.id).toBe(newSession);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHALLENGE CONTEXT WITH APPROVAL
// ═══════════════════════════════════════════════════════════════════════════

describe('challenge schedule integration with approval', () => {
  it('setWeekSlotVideo fills a slot when approval is confirmed', async () => {
    const db = await import('../db');

    // Create challenge and init slots
    db.getDb().prepare(`DELETE FROM weekly_schedule`).run();
    db.getDb().prepare(`DELETE FROM challenges`).run();

    const challengeId = db.createChallenge(50, '2026-09-01', '2026-09-21');
    db.activateChallenge(challengeId);
    db.initWeekSlots(challengeId, 1);

    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'challenge-approval-1' }));
    const sessionId = db.createApprovalSession('2026-09-01', 'stretching', videoId);
    db.setApprovalStatus(sessionId, 'approved');

    // Simulate what approval callback does: fill the weekly schedule
    db.setWeekSlotVideo(challengeId, 1, videoId);

    const slot = db.getWeekSlotForDay(challengeId, 1);
    expect(slot).not.toBeNull();
    expect(slot!.video_id).toBe(videoId);
    expect(slot!.status).toBe('queued');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONCURRENT SESSIONS (multiple categories for same date)
// ═══════════════════════════════════════════════════════════════════════════

describe('multi-category approval for same date', () => {
  it('handles 3 categories independently', async () => {
    const db = await import('../db');
    const v1 = db.upsertVideo(makeVideo({ youtube_id: 'multi-cat-1', category: 'stretching' }));
    const v2 = db.upsertVideo(makeVideo({ youtube_id: 'multi-cat-2', category: 'strength' }));
    const v3 = db.upsertVideo(makeVideo({ youtube_id: 'multi-cat-3', category: 'mobility' }));

    const s1 = db.createApprovalSession('2026-10-01', 'stretching', v1);
    const s2 = db.createApprovalSession('2026-10-01', 'strength', v2);
    const s3 = db.createApprovalSession('2026-10-01', 'mobility', v3);

    // Approve 1 and 3, reject 2
    db.setApprovalStatus(s1, 'approved');
    db.setApprovalStatus(s2, 'rejected');
    db.setApprovalStatus(s3, 'approved');

    const queue = db.getApprovalQueue('2026-10-01', '2026-10-01');
    const categories = queue.map(q => q.category);

    expect(categories).toContain('stretching');
    expect(categories).toContain('mobility');
    expect(categories).not.toContain('strength');
    expect(queue.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatViews — pure helper
// ═══════════════════════════════════════════════════════════════════════════

describe('formatViews', () => {
  let formatViews: typeof import('../approval')['formatViews'];

  beforeAll(async () => {
    const mod = await import('../approval');
    formatViews = mod.formatViews;
  });

  it('formats millions with one decimal', () => {
    expect(formatViews(1_000_000)).toBe('1.0M');
    expect(formatViews(2_500_000)).toBe('2.5M');
    expect(formatViews(12_300_000)).toBe('12.3M');
  });

  it('formats thousands rounded to whole number', () => {
    expect(formatViews(1_000)).toBe('1K');
    expect(formatViews(1_499)).toBe('1K');
    expect(formatViews(1_500)).toBe('2K');
    expect(formatViews(50_000)).toBe('50K');
    expect(formatViews(999_999)).toBe('1000K');
  });

  it('returns raw number for values below 1000', () => {
    expect(formatViews(0)).toBe('0');
    expect(formatViews(1)).toBe('1');
    expect(formatViews(500)).toBe('500');
    expect(formatViews(999)).toBe('999');
  });

  it('handles boundary at exactly 1M', () => {
    expect(formatViews(1_000_000)).toBe('1.0M');
  });

  it('handles boundary at exactly 1K', () => {
    expect(formatViews(1_000)).toBe('1K');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatApprovalMessage — card format
// ═══════════════════════════════════════════════════════════════════════════

describe('formatApprovalMessage', () => {
  let formatApprovalMessage: typeof import('../approval')['formatApprovalMessage'];

  beforeAll(async () => {
    const mod = await import('../approval');
    formatApprovalMessage = mod.formatApprovalMessage;
  });

  function makeScoredVideo(overrides: Partial<import('../youtube').ScoredVideo> = {}): import('../youtube').ScoredVideo {
    return {
      youtube_id: 'test123',
      title: 'Morning Stretching',
      channel_name: 'FitChannel',
      channel_url: null,
      duration_seconds: 600,
      duration_label: '10:00',
      difficulty: 'beginner',
      category: 'stretching',
      muscles: '["hamstrings","back"]',
      thumbnail_url: 'https://img.youtube.com/vi/test123/0.jpg',
      video_url: 'https://youtube.com/watch?v=test123',
      view_count: 150_000,
      rating: 0,
      like_ratio: 0.95,
      channel_subscribers: 50_000,
      search_query: 'stretching routine',
      brand_score: 75,
      total_score: 80,
      equipment: [],
      ...overrides,
    } as any;
  }

  it('starts with category emoji and bold category name', async () => {
    const text = await formatApprovalMessage(makeScoredVideo(), 'stretching');
    // First line: 🧘 *Стретчинг*
    const firstLine = text.split('\n')[0];
    expect(firstLine).toContain('🧘');
    expect(firstLine).toContain('*');
  });

  it('contains YouTube link', async () => {
    const text = await formatApprovalMessage(makeScoredVideo(), 'stretching');
    expect(text).toContain('[YouTube]');
    expect(text).toContain('youtube.com');
  });

  it('shows duration label', async () => {
    const text = await formatApprovalMessage(makeScoredVideo({ duration_label: '15:30' }), 'strength');
    expect(text).toContain('15:30');
  });

  it('shows difficulty in Russian', async () => {
    const text = await formatApprovalMessage(makeScoredVideo({ difficulty: 'beginner' }), 'stretching');
    // DIFFICULTY_RU['beginner'] = 'начинающий', escaped and capitalized
    expect(text).toMatch(/ачинающий/); // partial match, escaped chars
  });

  it('shows view count formatted', async () => {
    const text = await formatApprovalMessage(makeScoredVideo({ view_count: 150_000 }), 'stretching');
    expect(text).toContain('150K');
    expect(text).toContain('просмотров');
  });

  it('shows "Только коврик" when no equipment', async () => {
    const text = await formatApprovalMessage(makeScoredVideo({ equipment: [] }), 'stretching');
    expect(text).toContain('Только коврик');
  });

  it('shows equipment list when present', async () => {
    const video = makeScoredVideo({ equipment: ['гантели', 'резинка'] });
    const text = await formatApprovalMessage(video, 'strength');
    expect(text).toContain('гантели');
    expect(text).toContain('резинка');
  });

  it('shows search score as X.X/10', async () => {
    const text = await formatApprovalMessage(makeScoredVideo({ total_score: 80, brand_score: 75 }), 'stretching');
    expect(text).toContain('8\\.0');  // 80/10 = 8.0, escaped dot
    expect(text).toContain('7\\.5');  // 75/10 = 7.5
  });

  it('parses muscles from JSON string', async () => {
    const text = await formatApprovalMessage(makeScoredVideo({ muscles: '["hamstrings","back"]' }), 'stretching');
    expect(text).toContain('hamstrings');
    expect(text).toContain('back');
  });

  it('shows em-dash when duration_label is null', async () => {
    const text = await formatApprovalMessage(makeScoredVideo({ duration_label: null }), 'stretching');
    // duration_label ?? '—' -> escV2('—') -> '—' (em-dash is not a MarkdownV2 special char)
    expect(text).toContain('—');
  });

  it('uses correct emoji for each category', async () => {
    const stretching = await formatApprovalMessage(makeScoredVideo(), 'stretching');
    expect(stretching).toContain('🧘');

    const strength = await formatApprovalMessage(makeScoredVideo(), 'strength');
    expect(strength).toContain('💪');

    const mobility = await formatApprovalMessage(makeScoredVideo(), 'mobility');
    expect(mobility).toContain('🐍');
  });

  it('escapes closing parenthesis in video URL', async () => {
    const video = makeScoredVideo({ video_url: 'https://youtube.com/watch?v=abc(123)' });
    const text = await formatApprovalMessage(video, 'stretching');
    // The linkUrl regex only escapes ) and \ in URLs
    expect(text).toContain('abc(123\\)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sendApprovalCard — Markdown fallback logic
// ═══════════════════════════════════════════════════════════════════════════

describe('sendApprovalCard', () => {
  let sendApprovalCard: typeof import('../approval')['sendApprovalCard'];

  beforeAll(async () => {
    const mod = await import('../approval');
    sendApprovalCard = mod.sendApprovalCard;
  });

  it('sends photo when thumbnail URL is provided', async () => {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 1 });
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage };
    const keyboard = {} as any;

    const result = await sendApprovalCard(api, 123, 'https://img.example.com/thumb.jpg', 'Hello', keyboard);

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.message_id).toBe(1);
    expect(sendPhoto.mock.calls[0][2]).toMatchObject({
      caption: 'Hello',
      parse_mode: 'MarkdownV2',
    });
  });

  it('sends text message when thumbnail URL is null', async () => {
    const sendPhoto = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 2 });
    const api = { sendPhoto, sendMessage };
    const keyboard = {} as any;

    const result = await sendApprovalCard(api, 123, null, 'Hello', keyboard);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(result.message_id).toBe(2);
    expect(sendMessage.mock.calls[0][2]).toMatchObject({
      parse_mode: 'MarkdownV2',
    });
  });

  it('falls back to plain text when MarkdownV2 parse fails on photo', async () => {
    const mkv2Error = new Error('Bad Request') as any;
    mkv2Error.description = "can't parse entities";

    const sendPhoto = vi.fn()
      .mockRejectedValueOnce(mkv2Error) // first call with MarkdownV2 fails
      .mockResolvedValueOnce({ message_id: 3 }); // second call with undefined parse_mode succeeds
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage };
    const keyboard = {} as any;

    const result = await sendApprovalCard(api, 123, 'https://img.example.com/thumb.jpg', 'Bad *markdown', keyboard);

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    // First call: MarkdownV2
    expect(sendPhoto.mock.calls[0][2].parse_mode).toBe('MarkdownV2');
    // Second call: no parse_mode
    expect(sendPhoto.mock.calls[1][2].parse_mode).toBeUndefined();
    expect(result.message_id).toBe(3);
  });

  it('falls back to plain text when MarkdownV2 parse fails on text message', async () => {
    const mkv2Error = new Error('Bad Request') as any;
    mkv2Error.description = "can't parse entities";

    const sendPhoto = vi.fn();
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(mkv2Error)
      .mockResolvedValueOnce({ message_id: 4 });
    const api = { sendPhoto, sendMessage };
    const keyboard = {} as any;

    const result = await sendApprovalCard(api, 123, null, 'Bad *markdown', keyboard);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][2].parse_mode).toBe('MarkdownV2');
    expect(sendMessage.mock.calls[1][2].parse_mode).toBeUndefined();
    expect(result.message_id).toBe(4);
  });

  it('throws non-parse errors immediately without fallback', async () => {
    const networkError = new Error('Network timeout');

    const sendPhoto = vi.fn().mockRejectedValue(networkError);
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage };
    const keyboard = {} as any;

    await expect(
      sendApprovalCard(api, 123, 'https://img.example.com/thumb.jpg', 'Hello', keyboard)
    ).rejects.toThrow('Network timeout');

    // Only one attempt — no fallback for non-parse errors
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('throws when both MarkdownV2 and plain text fail', async () => {
    const mkv2Error = new Error('Bad Request') as any;
    mkv2Error.description = "can't parse entities";
    const secondError = new Error('Still broken');

    const sendMessage = vi.fn()
      .mockRejectedValueOnce(mkv2Error)
      .mockRejectedValueOnce(secondError);
    const api = { sendPhoto: vi.fn(), sendMessage };
    const keyboard = {} as any;

    await expect(
      sendApprovalCard(api, 123, null, 'Bad', keyboard)
    ).rejects.toThrow('Still broken');
  });
});
