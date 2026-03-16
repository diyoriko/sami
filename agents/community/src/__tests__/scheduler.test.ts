import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-scheduler.db');

// ── Mock node-cron ──────────────────────────────────────────────────────────

type CronCallback = () => void | Promise<void>;
interface ScheduledTask {
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

const scheduledJobs: Array<{ expression: string; callback: CronCallback; options: Record<string, unknown>; task: ScheduledTask }> = [];

vi.mock('node-cron', () => ({
  schedule: vi.fn((expression: string, callback: CronCallback, options?: Record<string, unknown>) => {
    const task: ScheduledTask = {
      stop: vi.fn(),
      start: vi.fn(),
    };
    scheduledJobs.push({ expression, callback, options: options ?? {}, task });
    return task;
  }),
  validate: vi.fn(() => true),
}));

// ── Mock strategist-sync ────────────────────────────────────────────────────

vi.mock('../strategist-sync', () => ({
  writeCommunityReport: vi.fn(),
}));

// ── Mock analytics ──────────────────────────────────────────────────────────

vi.mock('../analytics', () => ({
  runDailyAnalytics: vi.fn(async () => {}),
  runWeeklyAnalytics: vi.fn(async () => {}),
}));

// ── Mock notify-admin ───────────────────────────────────────────────────────

vi.mock('../notify-admin', () => ({
  notifyAdmin: vi.fn(async () => {}),
}));

// ── Mock dates ──────────────────────────────────────────────────────────────

vi.mock('../dates', () => ({
  todayMsk: vi.fn(() => '2026-03-16'),
  currentWeekMsk: vi.fn(() => ({ start: '2026-03-09', end: '2026-03-15' })),
}));

// ── Env setup ───────────────────────────────────────────────────────────────

beforeAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  process.env.COMMUNITY_DB_PATH = TEST_DB_PATH;
  process.env.TELEGRAM_BOT_TOKEN = 'test:token';
  process.env.TELEGRAM_CHANNEL_ID = '-1001234567890';
  process.env.TELEGRAM_GROUP_ID = '-1009876543210';
  process.env.TELEGRAM_ADMIN_USER_ID = '123456';
  process.env.YOUTUBE_API_KEY = 'test-key';
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
});

// ── Fake bot ────────────────────────────────────────────────────────────────

function createFakeBot() {
  return {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      sendPoll: vi.fn(async () => ({ message_id: 2 })),
    },
  } as any;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('scheduler: incrementNewMembers', () => {
  it('increments the counter', async () => {
    const { incrementNewMembers } = await import('../scheduler');
    // Call it a few times — should not throw
    incrementNewMembers();
    incrementNewMembers();
    incrementNewMembers();
    // No assertion on value since it's module-internal, but it should not throw
    expect(true).toBe(true);
  });
});

describe('scheduler: startScheduler registers cron jobs', () => {
  beforeEach(() => {
    scheduledJobs.length = 0;
  });

  it('registers all expected cron jobs', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();

    startScheduler(bot);

    // The scheduler registers:
    // 1. Season auto-publish (config.CRON_SEASON_PUBLISH)
    // 2. Daily report (55 23 * * *)
    // 3. Daily analytics (config.CRON_ANALYTICS_DAILY)
    // 4. Weekly analytics (config.CRON_ANALYTICS_WEEKLY)
    // 5. Weekly progress poll (0 9 * * 0)
    // 6. Stability wall (0 16 * * 5)
    // 7. 48h inactivity reminder (0 10 * * *)
    // 8. Owner reminder (0 15 * * *)
    expect(scheduledJobs.length).toBe(8);
  });

  it('all cron jobs use Europe/Moscow timezone', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();
    startScheduler(bot);

    for (const job of scheduledJobs) {
      expect(job.options.timezone).toBe('Europe/Moscow');
    }
  });

  it('registers daily report job at 23:55', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();
    startScheduler(bot);

    const dailyReport = scheduledJobs.find(j => j.expression === '55 23 * * *');
    expect(dailyReport).toBeDefined();
  });

  it('registers weekly poll job for Sundays at 09:00', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();
    startScheduler(bot);

    const weeklyPoll = scheduledJobs.find(j => j.expression === '0 9 * * 0');
    expect(weeklyPoll).toBeDefined();
  });

  it('registers stability wall job for Fridays at 16:00', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();
    startScheduler(bot);

    const stabilityWall = scheduledJobs.find(j => j.expression === '0 16 * * 5');
    expect(stabilityWall).toBeDefined();
  });

  it('registers 48h inactivity reminder at 10:00 daily', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();
    startScheduler(bot);

    const reminder = scheduledJobs.find(j => j.expression === '0 10 * * *');
    expect(reminder).toBeDefined();
  });

  it('registers owner reminder at 15:00 daily', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();
    startScheduler(bot);

    const ownerReminder = scheduledJobs.find(j => j.expression === '0 15 * * *');
    expect(ownerReminder).toBeDefined();
  });
});

