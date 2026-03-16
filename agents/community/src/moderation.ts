import { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import { type Category, CATEGORY_RU, escV2 } from './shared';
import { moscowHour } from './dates';
import { incrementNewMembers } from './scheduler';

const log = createLogger('moderation');
import {
  upsertMember, setMemberGoal, addWarning, muteMember,
  recordCompletion, removeCompletion, getCompletionCount, hasUserCompleted,
  getPostByMessageId, getLatestPostByVideoId, getPostByGroupCommentId, setGroupCommentId, updateVideoRating, getLastCompletionTime,
  getUserStreak,
  saveCaptcha, getCaptcha, deleteCaptcha, getExpiredCaptchas,
  getLatestPostForDate,
  getMemberLevel, getMemberJoinedAt,
  logModAction, getStopPhrases,
  wasBuddyInviteSent, markBuddyInviteSent,
  upsertPollResult,
  getRecentPostsByCategory,
} from './db';

// ─── FIRST COMPLETION DM ─────────────────────────────────────────────────────
// After the very first "Я сделаль", send a personal congratulation + 2-3 videos
// from the same category so the user sticks around.

async function sendFirstCompletionDM(bot: Bot, userId: number, category: string): Promise<void> {
  const config = getConfig();
  const channelHandle = config.TELEGRAM_CHANNEL_ID.startsWith('@')
    ? config.TELEGRAM_CHANNEL_ID.slice(1)
    : `c/${config.TELEGRAM_CHANNEL_ID.replace(/^-100/, '')}`;

  const catLabel = CATEGORY_RU[category as Category] ?? category;
  const recentPosts = getRecentPostsByCategory(category, 3);

  let linksBlock = '';
  if (recentPosts.length > 0) {
    const links = recentPosts.map(p =>
      `• [${escV2(p.title.slice(0, 50))}](https://t.me/${channelHandle}/${p.channel_message_id})`
    ).join('\n');
    linksBlock = `\n\n*Ещё ${escV2(catLabel)}:*\n${links}`;
  }

  try {
    await bot.api.sendMessage(
      userId,
      `🎉 *Поздравляем с первой тренировкой\\!*\n\n` +
      `Ты только что сделал\\(а\\) первый шаг — это уже победа\\. ` +
      `Теперь главное — не останавливаться\\.` +
      linksBlock +
      `\n\nКаждый день в канале новая тренировка — заглядывай\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    log.info('first completion DM sent', { userId, category });
  } catch {
    // User blocked DMs — that's ok
  }
}

// ─── CELEBRATION MESSAGES ─────────────────────────────────────────────────────

const CELEBRATION_PHRASES = [
  (n: string) => `${n} на коврике!`,
  (n: string) => `${n} сделаль!`,
  (n: string) => `${n} в деле.`,
  (n: string) => `Есть! ${n} размялся.`,
  (n: string) => `${n} — тренировка в кармане.`,
  (n: string) => `Коврик не пустовал — ${n} поработал.`,
  (n: string) => `${n} — done.`,
  (n: string) => `+1 от ${n}. Уважение.`,
  (n: string) => `${n} потянулся. Красиво.`,
  (n: string) => `${n} зашёл, сделал, ушёл.`,
];

const STREAK_PHRASES = [
  (d: number) => `${d} дн. подряд — машина.`,
  (d: number) => `Серия ${d} дн. Не сбивайся.`,
  (d: number) => `${d}-й день подряд. Стабильность.`,
  (d: number) => `${d} дн. без перерыва.`,
];

const MILESTONE_PHRASES: Record<number, string> = {
  5: '🏅 Пять подряд — это уже привычка.',
  7: '🗓 Неделя без пропусков. Уровень.',
  14: '💎 Две недели. Ты в элите.',
  21: '👑 21 день. Сезон пройден. Легенда.',
};

const CROWD_PHRASES = [
  (n: number) => `Уже ${n} чел. сделали эту тренировку.`,
  (n: number) => `${n} человек — вместе проще.`,
  (n: number) => `Нас уже ${n}. Кто следующий?`,
];

function buildCelebrationComment(firstName: string, streak: number, completionCount: number): string {
  const emojis = ['🎉', '💪', '🔥', '⚡', '🙌', '✊', '🧘', '🏋️'];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];

  // Main phrase
  const phrase = CELEBRATION_PHRASES[Math.floor(Math.random() * CELEBRATION_PHRASES.length)];
  let text = `${emoji} ${phrase(firstName)}`;

  // Milestone takes priority over generic streak
  if (MILESTONE_PHRASES[streak]) {
    text += `\n${MILESTONE_PHRASES[streak]}`;
  } else if (streak > 1) {
    const sp = STREAK_PHRASES[Math.floor(Math.random() * STREAK_PHRASES.length)];
    text += `\n🔥 ${sp(streak)}`;
  }

  // Crowd
  if (completionCount > 1) {
    const cp = CROWD_PHRASES[Math.floor(Math.random() * CROWD_PHRASES.length)];
    text += `\n${cp(completionCount)}`;
  }

  return text;
}

// ─── CAPTCHA ──────────────────────────────────────────────────────────────────
// Simple math captcha to filter bots. New member is muted until they pass.
// Wrong answer or timeout (2 min) → kick.
// State is persisted in SQLite — survives bot restarts.

const CAPTCHA_TIMEOUT_MS = 2 * 60 * 1000;

export function generateCaptcha(): { question: string; answer: number; options: number[] } {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const answer = a + b;

  // 3 wrong options, all different from answer and each other
  const wrong = new Set<number>();
  while (wrong.size < 3) {
    const n = Math.floor(Math.random() * 18) + 1;
    if (n !== answer) wrong.add(n);
  }

  const options = [answer, ...wrong].sort(() => Math.random() - 0.5);
  return { question: `${a} + ${b}`, answer, options };
}

// ─── GOAL QUIZ ────────────────────────────────────────────────────────────────
// Shown after captcha is passed. Aligned with SAMI values — no weight loss.

const GOAL_OPTIONS = [
  { text: '🔄 Вернуть ритм и дисциплину', data: 'goal:rhythm' },
  { text: '🧘 Стать гибче и мобильнее', data: 'goal:mobility' },
  { text: '💪 Набрать силу', data: 'goal:strength' },
  { text: '👀 Просто исследую', data: 'goal:observer' },
];

const GOAL_RESPONSES: Record<string, string> = {
  rhythm: `Отличный выбор. Ритм строится через маленькие ежедневные действия — именно за этим мы здесь.\n\nКаждый день выходят три тренировки: стретчинг, силовая и мобильность. Начни с любой.`,
  mobility: `Мобильность — основа всего. Тело благодарит, когда его двигают мягко и регулярно.\n\nКаждый день выходят три тренировки. Мобильность особенно для тебя.`,
  strength: `Сила без инвентаря — это реально. Только коврик, только тело, только практика.\n\nКаждый день выходят три тренировки. Силовая — вторая по счёту.`,
  observer: `Хорошее начало. Смотри, пробуй, пиши как дела — здесь никто не торопит.\n\nКаждый день выходят три тренировки. Когда будешь готов — просто нажми play.`,
};

// ─── SPAM PATTERNS ───────────────────────────────────────────────────────────

const SPAM_PATTERNS = [
  // External URLs (except YouTube, youtu.be, t.me/sami)
  /https?:\/\/(?!youtube\.com|youtu\.be|t\.me\/sami)/i,
  // Financial/gambling/crypto
  /(?:заработ|earn|casino|казино|crypto|крипт|invest|инвест|forex|форекс|binance|биржа|трейд|trade|betting|ставк|slot|слот|poker|покер|roulette|рулетк)/i,
  // Follow/subscribe spam
  /подпишись|subscribe|follow me|подпишитесь/i,
  // Adult/dating spam
  /(?:знакомств|dating|18\+|секс|sex|порн|porn|onlyfans|эскорт|escort)/i,
  // MLM/pyramid
  /(?:пассивн.{0,10}доход|passive\s*income|mlm|сетев.{0,10}маркетинг|network\s*marketing|пирамид)/i,
  // Telegram channel/group promo (except our own)
  /(?:t\.me\/(?!sami)\w+|телеграм.{0,10}канал|telegram.{0,10}channel)/i,
];

export function isSpam(text: string): boolean {
  return SPAM_PATTERNS.some(re => re.test(text));
}

// ─── STOP PHRASES (dynamic, loaded from DB) ─────────────────────────────────

let _cachedStopPhrases: string[] = [];
let _stopPhrasesLoadedAt = 0;
const STOP_PHRASES_TTL_MS = 5 * 60 * 1000; // refresh every 5 min

function matchesStopPhrases(text: string): boolean {
  const now = Date.now();
  if (now - _stopPhrasesLoadedAt > STOP_PHRASES_TTL_MS) {
    try {
      _cachedStopPhrases = getStopPhrases();
    } catch {
      // DB not ready yet, use cached
    }
    _stopPhrasesLoadedAt = now;
  }
  if (_cachedStopPhrases.length === 0) return false;
  const lower = text.toLowerCase();
  return _cachedStopPhrases.some(phrase => lower.includes(phrase));
}

// ─── ANTIFLOOD (in-memory rate limiter) ──────────────────────────────────────
// Tracks message timestamps per user. Mutes at threshold.

const ANTIFLOOD_WINDOW_MS = 30_000;   // 30 seconds
const ANTIFLOOD_MAX_MESSAGES = 5;     // max messages in window

// Newbie cooldown: 1 message per minute for first 24h
const NEWBIE_COOLDOWN_MS = 60_000;    // 1 minute between messages
const NEWBIE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

// Night mode: 00:00-07:00 MSK — stricter thresholds
const NIGHT_START_HOUR = 0;
const NIGHT_END_HOUR = 7;
const NIGHT_ANTIFLOOD_MAX = 3; // stricter at night

const messageTimestamps = new Map<number, number[]>();

function cleanupTimestamps(userId: number, now: number): number[] {
  const timestamps = messageTimestamps.get(userId) ?? [];
  const recent = timestamps.filter(t => now - t < ANTIFLOOD_WINDOW_MS);
  messageTimestamps.set(userId, recent);
  return recent;
}

function isNightMode(): boolean {
  const hour = moscowHour();
  return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
}

// ─── REPUTATION-BASED THRESHOLDS ─────────────────────────────────────────────
// новичок: stricter (standard thresholds)
// практик: relaxed (double thresholds)
// наставник: minimal moderation (quadruple thresholds, no cooldown)

function getAntifloodLimit(userId: number): number {
  const { level } = getMemberLevel(userId);
  const base = isNightMode() ? NIGHT_ANTIFLOOD_MAX : ANTIFLOOD_MAX_MESSAGES;
  switch (level) {
    case 'наставник': return base * 4;
    case 'практик': return base * 2;
    default: return base;
  }
}

function isNewbie(userId: number): boolean {
  const { level } = getMemberLevel(userId);
  if (level !== 'новичок') return false;

  const joinedAt = getMemberJoinedAt(userId);
  if (!joinedAt) return true; // no record = treat as new
  const joinedMs = new Date(joinedAt).getTime();
  return Date.now() - joinedMs < NEWBIE_PERIOD_MS;
}

// ─── EXPIRED CAPTCHA CLEANUP ────────────────────────────────────────────────

/** Kick users with expired captchas. Called periodically and on startup. */
export async function cleanupExpiredCaptchas(bot: Bot): Promise<void> {
  const config = getConfig();
  const expired = getExpiredCaptchas();
  for (const captcha of expired) {
    try {
      await bot.api.banChatMember(captcha.chat_id, captcha.telegram_user_id);
      await bot.api.unbanChatMember(captcha.chat_id, captcha.telegram_user_id);
    } catch {}
    try {
      if (captcha.captcha_message_id) {
        await bot.api.deleteMessage(captcha.chat_id, captcha.captcha_message_id);
      }
    } catch {}
    try {
      await bot.api.sendMessage(
        captcha.chat_id,
        `⏱ ${captcha.first_name} не ответил на проверку и был исключён. Он может вернуться в любой момент.`
      );
    } catch {}
    deleteCaptcha(captcha.telegram_user_id);
  }
}

// ─── REGISTER ────────────────────────────────────────────────────────────────

export function registerModeration(bot: Bot): void {
  const config = getConfig();

  // Periodic cleanup of expired captchas (every 30s)
  setInterval(() => cleanupExpiredCaptchas(bot).catch(err => {
    log.error('captcha cleanup failed', { error: String(err) });
  }), 30_000);

  // --- New member: mute + send captcha ---
  bot.on('chat_member', async (ctx) => {
    const member = ctx.chatMember;
    if (!member || ctx.chat.id.toString() !== config.TELEGRAM_GROUP_ID) return;
    if (member.new_chat_member?.status !== 'member') return;

    const user = member.new_chat_member.user;
    if (user.is_bot) return;

    upsertMember(user.id, user.username ?? null, user.first_name ?? null);

    const chatId = ctx.chat.id;
    const firstName = user.first_name ?? 'новый участник';

    // Mute until captcha passed
    try {
      await ctx.api.restrictChatMember(
        chatId,
        user.id,
        { can_send_messages: false, can_send_polls: false, can_send_other_messages: false }
      );
    } catch (err) {
      log.error('failed to mute new member for captcha', { error: String(err) });
    }

    const { question, answer, options } = generateCaptcha();

    const keyboard = new InlineKeyboard();
    options.forEach((opt, i) => {
      keyboard.text(String(opt), `captcha:${user.id}:${opt}`);
      if (i === 1) keyboard.row();
    });

    let captchaMsg;
    try {
      captchaMsg = await ctx.reply(
        `👋 ${escV2(firstName)}, добро пожаловать\\!\n\nЧтобы начать общаться, реши простой пример:\n\n*${escV2(question)} \\= ?*`,
        { parse_mode: 'MarkdownV2', reply_markup: keyboard }
      );
    } catch (err) {
      log.error('failed to send captcha', { error: String(err) });
      return;
    }

    // Persist captcha state in SQLite
    const expiresAt = new Date(Date.now() + CAPTCHA_TIMEOUT_MS);
    saveCaptcha(user.id, chatId, answer, firstName, captchaMsg.message_id, expiresAt);
  });

  // --- Captcha answer ---
  bot.callbackQuery(/^captcha:(\d+):(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    const chosen = parseInt(ctx.match[2]);
    const respondentId = ctx.from?.id;

    // Only the intended user can answer
    if (respondentId !== targetUserId) {
      await ctx.answerCallbackQuery('Это не твоя проверка 😄');
      return;
    }

    const captcha = getCaptcha(targetUserId);
    if (!captcha) {
      await ctx.answerCallbackQuery('Проверка уже завершена');
      return;
    }

    // Remove from DB immediately (no double-processing)
    deleteCaptcha(targetUserId);

    if (chosen !== captcha.answer) {
      // Wrong answer → kick (can rejoin)
      try {
        await ctx.editMessageText(`❌ Неверно. Ты можешь вернуться и попробовать снова.`);
      } catch {}
      try {
        await ctx.api.banChatMember(captcha.chat_id, targetUserId);
        await ctx.api.unbanChatMember(captcha.chat_id, targetUserId);
      } catch {}
      await ctx.answerCallbackQuery('Неверно');
      return;
    }

    // Correct → unrestrict + show goal quiz
    try {
      await ctx.api.restrictChatMember(
        captcha.chat_id,
        targetUserId,
        {
          can_send_messages: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
        }
      );
    } catch (err) {
      log.error('failed to unrestrict member', { error: String(err) });
    }

    await ctx.answerCallbackQuery('✅ Верно!');

    incrementNewMembers();

    const goalKeyboard = new InlineKeyboard();
    GOAL_OPTIONS.forEach((opt, i) => {
      goalKeyboard.text(opt.text, opt.data);
      if (i % 2 === 1) goalKeyboard.row();
    });

    try {
      await ctx.editMessageText(
        `✅ Отлично, ты человек\\!\n\nДобро пожаловать в Sami Community — место для тех, кто возвращает движение в свой день\\. Только коврик, без лишнего шума\\.\n\n*Что тебя сюда привело?*`,
        { parse_mode: 'MarkdownV2', reply_markup: goalKeyboard }
      );
    } catch {}
  });

  // --- Goal quiz callback ---
  bot.callbackQuery(/^goal:(.+)$/, async (ctx) => {
    const goal = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) return;

    setMemberGoal(userId, goal);
    await ctx.answerCallbackQuery();

    const response = GOAL_RESPONSES[goal] ?? 'Добро пожаловать! Рады тебя видеть.';

    // Build welcome message with link to today's training if available
    const { todayMsk } = await import('./dates');
    const latestPost = getLatestPostForDate(todayMsk());

    let welcomeText = `${escV2(response)}\n\n_Нажми «Я сделаль» под видео, когда закончишь тренировку\\._`;
    if (latestPost) {
      const catLabel = CATEGORY_RU[latestPost.category as Category] ?? latestPost.category;
      const channelHandle = config.TELEGRAM_CHANNEL_ID.startsWith('@')
        ? config.TELEGRAM_CHANNEL_ID.slice(1)
        : `c/${config.TELEGRAM_CHANNEL_ID.replace(/^-100/, '')}`;
      const postLink = `https://t.me/${channelHandle}/${latestPost.channel_message_id}`;
      welcomeText += `\n\n*Сегодняшняя тренировка \\(${escV2(catLabel)}\\):*\n[Перейти к видео](${postLink})`;
    }

    try {
      await ctx.editMessageText(welcomeText, { parse_mode: 'MarkdownV2' });
    } catch {}

    // Post-onboarding DM: explain how Sami works (sent privately)
    try {
      await bot.api.sendMessage(
        userId,
        `*Как устроен Sami*\n\n` +
        `Каждый день в канале @sami\\_workouts появляются видео\\-тренировки: стретчинг, силовая, мобильность и другие\\.\n\n` +
        `*Что делать:*\n` +
        `1\\. Открой видео, сделай тренировку\n` +
        `2\\. Нажми *Я сделаль* под постом — это отмечает выполнение\n` +
        `3\\. Счётчик показывает сколько людей уже сделали\n\n` +
        `*Что ещё умеет бот:*\n` +
        `• _Профиль_ — твоя статистика и уровень\n` +
        `• _🏋️ Мои тренировки_ — загруженные тобой видео\n` +
        `• _💡 Предложить тренировку_ — поделись своей находкой\n` +
        `• _Фильтры_ — найди видео по категории и длительности\n\n` +
        `Вопросы? Пиши в группу — поможем\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch {
      // User may have blocked DMs — that's ok
    }
  });

  // --- Spam + antiflood + cooldown filter ---
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.id.toString() !== config.TELEGRAM_GROUP_ID) return next();
    // Don't filter auto-forwarded channel posts — let auto-forward handler process them
    if (ctx.message.is_automatic_forward) return next();

    const userId = ctx.from?.id;
    if (!userId) return next();

    // Skip admins
    try {
      const member = await ctx.getChatMember(userId);
      if (['administrator', 'creator'].includes(member.status)) return;
    } catch {
      return;
    }

    const text = ctx.message.text ?? '';
    const now = Date.now();
    const night = isNightMode();

    // 1. Antiflood check (5 msgs / 30s, or 3 at night, scaled by reputation)
    const timestamps = cleanupTimestamps(userId, now);
    timestamps.push(now);
    messageTimestamps.set(userId, timestamps);

    const limit = getAntifloodLimit(userId);
    if (timestamps.length > limit) {
      try { await ctx.deleteMessage(); } catch {}
      muteMember(userId, night ? 2 : 1); // 1h mute (2h at night)
      const muteHours = night ? 2 : 1;
      try {
        const until = Math.floor(now / 1000) + muteHours * 3600;
        await ctx.api.restrictChatMember(
          ctx.chat.id, userId,
          { can_send_messages: false, can_send_polls: false, can_send_other_messages: false },
          { until_date: until }
        );
      } catch {}
      logModAction(userId, 'antiflood', `${timestamps.length} msgs in 30s (limit: ${limit})${night ? ' [night]' : ''}`, text);
      const username = ctx.from?.username ? `@${ctx.from.username}` : String(userId);
      await ctx.reply(`🔇 ${username} получил мут на ${muteHours}ч за флуд.`).catch(() => {});
      // Clear timestamps after mute
      messageTimestamps.delete(userId);
      return;
    }

    // 2. Newbie cooldown (1 msg / min for first 24h)
    if (isNewbie(userId) && timestamps.length >= 2) {
      const prevTimestamp = timestamps[timestamps.length - 2];
      if (now - prevTimestamp < NEWBIE_COOLDOWN_MS) {
        try { await ctx.deleteMessage(); } catch {}
        logModAction(userId, 'cooldown', 'newbie cooldown: <1min between messages', text);
        // Silent delete — no public warning for cooldown
        return;
      }
    }

    // 3. Spam patterns + stop phrases
    const isSpamMessage = isSpam(text) || matchesStopPhrases(text);

    // Night mode: also flag messages with multiple caps words or excessive emojis
    if (!isSpamMessage && night) {
      const capsWords = (text.match(/[A-ZА-ЯЁ]{4,}/g) ?? []).length;
      if (capsWords >= 3) {
        try { await ctx.deleteMessage(); } catch {}
        logModAction(userId, 'delete', 'excessive caps at night', text);
        return;
      }
    }

    if (!isSpamMessage) return;

    // Delete and escalate
    try { await ctx.deleteMessage(); } catch {}

    const warnings = addWarning(userId);
    const username = ctx.from?.username ? `@${ctx.from.username}` : String(userId);
    const reason = matchesStopPhrases(text) ? 'stop phrase' : 'spam pattern';

    if (warnings === 1) {
      logModAction(userId, 'warn', reason, text);
      await ctx.reply(
        `⚠️ ${username}, внешние ссылки и реклама здесь не приветствуются. Следующее нарушение — мут на 24 часа.`
      ).catch(() => {});
    } else if (warnings === 2) {
      muteMember(userId, 24);
      logModAction(userId, 'mute', `${reason}, 2nd warning`, text);
      try {
        const until = Math.floor(now / 1000) + 24 * 3600;
        await ctx.api.restrictChatMember(
          ctx.chat.id,
          userId,
          { can_send_messages: false, can_send_polls: false, can_send_other_messages: false },
          { until_date: until }
        );
        await ctx.reply(`🔇 ${username} получил мут на 24 часа.`).catch(() => {});
      } catch (err) {
        log.error('failed to mute', { error: String(err) });
      }
    } else if (warnings >= 3) {
      logModAction(userId, 'ban', `${reason}, ${warnings} warnings`, text);
      try {
        await ctx.api.banChatMember(ctx.chat.id, userId);
        await ctx.reply(`🚫 Участник заблокирован за систематические нарушения.`).catch(() => {});
        await bot.api.sendMessage(
          config.TELEGRAM_ADMIN_USER_ID,
          `🚫 Заблокировал ${userId} (@${ctx.from?.username ?? '?'}) за спам.`
        );
      } catch (err) {
        log.error('failed to ban', { error: String(err) });
      }
    }
  });

  // --- /report command ---
  bot.command('report', async (ctx) => {
    if (ctx.chat.id.toString() !== config.TELEGRAM_GROUP_ID) return;
    const reply = ctx.message?.reply_to_message;
    if (!reply) {
      await ctx.reply('Ответь на сообщение командой /report, чтобы пожаловаться.');
      return;
    }
    const reporter = ctx.from?.username ?? String(ctx.from?.id);
    const reported = reply.from?.username ?? String(reply.from?.id);
    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `🚨 *Репорт*\nОт: @${escV2(reporter)}\nНа: @${escV2(reported)}\n\n_${escV2((reply.text ?? '[медиа]').slice(0, 300))}_`,
      { parse_mode: 'MarkdownV2' }
    );
    await ctx.reply('✅ Репорт отправлен.').catch(() => {});
    try { await ctx.deleteMessage(); } catch {}
  });

  // --- Auto-forward from channel → post "Я сделаль" button as comment in discussion group ---
  bot.on('message', async (ctx, next) => {
    const groupId = Number(config.TELEGRAM_GROUP_ID);
    if (ctx.chat.id !== groupId) return next();

    // Diagnostic: log every group message to understand what Telegram sends
    const msg = ctx.message;
    log.info('group message received', {
      messageId: msg.message_id,
      isAutoForward: msg.is_automatic_forward ?? false,
      forwardOrigin: msg.forward_origin?.type ?? null,
      senderChatId: msg.sender_chat?.id ?? null,
      senderChatType: msg.sender_chat?.type ?? null,
      hasVideo: 'video' in msg,
      hasText: 'text' in msg,
      fromId: ctx.from?.id ?? null,
    });

    // Only handle auto-forwarded channel posts
    if (!msg.is_automatic_forward) return next();

    // Find the original channel message_id from forward_origin
    const origin = msg.forward_origin;
    if (!origin || origin.type !== 'channel') {
      log.warn('auto-forward: unexpected origin type', { origin });
      return next();
    }

    const channelMsgId = origin.message_id;
    const post = getPostByMessageId(channelMsgId);

    let keyboard: InlineKeyboard;
    if (post) {
      const count = getCompletionCount(post.id);
      keyboard = new InlineKeyboard()
        .text(`Я сделаль${count > 0 ? ` · ${count}` : ''}`, `done:${post.video_id}`);
    } else {
      // Post not tracked in DB (e.g. manual publish) — skip autocomment
      log.info('auto-forward: no post in DB, skipping autocomment', { channelMsgId });
      return next();
    }

    try {
      const comment = await bot.api.sendMessage(
        config.TELEGRAM_GROUP_ID,
        'Сделал(а) тренировку? Нажми кнопку:',
        {
          reply_parameters: { message_id: msg.message_id },
          reply_markup: keyboard,
        }
      );
      if (post) {
        setGroupCommentId(post.id, comment.message_id);
      }
      log.info('posted completion button in discussion', { postId: post?.id ?? null, commentId: comment.message_id });
    } catch (err) {
      log.error('failed to post completion button in discussion', { postId: post?.id ?? null, error: String(err) });
    }
  });

  // --- "Я сделаль" fallback for posts not tracked in DB ---
  // When auto-forward handler can't find a post in DB, it uses done_msg:{channelMsgId}
  bot.callbackQuery(/^done_msg:(\d+)$/, async (ctx) => {
    const channelMsgId = parseInt(ctx.match[1]);
    const userId = ctx.from?.id;
    if (!userId) return;

    // Try to find post by channel message ID
    const post = getPostByMessageId(channelMsgId);
    if (post) {
      // Found it — delegate to the regular done: flow by recording completion
      if (hasUserCompleted(post.id, userId)) {
        removeCompletion(post.id, userId);
        const count = getCompletionCount(post.id);
        const undoKeyboard = new InlineKeyboard()
          .text(count > 0 ? `Я сделаль · ${count}` : 'Я сделаль', `done:${post.video_id}`);
        try {
          const msgText = ctx.callbackQuery.message?.text;
          if (msgText) {
            await ctx.editMessageText('Сделал(а) тренировку? Нажми кнопку:', { reply_markup: undoKeyboard });
          } else {
            await ctx.editMessageReplyMarkup({ reply_markup: undoKeyboard });
          }
        } catch { /* message too old */ }
        await ctx.answerCallbackQuery('Отметка снята');
        return;
      }

      const COOLDOWN_MS = 60 * 60 * 1000;
      const lastTime = getLastCompletionTime(userId);
      if (lastTime) {
        const elapsed = Date.now() - new Date(lastTime + 'Z').getTime();
        if (elapsed < COOLDOWN_MS) {
          const minLeft = Math.ceil((COOLDOWN_MS - elapsed) / 60_000);
          await ctx.answerCallbackQuery(`Подожди ${minLeft} мин. перед следующей отметкой`);
          return;
        }
      }

      recordCompletion(post.id, post.video_id, userId);

      // First completion DM
      const { completions: doneCount } = getMemberLevel(userId);
      if (doneCount === 1) {
        sendFirstCompletionDM(bot, userId, post.category);
      }

      const count = getCompletionCount(post.id);

      // Upgrade button to use proper done: callback with video_id
      const keyboard = new InlineKeyboard()
        .text(`Я сделаль · ${count}`, `done:${post.video_id}`);

      try {
        await ctx.editMessageText('Сделал(а) тренировку? Нажми кнопку:', { reply_markup: keyboard });
      } catch {
        try { await ctx.editMessageReplyMarkup({ reply_markup: keyboard }); } catch {}
      }

      // Post celebratory comment in discussion group
      const streak = getUserStreak(userId);
      const firstName = ctx.from?.first_name ?? 'Участник';
      const commentText = buildCelebrationComment(firstName, streak, count);
      try {
        const msgId = ctx.callbackQuery.message?.message_id;
        if (msgId) {
          await bot.api.sendMessage(config.TELEGRAM_GROUP_ID, commentText, {
            reply_parameters: { message_id: msgId },
          });
        }
      } catch (err) {
        log.warn('failed to post streak comment', { error: String(err) });
      }

      await ctx.answerCallbackQuery('Тренировка записана.');

      // Buddy invite check
      const { completions } = getMemberLevel(userId);
      if (completions === 3 && !wasBuddyInviteSent(userId)) {
        markBuddyInviteSent(userId);
        try {
          await bot.api.sendMessage(userId,
            `Три тренировки позади — ты уже в ритме.\n\n` +
            `Если есть кто-то, кому тоже не хватает структуры в движении — ` +
            `можешь поделиться ссылкой на сообщество:\nhttps://t.me/sami_workouts\n\n` +
            `Вместе проще держать темп.`
          );
        } catch {}
      }
    } else {
      // Post not in DB — graceful degradation, just acknowledge
      log.warn('done_msg: post not found in DB', { channelMsgId, userId });
      await ctx.answerCallbackQuery('Тренировка записана!');
    }
  });

  // --- "Сделано ✓" button on video posts ---
  bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
    const videoId = parseInt(ctx.match[1]);
    const userId = ctx.from?.id;
    if (!userId) return;

    // Find post: by group comment, by channel message, or by video_id
    const msg = ctx.callbackQuery.message;
    let post = msg ? getPostByGroupCommentId(msg.message_id) : null;
    if (!post) {
      post = msg ? getPostByMessageId(msg.message_id) : null;
    }
    if (!post) {
      post = getLatestPostByVideoId(videoId);
    }
    if (!post) {
      await ctx.answerCallbackQuery('Пост не найден');
      return;
    }

    if (hasUserCompleted(post.id, userId)) {
      removeCompletion(post.id, userId);
      const count = getCompletionCount(post.id);
      const keyboard = new InlineKeyboard()
        .text(count > 0 ? `Я сделаль · ${count}` : 'Я сделаль', `done:${videoId}`);
      try {
        const msgText = ctx.callbackQuery.message?.text;
        if (msgText) {
          await ctx.editMessageText('Сделал(а) тренировку? Нажми кнопку:', { reply_markup: keyboard });
        } else {
          await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
        }
      } catch { /* message too old */ }
      await ctx.answerCallbackQuery('Отметка снята');
      return;
    }

    // Cooldown: max 1 completion per hour (across all posts)
    const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
    const lastTime = getLastCompletionTime(userId);
    if (lastTime) {
      const elapsed = Date.now() - new Date(lastTime + 'Z').getTime();
      if (elapsed < COOLDOWN_MS) {
        const minLeft = Math.ceil((COOLDOWN_MS - elapsed) / 60_000);
        await ctx.answerCallbackQuery(`Подожди ${minLeft} мин. перед следующей отметкой`);
        return;
      }
    }

    recordCompletion(post.id, videoId, userId);

    // DM milestones based on completion count
    const { completions } = getMemberLevel(userId);

    // First completion ever — personal congrats + category recommendations
    if (completions === 1) {
      sendFirstCompletionDM(bot, userId, post.category);
    }

    // Buddy invite: after 3rd completion, suggest inviting a friend (once)
    if (completions === 3 && !wasBuddyInviteSent(userId)) {
      markBuddyInviteSent(userId);
      try {
        await bot.api.sendMessage(
          userId,
          `Три тренировки позади — ты уже в ритме.\n\n` +
          `Если есть кто-то, кому тоже не хватает структуры в движении — ` +
          `можешь поделиться ссылкой на сообщество:\n` +
          `https://t.me/sami_workouts\n\n` +
          `Вместе проще держать темп.`,
        );
      } catch {
        // User may have blocked DMs — that's ok
      }
    }

    const count = getCompletionCount(post.id);

    // Update button with new count
    const keyboard = new InlineKeyboard()
      .text(`Я сделаль · ${count}`, `done:${videoId}`);

    try {
      const msgText = ctx.callbackQuery.message?.text;
      if (msgText) {
        await ctx.editMessageText('Сделал(а) тренировку? Нажми кнопку:', { reply_markup: keyboard });
      } else {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      }
    } catch {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch { /* message too old, that's ok */ }
    }

    // Post celebratory comment in discussion group
    const streak = getUserStreak(userId);
    const firstName = ctx.from?.first_name ?? 'Участник';
    const commentText = buildCelebrationComment(firstName, streak, count);
    try {
      const msgId = ctx.callbackQuery.message?.message_id;
      if (msgId) {
        await bot.api.sendMessage(config.TELEGRAM_GROUP_ID, commentText, {
          reply_parameters: { message_id: msgId },
        });
      }
    } catch (err) {
      log.warn('failed to post streak comment', { error: String(err) });
    }

    await ctx.answerCallbackQuery('Тренировка записана.');
  });

  // --- Rating popup ---
  bot.callbackQuery(/^rating:(\d+)$/, async (ctx) => {
    const videoId = parseInt(ctx.match[1]);
    const rating = updateVideoRating(videoId);
    const ratingStr = rating.toFixed(1);
    await ctx.answerCallbackQuery({
      text: `⭐ Рейтинг: ${ratingStr} из 10\n\nФормула:\n• 35% — просмотры на YouTube\n• 30% — соотношение лайков\n• 20% — авторитет канала\n• 15% — выполнения в Sami\n\nЧем больше людей делает тренировку, тем выше рейтинг.`,
      show_alert: true,
    });
  });

  // --- Rating popup fallback (for posts not in DB, uses channel msg ID) ---
  bot.callbackQuery(/^rating_msg:(\d+)$/, async (ctx) => {
    const channelMsgId = parseInt(ctx.match[1]);
    // Try to find the post now (it may have been recorded since the autocomment was posted)
    const post = getPostByMessageId(channelMsgId);
    if (post) {
      const rating = updateVideoRating(post.video_id);
      const ratingStr = rating.toFixed(1);
      await ctx.answerCallbackQuery({
        text: `⭐ Рейтинг: ${ratingStr} из 10\n\nФормула:\n• 35% — просмотры на YouTube\n• 30% — соотношение лайков\n• 20% — авторитет канала\n• 15% — выполнения в Sami\n\nЧем больше людей делает тренировку, тем выше рейтинг.`,
        show_alert: true,
      });
    } else {
      await ctx.answerCallbackQuery({
        text: '⭐ Рейтинг пока не рассчитан — видео ещё не в базе.',
        show_alert: true,
      });
    }
  });

  // ---- Poll results tracking (S5) ----
  bot.on('poll', (ctx) => {
    const poll = ctx.poll;
    if (!poll) return;
    const options = poll.options.map(o => ({ text: o.text, voter_count: o.voter_count }));
    // Extract season/week from question ("Первая неделя Сезона N позади!")
    const seasonMatch = poll.question.match(/Сезона\s+(\d+)/);
    const weekMatch = poll.question.match(/(Первая|Вторая|Третья)/);
    const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : undefined;
    const weekNum = weekMatch ? (weekMatch[1] === 'Первая' ? 1 : weekMatch[1] === 'Вторая' ? 2 : 3) : undefined;
    upsertPollResult(poll.id, poll.question, poll.total_voter_count, options, seasonNum, weekNum);
    log.info('poll results updated', { pollId: poll.id, voters: poll.total_voter_count });
  });

  log.info('handlers registered');
}
