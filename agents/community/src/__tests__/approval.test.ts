/**
 * Approval module tests: DB-level approval queue operations,
 * state transitions, edge cases, and formatViews helper.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
