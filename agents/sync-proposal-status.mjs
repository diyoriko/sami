#!/usr/bin/env node

/**
 * Sync strategist proposal statuses against COMMUNITY_TASKS.md.
 *
 * Reads proposed-tasks.md, checks each proposal against the backlog:
 * - If found in COMMUNITY_TASKS.md (fuzzy match) → mark as "accepted"
 * - If found and marked [x] → mark as "done"
 * - Otherwise → stays "pending"
 *
 * Writes updated proposed-tasks.md with status tags.
 * Generates proposal-status.md for strategist context.
 *
 * Usage:
 *   node agents/sync-proposal-status.mjs
 *   node agents/sync-proposal-status.mjs --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const proposedPath = path.join(rootDir, "reports/strategist/.internal/proposed-tasks.md");
const backlogPath = path.join(rootDir, "COMMUNITY_TASKS.md");
const statusOutputPath = path.join(rootDir, "reports/strategist/.internal/proposal-status.md");
const dryRun = process.argv.includes("--dry-run");

/**
 * Normalize text for fuzzy matching: lowercase, strip punctuation, collapse whitespace.
 */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[—–\-:.,;!?()[\]{}«»""''`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if a proposal text fuzzy-matches any line in the backlog.
 * Returns: 'done' | 'accepted' | 'pending'
 */
function matchStatus(proposalText, backlogLines) {
  const normProposal = normalize(proposalText);
  // Extract key phrases (first 5 significant words)
  const keywords = normProposal.split(" ").filter(w => w.length > 3).slice(0, 5);

  if (keywords.length === 0) return "pending";

  for (const line of backlogLines) {
    const normLine = normalize(line);
    // Check if most keywords appear in the backlog line
    const matches = keywords.filter(kw => normLine.includes(kw));
    if (matches.length >= Math.min(3, keywords.length)) {
      // Check if it's marked as done
      if (line.trimStart().startsWith("- [x]")) return "done";
      return "accepted";
    }
  }

  return "pending";
}

async function main() {
  // Read proposed tasks
  let proposed;
  try {
    proposed = await fs.readFile(proposedPath, "utf8");
  } catch {
    console.log("[sync-proposals] no proposed-tasks.md found, nothing to sync");
    return;
  }

  // Read backlog
  const backlog = await fs.readFile(backlogPath, "utf8");
  const backlogLines = backlog.split("\n");

  // Parse proposals: "- [P1] [Sprint 6] Text" or "- [P1] [Sprint 6] Text {status:accepted}"
  const proposalRegex = /^- \[(P\d)\] \[Sprint (\d+)\] (.+?)(?:\s*\{status:(\w+)\})?$/;
  const lines = proposed.split("\n");
  const updatedLines = [];
  const statuses = [];

  for (const line of lines) {
    const m = line.match(proposalRegex);
    if (!m) {
      updatedLines.push(line);
      continue;
    }

    const [, priority, sprint, text] = m;
    const status = matchStatus(text, backlogLines);

    // Update line with status tag
    updatedLines.push(`- [${priority}] [Sprint ${sprint}] ${text} {status:${status}}`);
    statuses.push({ priority, sprint, text, status });
  }

  // Generate status summary for strategist context
  const statusLines = [
    "# Proposal Status",
    "",
    "Статусы предложений стратега (автоматически синхронизировано с COMMUNITY_TASKS.md).",
    "",
  ];

  const pending = statuses.filter(s => s.status === "pending");
  const accepted = statuses.filter(s => s.status === "accepted");
  const done = statuses.filter(s => s.status === "done");

  if (done.length > 0) {
    statusLines.push("## Done");
    done.forEach(s => statusLines.push(`- [${s.priority}] ${s.text}`));
    statusLines.push("");
  }
  if (accepted.length > 0) {
    statusLines.push("## Accepted (в бэклоге)");
    accepted.forEach(s => statusLines.push(`- [${s.priority}] ${s.text}`));
    statusLines.push("");
  }
  if (pending.length > 0) {
    statusLines.push("## Pending (не в бэклоге)");
    pending.forEach(s => statusLines.push(`- [${s.priority}] ${s.text}`));
    statusLines.push("");
  }

  statusLines.push(`\nВсего: ${statuses.length} (done: ${done.length}, accepted: ${accepted.length}, pending: ${pending.length})`);

  if (dryRun) {
    console.log("[sync-proposals] dry-run:");
    console.log(statusLines.join("\n"));
    console.log("\n---\nUpdated proposals:");
    console.log(updatedLines.join("\n"));
    return;
  }

  // Write updated proposed-tasks.md
  await fs.writeFile(proposedPath, updatedLines.join("\n"), "utf8");

  // Write status summary for strategist
  await fs.mkdir(path.dirname(statusOutputPath), { recursive: true });
  await fs.writeFile(statusOutputPath, statusLines.join("\n") + "\n", "utf8");

  console.log(`[sync-proposals] synced ${statuses.length} proposals: ${done.length} done, ${accepted.length} accepted, ${pending.length} pending`);
}

main().catch(err => {
  console.error("[sync-proposals]", err.message || err);
  process.exit(1);
});
