import { Bot } from 'grammy';
import { getConfig } from './config';
import { escV2 } from './shared';

/**
 * Send a DM to admin via the unified bot (@diyoriko_claude_bot).
 * Falls back to the project bot if ADMIN_NOTIFY_BOT_TOKEN is not set.
 * Safe to call from any context — swallows its own errors.
 */
export async function notifyAdmin(
  bot: Bot,
  agent: string,
  message: string,
): Promise<void> {
  try {
    const config = getConfig();
    const unifiedToken = process.env.ADMIN_NOTIFY_BOT_TOKEN;

    if (unifiedToken) {
      // Send via unified bot (plain text, no MarkdownV2 quirks)
      const text = `⚠️ SAMI ${agent} — ошибка\n\n${message}`;
      await fetch(`https://api.telegram.org/bot${unifiedToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_ADMIN_USER_ID,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
      });
    } else {
      // Fallback to project bot
      const text = `\u26a0\ufe0f *SAMI ${escV2(agent)}* — ошибка\n\n${escV2(message)}`;
      await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, text, {
        parse_mode: 'MarkdownV2',
      });
    }
  } catch (err) {
    console.error(`[notify-admin] failed to send alert:`, err);
  }
}

/**
 * Send any admin message via the unified bot.
 * Use this for status updates, analytics, deploy reports.
 */
export async function sendAdminMessage(text: string): Promise<void> {
  try {
    const config = getConfig();
    const token = process.env.ADMIN_NOTIFY_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_ADMIN_USER_ID,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error(`[notify-admin] sendAdminMessage failed:`, err);
  }
}
