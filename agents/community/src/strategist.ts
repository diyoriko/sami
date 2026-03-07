import Anthropic from '@anthropic-ai/sdk';
import { Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { todayMsk } from './dates';

const MODEL = 'claude-sonnet-4-6';
const MAX_CONTEXT_CHARS = 6000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10_000;

// Context files relative to project root (repo root on Railway)
const CONTEXT_FILES = [
  'STRATEGIST_BRIEF.md',
  'SAMI_PRD_v1.md',
  'SAMI_MVP_SCOPE.md',
  'SAMI_14_DAY_PLAN.md',
  'APP_TASKS.md',
  'COMMUNITY_TASKS.md',
];

function getProjectRoot(): string {
  // agents/community/src/strategist.ts -> project root is 3 levels up
  return path.resolve(__dirname, '..', '..', '..');
}

function getReportDir(): string {
  const config = getConfig();
  const dbPath = config.COMMUNITY_DB_PATH;
  // On Railway: /data/community.db -> use /data/strategist for reports
  // Locally: use project root reports/strategist
  if (dbPath.startsWith('/data/')) {
    return '/data/strategist';
  }
  return path.resolve(getProjectRoot(), 'reports', 'strategist');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readContextFiles(): string {
  const root = getProjectRoot();
  const parts: string[] = [];

  for (const file of CONTEXT_FILES) {
    const filePath = path.resolve(root, file);
    try {
      const text = fs.readFileSync(filePath, 'utf8').trim();
      if (text) {
        parts.push(`## Source: ${file}\n\n${text.slice(0, MAX_CONTEXT_CHARS)}`);
      }
    } catch {
      // file not found — skip
    }
  }

  return parts.join('\n\n');
}

function readLocalReport(reportPath: string): string | null {
  try {
    const text = fs.readFileSync(reportPath, 'utf8').trim();
    if (text) return text.slice(0, MAX_CONTEXT_CHARS);
  } catch { /* not found */ }
  return null;
}

async function fetchReport(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.status === 'pending' || data.error) return null;
    return JSON.stringify(data, null, 2).slice(0, MAX_CONTEXT_CHARS);
  } catch {
    return null;
  }
}

async function gatherReportsContext(): Promise<string> {
  const config = getConfig();
  const parts: string[] = [];

  // Community report — try local file first, then HTTP
  const communityDir = path.resolve(getProjectRoot(), 'reports', 'community', '.internal');
  let community = readLocalReport(path.join(communityDir, 'latest.json'));
  if (!community) {
    // On Railway, reports are in /data/ volume
    community = readLocalReport('/data/reports/community/.internal/latest.json');
  }
  if (!community) {
    // Self-fetch via localhost (we're in the same process)
    community = await fetchReport(`http://localhost:${process.env.PORT || '3000'}/report/community`);
  }
  if (community) {
    parts.push(`## Source: community-report.json\n\n${community}`);
  }

  // Analytics report — same strategy
  const analyticsDir = path.resolve(getProjectRoot(), 'reports', 'analytics', '.internal');
  let analytics = readLocalReport(path.join(analyticsDir, 'latest.json'));
  if (!analytics) {
    analytics = readLocalReport('/data/reports/analytics/.internal/latest.json');
  }
  if (!analytics) {
    analytics = await fetchReport(`http://localhost:${process.env.PORT || '3000'}/report/analytics`);
  }
  if (analytics) {
    parts.push(`## Source: analytics-report.json\n\n${analytics}`);
  }

  return parts.join('\n\n');
}

function buildPrompt(context: string, reportsContext: string): string {
  const fullContext = reportsContext ? `${context}\n\n${reportsContext}` : context;

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
\`\`\`json
{JSON с полями: week_focus, content_themes, challenge_active, challenge_name, search_keywords (stretching/strength/mobility), community_priority}
\`\`\`
// COMMUNITY_PACKET_END

Формат: валидный Markdown. Заголовок: "# Sami Strategist Report — YYYY-MM-DD".
Пиши на русском. Только текстовый отчёт, без команд и файловых операций.

Контекст проекта:
${fullContext}`;
}

