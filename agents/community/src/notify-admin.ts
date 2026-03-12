import { Bot } from 'grammy';
import { getConfig } from './config';
import { escV2 } from './shared';

/**
 * Send an error/alert DM to admin. Never visible to regular users.
 * Safe to call from any context — swallows its own errors to avoid cascading failures.
 */
export async function notifyAdmin(
  bot: Bot,
  agent: string,
  message: string,
): Promise<void> {
  try {
    const config = getConfig();
    const text = `\u26a0\ufe0f *SAMI ${escV2(agent)}* — ошибка\n\n${escV2(message)}`;
    await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, text, {
      parse_mode: 'MarkdownV2',
    });
  } catch (err) {
    console.error(`[notify-admin] failed to send alert:`, err);
  }
}
