import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that are available during vi.mock hoisting
const mockDb = vi.hoisted(() => ({
  writeChannelStats: vi.fn(),
  getChannelStats: vi.fn(),
  getWeeklyStats: vi.fn(),
  getPostCountForDate: vi.fn(),
  getCompletionCountForDate: vi.fn(),
  getUniqueCompletionUsersForDate: vi.fn(),
  getTopVideosByCompletions: vi.fn(),
  getRetention: vi.fn(),
  getCompletionsByCategory: vi.fn(),
  getPostTypeBreakdown: vi.fn(),
  getCumulativeStats: vi.fn(),
  getRecentPosts: vi.fn(),
}));

const writtenFiles = vi.hoisted(() => new Map<string, string>());

// Mock config to avoid process.exit
vi.mock('../config', () => ({
  getConfig: () => ({
    TELEGRAM_CHANNEL_ID: '@test_channel',
    TELEGRAM_GROUP_ID: '@test_group',
    TELEGRAM_ADMIN_USER_ID: 123456,
    ANALYTICS_REPORT_DIR: '../../reports/analytics/.internal',
    ANALYTICS_WEEKLY_DIR: '../../reports/analytics',
  }),
}));

// Mock logger
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withCorrelation: vi.fn(),
  }),
}));

// Mock DB
vi.mock('../db', () => mockDb);

// Mock fs — keep real path module but intercept writes
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((filePath: any, data: any) => {
      writtenFiles.set(String(filePath), String(data));
    }),
  };
});

import { runDailyAnalytics } from '../analytics';

// Helper: create a minimal mock bot
function createMockBot() {
  const sentMessages: { chatId: any; text: string; opts: any }[] = [];
  return {
    bot: {
      api: {
        getChatMemberCount: vi.fn().mockResolvedValue(100),
        sendMessage: vi.fn().mockImplementation((chatId: any, text: string, opts: any) => {
          sentMessages.push({ chatId, text, opts });
          return Promise.resolve({});
        }),
      },
    } as any,
    sentMessages,
  };
}

describe('analytics — runDailyAnalytics', () => {
  beforeEach(() => {
    writtenFiles.clear();
    vi.clearAllMocks();

    // Default DB mock returns
    mockDb.getPostCountForDate.mockReturnValue(5);
    mockDb.getCompletionCountForDate.mockReturnValue(20);
    mockDb.getUniqueCompletionUsersForDate.mockReturnValue(8);
    mockDb.getTopVideosByCompletions.mockReturnValue([
      { video_id: 1, title: 'Morning Stretch', category: 'stretching', completions: 10 },
      { video_id: 2, title: 'Yoga Flow', category: 'yoga', completions: 7 },
    ]);
    mockDb.getRetention.mockReturnValue({ yesterday_active: 10, returned_today: 6 });
    mockDb.getCompletionsByCategory.mockReturnValue([
      { category: 'stretching', completions: 12, users: 5 },
      { category: 'strength', completions: 8, users: 3 },
    ]);
    mockDb.getPostTypeBreakdown.mockReturnValue([
      { post_type: 'video', count: 4 },
      { post_type: 'link', count: 1 },
    ]);
    mockDb.getCumulativeStats.mockReturnValue({
      total_completions: 500,
      total_active_users: 30,
      total_posts: 100,
    });
    mockDb.getChannelStats.mockReturnValue({
      subscriber_count: 95,
      group_member_count: 50,
      posts_today: 3,
    });
  });

  it('writes JSON report with correct structure', async () => {
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    expect(reportEntry).toBeDefined();
    const report = JSON.parse(reportEntry![1]);

    expect(report.date).toBe('2026-03-23');
    expect(report.posts_today).toBe(5);
    expect(report.completions_today).toBe(20);
    expect(report.completion_users).toBe(8);
    expect(report.cumulative).toEqual({
      total_completions: 500,
      total_active_users: 30,
      total_posts: 100,
    });
  });

  it('calculates retention rate correctly (6/10 = 60%)', async () => {
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    const report = JSON.parse(reportEntry![1]);

    expect(report.retention.rate).toBe(60);
    expect(report.retention.yesterday_active).toBe(10);
    expect(report.retention.returned_today).toBe(6);
  });

  it('caps retention rate at 100%', async () => {
    mockDb.getRetention.mockReturnValue({ yesterday_active: 3, returned_today: 5 });
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    const report = JSON.parse(reportEntry![1]);

    expect(report.retention.rate).toBe(100);
  });

  it('handles zero yesterday_active without division by zero', async () => {
    mockDb.getRetention.mockReturnValue({ yesterday_active: 0, returned_today: 0 });
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    const report = JSON.parse(reportEntry![1]);

    expect(report.retention.rate).toBe(0);
  });

  it('calculates positive subscriber delta (100 - 95 = +5)', async () => {
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    const report = JSON.parse(reportEntry![1]);

    expect(report.subscriber_delta).toBe(5);
  });

  it('handles missing previous day stats (delta = 0)', async () => {
    mockDb.getChannelStats.mockReturnValue(null);
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    const report = JSON.parse(reportEntry![1]);

    expect(report.subscriber_delta).toBe(0);
  });

  it('sends DM to admin with MarkdownV2 format', async () => {
    const { bot, sentMessages } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].chatId).toBe(123456);
    expect(sentMessages[0].opts.parse_mode).toBe('MarkdownV2');
    expect(sentMessages[0].text).toContain('Аналитика за');
    expect(sentMessages[0].text).toContain('Retention');
  });

  it('does not throw if admin DM fails', async () => {
    const { bot } = createMockBot();
    bot.api.sendMessage.mockRejectedValue(new Error('Forbidden'));
    await expect(runDailyAnalytics(bot, '2026-03-23')).resolves.not.toThrow();
  });

  it('includes top videos in report', async () => {
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    const report = JSON.parse(reportEntry![1]);

    expect(report.top_videos).toHaveLength(2);
    expect(report.top_videos[0].title).toBe('Morning Stretch');
    expect(report.top_videos[0].completions).toBe(10);
  });

  it('includes completions by category in report', async () => {
    const { bot } = createMockBot();
    await runDailyAnalytics(bot, '2026-03-23');

    const reportEntry = [...writtenFiles.entries()].find(([k]) => k.endsWith('latest.json'));
    const report = JSON.parse(reportEntry![1]);

    expect(report.completions_by_category).toHaveLength(2);
    expect(report.completions_by_category[0].category).toBe('stretching');
  });
});