async function callClaude(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[strategist] Claude API attempt ${attempt}/${MAX_RETRIES}`);
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      if (!text.trim()) throw new Error('Empty response from Claude');
      return text;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const isTransient = /overloaded|rate_limit|529|500|502|503|504|timeout|fetch failed/i.test(msg);
      if (isTransient && attempt < MAX_RETRIES) {
        console.warn(`[strategist] transient error, retrying in ${RETRY_DELAY_MS / 1000}s: ${msg.slice(0, 200)}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error('All retries exhausted');
}

function ensureSummaryBlock(report: string, date: string): string {
  if (/^## (Резюме|TL;DR)/m.test(report)) return report;
  return `# Sami Strategist Report — ${date}\n\n## Резюме\n- Отчёт сгенерирован автоматически агентом Strategist.\n- Ниже полный стратегический разбор.\n\n${report}`;
}

export async function runStrategist(bot: Bot): Promise<void> {
  const config = getConfig();
  const date = todayMsk();
  const reportDir = getReportDir();
  const internalDir = path.join(reportDir, '.internal');
  ensureDir(reportDir);
  ensureDir(internalDir);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportFile = `${date}_${stamp}__strategist-report.md`;
  const reportPath = path.join(reportDir, reportFile);
  const latestJson = path.join(internalDir, 'latest.json');
  const logPath = path.join(internalDir, 'strategist.log');

  console.log(`[strategist] starting report generation for ${date}`);

  try {
    // 1. Gather context
    const context = readContextFiles();
    const reportsContext = await gatherReportsContext();
    const prompt = buildPrompt(context, reportsContext);

    // Save prompt for debugging
    fs.writeFileSync(path.join(internalDir, `prompt-${stamp}.md`), prompt, 'utf8');

    // 2. Call Claude
    const rawReport = await callClaude(prompt);
    const report = ensureSummaryBlock(rawReport, date);

    // 3. Save report
    fs.writeFileSync(reportPath, report, 'utf8');

    // 4. Update latest.json
    fs.writeFileSync(latestJson, JSON.stringify({
      timestamp: new Date().toISOString(),
      status: 'completed',
      exit_code: 0,
      report_path: reportPath,
      report_file: reportFile,
      date,
    }, null, 2), 'utf8');

    // 5. Append to log
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] status=completed report=${reportPath}\n`);

    // 6. Notify admin via Telegram
    const summaryLines = report
      .split('\n')
      .filter(l => l.startsWith('- '))
      .slice(0, 5)
      .join('\n');

    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `*Strategist Report — ${date}*\n\n${summaryLines}\n\n_Полный отчёт на сервере_`,
      { parse_mode: 'Markdown' },
    );

    console.log(`[strategist] report saved: ${reportFile}`);
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[strategist] failed:`, err);

    // Save error report
    const errorReport = `# Sami Strategist Report — ${date}\n\n## Резюме\n- Отчёт не был сгенерирован.\n- Ошибка: ${errMsg.slice(0, 500)}\n`;
    fs.writeFileSync(reportPath, errorReport, 'utf8');

    fs.writeFileSync(latestJson, JSON.stringify({
      timestamp: new Date().toISOString(),
      status: 'failed',
      exit_code: 1,
      error: errMsg.slice(0, 500),
      date,
    }, null, 2), 'utf8');

    fs.appendFileSync(logPath, `[${new Date().toISOString()}] status=failed error=${errMsg.slice(0, 200)}\n`);

    // Notify admin about failure
    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `*Strategist FAILED — ${date}*\n\n\`${errMsg.slice(0, 300)}\``,
      { parse_mode: 'Markdown' },
    ).catch(() => {});
  }
}
