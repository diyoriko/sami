import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-index-smoke.db');

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
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

describe('index.ts module smoke tests', () => {
  // NOTE: We do NOT import index.ts directly because it calls main() at the
  // top level, which starts the bot, HTTP server, and scheduler. Instead we
  // verify that the module source is well-formed and its key dependencies load.

  it('index.ts file exists and is readable', () => {
    const indexPath = path.join(__dirname, '..', 'index.ts');
    expect(fs.existsSync(indexPath)).toBe(true);
    const source = fs.readFileSync(indexPath, 'utf8');
    expect(source.length).toBeGreaterThan(100);
  });

  it('imports grammy Bot correctly', async () => {
    const grammy = await import('grammy');
    expect(grammy.Bot).toBeDefined();
    expect(typeof grammy.Bot).toBe('function');
  });

  it('config module loads without throwing', async () => {
    const config = await import('../config');
    expect(typeof config.getConfig).toBe('function');
    const cfg = config.getConfig();
    expect(cfg.TELEGRAM_BOT_TOKEN).toBe('test:token');
    expect(cfg.TELEGRAM_CHANNEL_ID).toBe('-1001234567890');
    expect(cfg.TELEGRAM_GROUP_ID).toBe('-1009876543210');
    expect(cfg.TELEGRAM_ADMIN_USER_ID).toBe(123456);
    expect(cfg.YOUTUBE_API_KEY).toBe('test-key');
    expect(cfg.COMMUNITY_DB_PATH).toBe(TEST_DB_PATH);
  });

  it('db module loads and creates tables', async () => {
    const db = await import('../db');
    expect(typeof db.getDb).toBe('function');
    const conn = db.getDb();
    expect(conn).toBeDefined();
    // Verify key tables exist
    const tables = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('videos');
    expect(tableNames).toContain('posts');
  });

  it('logger module loads without throwing', async () => {
    const logger = await import('../logger');
    expect(typeof logger.createLogger).toBe('function');
    const log = logger.createLogger('smoke-test');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('shared module exports expected constants', async () => {
    const shared = await import('../shared');
    expect(shared.CATEGORIES).toBeDefined();
    expect(Array.isArray(shared.CATEGORIES)).toBe(true);
    expect(shared.CATEGORIES.length).toBeGreaterThan(0);
    expect(shared.CATEGORY_RU).toBeDefined();
    expect(shared.CATEGORY_EMOJI).toBeDefined();
    expect(shared.DIFFICULTY_RU).toBeDefined();
    expect(typeof shared.escV2).toBe('function');
  });

  it('scheduler module loads without side effects', async () => {
    const scheduler = await import('../scheduler');
    expect(typeof scheduler.startScheduler).toBe('function');
  });

  it('poster module loads without throwing', async () => {
    const poster = await import('../poster');
    expect(typeof poster.postVideoToChannel).toBe('function');
    expect(typeof poster.postChallengeVideo).toBe('function');
  });

  it('approval module loads without throwing', async () => {
    const approval = await import('../approval');
    expect(typeof approval.registerApprovalCallbacks).toBe('function');
  });

  it('downloader module loads without throwing', async () => {
    const downloader = await import('../downloader');
    expect(typeof downloader.isYtDlpAvailable).toBe('function');
    expect(typeof downloader.downloadVideo).toBe('function');
  });
});

describe('index.ts source structure', () => {
  const indexSource = fs.readFileSync(
    path.join(__dirname, '..', 'index.ts'),
    'utf8',
  );

  it('has main() function', () => {
    expect(indexSource).toContain('async function main()');
  });

  it('registers bot handlers', () => {
    expect(indexSource).toContain('registerBotMenu(bot)');
    expect(indexSource).toContain('registerModeration(bot)');
    expect(indexSource).toContain('registerApprovalCallbacks(bot)');
    expect(indexSource).toContain('registerStrategistCallbacks(bot)');
    expect(indexSource).toContain('registerRubricHandlers(bot)');
  });

  it('has graceful shutdown handlers', () => {
    expect(indexSource).toContain('SIGTERM');
    expect(indexSource).toContain('SIGINT');
    expect(indexSource).toContain('shutdown');
  });

  it('starts HTTP server', () => {
    expect(indexSource).toContain('http.createServer');
    expect(indexSource).toContain("'/health'");
  });

  it('has admin commands', () => {
    expect(indexSource).toContain("bot.command('status'");
    expect(indexSource).toContain("bot.command('search'");
    expect(indexSource).toContain("bot.command('post'");
    expect(indexSource).toContain("bot.command('reset'");
    expect(indexSource).toContain("bot.command('analytics'");
  });

  it('calls startScheduler', () => {
    expect(indexSource).toContain('startScheduler(bot)');
  });

  it('sends deploy report on start', () => {
    expect(indexSource).toContain('sendDeployReport');
  });
});
