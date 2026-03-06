#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const internalDir = path.join(rootDir, "reports", "strategist", ".internal");

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

function joinUrl(baseUrl, fileName) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/${encodeURIComponent(fileName)}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadCredentials(credentialsPath) {
  const raw = await loadJson(credentialsPath);
  const creds = raw.installed || raw.web || raw;
  if (!creds.client_id || !creds.client_secret) {
    throw new Error("google_credentials_missing_client_fields");
  }
  return {
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    tokenUri: creds.token_uri || "https://oauth2.googleapis.com/token",
  };
}

async function refreshAccessToken(tokenPath, credentials) {
  const token = await loadJson(tokenPath);
  if (!token.refresh_token) {
    throw new Error("google_token_missing_refresh_token");
  }

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  });

  const response = await fetch(credentials.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`google_token_refresh_failed:${response.status}`);
  }

  const refreshed = await response.json();
  const nextToken = {
    ...token,
    access_token: refreshed.access_token,
    token_type: refreshed.token_type || token.token_type || "Bearer",
    expiry_date: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
    scope: refreshed.scope || token.scope,
  };

  await writeJson(tokenPath, nextToken);
  return nextToken.access_token;
}

async function googleRequest(url, accessToken, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`google_request_failed:${response.status}:${text}`);
  }

  return response.json();
}

async function uploadReportToDrive({ accessToken, folderId, reportPath, reportFile }) {
  const metadata = {
    name: reportFile,
    mimeType: "text/markdown",
  };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const content = await fs.readFile(reportPath, "utf8");
  const boundary = `sami-${Date.now()}`;
  const payload = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/markdown; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return googleRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
    accessToken,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: payload,
    },
  );
}

async function uploadReportToPublicPaste({ reportPath }) {
  const pasteUrl = process.env.STRATEGIST_PUBLIC_PASTE_URL || "https://paste.rs";
  const content = await fs.readFile(reportPath, "utf8");
  const response = await fetch(pasteUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/markdown; charset=UTF-8",
    },
    body: content,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`public_paste_failed:${response.status}:${text}`);
  }

  const url = (await response.text()).trim();
  return {
    url,
  };
}

async function extractReportSummary(reportPath) {
  const content = await fs.readFile(reportPath, "utf8");
  const summaryMatch = content.match(/^##\s+Резюме\s*\n([\s\S]*?)(?:\n##\s+|\n#\s+|$)/m);
  if (!summaryMatch) {
    return [];
  }

  return summaryMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, 7);
}

async function buildTaskBody({ status, timestamp, exitCode, reportFile, reportPath, reportUrl }) {
  const lines = [
    `Strategist status: ${status}`,
    `Exit code: ${exitCode}`,
    `Timestamp (UTC): ${timestamp}`,
    `Report file: ${reportFile}`,
    `Local path: ${reportPath}`,
  ];
  const summary = await extractReportSummary(reportPath);

  if (summary.length > 0) {
    lines.push("");
    lines.push("Резюме:");
    lines.push(...summary);
  }

  if (reportUrl) {
    lines.push("");
    lines.push(`Result link: ${reportUrl}`);
  }

  return {
    title: `SAMI Strategist: ${status}`,
    notes: lines.join("\n"),
    due: timestamp,
    status: "needsAction",
  };
}

async function createTask({ accessToken, tasklistId, taskBody }) {
  const encodedTasklistId = encodeURIComponent(tasklistId);
  return googleRequest(
    `https://tasks.googleapis.com/tasks/v1/lists/${encodedTasklistId}/tasks`,
    accessToken,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(taskBody),
    },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = path.resolve(args.report || "");
  const reportFile = args["report-file"] || path.basename(reportPath);
  const outputPath = path.resolve(
    args.output || path.join(internalDir, "latest-notification.json"),
  );

  const result = {
    status: "skipped",
    reason: "",
    timestamp: args.timestamp || new Date().toISOString(),
    report_path: reportPath,
    report_file: reportFile,
    report_url: "",
    drive: null,
    public_paste: null,
    task: null,
  };

  if (!(await exists(reportPath))) {
    result.reason = "report_missing";
    await writeJson(outputPath, result);
    return;
  }

  const publicBaseUrl = process.env.STRATEGIST_REPORT_PUBLIC_BASE_URL || "";
  if (publicBaseUrl) {
    result.report_url = joinUrl(publicBaseUrl, reportFile);
  }

  const credentialsPath =
    process.env.STRATEGIST_GOOGLE_OAUTH_CREDENTIALS_FILE ||
    path.join(rootDir, "agents", "google-oauth-client.json");
  const tokenPath =
    process.env.STRATEGIST_GOOGLE_TOKEN_FILE ||
    path.join(internalDir, "google-calendar-token.json");

  if (!(await exists(credentialsPath)) || !(await exists(tokenPath))) {
    result.reason = "google_auth_not_configured";
    await writeJson(outputPath, result);
    return;
  }

  const credentials = await loadCredentials(credentialsPath);
  const accessToken = await refreshAccessToken(tokenPath, credentials);
  const driveFolderId = process.env.STRATEGIST_GOOGLE_DRIVE_FOLDER_ID || "";
  const disableDriveUpload = process.env.STRATEGIST_DISABLE_DRIVE_UPLOAD === "1";

  if (!disableDriveUpload) {
    try {
      result.drive = await uploadReportToDrive({
        accessToken,
        folderId: driveFolderId,
        reportPath,
        reportFile,
      });
      result.report_url = result.drive.webViewLink || result.report_url;
    } catch (error) {
      result.drive = {
        status: "failed",
        error: String(error.message || error),
      };
    }
  }

  const disablePublicPaste = process.env.STRATEGIST_DISABLE_PUBLIC_PASTE === "1";
  if (!result.report_url && !disablePublicPaste) {
    try {
      result.public_paste = await uploadReportToPublicPaste({ reportPath });
      result.report_url = result.public_paste.url || result.report_url;
    } catch (error) {
      result.public_paste = {
        status: "failed",
        error: String(error.message || error),
      };
    }
  }

  const taskBody = await buildTaskBody({
    status: args.status || "completed",
    timestamp: result.timestamp,
    exitCode: Number(args["exit-code"] || 0),
    reportFile,
    reportPath,
    reportUrl: result.report_url,
  });

  result.task = await createTask({
    accessToken,
    tasklistId: process.env.STRATEGIST_GOOGLE_TASKLIST_ID || "@default",
    taskBody,
  });
  result.status = "completed";
  await writeJson(outputPath, result);
}

main().catch(async (error) => {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(
    args.output || path.join(internalDir, "latest-notification.json"),
  );
  const fallback = {
    status: "failed",
    reason: String(error.message || error),
    timestamp: args.timestamp || new Date().toISOString(),
    report_path: args.report || "",
    report_file: args["report-file"] || "",
    report_url: "",
  };
  await writeJson(outputPath, fallback);
  console.error("[google-calendar-sync]", fallback.reason);
  process.exit(1);
});
