#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function extractOutputText(payload) {
  const items = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];

  for (const item of items) {
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      } else if (content?.type === "text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const promptPath = path.resolve(args.prompt || "");
  const outputPath = path.resolve(args.output || "");
  const apiKey = process.env.OPENAI_API_KEY;

  if (!promptPath || !outputPath) {
    throw new Error("missing_required_paths");
  }
  if (!apiKey) {
    throw new Error("missing_openai_api_key");
  }

  const prompt = await fs.readFile(promptPath, "utf8");
  const model = args.model || "gpt-5.4";
  const reasoning = args.reasoning || "high";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      reasoning: {
        effort: reasoning,
      },
      text: {
        format: {
          type: "text",
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`openai_request_failed:${response.status}:${text}`);
  }

  const payload = await response.json();
  const outputText = extractOutputText(payload);
  if (!outputText) {
    throw new Error("openai_empty_output");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${outputText.trim()}\n`, "utf8");
  console.log(`[strategist-openai] response_id=${payload.id || "unknown"} model=${payload.model || model}`);
}

main().catch((error) => {
  console.error(`[strategist-openai] ${String(error.message || error)}`);
  process.exit(1);
});
