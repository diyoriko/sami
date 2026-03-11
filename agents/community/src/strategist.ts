import Anthropic from '@anthropic-ai/sdk';
import { Bot, InlineKeyboard } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { getDb } from './db';
import { todayMsk } from './dates';
import { notifyAdmin } from './notify-admin';
import { createLogger } from './logger';

const log = createLogger('strategist');

// ---------------------------------------------------------------------------
// DB: strategist_packets table
// ---------------------------------------------------------------------------

export function migrateStrategist(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS strategist_packets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      week_focus TEXT DEFAULT 'general',
      content_themes TEXT DEFAULT '[]',
      challenge_active INTEGER DEFAULT 0,
      challenge_name TEXT,
      search_keywords TEXT DEFAULT '{}',
      community_priority TEXT DEFAULT 'activation',
      report_summary TEXT,
      full_report TEXT,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_strategist_packets_date ON strategist_packets(date);

    CREATE TABLE IF NOT EXISTS bot_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS strategist_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packet_id INTEGER REFERENCES strategist_packets(id),
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      params TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','executed','failed')),
      admin_message_id INTEGER,
      result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT,
      executed_at TEXT
    );
  `);
}

// --- Action DB helpers ---

export function saveAction(packetId: number | null, action: StrategistAction): number {
  const result = getDb().prepare(`
    INSERT INTO strategist_actions (packet_id, type, description, params)
    VALUES (?, ?, ?, ?)
  `).run(packetId, action.type, action.description, JSON.stringify(action.params));
  return Number(result.lastInsertRowid);
}

export function setActionMessageId(actionId: number, messageId: number): void {
  getDb().prepare(`UPDATE strategist_actions SET admin_message_id = ? WHERE id = ?`).run(messageId, actionId);
}

export function getActionByMessageId(messageId: number): {
  id: number; type: StrategistActionType; description: string; params: string; status: string;
} | null {
  return getDb().prepare(
    `SELECT id, type, description, params, status FROM strategist_actions WHERE admin_message_id = ?`
  ).get(messageId) as any ?? null;
}

export function setActionStatus(actionId: number, status: 'approved' | 'rejected' | 'executed' | 'failed', result?: string): void {
  if (status === 'executed' || status === 'failed') {
    getDb().prepare(
      `UPDATE strategist_actions SET status = ?, result = ?, executed_at = datetime('now') WHERE id = ?`
    ).run(status, result ?? null, actionId);
  } else {
    getDb().prepare(
      `UPDATE strategist_actions SET status = ?, decided_at = datetime('now') WHERE id = ?`
    ).run(status, actionId);
  }
}

export function getPendingActions(): Array<{
  id: number; type: StrategistActionType; description: string; params: string;
}> {
  return getDb().prepare(
    `SELECT id, type, description, params FROM strategist_actions WHERE status = 'approved'`
  ).all() as any[];
}

export function getActionById(actionId: number): StrategistAction | null {
  const row = getDb().prepare(
    `SELECT type, description, params FROM strategist_actions WHERE id = ?`
  ).get(actionId) as { type: StrategistActionType; description: string; params: string } | undefined;
  if (!row) return null;
  return { type: row.type, description: row.description, params: JSON.parse(row.params) };
}

// --- Strategist Actions (v2) ---

export type StrategistActionType = 'create_poll' | 'update_welcome' | 'limit_posts' | 'send_digest';

export interface StrategistAction {
  type: StrategistActionType;
  description: string; // Human-readable explanation from strategist
  params: Record<string, unknown>; // Type-specific params
}

export interface StrategistPacket {
  week_focus: string;
  content_themes: string[];
  challenge_active: boolean;
  challenge_name: string | null;
  search_keywords: {
    stretching?: string;
    strength?: string;
    mobility?: string;
  };
  community_priority: string;
  actions?: StrategistAction[];
}

const DEFAULT_PACKET: StrategistPacket = {
  week_focus: 'general',
  content_themes: ['всё тело', 'ежедневная практика'],
  challenge_active: false,
  challenge_name: null,
  search_keywords: {},
  community_priority: 'activation',
};

// ---------------------------------------------------------------------------
// Read latest packet from DB
// ---------------------------------------------------------------------------

export function getLatestPacket(): StrategistPacket {
  const row = getDb().prepare(`
    SELECT week_focus, content_themes, challenge_active, challenge_name,
           search_keywords, community_priority
    FROM strategist_packets
    ORDER BY created_at DESC LIMIT 1
  `).get() as any | undefined;

  if (!row) return DEFAULT_PACKET;

  try {
    return {
      week_focus: row.week_focus ?? DEFAULT_PACKET.week_focus,
      content_themes: JSON.parse(row.content_themes ?? '[]'),
      challenge_active: Boolean(row.challenge_active),
      challenge_name: row.challenge_name,
      search_keywords: JSON.parse(row.search_keywords ?? '{}'),
      community_priority: row.community_priority ?? DEFAULT_PACKET.community_priority,
    };
  } catch {
    return DEFAULT_PACKET;
  }
}

// ---------------------------------------------------------------------------
// Save packet from external source (Mac strategist via HTTP POST)
// ---------------------------------------------------------------------------

export function savePacketFromExternal(
  packet: Partial<StrategistPacket>,
  report?: { summary?: string; full_report?: string },
): { packetId: number; actionIds: number[] } {
  const merged = { ...DEFAULT_PACKET, ...packet };
  const result = getDb().prepare(`
    INSERT INTO strategist_packets
      (date, week_focus, content_themes, challenge_active, challenge_name,
       search_keywords, community_priority, report_summary, full_report)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    todayMsk(),
    merged.week_focus,
    JSON.stringify(merged.content_themes),
    merged.challenge_active ? 1 : 0,
    merged.challenge_name,
    JSON.stringify(merged.search_keywords),
    merged.community_priority,
    report?.summary ?? null,
    report?.full_report ?? null,
  );
  const packetId = Number(result.lastInsertRowid);

  // Save actions if present
  const actionIds: number[] = [];
  if (packet.actions?.length) {
    for (const action of packet.actions) {
      actionIds.push(saveAction(packetId, action));
    }
    log.info(`saved ${packet.actions.length} actions from external packet`);
  }

  log.info(`packet saved from external source`, { weekFocus: merged.week_focus, priority: merged.community_priority });
  return { packetId, actionIds };
}

