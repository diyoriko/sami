/**
 * Integration tests: test real bot handler chains via bot.handleUpdate()
 * with mocked Telegram API. Covers auto-forward, "Я сделаль", UGC flow.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-integration.db');

const CHANNEL_ID = -1003746963456;
const GROUP_ID = -1003604276410;
const ADMIN_ID = 85013206;
const USER_ID = 42001;
const BOT_ID = 99999;

// --- Fake Update builders ---

let updateCounter = 0;

function makeMessage(overrides: { chat_id?: number; user_id?: number; text?: string; [k: string]: any } = {}) {
  const chatId = overrides.chat_id ?? USER_ID;
  const userId = overrides.user_id ?? USER_ID;
  const chatType = chatId > 0 ? 'private' as const : 'supergroup' as const;
  return {
    message_id: ++updateCounter + 1000,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: chatType, title: chatType === 'supergroup' ? 'Test Group' : undefined },
    from: { id: userId, is_bot: false, first_name: 'Алексей', username: 'alexey' },
    text: '',
    ...overrides,
  };
}

function textUpdate(text: string, overrides: Parameters<typeof makeMessage>[0] = {}): Update {
  return {
    update_id: ++updateCounter,
    message: makeMessage({ text, ...overrides }) as any,
  };
}

function callbackUpdate(data: string, overrides: { user_id?: number; chat_id?: number; message_id?: number } = {}): Update {
  const chatId = overrides.chat_id ?? GROUP_ID;
  return {
    update_id: ++updateCounter,
    callback_query: {
      id: `cb_${updateCounter}`,
      chat_instance: 'test',
      from: { id: overrides.user_id ?? USER_ID, is_bot: false, first_name: 'Алексей', username: 'alexey' },
      message: {
        message_id: overrides.message_id ?? 5000,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'supergroup' as const, title: 'Test Group' } as any,
        from: { id: BOT_ID, is_bot: true, first_name: 'Сами botik' },
        text: 'Сделал(а) тренировку? Нажми кнопку:',
      } as any,
      data,
    },
  };
}

function autoForwardUpdate(channelMsgId: number): Update {
  return {
    update_id: ++updateCounter,
    message: {
      message_id: ++updateCounter + 2000,
      date: Math.floor(Date.now() / 1000),
      chat: { id: GROUP_ID, type: 'supergroup' as const, title: 'Сами Daily' } as any,
      from: { id: 777000, is_bot: false, first_name: 'Telegram' },
      is_automatic_forward: true,
      forward_origin: {
        type: 'channel' as const,
        chat: { id: CHANNEL_ID, type: 'channel' as const, title: 'Сами' } as any,
        message_id: channelMsgId,
        date: Math.floor(Date.now() / 1000),
      },
      text: 'Test video caption',
    } as any,
  };
}

/** Helper to create a video with sensible defaults */
function makeVideo(overrides: Partial<Parameters<typeof import('../db').upsertVideo>[0]> & { youtube_id: string }) {
  return {
    title: 'Test Video',
    channel_name: 'TestCh',
    channel_url: null,
    duration_seconds: 600,
    duration_label: '10 мин',
    video_url: `https://youtube.com/watch?v=${overrides.youtube_id}`,
    thumbnail_url: null,
    view_count: 1000,
    like_ratio: 0.95,
    channel_subscribers: 500,
    rating: 0,
    category: 'stretching' as const,
    difficulty: 'beginner' as const,
    muscles: '["спина"]',
    search_query: 'test',
    ...overrides,
  };
}

// --- Setup ---

let bot: Bot;
let apiMocks: Record<string, ReturnType<typeof vi.fn>>;

// Lazy-imported modules (after env setup)
let db: typeof import('../db');
let registerBotMenu: typeof import('../bot-menu').registerBotMenu;
let registerModeration: typeof import('../moderation').registerModeration;

