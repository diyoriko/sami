import { execFile } from 'child_process';
import { promisify } from 'util';
import { Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { todayMsk } from './dates';

const execFileAsync = promisify(execFile);

const MODEL = 'claude-sonnet-4-6';
const MAX_CONTEXT_CHARS = 6000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10_000;
const CLAUDE_TIMEOUT_MS = 300_000; // 5 min

const CONTEXT_FILES = [
  'STRATEGIST_BRIEF.md',
  'SAMI_PRD_v1.md',
  'SAMI_MVP_SCOPE.md',
  'SAMI_14_DAY_PLAN.md',
  'APP_TASKS.md',
  'COMMUNITY_TASKS.md',
];

function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

function getReportDir(): string {
  const config = getConfig();
  if (config.COMMUNITY_DB_PATH.startsWith('/data/')) {
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
    try {
      const text = fs.readFileSync(path.resolve(root, file), 'utf8').trim();
      if (text) parts.push(`## Source: ${file}\n\n${text.slice(0, MAX_CONTEXT_CHARS)}`);
    } catch { /* skip */ }
  }
  return parts.join('\n\n');
}

function readLocalReport(p: string): string | null {
  try {
    const text = fs.readFileSync(p, 'utf8').trim();
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
  } catch { return null; }
}

async function gatherReportsContext(): Promise<string> {
  const parts: string[] = [];
  const port = process.env.PORT || '3000';

  // Community report
  let community = readLocalReport('/data/reports/community/.internal/latest.json');
  if (!community) community = readLocalReport(path.resolve(getProjectRoot(), 'reports/community/.internal/latest.json'));
  if (!community) community = await fetchReport(`http://localhost:${port}/report/community`);
  if (community) parts.push(`## Source: community-report.json\n\n${community}`);

  // Analytics report
  let analytics = readLocalReport('/data/reports/analytics/.internal/latest.json');
  if (!analytics) analytics = readLocalReport(path.resolve(getProjectRoot(), 'reports/analytics/.internal/latest.json'));
  if (!analytics) analytics = await fetchReport(`http://localhost:${port}/report/analytics`);
  if (analytics) parts.push(`## Source: analytics-report.json\n\n${analytics}`);

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

function findClaudeBin(): string {
  try {
    const result = require('child_process').execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    if (result) return result;
  } catch { /* not in PATH */ }

  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.claude/local/claude`,
    '/root/.nix-profile/bin/claude',
  ];
  for (const bin of candidates) {
    try {
      require('child_process').execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch { continue; }
  }
  throw new Error('claude CLI not found');
}

async function callClaude(prompt: string, promptPath: string): Promise<string> {
  const claudeBin = findClaudeBin();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[strategist] claude --print attempt ${attempt}/${MAX_RETRIES}`);
      const { stdout } = await execFileAsync(claudeBin, [
        '--print',
        '--output-format', 'text',
        '--model', MODEL,
        '--prompt', fs.readFileSync(promptPath, 'utf8'),
      ], {
        timeout: CLAUDE_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CLAUDECODE: '' },
      });

      if (!stdout.trim()) throw new Error('Empty response from claude');
      return stdout;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const isTransient = /overloaded|rate_limit|529|500|502|503|504|timeout|fetch failed|ETIMEDOUT/i.test(msg);
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
  const promptPath = path.join(internalDir, `prompt-${stamp}.md`);

  console.log(`[strategist] starting report generation for ${date}`);

  try {
    // 1. Gather context
    const context = readContextFiles();
    const reportsContext = await gatherReportsContext();
    const prompt = buildPrompt(context, reportsContext);
    fs.writeFileSync(promptPath, prompt, 'utf8');

    // 2. Call Claude CLI
    const rawReport = await callClaude(prompt, promptPath);
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

    // 6. Notify admin
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

    await bot.api.sendMessage(
      config.TELEGRAM_ADMIN_USER_ID,
      `*Strategist FAILED — ${date}*\n\n\`${errMsg.slice(0, 300)}\``,
      { parse_mode: 'Markdown' },
    ).catch(() => {});
  }
}