// ---------------------------------------------------------------------------
// Build prompt from context files + DB metrics
// ---------------------------------------------------------------------------

function buildPrompt(): string {
  const contextFiles = [
    path.resolve(__dirname, '../../../STRATEGIST_BRIEF.md'),
    path.resolve(__dirname, '../../../COMMUNITY_TASKS.md'),
  ];

  const contextParts: string[] = [];
  for (const filePath of contextFiles) {
    try {
      if (fs.existsSync(filePath)) {
        const text = fs.readFileSync(filePath, 'utf-8').trim();
        if (text) {
          contextParts.push(`## Source: ${path.basename(filePath)}\n\n${text.slice(0, 6000)}`);
        }
      }
    } catch { /* skip missing files */ }
  }

  // Add live metrics from DB
  const db = getDb();
  const today = todayMsk();

  const channelStats = db.prepare(
    'SELECT * FROM channel_stats ORDER BY date DESC LIMIT 1'
  ).get() as any;

  const recentPosts = db.prepare(
    'SELECT date, category, COUNT(*) as cnt FROM posts WHERE date >= date(?, "-7 days") GROUP BY date, category'
  ).all(today) as any[];

  const topVideos = db.prepare(`
    SELECT v.title, v.category, v.rating, COUNT(c.id) as completions
    FROM videos v
    LEFT JOIN completions c ON c.video_id = v.id
    GROUP BY v.id
    ORDER BY completions DESC
    LIMIT 5
  `).all() as any[];

  const completionsByCategory = db.prepare(`
    SELECT v.category, COUNT(c.id) as completions, COUNT(DISTINCT c.telegram_user_id) as users
    FROM completions c
    JOIN videos v ON v.id = c.video_id
    JOIN posts p ON p.id = c.post_id
    WHERE p.date >= date(?, '-7 days')
    GROUP BY v.category
  `).all(today) as any[];

  const metricsBlock = [
    '## Live Metrics (from DB)',
    '',
    channelStats
      ? `Subscribers: ${channelStats.subscriber_count}, Group members: ${channelStats.group_member_count} (${channelStats.date})`
      : 'Channel stats: no data yet',
    '',
    '### Posts last 7 days',
    recentPosts.length > 0
      ? recentPosts.map((r: any) => `- ${r.date} ${r.category}: ${r.cnt}`).join('\n')
      : 'No posts in last 7 days',
    '',
    '### Top videos by completions',
    topVideos.length > 0
      ? topVideos.map((v: any) => `- "${v.title}" (${v.category}) — ${v.completions} completions, rating ${v.rating}`).join('\n')
      : 'No completion data yet',
    '',
    '### Completions by category (7 days)',
    completionsByCategory.length > 0
      ? completionsByCategory.map((c: any) => `- ${c.category}: ${c.completions} completions (${c.users} unique users)`).join('\n')
      : 'No data',
  ].join('\n');

  contextParts.push(metricsBlock);

  // Previous packet for continuity
  const prevPacket = getLatestPacket();
  contextParts.push(`## Previous COMMUNITY_PACKET\n\n\`\`\`json\n${JSON.stringify(prevPacket, null, 2)}\n\`\`\``);

  const context = contextParts.join('\n\n');

  return `Ты стратегический агент проекта Sami. Запуск: 1 раз в день утром.

Цель: построить Telegram-сообщество так, чтобы оно конвертировалось в будущий запуск приложения.

ВАЖНО — экономия токенов:
- Будь лаконичен. Не повторяй контекст обратно.
- Каждый раздел: 3-5 конкретных пунктов, без воды.
- Общий объём отчёта: до 3000 слов (не больше).
- Фокус на actionable items, а не описания.

Обязательные блоки:
1. ## Резюме — 5-7 кратких буллетов (самое важное)
2. ## Фокус дня — 3 конкретных действия на сегодня
3. ## Эксперименты — таблица: гипотеза, шаги, метрика, дедлайн (только активные)
4. ## Метрики — North Star + 3-4 ведущих показателя (цифры, не описания)
5. ## Решения — 3 решения для владельца проекта
6. ## Ресерч — 3 внешних инсайта с источниками

Также включи (кратко, по 2-3 пункта):
- Позиционирование и ICP
- Контентные рубрики
- Growth loops
- Риски

Обязательно в конце добавь блок:
// COMMUNITY_PACKET_START
{JSON с полями: week_focus, content_themes, challenge_active, challenge_name, search_keywords (stretching/strength/mobility), community_priority, actions}
// COMMUNITY_PACKET_END

Поле actions — массив конкретных действий, которые бот может выполнить с одобрения админа.
Каждое действие: { type, description, params }
Типы:
- "create_poll" — создать опрос в группе. params: { question: string, options: string[], anonymous?: boolean }
- "update_welcome" — обновить приветственный текст. params: { text: string }
- "limit_posts" — изменить лимит постов/день. params: { max_per_day: number }
- "send_digest" — отправить дайджест в канал. params: { text: string }
Если нет предложений — actions: []

Формат: валидный Markdown. Заголовок: "# Sami Strategist Report — YYYY-MM-DD".
Пиши на русском. Только текстовый отчёт, без команд и файловых операций.

Контекст проекта:
${context}`;
}

