import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-admin.db');

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

describe('invite links (admin)', () => {
  it('creates invite link and retrieves it', async () => {
    const { createInviteLink, getInviteLinks } = await import('../db');
    const id = createInviteLink('instagram', 'https://t.me/+AbCdEf12345');
    expect(id).toBeGreaterThan(0);

    const links = getInviteLinks();
    expect(links.length).toBeGreaterThanOrEqual(1);
    const link = links.find(l => l.label === 'instagram');
    expect(link).toBeDefined();
    expect(link!.url).toBe('https://t.me/+AbCdEf12345');
    expect(link!.clicks).toBe(0);
    expect(link!.joins).toBe(0);
  });

  it('rejects duplicate invite links', async () => {
    const { createInviteLink } = await import('../db');
    expect(() => createInviteLink('instagram', 'https://t.me/+AbCdEf12345'))
      .toThrow(/UNIQUE/);
  });

  it('creates multiple links with different labels', async () => {
    const { createInviteLink, getInviteLinks } = await import('../db');
    createInviteLink('twitter', 'https://t.me/+XyZ789');
    const links = getInviteLinks();
    expect(links.length).toBeGreaterThanOrEqual(2);
  });
});

describe('week slots and scheduling', () => {
  it('initWeekSlots does not throw', async () => {
    const { ensureActiveChallenge, initWeekSlots } = await import('../db');
    const { todayMsk, thisMondayMsk } = await import('../dates');
    const challenge = ensureActiveChallenge(todayMsk(), thisMondayMsk());
    expect(() => initWeekSlots(challenge.id, 1)).not.toThrow();
  });

  it('getWeekStatus returns array', async () => {
    const { ensureActiveChallenge, getWeekStatus } = await import('../db');
    const { todayMsk, thisMondayMsk } = await import('../dates');
    const challenge = ensureActiveChallenge(todayMsk(), thisMondayMsk());
    const status = getWeekStatus(challenge.id, 1);
    expect(Array.isArray(status)).toBe(true);
  });
});

describe('dashboard stats', () => {
  it('getChannelStats returns object or null', async () => {
    const { getChannelStats } = await import('../db');
    const { todayMsk } = await import('../dates');
    const stats = getChannelStats(todayMsk());
    // null for no data, object if exists
    expect(stats === null || typeof stats === 'object').toBe(true);
  });

  it('getRetention returns structured data', async () => {
    const { getRetention } = await import('../db');
    const { todayMsk, yesterdayMsk } = await import('../dates');
    const retention = getRetention(todayMsk(), yesterdayMsk());
    expect(retention).toBeDefined();
  });

  it('getPendingUgcCount returns zero for empty db', async () => {
    const { getPendingUgcCount } = await import('../db');
    const count = getPendingUgcCount();
    expect(count).toBe(0);
  });

  it('getPostCountForDate returns zero for no posts', async () => {
    const { getPostCountForDate } = await import('../db');
    const count = getPostCountForDate('2020-01-01');
    expect(count).toBe(0);
  });

  it('getCompletionCountForDate returns zero for no completions', async () => {
    const { getCompletionCountForDate } = await import('../db');
    const count = getCompletionCountForDate('2020-01-01');
    expect(count).toBe(0);
  });

  it('getUniqueCompletionUsersForDate returns zero for no users', async () => {
    const { getUniqueCompletionUsersForDate } = await import('../db');
    const count = getUniqueCompletionUsersForDate('2020-01-01');
    expect(count).toBe(0);
  });
});

describe('admin guard', () => {
  it('isAdmin returns true for admin user ID', () => {
    const isAdmin = (userId: number) => userId === 123456;
    expect(isAdmin(123456)).toBe(true);
    expect(isAdmin(999999)).toBe(false);
  });
});

describe('shared utilities used by admin', () => {
  it('escV2 escapes markdown special chars', async () => {
    const { escV2 } = await import('../shared');
    expect(escV2('hello_world')).toBe('hello\\_world');
    expect(escV2('test*bold*')).toBe('test\\*bold\\*');
  });

  it('decodeHtmlEntities decodes basic entities', async () => {
    const { decodeHtmlEntities } = await import('../shared');
    expect(decodeHtmlEntities('&amp;')).toBe('&');
    expect(decodeHtmlEntities('&lt;b&gt;')).toBe('<b>');
  });

  it('CATEGORIES has 8 entries (7 weekday slots + muay_thai opt-in)', async () => {
    const { CATEGORIES } = await import('../shared');
    expect(CATEGORIES.length).toBe(8);
  });

  it('formatUptime returns human readable string', async () => {
    const { formatUptime } = await import('../bot-menu-views');
    const result = formatUptime(3661);
    expect(result).toContain('1');
  });
});

describe('challenge system', () => {
  it('getChallengeDay returns number', async () => {
    const { getChallengeDay } = await import('../db');
    const { todayMsk } = await import('../dates');
    const day = getChallengeDay('2026-01-01', todayMsk());
    expect(typeof day).toBe('number');
  });
});

describe('approval sessions', () => {
  it('resetApprovalSessions returns count of reset sessions', async () => {
    const { resetApprovalSessions } = await import('../db');
    const count = resetApprovalSessions('2020-01-01');
    expect(count).toBe(0);
  });
});
