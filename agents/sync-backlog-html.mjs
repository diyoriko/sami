#!/usr/bin/env node

/**
 * Parse COMMUNITY_TASKS.md and regenerate staticData in backlog.html.
 *
 * Usage:
 *   node agents/sync-backlog-html.mjs
 *   node agents/sync-backlog-html.mjs --dry-run   # prints JSON, doesn't write
 *
 * This is a dev-time tool, not a runtime agent.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const tasksPath = path.join(rootDir, "COMMUNITY_TASKS.md");
const htmlPath = path.join(rootDir, "backlog.html");

const dryRun = process.argv.includes("--dry-run");

function parseTasks(md) {
  const lines = md.split("\n");
  const releases = [];
  const sprints = [];
  let currentRelease = null;
  let currentSprint = null;
  let currentGroup = null;

  for (const line of lines) {
    // Release header: **v0.1.0 (08.03):**
    const releaseMatch = line.match(
      /^\*\*v([\d.]+)\s*\(([^)]+)\):\*\*$/,
    );
    if (releaseMatch) {
      currentRelease = {
        version: `v${releaseMatch[1]}`,
        date: releaseMatch[2],
        status: "deployed",
        items: [],
      };
      releases.push(currentRelease);
      currentSprint = null;
      currentGroup = null;
      continue;
    }

    // Sprint header: ## SPRINT 2 — стабильность и polish
    const sprintMatch = line.match(
      /^## SPRINT (\d+)\s*[—–-]\s*(.+)$/,
    );
    if (sprintMatch) {
      currentRelease = null;
      currentSprint = {
        name: `Sprint ${sprintMatch[1]} — ${sprintMatch[2].trim()}`,
        status: "planned",
        groups: [],
      };
      sprints.push(currentSprint);
      currentGroup = null;
      continue;
    }

    // Sprint status line: Статус: **в работе** | **завершён** | **следующий**
    if (currentSprint && /^Статус:/.test(line)) {
      if (/завершён|completed|done/i.test(line)) {
        currentSprint.status = "completed";
      } else if (/в работе|active|почти завершён/i.test(line)) {
        currentSprint.status = "active";
      }
      continue;
    }

    // Group header: ### P1: Something
    const groupMatch = line.match(/^### (P\d):\s*(.+)$/);
    if (groupMatch && (currentSprint || currentRelease === null)) {
      if (!currentSprint) {
        // Orphan group (e.g., P0 outside sprint) — attach to a virtual sprint
        currentSprint = { name: "Прочее", status: "active", groups: [] };
        sprints.push(currentSprint);
      }
      currentGroup = {
        title: groupMatch[2].trim(),
        priority: groupMatch[1].toLowerCase(),
        tasks: [],
      };
      currentSprint.groups.push(currentGroup);
      continue;
    }

    // Task item: - [x] or - [ ] text
    const taskMatch = line.match(/^- \[([ x])\]\s*(.+)$/);
    if (taskMatch) {
      const done = taskMatch[1] === "x";
      let text = taskMatch[2];

      // Extract bold title if present
      const boldMatch = text.match(/^\*\*(.+?)\*\*\s*[—–-]?\s*(.*)/);
      if (boldMatch) {
        text = boldMatch[1];
      }

      if (currentRelease) {
        currentRelease.items.push(text);
      } else if (currentGroup) {
        currentGroup.tasks.push({ text, done });
      }
      continue;
    }

    // Release item without checkbox
    if (currentRelease && line.startsWith("- ")) {
      currentRelease.items.push(line.slice(2).trim());
    }
  }

  return { releases, sprints };
}

async function main() {
  const md = await fs.readFile(tasksPath, "utf8");
  const { releases, sprints } = parseTasks(md);

  const staticData = {
    releases,
    sprints,
    agents: [
      {
        id: "strategist",
        name: "Strategist",
        icon: "🧠",
        color: "#6366f1",
        platform: "launchd Mac",
        model: "Claude Sonnet 4.6",
        status: "active",
        statusLabel: "Active",
        schedule: "12:30 МСК ежедневно",
        skills: ["strategy", "research", "planning"],
        entry: "agents/strategist.sh",
      },
      {
        id: "community",
        name: "Community Bot",
        icon: "📢",
        color: "#22c55e",
        platform: "Railway 24/7",
        model: "—",
        status: "active",
        statusLabel: "Active",
        schedule: "19:00 поиск, посты вручную",
        skills: ["video-search", "posting", "moderation", "ugc"],
        entry: "agents/community/",
      },
      {
        id: "analytics",
        name: "Analytics",
        icon: "📊",
        color: "#eab308",
        platform: "Railway (модуль в community)",
        model: "—",
        status: "active",
        statusLabel: "Active",
        schedule: "00:30 ежедневно + вс 10:00 + при старте",
        skills: ["metrics", "reporting"],
        entry: "agents/community/src/analytics.ts",
      },
    ],
    flows: [
      { from: "strategist", to: "community", label: "COMMUNITY_PACKET", type: "http", protocol: "POST /packet" },
      { from: "community", to: "strategist", label: "community-latest.json", type: "http", protocol: "GET /report/community" },
      { from: "analytics", to: "strategist", label: "analytics-latest.json", type: "http", protocol: "GET /report/analytics" },
      { from: "strategist", to: "admin", label: "Telegram DM", type: "telegram", protocol: "sendMessage" },
      { from: "community", to: "channel", label: "Видео-посты", type: "telegram", protocol: "sendVideo" },
    ],
    services: [
      { name: "Railway", desc: "Хостинг бота 24/7", cost: "~$5/мес", paid: true },
      { name: "Dataimpulse", desc: "Residential proxy для yt-dlp", cost: "Prepaid 5GB", paid: true },
      { name: "Claude CLI", desc: "Стратег-агент", cost: "Подписка Max", paid: true },
      { name: "YouTube API v3", desc: "Поиск видео", cost: "Бесплатно (10K/day)", paid: false },
      { name: "Telegram Bot API", desc: "Бот", cost: "Бесплатно", paid: false },
    ],
  };

  const json = JSON.stringify(staticData, null, 2);

  if (dryRun) {
    console.log(json);
    return;
  }

  // Replace staticData in backlog.html
  const html = await fs.readFile(htmlPath, "utf8");
  const startMarker = "const staticData = ";
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) {
    console.error("Could not find 'const staticData = ' in backlog.html");
    process.exit(1);
  }

  // Find the end of the staticData object (matching closing brace + semicolon)
  let braceDepth = 0;
  let endIdx = -1;
  const searchStart = startIdx + startMarker.length;
  for (let i = searchStart; i < html.length; i++) {
    if (html[i] === "{") braceDepth++;
    if (html[i] === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        // Include trailing semicolons/newlines
        endIdx = i + 1;
        break;
      }
    }
  }

  if (endIdx === -1) {
    console.error("Could not find end of staticData object");
    process.exit(1);
  }

  const before = html.slice(0, startIdx + startMarker.length);
  const after = html.slice(endIdx);
  const newHtml = before + json + after;

  await fs.writeFile(htmlPath, newHtml, "utf8");
  console.log(
    `[sync-backlog] Updated backlog.html: ${releases.length} releases, ${sprints.length} sprints`,
  );
}

main().catch((err) => {
  console.error("[sync-backlog]", err.message || err);
  process.exit(1);
});
