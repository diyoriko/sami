/**
 * View functions extracted from bot-menu.ts.
 *
 * These render UI (messages, inline keyboards) but don't register
 * any grammY handlers. They are imported back into bot-menu.ts.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { getConfig } from './config';
import { createLogger } from './logger';
import {
  getUserSubmissions, getUserSubmissionTotal,
  updateUgcSubmission,
  getChallengeSeries,
  getChallengeSeriesDaysStatus,
  getChallengeParticipantCount,
  filterVideos,
  type UgcSubmission,
} from './db';
import {
  type Category, type Difficulty, type EquipmentValue,
  CATEGORY_RU, CATEGORY_EMOJI,
  DIFFICULTY_RU, DIFFICULTY_EMOJI,
  EQUIPMENT_VALUE_RU,
  formatDurationLabel,
  escV2, decodeHtmlEntities,
} from './shared';

const log = createLogger('bot-menu-views');

const PAGE_SIZE = 5;

// ---------------------------------------------------------------------------
// sendMyWorkouts
// ---------------------------------------------------------------------------

export async function sendMyWorkouts(
  ctx: any,
  userId: number,
  offset: number,
  editMessageId?: number
): Promise<void> {
  const config = getConfig();
  const total = getUserSubmissionTotal(userId);

  if (total === 0) {
    const text = 'У тебя пока нет тренировок.\n\nНажми «Предложить тренировку» чтобы добавить свою.';
    if (editMessageId) {
      try { await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text); } catch { /* TG API: message may be deleted */ }
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const items = getUserSubmissions(userId, PAGE_SIZE, offset);

  const STATUS_LABEL: Record<string, string> = {
    draft: '\u270F\uFE0F черновик',
    pending: '\u23F3 на модерации',
    approved: '\u2705 одобрено',
    published: '\u2705 опубликовано',
    rejected: '\u274C отклонено',
  };

  const lines = items.map((item, i) => {
    const num = offset + i + 1;
    const catEmoji = item.category ? (CATEGORY_EMOJI[item.category as Category] ?? '') : '';
    const catRu = item.category ? (CATEGORY_RU[item.category as Category] ?? item.category) : '—';
    const title = item.title ? decodeHtmlEntities(item.title) : 'Без названия';
    const status = item.published_at ? '\u2705 опубликовано' : (STATUS_LABEL[item.status] ?? item.status);
    // Build info line: category · duration · difficulty
    const infoParts: string[] = [`${catEmoji} ${catRu}`];
    if (item.duration_seconds) infoParts.push(formatDurationLabel(item.duration_seconds));
    if (item.difficulty) infoParts.push(DIFFICULTY_EMOJI[item.difficulty as Difficulty] ?? item.difficulty);
    if (item.equipment && item.equipment !== 'none') infoParts.push(EQUIPMENT_VALUE_RU[item.equipment as EquipmentValue] ?? item.equipment);
    return `${escV2(String(num))}\\. *${escV2(title)}*\n   ${escV2(infoParts.join(' · '))}\n   ${escV2(status)}`;
  });

  const header = `*Мои тренировки* \\(${escV2(String(total))}\\)\n`;
  const text = header + '\n' + lines.join('\n\n');

  const kb = new InlineKeyboard();
  // Action buttons for each item: drafts get "Доделать" + "Удалить", others get "Удалить" only
  items.forEach((item) => {
    const title = item.title ? decodeHtmlEntities(item.title) : 'Без названия';
    const shortTitle = title.length > 15 ? title.slice(0, 12) + '…' : title;
    const isDraft = item.status === 'draft' && !item.published_at;
    if (isDraft) {
      kb.text(`✏️ ${shortTitle}`, `ugc_resume:${item.id}:${offset}`);
    }
    kb.text(`🗑 ${shortTitle}`, `ugc_del:${item.id}:${offset}`);
    kb.row();
  });
  // Pagination
  if (offset > 0) {
    kb.text('← Назад', `mywk:${Math.max(0, offset - PAGE_SIZE)}`);
  }
  if (offset + PAGE_SIZE < total) {
    kb.text('Дальше →', `mywk:${offset + PAGE_SIZE}`);
  }

  const opts: any = {
    parse_mode: 'MarkdownV2',
    reply_markup: kb,
  };

  if (editMessageId) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, opts);
    } catch { /* TG API: message may be deleted */ }
  } else {
    await ctx.reply(text, opts);
  }
}

// ---------------------------------------------------------------------------
// sendUgcToAdmin
// ---------------------------------------------------------------------------

