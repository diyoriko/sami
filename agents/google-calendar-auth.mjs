#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
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

async function loadCredentials(credentialsPath) {
  const raw = await loadJson(credentialsPath);
  const creds = raw.installed || raw.web || raw;
  let redirectUri =
    creds.redirect_uris?.find((item) => item.startsWith("http://127.0.0.1")) ||
    creds.redirect_uris?.[0] ||
    "http://127.0.0.1:8788/oauth2callback";

  if (redirectUri === "http://localhost" || redirectUri === "http://127.0.0.1") {
    redirectUri = "http://127.0.0.1:8788/oauth2callback";
  }

  if (!creds.client_id || !creds.client_secret) {
    throw new Error("google_credentials_missing_client_fields");
  }

  return {
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    authUri: creds.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUri: creds.token_uri || "https://oauth2.googleapis.com/token",
    redirectUri,
  };
}

function openBrowser(url) {
  const child = spawn("open", [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function exchangeCode({ code, credentials }) {
  const body = new URLSearchParams({
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: credentials.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(credentials.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`google_auth_exchange_failed:${response.status}`);
  }

  return response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentialsPath =
    args.credentials ||
    process.env.STRATEGIST_GOOGLE_OAUTH_CREDENTIALS_FILE ||
    path.join(rootDir, "agents", "google-oauth-client.json");
  const tokenPath =
    args.output ||
    process.env.STRATEGIST_GOOGLE_TOKEN_FILE ||
    path.join(internalDir, "google-calendar-token.json");
  const credentials = await loadCredentials(credentialsPath);
  const redirectUrl = new URL(credentials.redirectUri);
  const state = crypto.randomBytes(12).toString("hex");
  const scopes = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/tasks",
  ];

  const authUrl = new URL(credentials.authUri);
  authUrl.searchParams.set("client_id", credentials.clientId);
  authUrl.searchParams.set("redirect_uri", credentials.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const token = await new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || "/", credentials.redirectUri);
        if (requestUrl.pathname !== redirectUrl.pathname) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        if (requestUrl.searchParams.get("state") !== state) {
          response.writeHead(400);
          response.end("State mismatch");
          return;
        }

        const code = requestUrl.searchParams.get("code");
        if (!code) {
          response.writeHead(400);
          response.end("Missing authorization code");
          return;
        }

        const issued = await exchangeCode({ code, credentials });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Strategist Google auth complete</h1><p>You can close this tab.</p>");
        server.close();
        resolve({
          ...issued,
          expiry_date: Date.now() + Number(issued.expires_in || 3600) * 1000,
        });
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.listen(Number(redirectUrl.port || 80), redirectUrl.hostname, () => {
      console.log(`Open this URL to authorize Strategist:\n${authUrl.toString()}\n`);
      try {
        openBrowser(authUrl.toString());
      } catch {
        // The printed URL is enough if automatic browser open fails.
      }
    });
  });

  await writeJson(tokenPath, token);
  console.log(`Saved token to ${tokenPath}`);
}

main().catch((error) => {
  console.error(`[google-calendar-auth] ${String(error.message || error)}`);
  process.exit(1);
});
