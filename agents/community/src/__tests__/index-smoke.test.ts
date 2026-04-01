import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
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

// ═══════════════════════════════════════════════════════════════════════════
// BOT BEHAVIOR SMOKE TESTS — actual handler execution via bot.handleUpdate()
// ═══════════════════════════════════════════════════════════════════════════

const ADMIN_ID = 123456;
const USER_ID = 55001;
const BOT_ID = 99999;

let behaviorBot: Bot;
let apiCalls: { method: string; payload: any }[];
let registerBotMenu: typeof import('../bot-menu').registerBotMenu;
let registerModeration: typeof import('../moderation').registerModeration;

let updateCounter = 0;

function textUpdate(text: string, overrides: { chat_id?: number; user_id?: number; first_name?: string } = {}): Update {
  const chatId = overrides.chat_id ?? USER_ID;
  const userId = overrides.user_id ?? USER_ID;
  const isCommand = text.startsWith('/');
  return {
    update_id: ++updateCounter,
    message: {
      message_id: ++updateCounter + 5000,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatId > 0 ? 'private' as const : 'supergroup' as const },
      from: { id: userId, is_bot: false, first_name: overrides.first_name ?? 'Тест', username: 'testuser' },
      text,
      ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
    } as any,
  };
}

function findCalls(method: string) {
  return apiCalls.filter(c => c.method === method);
}

describe('bot behavior smoke tests', () => {
  beforeAll(async () => {
    const botMenu = await import('../bot-menu');
    const moderation = await import('../moderation');
    registerBotMenu = botMenu.registerBotMenu;
    registerModeration = moderation.registerModeration;
  });

  beforeEach(() => {
    updateCounter = 0;
    apiCalls = [];

    behaviorBot = new Bot('test:token');
    behaviorBot.botInfo = {
      id: BOT_ID,
      is_bot: true,
      first_name: 'Сами botik',
      username: 'sami_workout_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as UserFromGetMe;

    behaviorBot.api.config.use(async (_prev, method, payload) => {
      apiCalls.push({ method, payload });
      const msgResult = {
        message_id: 9999,
        date: Math.floor(Date.now() / 1000),
        chat: { id: (payload as any)?.chat_id ?? USER_ID, type: 'private' },
        from: { id: BOT_ID, is_bot: true, first_name: 'Bot' },
        text: '',
      };
      if (method === 'sendMessage') return { ok: true as const, result: msgResult as any };
      if (method === 'deleteMessage') return { ok: true as const, result: true as any };
      if (method === 'setMyCommands') return { ok: true as const, result: true as any };
      return { ok: true as const, result: true as any };
    });

    registerModeration(behaviorBot);
    registerBotMenu(behaviorBot);
  });

  it('/start in private chat sends greeting with user name', async () => {
    await behaviorBot.handleUpdate(textUpdate('/start', { chat_id: USER_ID, user_id: USER_ID, first_name: 'Алексей' }));

    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);

    const text = sends[sends.length - 1].payload.text;
    expect(text).toContain('Привет, Алексей');
    expect(text).toContain('Ботик Сами');
  });

  it('/start sends reply keyboard with menu buttons', async () => {
    await behaviorBot.handleUpdate(textUpdate('/start', { chat_id: USER_ID, user_id: USER_ID }));

    const sends = findCalls('sendMessage');
    const lastSend = sends[sends.length - 1];
    const markup = JSON.stringify(lastSend.payload.reply_markup ?? {});
    expect(markup).toContain('Мои тренировки');
    expect(markup).toContain('Предложить тренировку');
  });

  it('/start in group chat is ignored', async () => {
    const groupId = -1009876543210;
    await behaviorBot.handleUpdate(textUpdate('/start', { chat_id: groupId, user_id: USER_ID }));

    // No greeting message sent (deleteMessage calls may happen for moderation, but no sendMessage with greeting)
    const sends = findCalls('sendMessage');
    const greetingSends = sends.filter(c => String(c.payload.text ?? '').includes('Ботик Сами'));
    expect(greetingSends.length).toBe(0);
  });

  it('/start shows admin keyboard for admin user', async () => {
    await behaviorBot.handleUpdate(textUpdate('/start', { chat_id: ADMIN_ID, user_id: ADMIN_ID }));

    const sends = findCalls('sendMessage');
    const lastSend = sends[sends.length - 1];
    const markup = JSON.stringify(lastSend.payload.reply_markup ?? {});
    expect(markup).toContain('Дашборд');
    expect(markup).toContain('Неделя');
  });

  it('/start does NOT show admin buttons to regular user', async () => {
    await behaviorBot.handleUpdate(textUpdate('/start', { chat_id: USER_ID, user_id: USER_ID }));

    const sends = findCalls('sendMessage');
    const lastSend = sends[sends.length - 1];
    const markup = JSON.stringify(lastSend.payload.reply_markup ?? {});
    expect(markup).not.toContain('Дашборд');
    expect(markup).not.toContain('Неделя');
  });

  it('handler registration does not throw', () => {
    const testBot = new Bot('test:token');
    testBot.botInfo = behaviorBot.botInfo;
    // Registering all handlers should not throw
    expect(() => {
      registerBotMenu(testBot);
      registerModeration(testBot);
    }).not.toThrow();
  });
});