export async function sendUgcToAdmin(bot: Bot, sub: UgcSubmission): Promise<void> {
  const config = getConfig();
  const catRu = sub.category ? (CATEGORY_RU[sub.category as Category] ?? sub.category) : '?';
  const diff = sub.difficulty ? (DIFFICULTY_RU[sub.difficulty as Difficulty] ?? sub.difficulty) : '?';
  const author = sub.username ? `@${sub.username}` : `id:${sub.telegram_user_id}`;

  const safeTitle = escV2(sub.title ?? 'Без названия');
  const videoLink = sub.video_url.startsWith('tg:') ? '\\(видеофайл\\)' : escV2(sub.video_url);

  const text = [
    `*Предложенная тренировка*`,
    '',
    `Автор: ${escV2(author)}`,
    `Название: ${safeTitle}`,
    `Тип: ${escV2(catRu)}`,
    `Уровень: ${escV2(diff)}`,
    ...(sub.duration_label ? [`Длительность: ${escV2(sub.duration_label)}`] : []),
    ...(sub.muscles ? [`Мышцы: ${escV2(sub.muscles)}`] : []),
    ...(sub.equipment ? [`Инвентарь: ${escV2(sub.equipment)}`] : []),
    `Видео: ${videoLink}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('Одобрить', `ugc_decide:${sub.id}:approve`)
    .text('Отклонить', `ugc_decide:${sub.id}:reject`);

  try {
    log.info('sending UGC to admin', { subId: sub.id, adminId: config.TELEGRAM_ADMIN_USER_ID });
    const msg = await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
    });
    updateUgcSubmission(sub.id, { admin_message_id: msg.message_id });
    log.info('UGC sent to admin', { subId: sub.id, msgId: msg.message_id });
  } catch (err) {
    log.error('FAILED to send UGC to admin', { subId: sub.id, adminId: config.TELEGRAM_ADMIN_USER_ID, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}д`);
  if (h > 0) parts.push(`${h}ч`);
  parts.push(`${m}м`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// sendChallengeView
// ---------------------------------------------------------------------------

export async function sendChallengeView(ctx: any, seriesId: number): Promise<void> {
  const series = getChallengeSeries(seriesId);
  if (!series) return;

  const days = getChallengeSeriesDaysStatus(seriesId);
  const pCount = getChallengeParticipantCount(seriesId);

  const statusLabels: Record<string, string> = {
    draft: '📝 черновик', active: '🟢 активен', completed: '📦 завершён', cancelled: '🚫 отменён',
  };

  const dayLines = days.map(d => {
    const icon = d.status === 'posted' ? '✅' : d.status === 'queued' ? '📋' : '⬜';
    const title = d.title ? ` — ${decodeHtmlEntities(d.title).slice(0, 30)}` : '';
    const catLabel = d.category ? (CATEGORY_EMOJI[d.category as Category] ?? '') : '';
    return `${icon} День ${d.day_number} ${catLabel}${title}`;
  });

  const filledCount = days.filter(d => d.status !== 'empty').length;

  const text = [
    `*🏆 ${escV2(series.name)}*`,
    ``,
    `Статус: ${escV2(statusLabels[series.status] ?? series.status)}`,
    `Дней: ${escV2(String(series.duration_days))}`,
    `Участников: ${escV2(String(pCount))}`,
    `Старт: ${escV2(series.start_date)} · Конец: ${escV2(series.end_date)}`,
    `Публикация: ${escV2(series.publish_time)} МСК`,
    ``,
    `*Расписание:*`,
    ...dayLines.map(l => escV2(l)),
    ``,
    `Заполнено: ${filledCount}/${series.duration_days}`,
  ].join('\n');

  const kb = new InlineKeyboard();

  // Day fill/replace buttons
  let buttonsInRow = 0;
  for (const d of days) {
    if (d.status === 'posted') continue;
    const label = d.status === 'queued' ? `↻ Д${d.day_number}` : `＋ Д${d.day_number}`;
    kb.text(label, `fill_series_day:${seriesId}:${d.day_number}`);
    buttonsInRow++;
    if (buttonsInRow === 4) { kb.row(); buttonsInRow = 0; }
  }
  if (buttonsInRow > 0) kb.row();

  // Action buttons based on status
  if (series.status === 'draft') {
    kb.text('▶️ Активировать', `cs_activate:${seriesId}`)
      .text('🚫 Отменить', `cs_cancel_series:${seriesId}`);
  } else if (series.status === 'active') {
    // Find today's slot for publish button
    const { todayMsk } = await import('./dates');
    const today = todayMsk();
    const startMs = new Date(series.start_date + 'T00:00:00').getTime();
    const todayMs = new Date(today + 'T00:00:00').getTime();
    const currentDay = Math.floor((todayMs - startMs) / 86400000) + 1;
    if (currentDay >= 1 && currentDay <= series.duration_days) {
      const todaySlot = days.find(d => d.day_number === currentDay);
      if (todaySlot?.status === 'queued') {
        kb.text(`📤 Опубликовать день ${currentDay}`, `cs_pub:${seriesId}:${currentDay}`).row();
      }
    }
    kb.text('✅ Завершить', `cs_complete:${seriesId}`);
  }

  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  } catch { /* TG API: message may be deleted, fallback to reply */
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

// ---------------------------------------------------------------------------
// sendFilterResults
// ---------------------------------------------------------------------------

export async function sendFilterResults(ctx: any, videos: ReturnType<typeof filterVideos>, label: string): Promise<void> {
  if (videos.length === 0) {
    try {
      await ctx.editMessageText(`Фильтр: ${label}\n\nНичего не найдено. Попробуй другой фильтр.`);
    } catch { /* TG API: message may be deleted, fallback to reply */
      await ctx.reply(`Фильтр: ${label}\n\nНичего не найдено.`);
    }
    return;
  }

  const config = getConfig();
  const channelHandle = config.TELEGRAM_CHANNEL_ID.startsWith('@')
    ? config.TELEGRAM_CHANNEL_ID.slice(1)
    : `c/${config.TELEGRAM_CHANNEL_ID.replace(/^-100/, '')}`;

  const lines = videos.map((v, i) => {
    const title = decodeHtmlEntities(v.title);
    const shortTitle = title.length > 40 ? title.slice(0, 37) + '...' : title;
    const catRu = CATEGORY_RU[v.category as Category] ?? v.category;
    const dur = v.duration_label ?? '?';
    const link = v.channel_message_id
      ? `[${escV2(shortTitle)}](https://t.me/${channelHandle}/${v.channel_message_id})`
      : escV2(shortTitle);
    return `${escV2(String(i + 1))}\\. ${link}\n   ${escV2(catRu)} · ${escV2(dur)} · ⭐${escV2(v.rating.toFixed(1))}`;
  });

  const text = `*${escV2(label)}* \\(${escV2(String(videos.length))}\\)\n\n` + lines.join('\n\n');

  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2' });
  } catch { /* TG API: message may be deleted, fallback to reply */
    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  }
}
