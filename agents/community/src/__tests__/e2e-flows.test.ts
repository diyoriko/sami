/**
 * Full E2E test suite: every user-facing scenario through bot.handleUpdate().
 * Covers: onboarding (captcha → goal → DM), /start, UGC flow (admin + user),
 * "Мои тренировки" (enriched cards, delete), completion, rating,
 * admin commands, profile, filters, rubric selection, poll tracking.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe, ChatMemberUpdated } from 'grammy/types';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-e2e.db');

const CHANNEL_ID = -1003746963456;
const GROUP_ID = -1003604276410;
const ADMIN_ID = 85013206;
const USER_ID = 50000;
const BOT_ID = 99999;

// ─── Update builders ──────────────────────────────────────────────────────────

let updateCounter = 0;

function textUpdate(text: string, opts: { chat_id?: number; user_id?: number; first_name?: string } = {}): Update {
  const chatId = opts.chat_id ?? USER_ID;
  const userId = opts.user_id ?? USER_ID;
  const msg: any = {
    message_id: ++updateCounter + 3000,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup', title: 'Test' } as any,
    from: { id: userId, is_bot: false, first_name: opts.first_name ?? 'Тестер', username: 'tester' },
    text,
  };
  // grammY's bot.command() needs bot_command entity
  if (text.startsWith('/')) {
    const cmd = text.split(/\s/)[0];
    msg.entities = [{ type: 'bot_command', offset: 0, length: cmd.length }];
  }
  return { update_id: ++updateCounter, message: msg };
}

function callbackUpdate(data: string, opts: { user_id?: number; chat_id?: number; message_id?: number; first_name?: string } = {}): Update {
  const chatId = opts.chat_id ?? USER_ID;
  return {
    update_id: ++updateCounter,
    callback_query: {
      id: `cb_${updateCounter}`,
      chat_instance: 'test',
      from: { id: opts.user_id ?? USER_ID, is_bot: false, first_name: opts.first_name ?? 'Тестер', username: 'tester' },
      message: {
        message_id: opts.message_id ?? 6000,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup', title: 'Test' } as any,
        from: { id: BOT_ID, is_bot: true, first_name: 'Сами botik' },
        text: 'prompt',
      } as any,
      data,
    },
  };
}

function chatMemberUpdate(userId: number, firstName: string): Update {
  return {
    update_id: ++updateCounter,
    chat_member: {
      chat: { id: GROUP_ID, type: 'supergroup', title: 'Сами Daily' } as any,
      from: { id: userId, is_bot: false, first_name: firstName },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { user: { id: userId, is_bot: false, first_name: firstName }, status: 'left' } as any,
      new_chat_member: { user: { id: userId, is_bot: false, first_name: firstName }, status: 'member' } as any,
    } as ChatMemberUpdated,
  };
}

function autoForwardUpdate(channelMsgId: number): Update {
  return {
    update_id: ++updateCounter,
    message: {
      message_id: ++updateCounter + 4000,
      date: Math.floor(Date.now() / 1000),
      chat: { id: GROUP_ID, type: 'supergroup', title: 'Сами Daily' } as any,
      from: { id: 777000, is_bot: false, first_name: 'Telegram' },
      is_automatic_forward: true,
      forward_origin: {
        type: 'channel',
        chat: { id: CHANNEL_ID, type: 'channel', title: 'Сами' } as any,
        message_id: channelMsgId,
        date: Math.floor(Date.now() / 1000),
      },
      text: 'Test video caption',
    } as any,
  };
}

function pollUpdate(pollId: string, question: string, options: { text: string; voter_count: number }[]): Update {
  return {
    update_id: ++updateCounter,
    poll: {
      id: pollId,
      question,
      options: options.map(o => ({ ...o, text: o.text })),
      total_voter_count: options.reduce((s, o) => s + o.voter_count, 0),
      is_closed: false,
      is_anonymous: true,
      type: 'regular',
      allows_multiple_answers: false,
    } as any,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let bot: Bot;
let apiCalls: { method: string; payload: any }[];
let db: typeof import('../db');
let registerBotMenu: typeof import('../bot-menu').registerBotMenu;
let registerModeration: typeof import('../moderation').registerModeration;

beforeAll(async () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}

  process.env.COMMUNITY_DB_PATH = TEST_DB_PATH;
  process.env.TELEGRAM_BOT_TOKEN = 'test:fake-token';
  process.env.TELEGRAM_CHANNEL_ID = String(CHANNEL_ID);
  process.env.TELEGRAM_GROUP_ID = String(GROUP_ID);
  process.env.TELEGRAM_ADMIN_USER_ID = String(ADMIN_ID);
  process.env.YOUTUBE_API_KEY = 'test-api-key';

  db = await import('../db');
  registerBotMenu = (await import('../bot-menu')).registerBotMenu;
  registerModeration = (await import('../moderation')).registerModeration;
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

beforeEach(() => {
  updateCounter = 0;
  apiCalls = [];

  bot = new Bot('test:fake-token');
  bot.botInfo = {
    id: BOT_ID, is_bot: true, first_name: 'Сами botik', username: 'sami_workout_bot',
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  } as UserFromGetMe;

  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    const msg = {
      message_id: 9999, date: Math.floor(Date.now() / 1000),
      chat: { id: (payload as any)?.chat_id ?? GROUP_ID, type: 'supergroup', title: 'Test' },
      from: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, text: '',
    };
    if (method === 'sendMessage' || method === 'sendVideo' || method === 'sendPoll') return { ok: true as const, result: msg as any };
    if (method === 'getChatMember') return { ok: true as const, result: { status: 'member', user: { id: (payload as any)?.user_id } } as any };
    if (method === 'getChatMemberCount') return { ok: true as const, result: 5 as any };
    if (method === 'getChat') return { ok: true as const, result: { id: CHANNEL_ID, type: 'channel', title: 'Test' } as any };
    return { ok: true as const, result: true as any };
  });

  registerModeration(bot);
  registerBotMenu(bot);
});

function findCalls(method: string) {
  return apiCalls.filter(c => c.method === method);
}

function lastSendText(): string {
  const sends = findCalls('sendMessage');
  return sends.length > 0 ? JSON.stringify(sends[sends.length - 1].payload) : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ONBOARDING: chat_member → captcha → goal quiz → DM
// ═══════════════════════════════════════════════════════════════════════════════

describe('onboarding flow', () => {
  const NEW_USER = USER_ID + 500;

  it('new member triggers captcha: mute + math question + 4 options', async () => {
    await bot.handleUpdate(chatMemberUpdate(NEW_USER, 'Новичок'));

    // User was restricted (muted)
    const restricts = findCalls('restrictChatMember');
    expect(restricts.length).toBeGreaterThan(0);
    expect(restricts[0].payload.user_id).toBe(NEW_USER);

    // Captcha message sent with inline keyboard
    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    const captchaPayload = JSON.stringify(sends[0].payload);
    expect(captchaPayload).toContain('Новичок');
    expect(captchaPayload).toContain('captcha:');

    // Captcha persisted in DB
    const captcha = db.getCaptcha(NEW_USER);
    expect(captcha).not.toBeNull();
    expect(captcha!.answer).toBeGreaterThanOrEqual(2);
    expect(captcha!.answer).toBeLessThanOrEqual(18);
  });

  it('correct captcha answer → unrestrict + goal quiz', async () => {
    // Trigger captcha
    await bot.handleUpdate(chatMemberUpdate(NEW_USER + 1, 'Правильный'));
    const captcha = db.getCaptcha(NEW_USER + 1)!;

    apiCalls = [];

    // Answer correctly
    await bot.handleUpdate(callbackUpdate(`captcha:${NEW_USER + 1}:${captcha.answer}`, {
      user_id: NEW_USER + 1, chat_id: GROUP_ID,
    }));

    // Unrestricted — restrictChatMember called with permissive permissions
    const restricts = findCalls('restrictChatMember');
    expect(restricts.length).toBeGreaterThan(0);

    // answerCallbackQuery with ✅
    const answers = findCalls('answerCallbackQuery');
    expect(answers.length).toBeGreaterThan(0);

    // Goal quiz shown (editMessageText with goal: buttons)
    const edits = findCalls('editMessageText');
    expect(edits.length).toBeGreaterThan(0);
    const goalText = JSON.stringify(edits[edits.length - 1].payload);
    expect(goalText).toContain('goal:');
    expect(goalText).toContain('привело');

    // Captcha removed from DB (better-sqlite3 .get() returns undefined, not null)
    expect(db.getCaptcha(NEW_USER + 1)).toBeFalsy();
  });

  it('wrong captcha answer → kick', async () => {
    await bot.handleUpdate(chatMemberUpdate(NEW_USER + 2, 'Неправильный'));
    const captcha = db.getCaptcha(NEW_USER + 2)!;
    const wrongAnswer = captcha.answer + 1;

    apiCalls = [];
    await bot.handleUpdate(callbackUpdate(`captcha:${NEW_USER + 2}:${wrongAnswer}`, {
      user_id: NEW_USER + 2, chat_id: GROUP_ID,
    }));

    // Kicked (ban + unban)
    expect(findCalls('banChatMember').length).toBeGreaterThan(0);
    expect(findCalls('unbanChatMember').length).toBeGreaterThan(0);
  });

  it('someone else cannot answer another user captcha', async () => {
    await bot.handleUpdate(chatMemberUpdate(NEW_USER + 3, 'Жертва'));
    const captcha = db.getCaptcha(NEW_USER + 3)!;

    apiCalls = [];
    // Different user tries to answer
    await bot.handleUpdate(callbackUpdate(`captcha:${NEW_USER + 3}:${captcha.answer}`, {
      user_id: NEW_USER + 999, chat_id: GROUP_ID,
    }));

    // answerCallbackQuery with "не твоя"
    const answers = findCalls('answerCallbackQuery');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers[0].payload.text).toContain('не твоя');

    // Captcha still in DB (not consumed)
    expect(db.getCaptcha(NEW_USER + 3)).not.toBeNull();

    // Cleanup
    db.deleteCaptcha(NEW_USER + 3);
  });

  it('goal selection → saves goal + sends onboarding DM', async () => {
    db.upsertMember(NEW_USER + 4, 'goaluser', 'Целевой');

    await bot.handleUpdate(callbackUpdate('goal:mobility', {
      user_id: NEW_USER + 4, chat_id: GROUP_ID,
    }));

    // Goal saved in DB
    const rawDb = db.getDb();
    const member = rawDb.prepare('SELECT fitness_goal FROM members WHERE telegram_user_id = ?').get(NEW_USER + 4) as any;
    expect(member?.fitness_goal).toBe('mobility');

    // Onboarding DM sent to user
    const dms = findCalls('sendMessage').filter(c => c.payload.chat_id === NEW_USER + 4);
    expect(dms.length).toBeGreaterThan(0);
    const dmText = JSON.stringify(dms[0].payload);
    expect(dmText).toContain('Как устроен Sami');
    expect(dmText).toContain('Я сделаль');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. /start IN PRIVATE CHAT
// ═══════════════════════════════════════════════════════════════════════════════

describe('/start command', () => {
  it('sends welcome message with persistent keyboard', async () => {
    await bot.handleUpdate(textUpdate('/start', { chat_id: USER_ID, user_id: USER_ID }));

    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    const payload = JSON.stringify(sends[0].payload);
    // Persistent keyboard buttons
    expect(payload).toContain('Предложить тренировку');
    expect(payload).toContain('Мои тренировки');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. UGC FLOW — REGULAR USER
// ═══════════════════════════════════════════════════════════════════════════════

describe('UGC flow — regular user', () => {
  const UID = USER_ID + 100;

  it('full flow: link → category → difficulty → duration → equipment → title → admin notified', async () => {
    // Step 1: trigger
    await bot.handleUpdate(textUpdate('💡 Предложить тренировку', { chat_id: UID, user_id: UID }));
    expect(db.getUgcState(UID)?.step).toBe('waiting_link');

    // Step 2: YouTube link
    await bot.handleUpdate(textUpdate('https://youtube.com/watch?v=e2eUsrTest1', { chat_id: UID, user_id: UID }));
    const state = db.getUgcState(UID);
    expect(state?.step).toBe('waiting_category');
    const subId = state!.submission_id!;

    // Step 3: category
    await bot.handleUpdate(callbackUpdate(`ugc_cat:${subId}:yoga`, { user_id: UID, chat_id: UID }));
    expect(db.getUgcState(UID)?.step).toBe('waiting_difficulty');

    // Step 4: difficulty
    await bot.handleUpdate(callbackUpdate(`ugc_diff:${subId}:intermediate`, { user_id: UID, chat_id: UID }));
    expect(db.getUgcState(UID)?.step).toBe('waiting_duration');

    // Step 5: duration
    await bot.handleUpdate(callbackUpdate(`ugc_dur:${subId}:900`, { user_id: UID, chat_id: UID }));
    expect(db.getUgcState(UID)?.step).toBe('waiting_equipment');

    // Step 6: equipment
    await bot.handleUpdate(callbackUpdate(`ugc_equip:${subId}:band`, { user_id: UID, chat_id: UID }));
    // Regular user skips rubric → goes to title
    expect(db.getUgcState(UID)?.step).toBe('waiting_title');

    // Step 7: title
    await bot.handleUpdate(textUpdate('Йога для плеч и шеи с резинкой', { chat_id: UID, user_id: UID }));
    expect(db.getUgcState(UID)).toBeFalsy();

    // Verify submission
    const sub = db.getUgcSubmission(subId)!;
    expect(sub.status).toBe('pending');
    expect(sub.category).toBe('yoga');
    expect(sub.difficulty).toBe('intermediate');
    expect(sub.duration_seconds).toBe(900);
    expect(sub.equipment).toBe('резинка'); // stored as Russian label via EQUIPMENT_VALUE_RU
    expect(sub.title).toBe('Йога для плеч и шеи с резинкой');
    expect(sub.muscles).toBeTruthy();

    // Admin notified
    const adminCalls = findCalls('sendMessage').filter(c => c.payload.chat_id === ADMIN_ID);
    expect(adminCalls.length).toBeGreaterThan(0);
  });

  it('back navigation: equipment → difficulty (duration set) → category', async () => {
    const uid = UID + 10;
    await bot.handleUpdate(textUpdate('💡 Предложить тренировку', { chat_id: uid, user_id: uid }));
    await bot.handleUpdate(textUpdate('https://youtube.com/watch?v=e2e_back_1x', { chat_id: uid, user_id: uid }));
    const subId = db.getUgcState(uid)!.submission_id!;

    // Forward to equipment
    await bot.handleUpdate(callbackUpdate(`ugc_cat:${subId}:stretching`, { user_id: uid, chat_id: uid }));
    await bot.handleUpdate(callbackUpdate(`ugc_diff:${subId}:beginner`, { user_id: uid, chat_id: uid }));
    await bot.handleUpdate(callbackUpdate(`ugc_dur:${subId}:300`, { user_id: uid, chat_id: uid }));
    expect(db.getUgcState(uid)?.step).toBe('waiting_equipment');

    // Back from equipment: since duration_seconds is set (300), goes to difficulty
    await bot.handleUpdate(callbackUpdate(`ugc_back:${subId}:waiting_equipment`, { user_id: uid, chat_id: uid }));
    expect(db.getUgcState(uid)?.step).toBe('waiting_difficulty');

    // Back to category
    await bot.handleUpdate(callbackUpdate(`ugc_back:${subId}:waiting_difficulty`, { user_id: uid, chat_id: uid }));
    expect(db.getUgcState(uid)?.step).toBe('waiting_category');

    // Cleanup
    db.deleteUgcState(uid);
    db.deleteUgcSubmission(subId);
  });

  it('cancel at any step clears state and soft-deletes submission', async () => {
    const uid = UID + 20;
    await bot.handleUpdate(textUpdate('💡 Предложить тренировку', { chat_id: uid, user_id: uid }));
    await bot.handleUpdate(textUpdate('https://youtube.com/watch?v=e2eCancelT1', { chat_id: uid, user_id: uid }));
    const subId = db.getUgcState(uid)!.submission_id!;

    await bot.handleUpdate(callbackUpdate(`ugc_cat:${subId}:cardio`, { user_id: uid, chat_id: uid }));
    expect(db.getUgcState(uid)?.step).toBe('waiting_difficulty');

    // Cancel mid-flow
    await bot.handleUpdate(callbackUpdate('ugc_cancel', { user_id: uid, chat_id: uid }));
    expect(db.getUgcState(uid)).toBeFalsy();
    expect(db.getUgcSubmission(subId)).toBeNull(); // soft-deleted
  });

  it('duplicate YouTube link shows warning', async () => {
    const uid = UID + 30;
    const ytId = 'dQw4w9WgXcQ'; // valid 11-char YouTube ID
    // First submission
    db.createUgcSubmission(uid, 'dup', `https://youtube.com/watch?v=${ytId}`, ytId);

    // Try to submit same link
    await bot.handleUpdate(textUpdate('💡 Предложить тренировку', { chat_id: uid, user_id: uid }));
    await bot.handleUpdate(textUpdate(`https://www.youtube.com/watch?v=${ytId}`, { chat_id: uid, user_id: uid }));

    // Should warn about duplicate ("уже было предложено")
    const sends = findCalls('sendMessage');
    const texts = sends.map(s => JSON.stringify(s.payload)).join(' ');
    expect(texts).toContain('уже');

    db.deleteUgcState(uid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. UGC FLOW — ADMIN (with rubric)
// ═══════════════════════════════════════════════════════════════════════════════

describe('UGC flow — admin with rubric', () => {
  it('admin sees rubric picker after equipment, can set custom rubric', async () => {
    // Admin starts UGC
    await bot.handleUpdate(textUpdate('💡 Предложить тренировку', { chat_id: ADMIN_ID, user_id: ADMIN_ID }));
    expect(db.getUgcState(ADMIN_ID)?.step).toBe('waiting_link');

    // Send link
    await bot.handleUpdate(textUpdate('https://youtube.com/watch?v=e2eAdmRub01', { chat_id: ADMIN_ID, user_id: ADMIN_ID }));
    const subId = db.getUgcState(ADMIN_ID)!.submission_id!;

    // Category → difficulty → duration → equipment
    await bot.handleUpdate(callbackUpdate(`ugc_cat:${subId}:breathing`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));
    await bot.handleUpdate(callbackUpdate(`ugc_diff:${subId}:beginner`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));
    await bot.handleUpdate(callbackUpdate(`ugc_dur:${subId}:600`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));
    await bot.handleUpdate(callbackUpdate(`ugc_equip:${subId}:none`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));

    // Admin should see rubric picker (waiting_rubric or similar)
    const state = db.getUgcState(ADMIN_ID);
    // After equipment, admin gets rubric options via callback
    // Check that editMessageText/sendMessage contains rubric options
    const allPayloads = apiCalls.map(c => JSON.stringify(c.payload)).join(' ');
    expect(allPayloads).toContain('ugc_rubric:');

    // Pick custom rubric
    await bot.handleUpdate(callbackUpdate(`ugc_rubric:${subId}:custom`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));
    expect(db.getUgcState(ADMIN_ID)?.step).toBe('waiting_rubric');

    // Type custom rubric text
    await bot.handleUpdate(textUpdate('Утренний ритуал', { chat_id: ADMIN_ID, user_id: ADMIN_ID }));

    // Should now be at waiting_title
    expect(db.getUgcState(ADMIN_ID)?.step).toBe('waiting_title');

    // Rubric saved
    const sub = db.getUgcSubmission(subId)!;
    expect(sub.rubric).toBe('Утренний ритуал');

    // Title
    await bot.handleUpdate(textUpdate('Дыхание утром', { chat_id: ADMIN_ID, user_id: ADMIN_ID }));
    expect(db.getUgcState(ADMIN_ID)).toBeFalsy();

    // Clean up
    db.deleteUgcState(ADMIN_ID);
  });

  it('admin "Сезон" rubric sets rubric to null', async () => {
    // Clean any leftover state from previous test
    db.deleteUgcState(ADMIN_ID);

    await bot.handleUpdate(textUpdate('💡 Предложить тренировку', { chat_id: ADMIN_ID, user_id: ADMIN_ID }));
    await bot.handleUpdate(textUpdate('https://youtube.com/watch?v=e2eAdmRub02', { chat_id: ADMIN_ID, user_id: ADMIN_ID }));
    const subId = db.getUgcState(ADMIN_ID)!.submission_id!;

    await bot.handleUpdate(callbackUpdate(`ugc_cat:${subId}:recovery`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));
    await bot.handleUpdate(callbackUpdate(`ugc_diff:${subId}:beginner`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));
    await bot.handleUpdate(callbackUpdate(`ugc_dur:${subId}:300`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));
    await bot.handleUpdate(callbackUpdate(`ugc_equip:${subId}:roller`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));

    // Pick "Сезон" — rubric = null
    await bot.handleUpdate(callbackUpdate(`ugc_rubric:${subId}:season`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));

    // Should skip to waiting_title
    expect(db.getUgcState(ADMIN_ID)?.step).toBe('waiting_title');
    expect(db.getUgcSubmission(subId)!.rubric).toBeNull();

    // Cleanup
    db.deleteUgcState(ADMIN_ID);
    db.deleteUgcSubmission(subId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. "МОИ ТРЕНИРОВКИ" — enriched cards + delete
// ═══════════════════════════════════════════════════════════════════════════════

describe('"Мои тренировки" display', () => {
  const UID = USER_ID + 200;

  it('shows enriched info: category emoji, duration, difficulty, equipment', async () => {
    // Create a workout
    const subId = db.createUgcSubmission(UID, 'myworkout', 'https://youtube.com/watch?v=myw1', 'myw1');
    db.updateUgcSubmission(subId, {
      title: 'Утренняя растяжка',
      category: 'stretching',
      difficulty: 'beginner',
      duration_seconds: 600,
      duration_label: '10 мин',
      equipment: 'none',
      status: 'published',
    });

    await bot.handleUpdate(textUpdate('🏋️ Мои тренировки', { chat_id: UID, user_id: UID }));

    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    const text = JSON.stringify(sends[sends.length - 1].payload);

    // Title bold
    expect(text).toContain('Утренняя растяжка');
    // Category emoji (🧘 for stretching)
    expect(text).toContain('🧘');
    // Duration
    expect(text).toContain('10 мин');
    // Status
    expect(text).toContain('опубликовано');
    // Delete button
    expect(text).toContain('ugc_del:');
  });

  it('shows equipment when not "none"', async () => {
    const subId = db.createUgcSubmission(UID + 1, 'equipuser', 'https://youtube.com/watch?v=myw2', 'myw2');
    db.updateUgcSubmission(subId, {
      title: 'Тренировка с гантелями',
      category: 'strength',
      difficulty: 'advanced',
      duration_seconds: 1800,
      duration_label: '30 мин',
      equipment: 'dumbbells',
      status: 'pending',
    });

    await bot.handleUpdate(textUpdate('🏋️ Мои тренировки', { chat_id: UID + 1, user_id: UID + 1 }));

    const text = lastSendText();
    expect(text).toContain('гантели');
    expect(text).toContain('💎💎💎'); // advanced = 3 diamonds
    expect(text).toContain('💪'); // strength emoji
  });

  it('empty state shows helpful message', async () => {
    const uid = UID + 99;

    await bot.handleUpdate(textUpdate('🏋️ Мои тренировки', { chat_id: uid, user_id: uid }));

    const text = lastSendText();
    expect(text).toContain('нет тренировок');
    expect(text).toContain('Предложить тренировку');
  });

  it('delete confirmation + soft delete + refresh', async () => {
    const uid = UID + 50;
    const subId = db.createUgcSubmission(uid, 'deltest', 'https://youtube.com/watch?v=del_e2e', 'del_e2e');
    db.updateUgcSubmission(subId, { title: 'Удаляемая', category: 'cardio', difficulty: 'beginner', status: 'draft' });

    // Click delete
    await bot.handleUpdate(callbackUpdate(`ugc_del:${subId}:0`, { user_id: uid, chat_id: uid }));

    // Should show confirmation
    const edits = findCalls('editMessageText');
    const confirmText = edits.map(e => JSON.stringify(e.payload)).join(' ');
    expect(confirmText).toContain('ugc_del_yes:');

    apiCalls = [];
    // Confirm
    await bot.handleUpdate(callbackUpdate(`ugc_del_yes:${subId}:0`, { user_id: uid, chat_id: uid }));

    // Submission soft-deleted
    expect(db.getUgcSubmission(subId)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. COMPLETION + RATING (auto-forward → "Я сделаль" → rating popup)
// ═══════════════════════════════════════════════════════════════════════════════

describe('completion + rating full flow', () => {
  it('auto-forward → completion button → click → count updates → rating popup', async () => {
    // Setup: video + post in DB
    const vid = db.upsertVideo({
      youtube_id: 'e2e_comp_1', title: 'Completion E2E', channel_name: 'TestCh',
      channel_url: null, duration_seconds: 600, duration_label: '10 мин',
      difficulty: 'beginner', category: 'stretching', muscles: null,
      thumbnail_url: null, video_url: 'https://youtube.com/watch?v=e2e_comp_1',
      view_count: 5000, rating: 0, like_ratio: 0.9, channel_subscribers: 10000,
    });
    const msgId = 8001;
    db.recordPost('2026-03-15', 'stretching', vid, msgId);

    // 1. Auto-forward triggers autocomment
    await bot.handleUpdate(autoForwardUpdate(msgId));
    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    const commentPayload = JSON.stringify(sends[0].payload);
    expect(commentPayload).toContain('done:');
    expect(commentPayload).toContain('rating:');

    // 2. User clicks "Я сделаль"
    const uid1 = USER_ID + 300;
    apiCalls = [];
    await bot.handleUpdate(callbackUpdate(`done:${vid}`, { user_id: uid1, chat_id: GROUP_ID }));

    const post = db.getPostByMessageId(msgId)!;
    expect(db.getCompletionCount(post.id)).toBe(1);
    expect(db.hasUserCompleted(post.id, uid1)).toBe(true);

    // 3. Second user completes
    const uid2 = USER_ID + 301;
    await bot.handleUpdate(callbackUpdate(`done:${vid}`, { user_id: uid2, chat_id: GROUP_ID }));
    expect(db.getCompletionCount(post.id)).toBe(2);

    // 4. Rating popup
    apiCalls = [];
    await bot.handleUpdate(callbackUpdate(`rating:${vid}`, { user_id: uid1, chat_id: GROUP_ID }));
    const answers = findCalls('answerCallbackQuery');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers[0].payload.show_alert).toBe(true);
    expect(answers[0].payload.text).toContain('Рейтинг');
    expect(answers[0].payload.text).toContain('35%');
  });

  it('fallback autocomment for unknown post still has buttons', async () => {
    await bot.handleUpdate(autoForwardUpdate(99998));

    const sends = findCalls('sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    const payload = JSON.stringify(sends[0].payload);
    expect(payload).toContain('done_msg:');
    expect(payload).toContain('rating_msg:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. ADMIN COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

describe('profile + menu buttons', () => {
  it('"Профиль" shows user stats', async () => {
    db.upsertMember(USER_ID + 600, 'profuser', 'Профиль');

    await bot.handleUpdate(textUpdate('Профиль', { chat_id: USER_ID + 600, user_id: USER_ID + 600 }));

    const sends = findCalls('sendMessage').filter(c => c.payload.chat_id === USER_ID + 600);
    expect(sends.length).toBeGreaterThan(0);
    const text = JSON.stringify(sends[0].payload);
    expect(text).toContain('Профиль');
  });

  it('"Фильтры" shows category filter buttons', async () => {
    await bot.handleUpdate(textUpdate('Фильтры', { chat_id: USER_ID + 601, user_id: USER_ID + 601 }));

    const sends = findCalls('sendMessage').filter(c => c.payload.chat_id === USER_ID + 601);
    expect(sends.length).toBeGreaterThan(0);
    const text = JSON.stringify(sends[0].payload);
    expect(text).toContain('filter:cat:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. UGC ADMIN DECISION (approve / reject)
// ═══════════════════════════════════════════════════════════════════════════════

describe('UGC admin decision', () => {
  it('admin approves tg: file → publishes to channel', async () => {
    // Use tg: file URL to avoid yt-dlp download
    const subId = db.createUgcSubmission(USER_ID + 400, 'approvetest', 'tg:file_approve_test', null);
    db.updateUgcSubmission(subId, {
      title: 'Одобряемая', category: 'stretching', difficulty: 'beginner',
      duration_seconds: 300, duration_label: '5 мин', equipment: 'none', status: 'pending',
    });

    await bot.handleUpdate(callbackUpdate(`ugc_decide:${subId}:approve`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));

    const sub = db.getUgcSubmission(subId)!;
    // Approve auto-publishes → status becomes 'published'
    expect(sub.status).toBe('published');

    // Video was sent to channel
    const videos = findCalls('sendVideo');
    expect(videos.length).toBeGreaterThan(0);
  });

  it('admin rejects → status changes to rejected', async () => {
    const subId = db.createUgcSubmission(USER_ID + 401, 'rejecttest', 'tg:file_reject_test', null);
    db.updateUgcSubmission(subId, {
      title: 'Отклоняемая', category: 'yoga', difficulty: 'beginner',
      duration_seconds: 300, equipment: 'none', status: 'pending',
    });

    await bot.handleUpdate(callbackUpdate(`ugc_decide:${subId}:reject`, { user_id: ADMIN_ID, chat_id: ADMIN_ID }));

    const sub = db.getUgcSubmission(subId)!;
    expect(sub.status).toBe('rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. POLL RESULTS TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

describe('poll results tracking', () => {
  it('poll update saves results to DB with season/week parsing', async () => {
    await bot.handleUpdate(pollUpdate('poll-e2e-1', 'Вторая неделя Сезона 2 позади! На каком вы дне?', [
      { text: 'День 1–7', voter_count: 3 },
      { text: 'День 8–14', voter_count: 5 },
      { text: 'День 15–21', voter_count: 1 },
      { text: 'Пропустил(а) неделю', voter_count: 2 },
    ]));

    const results = db.getPollResults(2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const poll = results.find(r => r.poll_id === 'poll-e2e-1')!;
    expect(poll.total_voters).toBe(11);
    expect(poll.season_number).toBe(2);
    expect(poll.week_number).toBe(2);
    expect(poll.options).toHaveLength(4);
  });

  it('subsequent votes update existing poll record', async () => {
    await bot.handleUpdate(pollUpdate('poll-e2e-2', 'Первая неделя Сезона 3 позади!', [
      { text: 'День 1–7', voter_count: 1 },
    ]));

    await bot.handleUpdate(pollUpdate('poll-e2e-2', 'Первая неделя Сезона 3 позади!', [
      { text: 'День 1–7', voter_count: 5 },
    ]));

    const results = db.getPollResults(3);
    const poll = results.find(r => r.poll_id === 'poll-e2e-2')!;
    expect(poll.total_voters).toBe(5); // Updated, not doubled
  });
});