// ---------------------------------------------------------------------------
// Extract COMMUNITY_PACKET from report text
// ---------------------------------------------------------------------------

function extractPacket(reportText: string): StrategistPacket {
  const match = reportText.match(/\/\/ COMMUNITY_PACKET_START\s*([\s\S]*?)\/\/ COMMUNITY_PACKET_END/);
  if (!match) return DEFAULT_PACKET;

  try {
    const parsed = JSON.parse(match[1].trim()) as Partial<StrategistPacket>;
    // Validate actions array
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.filter(a => a && typeof a.type === 'string' && typeof a.description === 'string')
      : [];
    return { ...DEFAULT_PACKET, ...parsed, actions };
  } catch (err) {
    console.warn('[strategist] failed to parse COMMUNITY_PACKET:', err);
    return DEFAULT_PACKET;
  }
}

// ---------------------------------------------------------------------------
// Extract summary (first ## Резюме block)
// ---------------------------------------------------------------------------

function extractSummary(report: string): string | null {
  const match = report.match(/^##\s+Резюме\s*\n([\s\S]*?)(?:\n##\s+|\n#\s+|$)/m);
  if (!match) return null;
  const bullets = match[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .slice(0, 5);
  return bullets.length > 0 ? bullets.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Run strategist
// ---------------------------------------------------------------------------

export async function runStrategist(bot: Bot): Promise<void> {
  const config = getConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('[strategist] ANTHROPIC_API_KEY not set, skipping');
    return;
  }

  const date = todayMsk();
  console.log(`[strategist] starting daily run for ${date}`);

  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt();

  try {
    const response = await client.messages.create({
      model: process.env.STRATEGIST_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const reportText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    const packet = extractPacket(reportText);
    const summary = extractSummary(reportText);

    // Store in DB
    getDb().prepare(`
      INSERT INTO strategist_packets
        (date, week_focus, content_themes, challenge_active, challenge_name,
         search_keywords, community_priority, report_summary, full_report,
         tokens_input, tokens_output)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      date,
      packet.week_focus,
      JSON.stringify(packet.content_themes),
      packet.challenge_active ? 1 : 0,
      packet.challenge_name,
      JSON.stringify(packet.search_keywords),
      packet.community_priority,
      summary,
      reportText,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    console.log(`[strategist] report stored (${response.usage.input_tokens}+${response.usage.output_tokens} tokens)`);

    // Notify admin
    const costEstimate = (
      (response.usage.input_tokens / 1_000_000) * 3 +
      (response.usage.output_tokens / 1_000_000) * 15
    ).toFixed(3);

    const lines = [
      `*Strategist Report — ${date}*`,
      '',
      summary ?? '(резюме не найдено)',
      '',
      `Фокус: ${packet.week_focus}`,
      `Приоритет: ${packet.community_priority}`,
      `Токены: ${response.usage.input_tokens}+${response.usage.output_tokens} (~$${costEstimate})`,
    ];

    await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join('\n'), {
      parse_mode: 'Markdown',
    }).catch(() => {});

    // Save and send actions to admin
    if (packet.actions?.length) {
      const packetId = getDb().prepare(
        `SELECT id FROM strategist_packets ORDER BY id DESC LIMIT 1`
      ).get() as { id: number } | undefined;
      if (packetId) {
        for (const action of packet.actions) {
          const actionId = saveAction(packetId.id, action);
          await sendActionToAdmin(bot, actionId, action);
        }
      }
    }

  } catch (err: any) {
    console.error('[strategist] generation failed:', err);
    await notifyAdmin(bot, 'Strategist', `Генерация отчёта упала:\n\`${String(err).slice(0, 200)}\``);
  }
}

// ---------------------------------------------------------------------------
// Action presentation & execution
// ---------------------------------------------------------------------------

const ACTION_TYPE_LABELS: Record<StrategistActionType, string> = {
  create_poll: 'Создать опрос',
  update_welcome: 'Обновить приветствие',
  limit_posts: 'Ограничить посты',
  send_digest: 'Отправить дайджест',
};

export async function sendActionToAdmin(bot: Bot, actionId: number, action: StrategistAction): Promise<void> {
  const config = getConfig();
  const label = ACTION_TYPE_LABELS[action.type] ?? action.type;

  const text = [
    `*Стратег предлагает: ${label}*`,
    '',
    action.description,
    '',
    `Параметры: \`${JSON.stringify(action.params)}\``,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('✅ Выполнить', `strat_action:approve:${actionId}`)
    .text('❌ Отклонить', `strat_action:reject:${actionId}`);

  try {
    const msg = await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    setActionMessageId(actionId, msg.message_id);
  } catch (err) {
    log.error('failed to send action to admin', { actionId, error: String(err) });
  }
}

async function executeAction(bot: Bot, actionId: number, type: StrategistActionType, params: Record<string, unknown>): Promise<string> {
  const config = getConfig();

  switch (type) {
    case 'create_poll': {
      const question = String(params.question ?? 'Опрос от стратега');
      const options = Array.isArray(params.options) ? params.options.map(String) : ['Да', 'Нет'];
      await bot.api.sendPoll(config.TELEGRAM_GROUP_ID, question, options, {
        is_anonymous: Boolean(params.anonymous ?? true),
      });
      return `Опрос создан: "${question}" (${options.length} вариантов)`;
    }

    case 'update_welcome': {
      // Store new welcome text in DB config (to be picked up by moderation.ts)
      const text = String(params.text ?? '');
      if (!text) return 'Нет текста для обновления';
      getDb().prepare(`
        INSERT OR REPLACE INTO bot_config (key, value) VALUES ('welcome_text', ?)
      `).run(text);
      return `Welcome-текст обновлён (${text.length} символов)`;
    }

    case 'limit_posts': {
      const maxPerDay = Number(params.max_per_day ?? 3);
      getDb().prepare(`
        INSERT OR REPLACE INTO bot_config (key, value) VALUES ('max_posts_per_day', ?)
      `).run(String(maxPerDay));
      return `Лимит постов: ${maxPerDay}/день`;
    }

    case 'send_digest': {
      const text = String(params.text ?? 'Недельный дайджест Sami');
      await bot.api.sendMessage(config.TELEGRAM_CHANNEL_ID, text, { parse_mode: 'Markdown' });
      return `Дайджест отправлен в канал`;
    }

    default:
      return `Неизвестный тип действия: ${type}`;
  }
}

export function registerStrategistCallbacks(bot: Bot): void {
  bot.callbackQuery(/^strat_action:(approve|reject):(\d+)$/, async (ctx) => {
    const decision = ctx.match[1] as 'approve' | 'reject';
    const actionId = parseInt(ctx.match[2]);

    const action = getDb().prepare(
      `SELECT id, type, description, params, status FROM strategist_actions WHERE id = ?`
    ).get(actionId) as { id: number; type: StrategistActionType; description: string; params: string; status: string } | undefined;

    if (!action || action.status !== 'pending') {
      await ctx.answerCallbackQuery('Действие уже обработано');
      return;
    }

    if (decision === 'reject') {
      setActionStatus(actionId, 'rejected');
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard().text('❌ Отклонено', 'noop'),
        });
      } catch {}
      await ctx.answerCallbackQuery('Отклонено');
      return;
    }

    // Approve and execute
    setActionStatus(actionId, 'approved');
    await ctx.answerCallbackQuery('Выполняю...');

    try {
      const params = JSON.parse(action.params) as Record<string, unknown>;
      const result = await executeAction(bot, actionId, action.type, params);
      setActionStatus(actionId, 'executed', result);

      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard().text(`✅ ${result}`, 'noop'),
        });
      } catch {}

      log.info('action executed', { actionId, type: action.type, result });
    } catch (err) {
      const errMsg = String(err).slice(0, 200);
      setActionStatus(actionId, 'failed', errMsg);

      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard().text(`⚠️ Ошибка: ${errMsg.slice(0, 50)}`, 'noop'),
        });
      } catch {}

      log.error('action execution failed', { actionId, error: errMsg });
    }
  });
}
