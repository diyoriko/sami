import { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { upsertMember, setMemberGoal, addWarning, muteMember } from './db';

// ─── CAPTCHA ──────────────────────────────────────────────────────────────────
// Simple math captcha to filter bots. New member is muted until they pass.
// Wrong answer or timeout (2 min) → kick.

interface PendingCaptcha {
  userId: number;
  chatId: number | string;
  answer: number;
  firstName: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pendingCaptchas = new Map<number, PendingCaptcha>(); // userId → captcha

function generateCaptcha(): { question: string; answer: number; options: number[] } {
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
  rhythm: `Отличный выбор. Ритм строится через маленькие ежедневные действия — именно за этим мы здесь.\n\nКаждое утро в 08:00 выходят три тренировки: стретчинг, силовая и мобильность. Начни с любой.`,
  mobility: `Мобильность — основа всего. Тело благодарит, когда его двигают мягко и регулярно.\n\nКаждое утро в 08:00 выходят три тренировки. Мобильность особенно для тебя.`,
  strength: `Сила без инвентаря — это реально. Только коврик, только тело, только практика.\n\nКаждое утро в 08:00 выходят три тренировки. Силовая — вторая по счёту.`,
  observer: `Хорошее начало. Смотри, пробуй, пиши как дела — здесь никто не торопит.\n\nКаждое утро в 08:00 выходят три тренировки. Когда будешь готов — просто нажми play.`,
};

// ─── SPAM PATTERNS ───────────────────────────────────────────────────────────

const SPAM_PATTERNS = [
  /https?:\/\/(?!youtube\.com|youtu\.be|t\.me\/sami)/i,
  /(?:заработ|earn|casino|казино|crypto|крипт|invest|инвест|forex|форекс)/i,
  /подпишись|subscribe|follow me|подпишитесь/i,
];

function isSpam(text: string): boolean {
  return SPAM_PATTERNS.some(re => re.test(text));
}

// ─── REGISTER ────────────────────────────────────────────────────────────────

export function registerModeration(bot: Bot): void {
  const config = getConfig();

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
      console.error('[moderation] failed to mute new member for captcha:', err);
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
        `👋 ${firstName}, добро пожаловать!\n\nЧтобы начать общаться, реши простой пример:\n\n*${question} = ?*`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } catch (err) {
      console.error('[moderation] failed to send captcha:', err);
      return;
    }

    // Kick if no answer in 2 minutes
    const timeoutHandle = setTimeout(async () => {
      pendingCaptchas.delete(user.id);
      try {
        await ctx.api.banChatMember(chatId, user.id);
        await ctx.api.unbanChatMember(chatId, user.id); // ban+unban = kick (can rejoin)
      } catch {}
      try {
        await ctx.api.deleteMessage(chatId, captchaMsg.message_id);
      } catch {}
      try {
        await ctx.reply(`⏱ ${firstName} не ответил на проверку и был исключён. Он может вернуться в любой момент.`);
      } catch {}
    }, 2 * 60 * 1000);

    pendingCaptchas.set(user.id, {
      userId: user.id,
      chatId,
      answer,
      firstName,
      timeoutHandle,
    });
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

    const captcha = pendingCaptchas.get(targetUserId);
    if (!captcha) {
      await ctx.answerCallbackQuery('Проверка уже завершена');
      return;
    }

    clearTimeout(captcha.timeoutHandle);
    pendingCaptchas.delete(targetUserId);

    if (chosen !== captcha.answer) {
      // Wrong answer → kick (can rejoin)
      try {
        await ctx.editMessageText(`❌ Неверно. Ты можешь вернуться и попробовать снова.`);
      } catch {}
      try {
        await ctx.api.banChatMember(captcha.chatId, targetUserId);
        await ctx.api.unbanChatMember(captcha.chatId, targetUserId);
      } catch {}
      await ctx.answerCallbackQuery('Неверно');
      return;
    }

    // Correct → unrestrict + show goal quiz
    try {
      await ctx.api.restrictChatMember(
        captcha.chatId,
        targetUserId,
        {
          can_send_messages: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
        }
      );
    } catch (err) {
      console.error('[moderation] failed to unrestrict member:', err);
    }

    await ctx.answerCallbackQuery('✅ Верно!');

    const goalKeyboard = new InlineKeyboard();
    GOAL_OPTIONS.forEach((opt, i) => {
      goalKeyboard.text(opt.text, opt.data);
      if (i % 2 === 1) goalKeyboard.row();
    });

    try {
      await ctx.editMessageText(
        `✅ Отлично, ты человек!\n\nДобро пожаловать в Sami Community — место для тех, кто возвращает движение в свой день. Только коврик, без лишнего шума.\n\n*Что тебя сюда привело?*`,
        { parse_mode: 'Markdown', reply_markup: goalKeyboard }
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

    try {
      await ctx.editMessageText(
        `${response}\n\n_Вечером — чекин дня. Просто нажми кнопку и отметь как прошло._`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // --- Spam filter ---
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.id.toString() !== config.TELEGRAM_GROUP_ID) return next();

    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      const member = await ctx.getChatMember(userId);
      if (['administrator', 'creator'].includes(member.status)) return;
    } catch {
      return;
    }

    const text = ctx.message.text ?? '';
    if (!isSpam(text)) return;

    try { await ctx.deleteMessage(); } catch {}

    const warnings = addWarning(userId);
    const username = ctx.from?.username ? `@${ctx.from.username}` : String(userId);

    if (warnings === 1) {
      await ctx.reply(
        `⚠️ ${username}, внешние ссылки и реклама здесь не приветствуются. Следующее нарушение — мут на 24 часа.`
      ).catch(() => {});
    } else if (warnings === 2) {
      muteMember(userId, 24);
      try {
        const until = Math.floor(Date.now() / 1000) + 24 * 3600;
        await ctx.api.restrictChatMember(
          ctx.chat.id,
          userId,
          { can_send_messages: false, can_send_polls: false, can_send_other_messages: false },
          { until_date: until }
        );
        await ctx.reply(`🔇 ${username} получил мут на 24 часа.`).catch(() => {});
      } catch (err) {
        console.error('[moderation] failed to mute:', err);
      }
    } else if (warnings >= 3) {
      try {
        await ctx.api.banChatMember(ctx.chat.id, userId);
        await ctx.reply(`🚫 Участник заблокирован за систематические нарушения.`).catch(() => {});
        await bot.api.sendMessage(
          config.TELEGRAM_ADMIN_USER_ID,
          `🚫 Заблокировал ${userId} (@${ctx.from?.username ?? '?'}) за спам.`
        );
      } catch (err) {
        console.error('[moderation] failed to ban:', err);
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
      `🚨 *Репорт*\nОт: @${reporter}\nНа: @${reported}\n\n_${(reply.text ?? '[медиа]').slice(0, 300)}_`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply('✅ Репорт отправлен.').catch(() => {});
    try { await ctx.deleteMessage(); } catch {}
  });

  // --- Check-in callbacks ---
  bot.callbackQuery(/^checkin:(did|partial|didnt):(.+)$/, async (ctx) => {
    const result = ctx.match[1] as 'did' | 'partial' | 'didnt';
    const date = ctx.match[2];
    const userId = ctx.from?.id;
    if (!userId) return;

    const { recordCheckin } = await import('./db');
    recordCheckin(date, userId, result);

    const responses: Record<string, string> = {
      did: 'Отлично! Ещё один день в копилку.',
      partial: 'Хотя бы что-то — это уже движение.',
      didnt: 'Ничего. Завтра новый старт.',
    };

    await ctx.answerCallbackQuery(responses[result] ?? 'Принято!');
  });

  console.log('[moderation] handlers registered');
}
