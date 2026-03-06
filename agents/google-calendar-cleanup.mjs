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

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function isStrategistEvent(event) {
  const summary = String(event.summary || "");
  const description = String(event.description || "");
  return (
    summary.startsWith("SAMI Strategist:") ||
    description.includes("Strategist status:") ||
    description.includes("Strategist report")
  );
}

function matchesEvent(event, summaryPrefix, summaryContains) {
  const summary = String(event.summary || "");
  if (summaryPrefix && summary.startsWith(summaryPrefix)) {
    return true;
  }
  if (summaryContains && summary.includes(summaryContains)) {
    return true;
  }
  return isStrategistEvent(event);
}

async function listEventsPage({ accessToken, calendarId, timeMin, timeMax, pageToken }) {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events`,
  );
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "250");
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  return googleRequest(url.toString(), accessToken);
}

async function listAllEvents({ accessToken, calendarId, timeMin, timeMax }) {
  const items = [];
  let pageToken = "";

  do {
    const page = await listEventsPage({
      accessToken,
      calendarId,
      timeMin,
      timeMax,
      pageToken,
    });
    if (Array.isArray(page.items)) {
      items.push(...page.items);
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);

  return items;
}

async function deleteEvent({ accessToken, calendarId, eventId }) {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}` +
    "?sendUpdates=none";
  try {
    return await googleRequest(url, accessToken, { method: "DELETE" });
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("google_request_failed:404:") || message.includes("google_request_failed:410:")) {
      return null;
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === "true";
  const calendarId = args.calendar || process.env.STRATEGIST_GOOGLE_CALENDAR_ID || "primary";
  const timeMin = args["time-min"] || "2020-01-01T00:00:00.000Z";
  const timeMax = args["time-max"] || "2035-01-01T00:00:00.000Z";
  const summaryPrefix = args["summary-prefix"] || "";
  const summaryContains = args["summary-contains"] || "";
  const listLimit = Number(args["list-limit"] || "100");
  const credentialsPath =
    process.env.STRATEGIST_GOOGLE_OAUTH_CREDENTIALS_FILE ||
    path.join(rootDir, "agents", "google-oauth-client.json");
  const tokenPath =
    process.env.STRATEGIST_GOOGLE_TOKEN_FILE ||
    path.join(internalDir, "google-calendar-token.json");

  if (!(await exists(credentialsPath)) || !(await exists(tokenPath))) {
    throw new Error("google_auth_not_configured");
  }

  const credentials = await loadCredentials(credentialsPath);
  const accessToken = await refreshAccessToken(tokenPath, credentials);
  const items = await listAllEvents({
    accessToken,
    calendarId,
    timeMin,
    timeMax,
  });
  const matches = items.filter((item) => matchesEvent(item, summaryPrefix, summaryContains));

  const deleted = [];
  const planned = [];
  const seenTargets = new Set();

  for (const item of matches) {
    const targetId = item.recurringEventId || item.id;
    if (seenTargets.has(targetId)) {
      continue;
    }
    seenTargets.add(targetId);
    planned.push({
      eventId: targetId,
      sample: item,
    });
  }

  for (const entry of planned) {
    const item = entry.sample;
    if (!dryRun) {
      await deleteEvent({
        accessToken,
        calendarId,
        eventId: entry.eventId,
      });
    }
    if (deleted.length < listLimit) {
      deleted.push({
        id: entry.eventId,
        summary: item.summary || "",
        start: item.start?.dateTime || item.start?.date || "",
        recurring: Boolean(item.recurringEventId),
        dry_run: dryRun,
      });
    }
  }

  const result = {
    status: "completed",
    dry_run: dryRun,
    calendar_id: calendarId,
    time_min: timeMin,
    time_max: timeMax,
    summary_prefix: summaryPrefix,
    summary_contains: summaryContains,
    checked: items.length,
    matched: matches.length,
    planned_deletions: planned.length,
    listed: deleted.length,
    deleted,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`[google-calendar-cleanup] ${String(error.message || error)}`);
  process.exit(1);
});
