import Anthropic from '@anthropic-ai/sdk';
import { Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { getDb } from './db';
import { todayMsk } from './dates';
import { notifyAdmin } from './notify-admin';

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
  `);
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
): void {
  const merged = { ...DEFAULT_PACKET, ...packet };
  getDb().prepare(`
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
  console.log(`[strategist] packet saved from external source (${merged.week_focus}, ${merged.community_priority})`);
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
{JSON с полями: week_focus, content_themes, challenge_active, challenge_name, search_keywords (stretching/strength/mobility), community_priority}
// COMMUNITY_PACKET_END

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
    return { ...DEFAULT_PACKET, ...parsed };
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

  } catch (err: any) {
    console.error('[strategist] generation failed:', err);
    await notifyAdmin(bot, 'Strategist', `Генерация отчёта упала:\n\`${String(err).slice(0, 200)}\``);
  }
}
