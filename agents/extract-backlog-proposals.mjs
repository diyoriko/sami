#!/usr/bin/env node

/**
 * Extract BACKLOG_PROPOSALS from a strategist report and append to proposed-tasks.md.
 *
 * Usage:
 *   node agents/extract-backlog-proposals.mjs <report-path>
 *   node agents/extract-backlog-proposals.mjs <report-path> --dry-run
 *
 * Extracts lines between // BACKLOG_PROPOSALS_START and // BACKLOG_PROPOSALS_END,
 * parses structured proposals [sprint:N] [priority:PN], and appends to
 * reports/strategist/.internal/proposed-tasks.md with date header.
 *
 * Deduplication: skips proposals whose text already exists in the output file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const outputPath = path.join(
  rootDir,
  "reports/strategist/.internal/proposed-tasks.md",
);

const dryRun = process.argv.includes("--dry-run");
const reportPath = process.argv[2];

if (!reportPath || reportPath.startsWith("--")) {
  console.error(
    "Usage: node extract-backlog-proposals.mjs <report-path> [--dry-run]",
  );
  process.exit(1);
}

/**
 * @typedef {{ sprint: string, priority: string, text: string }} Proposal
 */

/**
 * Parse BACKLOG_PROPOSALS block from report markdown.
 * @param {string} report
 * @returns {Proposal[]}
 */
function parseProposals(report) {
  const match = report.match(
    /\/\/ BACKLOG_PROPOSALS_START\s*([\s\S]*?)\/\/ BACKLOG_PROPOSALS_END/,
  );
  if (!match) return [];

  const lines = match[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));

  return lines
    .map((line) => {
      const m = line.match(
        /^- \[sprint:(\d+)\]\s*\[priority:(P\d)\]\s*(.+)$/i,
      );
      if (!m) return null;
      return { sprint: m[1], priority: m[2].toUpperCase(), text: m[3].trim() };
    })
    .filter(Boolean);
}

/**
 * Load existing proposals to check for duplicates.
 * @returns {Promise<Set<string>>}
 */
async function loadExisting() {
  try {
    const content = await fs.readFile(outputPath, "utf8");
    const texts = new Set();
    for (const line of content.split("\n")) {
      // Extract text after priority tag: "- [P1] [Sprint 3] Some text"
      const m = line.match(/^- \[P\d\] \[Sprint \d\] (.+)$/);
      if (m) texts.add(m[1].toLowerCase());
    }
    return texts;
  } catch {
    return new Set();
  }
}

async function main() {
  const report = await fs.readFile(reportPath, "utf8");
  const proposals = parseProposals(report);

  if (proposals.length === 0) {
    console.log("[extract-backlog] no proposals found in report");
    return;
  }

  const existing = await loadExisting();
  const novel = proposals.filter(
    (p) => !existing.has(p.text.toLowerCase()),
  );

  if (novel.length === 0) {
    console.log(
      `[extract-backlog] ${proposals.length} proposals found, all duplicates — skipping`,
    );
    return;
  }

  // Format date from report filename or current date
  const dateMatch = reportPath.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

  const block = [
    "",
    `## ${date}`,
    "",
    ...novel.map(
      (p) => `- [${p.priority}] [Sprint ${p.sprint}] ${p.text}`,
    ),
  ].join("\n");

  if (dryRun) {
    console.log("[extract-backlog] dry-run output:");
    console.log(block);
    return;
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Initialize file if it doesn't exist
  try {
    await fs.access(outputPath);
  } catch {
    await fs.writeFile(
      outputPath,
      "# Proposed Tasks from Strategist\n\nАвтоматически извлечённые предложения из отчётов стратега.\nРешение принимает владелец.\n",
      "utf8",
    );
  }

  await fs.appendFile(outputPath, block + "\n", "utf8");
  console.log(
    `[extract-backlog] appended ${novel.length} proposals (${proposals.length - novel.length} duplicates skipped)`,
  );
}

main().catch((err) => {
  console.error("[extract-backlog]", err.message || err);
  process.exit(1);
});
