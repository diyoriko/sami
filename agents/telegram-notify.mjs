#!/usr/bin/env node

/**
 * Universal Telegram DM notifier for SAMI agents.
 *
 * Usage:
 *   node agents/telegram-notify.mjs \
 *     --agent strategist \
 *     --status completed \
 *     --report reports/strategist/2026-03-06__report.md \
 *     --summary "3 ключевых решения, фокус: стретчинг"
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   — bot token (required)
 *   TELEGRAM_ADMIN_USER_ID — admin chat id for DM (required)
 *
 * Reads env from ~/.config/sami/community.env if present.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Env loading (dotenv-free)
// ---------------------------------------------------------------------------

async function loadEnvFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // file not found — ok
  }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function sendTelegramMessage(token, chatId, text, parseMode = "Markdown") {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram_send_failed:${res.status}:${body}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

async function extractSummary(reportPath) {
  try {
    const content = await fs.readFile(reportPath, "utf8");
    const match = content.match(/^##\s+Резюме\s*\n([\s\S]*?)(?:\n##\s+|\n#\s+|$)/m);
    if (!match) return null;
    const bullets = match[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .slice(0, 5);
    return bullets.length > 0 ? bullets.join("\n") : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent emoji map
// ---------------------------------------------------------------------------

const AGENT_EMOJI = {
  strategist: "🧠",
  community: "📢",
  analytics: "📊",
  "content-curator": "📋",
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load env files (community.env has bot token + admin id)
  const envPaths = [
    path.join(process.env.HOME || "", ".config", "sami", "community.env"),
    path.join(__dirname, "community", ".env"),
  ];
  for (const p of envPaths) await loadEnvFile(p);

  const args = parseArgs(process.argv.slice(2));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.TELEGRAM_ADMIN_USER_ID;

  if (!token || !adminId) {
    console.error("[telegram-notify] TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_USER_ID not set");
    process.exit(1);
  }

  const agent = args.agent || "unknown";
  const status = args.status || "completed";
  const reportPath = args.report ? path.resolve(args.report) : "";
  const reportFile = reportPath ? path.basename(reportPath) : "";

  // Build summary
  let summary = args.summary || "";
  if (!summary && reportPath) {
    summary = (await extractSummary(reportPath)) || "";
  }

  // Build message
  const emoji = AGENT_EMOJI[agent] || "🤖";
  const statusEmoji = status === "completed" ? "✅" : status === "failed" ? "❌" : "⏳";

  const lines = [
    `${emoji} *SAMI ${agent.charAt(0).toUpperCase() + agent.slice(1)}* ${statusEmoji}`,
    "",
  ];

  if (summary) {
    lines.push(summary);
    lines.push("");
  }

  if (reportFile) {
    lines.push(`📄 \`${reportFile}\``);
  }

  const timestamp = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  lines.push(`🕐 ${timestamp} МСК`);

  const text = lines.join("\n");

  await sendTelegramMessage(token, adminId, text);
  console.log(`[telegram-notify] Sent DM to admin: ${agent} ${status}`);
}

main().catch((err) => {
  console.error("[telegram-notify]", err.message || err);
  process.exit(1);
});