beforeAll(async () => {
  // Clean test DB
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}

  // Set env before imports
  process.env.COMMUNITY_DB_PATH = TEST_DB_PATH;
  process.env.TELEGRAM_BOT_TOKEN = 'test:fake-token';
  process.env.TELEGRAM_CHANNEL_ID = String(CHANNEL_ID);
  process.env.TELEGRAM_GROUP_ID = String(GROUP_ID);
  process.env.TELEGRAM_ADMIN_USER_ID = String(ADMIN_ID);
  process.env.YOUTUBE_API_KEY = 'test-api-key';

  // Dynamic imports so env vars are picked up
  db = await import('../db');
  const botMenu = await import('../bot-menu');
  const moderation = await import('../moderation');
  registerBotMenu = botMenu.registerBotMenu;
  registerModeration = moderation.registerModeration;
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

/** Track all API calls made by the bot */
let apiCalls: { method: string; payload: any }[];

beforeEach(() => {
  updateCounter = 0;
  apiCalls = [];

  // Create fresh bot for each test
  bot = new Bot('test:fake-token');
  bot.botInfo = {
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

  // Intercept ALL API calls via grammY transformer
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });

    // Return appropriate mock results
    const msgResult = {
      message_id: 9999,
      date: Math.floor(Date.now() / 1000),
      chat: { id: (payload as any)?.chat_id ?? GROUP_ID, type: 'supergroup', title: 'Test' },
      from: { id: BOT_ID, is_bot: true, first_name: 'Bot' },
      text: '',
    };

    if (method === 'sendMessage' || method === 'sendVideo') return { ok: true as const, result: msgResult as any };
    if (method === 'editMessageText' || method === 'editMessageReplyMarkup') return { ok: true as const, result: true as any };
    if (method === 'answerCallbackQuery') return { ok: true as const, result: true as any };
    if (method === 'pinChatMessage') return { ok: true as const, result: true as any };
    if (method === 'restrictChatMember') return { ok: true as const, result: true as any };
    if (method === 'deleteMessage') return { ok: true as const, result: true as any };
    if (method === 'getChatMemberCount') return { ok: true as const, result: 5 as any };
    if (method === 'getChat') return { ok: true as const, result: { id: CHANNEL_ID, type: 'channel', title: 'Test' } as any };
    if (method === 'setMyCommands') return { ok: true as const, result: true as any };

    // Fallback for any unhandled method
    return { ok: true as const, result: true as any };
  });

  // Register handlers
  registerModeration(bot);
  registerBotMenu(bot);
});

/** Helper: find API calls by method */
function findCalls(method: string) {
  return apiCalls.filter(c => c.method === method);
}


