import { Bot, Context } from 'grammy';
import { getConfig } from './config';
import { upsertMember, setMemberGoal, addWarning, muteMember } from './db';

// Goal options for welcome quiz
const GOAL_OPTIONS = [
  { text: '🔄 Вернуть ритм', data: 'goal:rhythm' },
  { text: '⚖️ Похудеть', data: 'goal:weight' },
  { text: '💪 Стать сильнее', data: 'goal:strength' },
  { text: '👀 Просто смотрю', data: 'goal:observer' },
];

// Regex patterns for spam detection
const SPAM_PATTERNS = [
  /https?:\/\/(?!youtube\.com|youtu\.be|t\.me\/sami)/i, // external links (except YouTube and own channel)
  /(?:заработ|earn|casino|казино|crypto|крипт|invest|инвест|forex|форекс)/i,
  /подпишись|subscribe|follow me|подпишитесь/i,
];

function isSpam(text: string): boolean {
  return SPAM_PATTERNS.some(re => re.test(text));
}

export function registerModeration(bot: Bot): void {
  const config = getConfig();

  // --- Welcome new members ---
  bot.on('chat_member', async (ctx) => {
    const member = ctx.chatMember;
    if (!member || ctx.chat.id.toString() !== config.TELEGRAM_GROUP_ID) return;
    if (member.new_chat_member?.status !== 'member') return;

    const user = member.new_chat_member.user;
    if (user.is_bot) return;

    upsertMember(user.id, user.username ?? null, user.first_name ?? null);

    const { InlineKeyboard } = await import('grammy');
    const keyboard = new InlineKeyboard();
    GOAL_OPTIONS.forEach((opt, i) => {
      keyboard.text(opt.text, opt.data);
      if (i % 2 === 1) keyboard.row();
    });

    await ctx.reply(
      `👋 Привет, ${user.first_name ?? 'новый участник'}!\n\nДобро пожаловать в Sami Community — место для тех, кто хочет вернуть движение в свой день.\n\n*Что тебя сюда привело?*`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  });

  // --- Goal quiz callback ---
  bot.callbackQuery(/^goal:(.+)$/, async (ctx) => {
    const goal = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) return;

    setMemberGoal(userId, goal);

    const responses: Record<string, string> = {
      rhythm: 'Отлично! Ежедневные практики помогут вернуть ритм. Начни с сегодняшней тренировки 👆',
      weight: 'Хороший выбор. Регулярное движение — основа. Смотри посты каждый день.',
      strength: 'Силовые тренировки здесь каждый день в 12:00. Будь на связи 💪',
      observer: 'Всегда рад! Смотри, пробуй, пиши как дела 👀',
    };

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `✅ Принято!\n\n${responses[goal] ?? 'Добро пожаловать!'}\n\n_Посты выходят в 08:00, 12:00 и 17:00. Вечером — чекин._`,
      { parse_mode: 'Markdown' }
    );
  });

  // --- Spam filter for group messages ---
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.id.toString() !== config.TELEGRAM_GROUP_ID) return next();

    const userId = ctx.from?.id;
    if (!userId) return;

    // Skip admins and the bot itself
    try {
      const member = await ctx.getChatMember(userId);
      if (['administrator', 'creator'].includes(member.status)) return;
    } catch {
      return;
    }

    const text = ctx.message.text ?? '';

    if (!isSpam(text)) return;

    // Delete spam message
    try {
      await ctx.deleteMessage();
    } catch (err) {
      console.error('[moderation] failed to delete message:', err);
    }

    const warnings = addWarning(userId);

    if (warnings === 1) {
      await ctx.reply(
        `⚠️ @${ctx.from?.username ?? String(userId)}, это предупреждение №1.\nВнешние ссылки и реклама запрещены. Следующее нарушение — мут на 24 часа.`,
        { parse_mode: 'Markdown' }
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
        await ctx.reply(
          `🔇 @${ctx.from?.username ?? String(userId)} получил мут на 24 часа за повторное нарушение.`
        ).catch(() => {});
      } catch (err) {
        console.error('[moderation] failed to mute user:', err);
      }
    } else if (warnings >= 3) {
      try {
        await ctx.api.banChatMember(ctx.chat.id, userId);
        await ctx.reply(
          `🚫 Участник заблокирован за систематические нарушения.`
        ).catch(() => {});
        // Notify admin
        await bot.api.sendMessage(
          config.TELEGRAM_ADMIN_USER_ID,
          `🚫 Заблокировал пользователя ${userId} (@${ctx.from?.username ?? '?'}) за спам (3 нарушения).`
        );
      } catch (err) {
        console.error('[moderation] failed to ban user:', err);
      }
    }
  });

  // --- Report button for group ---
  bot.command('report', async (ctx) => {
    if (ctx.chat.id.toString() !== config.TELEGRAM_GROUP_ID) return;

    const reply = ctx.message?.reply_to_message;
    if (!reply) {
      await ctx.reply('Ответь на сообщение командой /report, чтобы пожаловаться на него.');
      return;
    }

    const reporter = ctx.from?.username ?? String(ctx.from?.id);
    const reported = reply.from?.username ?? String(reply.from?.id);
    const text = reply.text ?? '[медиа]';

    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `🚨 *Репорт*\n\nОт: @${reporter}\nНа: @${reported}\n\nСообщение:\n_${text.slice(0, 300)}_`,
      { parse_mode: 'Markdown' }
    );

    await ctx.reply('✅ Репорт отправлен администратору.').catch(() => {});
    try { await ctx.deleteMessage(); } catch {}
  });

  // --- Check-in callback from channel posts ---
  bot.callbackQuery(/^checkin:(did|partial|didnt):(.+)$/, async (ctx) => {
    const result = ctx.match[1] as 'did' | 'partial' | 'didnt';
    const date = ctx.match[2];
    const userId = ctx.from?.id;
    if (!userId) return;

    const { recordCheckin } = await import('./db');
    recordCheckin(date, userId, result);

    const responses: Record<string, string> = {
      did: '🔥 Отлично! Так держать!',
      partial: '👍 Хотя бы что-то — это уже победа!',
      didnt: '💪 Ничего, завтра новый день. Главное — не бросать.',
    };

    await ctx.answerCallbackQuery(responses[result] ?? 'Принято!');
  });

  console.log('[moderation] handlers registered');
}
