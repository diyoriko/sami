import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-menu.db');

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

describe('getUserSubmissions (Мои тренировки)', () => {
  it('returns empty for user with no submissions', async () => {
    const { getUserSubmissions, getUserSubmissionTotal } = await import('../db');
    expect(getUserSubmissions(999, 5, 0)).toEqual([]);
    expect(getUserSubmissionTotal(999)).toBe(0);
  });

  it('returns non-draft submissions', async () => {
    const db = await import('../db');

    // draft — should NOT appear
    db.createUgcSubmission(80, 'user80', 'https://youtube.com/watch?v=draft1', 'draft1');

    // pending — should appear
    const pendingId = db.createUgcSubmission(80, 'user80', 'https://youtube.com/watch?v=pend1', 'pend1');
    db.updateUgcSubmission(pendingId, { title: 'My Stretch', category: 'stretching', difficulty: 'beginner', status: 'pending' });

    const items = db.getUserSubmissions(80, 5, 0);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('My Stretch');
    expect(items[0].status).toBe('pending');

    expect(db.getUserSubmissionTotal(80)).toBe(1);
  });
});

describe('UGC submissions', () => {
  it('creates, updates, and retrieves submission', async () => {
    const db = await import('../db');

    const id = db.createUgcSubmission(42, 'testuser', 'https://youtube.com/watch?v=abc123', 'abc123');
    expect(id).toBeGreaterThan(0);

    const draft = db.getUserDraftSubmission(42);
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('draft');
    expect(draft!.youtube_id).toBe('abc123');

    db.updateUgcSubmission(id, { category: 'stretching', difficulty: 'beginner', title: 'Test Workout' });
    const updated = db.getUgcSubmission(id);
    expect(updated!.title).toBe('Test Workout');
    expect(updated!.category).toBe('stretching');

    db.updateUgcSubmission(id, { status: 'pending' });
    expect(db.getUgcSubmission(id)!.status).toBe('pending');

    db.updateUgcSubmission(id, { status: 'approved' });
    const approved = db.getUgcSubmission(id)!;
    expect(approved.status).toBe('approved');
    expect(approved.decided_at).not.toBeNull();
  });

  it('deleteUgcSubmission removes the record', async () => {
    const db = await import('../db');
    const id = db.createUgcSubmission(43, null, 'https://youtube.com/watch?v=xyz', 'xyz');
    db.deleteUgcSubmission(id);
    expect(db.getUgcSubmission(id)).toBeNull();
  });
});

describe('bot-menu module structure', () => {
  it('has persistent keyboard with correct buttons', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bot-menu.ts'), 'utf8');
    expect(source).toContain("'Мои тренировки'");
    expect(source).toContain("'Предложить тренировку'");
    expect(source).toContain('.persistent()');
  });

  it('handles YouTube link extraction', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bot-menu.ts'), 'utf8');
    expect(source).toContain('youtube');
    expect(source).toContain('youtu');
    expect(source).toContain('shorts');
  });

  it('has UGC admin review flow', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bot-menu.ts'), 'utf8');
    expect(source).toContain('ugc_decide');
    expect(source).toContain('approve');
    expect(source).toContain('reject');
  });
});