// ═══════════════════════════════════════════════════════════════════════════
// AUTO-FORWARD + AUTOCOMMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('auto-forward → autocomment', () => {

  it('posts autocomment with "Я сделаль" + rating when post is in DB', async () => {
    // Arrange: create video + post in DB
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'fwd_test_1', title: 'Forward Test' }));
    const channelMsgId = 42;
    db.recordPost('2026-03-12', 'stretching', videoId, channelMsgId);

    // Act: simulate auto-forward
    await bot.handleUpdate(autoForwardUpdate(channelMsgId));

    // Assert: sendMessage called with both buttons
    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    const buttons = JSON.stringify(sends[0].payload);
    expect(buttons).toContain('done:');
    expect(buttons).toContain('rating:');
    expect(buttons).toContain('Я сделаль');
  });

  it('fallback autocomment has both "Я сделаль" and rating when post NOT in DB', async () => {
    const unknownChannelMsgId = 99999;

    await bot.handleUpdate(autoForwardUpdate(unknownChannelMsgId));

    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    const buttons = JSON.stringify(sends[0].payload);
    expect(buttons).toContain('done_msg:');
    expect(buttons).toContain('rating_msg:');
  });

  it('does not pin autocomment in group', async () => {
    const videoId = db.upsertVideo(makeVideo({ youtube_id: 'pin_test_1', title: 'Pin Test', category: 'strength', difficulty: 'intermediate' }));
    db.recordPost('2026-03-12', 'strength', videoId, 43);

    await bot.handleUpdate(autoForwardUpdate(43));

    const pins = findCalls('pinChatMessage');
    expect(pins.length).toBe(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// "Я СДЕЛАЛЬ" CALLBACK
// ═══════════════════════════════════════════════════════════════════════════

describe('"Я сделаль" callback', () => {

  function setupDoneTest(suffix: string) {
    const vid = db.upsertVideo(makeVideo({ youtube_id: `done_${suffix}`, title: `Done ${suffix}`, category: 'mobility', difficulty: 'advanced' }));
    const msgId = 200 + Math.floor(Math.random() * 100000);
    db.recordPost(`2026-03-12`, 'mobility', vid, msgId);
    const post = db.getPostByMessageId(msgId);
    return { videoId: vid, postId: post!.id };
  }

  it('records completion and updates button', async () => {
    const { videoId, postId } = setupDoneTest('rec');
    const uid = USER_ID + 100;

    await bot.handleUpdate(callbackUpdate(`done:${videoId}`, { user_id: uid }));

    // Completion recorded in DB
    expect(db.getCompletionCount(postId)).toBe(1);

    // Button updated via editMessageText or editMessageReplyMarkup
    const edits = findCalls('editMessageText').length + findCalls('editMessageReplyMarkup').length;
    expect(edits).toBeGreaterThan(0);

    // answerCallbackQuery called
    expect(findCalls('answerCallbackQuery').length).toBeGreaterThan(0);
  });

  it('prevents duplicate completion from same user', async () => {
    const { videoId, postId } = setupDoneTest('dedup');
    const uid = USER_ID + 200;

    // First completion
    await bot.handleUpdate(callbackUpdate(`done:${videoId}`, { user_id: uid }));
    expect(db.getCompletionCount(postId)).toBe(1);

    // Second attempt — same user, same post
    apiCalls = [];
    await bot.handleUpdate(callbackUpdate(`done:${videoId}`, { user_id: uid }));
    expect(db.getCompletionCount(postId)).toBe(1); // Still 1

    // answerCallbackQuery called with dedup message
    const answers = findCalls('answerCallbackQuery');
    const answerText = JSON.stringify(answers);
    expect(answerText).toContain('уже');
  });

  it('allows different users to complete same post', async () => {
    const { videoId, postId } = setupDoneTest('multi');
    const uid1 = USER_ID + 300;
    const uid2 = USER_ID + 301;

    await bot.handleUpdate(callbackUpdate(`done:${videoId}`, { user_id: uid1 }));
    await bot.handleUpdate(callbackUpdate(`done:${videoId}`, { user_id: uid2 }));

    expect(db.getCompletionCount(postId)).toBe(2);
  });

  it('rating popup shows formula on click', async () => {
    const { videoId } = setupDoneTest('rating');

    await bot.handleUpdate(callbackUpdate(`rating:${videoId}`, { user_id: USER_ID + 400 }));

    const answers = findCalls('answerCallbackQuery');
    expect(answers.length).toBeGreaterThan(0);
    const payload = answers[0].payload;
    // show_alert: true + text with formula
    expect(payload.show_alert).toBe(true);
    expect(payload.text).toContain('35%');
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// UGC FLOW: YouTube link → category → difficulty → duration → equipment → title
// ═══════════════════════════════════════════════════════════════════════════

describe('UGC flow end-to-end', () => {

  it('completes full UGC submission from YouTube link to admin review', async () => {
    // Step 1: "Предложить тренировку"
    await bot.handleUpdate(textUpdate('Предложить тренировку', { chat_id: USER_ID, user_id: USER_ID }));

    let state = db.getUgcState(USER_ID);
    expect(state?.step).toBe('waiting_link');

    // Step 2: YouTube link
    await bot.handleUpdate(textUpdate('https://www.youtube.com/watch?v=abc123test1', { chat_id: USER_ID, user_id: USER_ID }));

    state = db.getUgcState(USER_ID);
    expect(state?.step).toBe('waiting_category');
    const subId = state!.submission_id!;
    expect(subId).toBeGreaterThan(0);

    // Step 3: Category callback
    await bot.handleUpdate(callbackUpdate(`ugc_cat:${subId}:stretching`, { user_id: USER_ID, chat_id: USER_ID }));

    state = db.getUgcState(USER_ID);
    expect(state?.step).toBe('waiting_difficulty');

    // Step 4: Difficulty callback
    await bot.handleUpdate(callbackUpdate(`ugc_diff:${subId}:beginner`, { user_id: USER_ID, chat_id: USER_ID }));

    state = db.getUgcState(USER_ID);
    expect(state?.step).toBe('waiting_duration');

    // Step 5: Duration callback (10 min)
    await bot.handleUpdate(callbackUpdate(`ugc_dur:${subId}:600`, { user_id: USER_ID, chat_id: USER_ID }));

    state = db.getUgcState(USER_ID);
    expect(state?.step).toBe('waiting_equipment');

    // Step 6: Equipment callback
    await bot.handleUpdate(callbackUpdate(`ugc_equip:${subId}:none`, { user_id: USER_ID, chat_id: USER_ID }));

    state = db.getUgcState(USER_ID);
    expect(state?.step).toBe('waiting_title');

    // Step 7: Title text
    await bot.handleUpdate(textUpdate('Утренняя растяжка для спины', { chat_id: USER_ID, user_id: USER_ID }));

    // State should be cleared (flow complete)
    state = db.getUgcState(USER_ID);
    expect(state).toBeFalsy();

    // Submission in DB with all fields
    const sub = db.getUgcSubmission(subId);
    expect(sub).toBeTruthy();
    expect(sub!.status).toBe('pending');
    expect(sub!.category).toBe('stretching');
    expect(sub!.difficulty).toBe('beginner');
    expect(sub!.duration_seconds).toBe(600);
    expect(sub!.equipment).toBeTruthy();
    expect(sub!.title).toBe('Утренняя растяжка для спины');
    expect(sub!.muscles).toBeTruthy(); // auto-detected "спина" from title

    // Admin was notified (sendMessage to admin)
    const adminCalls = findCalls('sendMessage').filter(
      c => c.payload.chat_id === ADMIN_ID
    );
    expect(adminCalls.length).toBeGreaterThan(0);
  });

  it('rejects invalid YouTube link', async () => {
    // Start UGC flow
    await bot.handleUpdate(textUpdate('Предложить тренировку', { chat_id: USER_ID + 10, user_id: USER_ID + 10 }));

    // Send invalid link
    await bot.handleUpdate(textUpdate('not-a-youtube-link', { chat_id: USER_ID + 10, user_id: USER_ID + 10 }));

    // State still waiting_link (didn't advance)
    const state = db.getUgcState(USER_ID + 10);
    expect(state?.step).toBe('waiting_link');

    // Cleanup
    db.deleteUgcState(USER_ID + 10);
  });

  it('cancel button clears UGC state', async () => {
    const uid = USER_ID + 20;
    // Start flow
    await bot.handleUpdate(textUpdate('Предложить тренировку', { chat_id: uid, user_id: uid }));
    expect(db.getUgcState(uid)?.step).toBe('waiting_link');

    // Send YouTube link to create submission
    await bot.handleUpdate(textUpdate('https://youtube.com/watch?v=cancel_tes1', { chat_id: uid, user_id: uid }));
    const state = db.getUgcState(uid);
    expect(state?.step).toBe('waiting_category');

    // Cancel
    await bot.handleUpdate(callbackUpdate('ugc_cancel', { user_id: uid, chat_id: uid }));

    // State cleared
    expect(db.getUgcState(uid)).toBeFalsy();

    // Submission deleted
    if (state?.submission_id) {
      expect(db.getUgcSubmission(state.submission_id)).toBeFalsy();
    }
  });

  it('muscle auto-detection works from title', async () => {
    const uid = USER_ID + 30;

    // Fast-track: create submission directly and test title step
    const subId = db.createUgcSubmission(uid, 'testuser', 'https://youtube.com/watch?v=muscle_test', 'muscle_test');
    db.updateUgcSubmission(subId, { category: 'stretching', difficulty: 'beginner', duration_seconds: 300, duration_label: '5 мин', equipment: 'без инвентаря' });
    db.saveUgcState(uid, 'waiting_title', subId);

    // Title with muscle keywords
    await bot.handleUpdate(textUpdate('Глубокая растяжка на шею и плечи', { chat_id: uid, user_id: uid }));

    const sub = db.getUgcSubmission(subId);
    expect(sub!.muscles).toBeTruthy();
    // Should detect neck/shoulders
    const muscles = sub!.muscles!.toLowerCase();
    expect(muscles.includes('шея') || muscles.includes('плечи')).toBe(true);

    // Cleanup
    db.deleteUgcState(uid);
  });
});