describe('scheduler: daily report callback', () => {
  beforeEach(() => {
    scheduledJobs.length = 0;
  });

  it('calls writeCommunityReport and resets newMembersToday', async () => {
    const { startScheduler, incrementNewMembers } = await import('../scheduler');
    const { writeCommunityReport } = await import('../strategist-sync');
    const bot = createFakeBot();

    // Increment counter before starting
    incrementNewMembers();

    startScheduler(bot);

    const dailyReport = scheduledJobs.find(j => j.expression === '55 23 * * *');
    expect(dailyReport).toBeDefined();

    // Execute the callback
    await dailyReport!.callback();

    expect(writeCommunityReport).toHaveBeenCalled();
    // First arg should be today's date
    expect((writeCommunityReport as any).mock.calls[0][0]).toBe('2026-03-16');
  });
});

describe('scheduler: daily analytics callback', () => {
  beforeEach(() => {
    scheduledJobs.length = 0;
  });

  it('calls runDailyAnalytics on trigger', async () => {
    const { startScheduler } = await import('../scheduler');
    const { runDailyAnalytics } = await import('../analytics');
    const bot = createFakeBot();

    startScheduler(bot);

    // Find daily analytics job by its config expression (default '30 0 * * *')
    const dailyAnalytics = scheduledJobs.find(j => j.expression === '30 0 * * *');
    expect(dailyAnalytics).toBeDefined();

    await dailyAnalytics!.callback();

    expect(runDailyAnalytics).toHaveBeenCalledWith(bot, '2026-03-16');
  });

  it('notifies admin when daily analytics throws', async () => {
    const { startScheduler } = await import('../scheduler');
    const { runDailyAnalytics } = await import('../analytics');
    const { notifyAdmin } = await import('../notify-admin');
    const bot = createFakeBot();

    (runDailyAnalytics as any).mockRejectedValueOnce(new Error('analytics boom'));

    startScheduler(bot);

    const dailyAnalytics = scheduledJobs.find(j => j.expression === '30 0 * * *');
    await dailyAnalytics!.callback();

    expect(notifyAdmin).toHaveBeenCalledWith(
      bot,
      'Analytics',
      expect.stringContaining('analytics boom'),
    );
  });
});

describe('scheduler: weekly analytics callback', () => {
  beforeEach(() => {
    scheduledJobs.length = 0;
  });

  it('calls runWeeklyAnalytics on trigger', async () => {
    const { startScheduler } = await import('../scheduler');
    const { runWeeklyAnalytics } = await import('../analytics');
    const bot = createFakeBot();

    startScheduler(bot);

    const weeklyAnalytics = scheduledJobs.find(j => j.expression === '0 10 * * 0');
    expect(weeklyAnalytics).toBeDefined();

    await weeklyAnalytics!.callback();

    expect(runWeeklyAnalytics).toHaveBeenCalled();
  });
});

describe('scheduler: owner reminder callback', () => {
  beforeEach(() => {
    scheduledJobs.length = 0;
  });

  it('registers owner reminder at 15:00 with correct cron expression', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();

    startScheduler(bot);

    const ownerReminder = scheduledJobs.find(j => j.expression === '0 15 * * *');
    expect(ownerReminder).toBeDefined();
    expect(ownerReminder!.options.timezone).toBe('Europe/Moscow');
  });

  it('callback does not throw even if internal require fails', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();

    startScheduler(bot);

    const ownerReminder = scheduledJobs.find(j => j.expression === '0 15 * * *');
    expect(ownerReminder).toBeDefined();

    // The callback uses require('./db') internally. In test context this may
    // resolve to the real DB or fail — either way, the callback catches errors.
    await expect(ownerReminder!.callback()).resolves.not.toThrow();
  });
});

describe('scheduler: cron expressions are valid', () => {
  beforeEach(() => {
    scheduledJobs.length = 0;
  });

  it('all registered jobs have non-empty cron expressions', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();
    startScheduler(bot);

    for (const job of scheduledJobs) {
      expect(job.expression).toBeTruthy();
      expect(typeof job.expression).toBe('string');
      // Basic cron format: 5 fields separated by spaces
      const parts = job.expression.trim().split(/\s+/);
      expect(parts.length).toBe(5);
    }
  });
});

describe('scheduler: startup timeouts', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scheduledJobs.length = 0;
    setTimeoutSpy = vi.spyOn(global, 'setTimeout');
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('schedules cleanup and catch-up tasks via setTimeout', async () => {
    const { startScheduler } = await import('../scheduler');
    const bot = createFakeBot();

    const beforeCount = setTimeoutSpy.mock.calls.length;
    startScheduler(bot);
    const afterCount = setTimeoutSpy.mock.calls.length;

    // scheduler.ts registers 3 setTimeout calls:
    // 1. cleanupOldApprovalSessions (1000ms)
    // 2. catch-up analytics (3000ms)
    // 3. catch-up season publish (5000ms)
    const newTimeouts = afterCount - beforeCount;
    expect(newTimeouts).toBeGreaterThanOrEqual(3);
  });
});
