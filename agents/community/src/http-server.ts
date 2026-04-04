/**
 * HTTP server extracted from index.ts.
 * Handles all HTTP endpoints: health, backup, analytics, packet, cookies,
 * implementor tasks, proposals, and report files.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Bot } from 'grammy';
import { type Config } from './config';
import { createLogger } from './logger';
import { getDb, getLatestDeploy, getLatestPost, listImplTasks, getNextImplTask, getImplTask, updateImplTaskStatus, createImplTask, saveProposal, getApprovedProposals, deleteProposals } from './db';
import { isYtDlpAvailable } from './downloader';
import { savePacketFromExternal, sendActionToAdmin, getActionById } from './strategist';
import type { ImplTaskStatus } from './db';

const log = createLogger('http');

// ---------------------------------------------------------------------------
// Shared body parser — replaces 5x copy-pasted pattern
// ---------------------------------------------------------------------------

function parseBody(req: http.IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodySize = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > maxSize) { tooBig = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function checkAuth(req: http.IncomingMessage, config: Config): boolean {
  const authHeader = req.headers['x-admin-token'];
  const expectedToken = config.STRATEGIST_API_KEY ?? config.TELEGRAM_BOT_TOKEN;
  return authHeader === expectedToken;
}

function sendUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function sendPayloadTooLarge(res: http.ServerResponse): void {
  res.writeHead(413, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'payload too large' }));
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function startHttpServer(bot: Bot, config: Config): http.Server {
  const port = parseInt(process.env.PORT || '3000');
  const reportBase = path.resolve(__dirname, '..');
  const reportFiles: Record<string, string> = {
    '/report/community': path.resolve(reportBase, config.COMMUNITY_REPORT_DIR, 'latest.json'),
    '/report/analytics': path.resolve(reportBase, config.ANALYTICS_REPORT_DIR, 'latest.json'),
  };

  const server = http.createServer((req, res) => {
    // GET /health — public, no auth
    if (req.url === '/health') {
      const deploy = getLatestDeploy();
      const latestPost = getLatestPost();
      const ytDlpAvailable = isYtDlpAvailable();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        status: 'ok',
        version: deploy?.version ?? null,
        commit: deploy?.commit_sha?.slice(0, 7) ?? null,
        deployed_at: deploy?.deployed_at ?? null,
        uptime_seconds: Math.floor(process.uptime()),
        ytDlpAvailable,
        lastPost: latestPost ? { date: latestPost.date, category: latestPost.category, posted_at: latestPost.posted_at } : null,
      }));
      return;
    }

    // GET /backup — download SQLite database
    if (req.url === '/backup' && req.method === 'GET') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      const dbPath = config.COMMUNITY_DB_PATH;
      if (!fs.existsSync(dbPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'database not found' }));
        return;
      }
      try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* WAL checkpoint best-effort */ }
      const stat = fs.statSync(dbPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="community-backup-${new Date().toISOString().slice(0, 10)}.db"`,
        'Content-Length': stat.size,
      });
      fs.createReadStream(dbPath).pipe(res);
      return;
    }

    // POST /trigger-analytics — strategist triggers fresh analytics
    if (req.url === '/trigger-analytics' && req.method === 'POST') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      (async () => {
        try {
          const { runDailyAnalytics } = await import('./analytics');
          const { todayMsk: today } = await import('./dates');
          await runDailyAnalytics(bot, today());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', date: today() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      })();
      return;
    }

    // POST /packet — receive COMMUNITY_PACKET from strategist
    if (req.url === '/packet' && req.method === 'POST') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      parseBody(req, 5 * 1024 * 1024).then(async (body) => {
        try {
          const payload = JSON.parse(body);
          if (!payload.packet || typeof payload.packet !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'packet must be an object' }));
            return;
          }
          const { packetId, actionIds } = savePacketFromExternal(payload.packet, payload.report);
          for (const actionId of actionIds) {
            const action = getActionById(actionId);
            if (action) {
              await sendActionToAdmin(bot, actionId, action);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', actions: actionIds.length }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      }).catch((err) => {
        if (err.message === 'PAYLOAD_TOO_LARGE') { sendPayloadTooLarge(res); }
        else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'read error' })); }
      });
      return;
    }

    // POST /upload-cookies — update yt-dlp cookies from local machine
    if (req.url === '/upload-cookies' && req.method === 'POST') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      parseBody(req, 1 * 1024 * 1024).then((body) => {
        try {
          const cookiesPath = process.env.YT_COOKIES_PATH || '/data/cookies.txt';
          const resolved = path.resolve(cookiesPath);
          if (!resolved.startsWith('/data/') && !resolved.startsWith(path.resolve(__dirname, '..'))) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid cookies path' }));
            return;
          }
          fs.writeFileSync(resolved, body, 'utf8');
          const lines = body.split('\n').length;
          log.info(`cookies updated: ${lines} lines`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', lines }));
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'write failed' }));
        }
      }).catch((err) => {
        if (err.message === 'PAYLOAD_TOO_LARGE') { sendPayloadTooLarge(res); }
        else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'read error' })); }
      });
      return;
    }

    // --- Implementor endpoints ---

    const parsedUrl = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (parsedUrl.pathname === '/impl/tasks' && req.method === 'GET') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      const statusFilter = parsedUrl.searchParams.get('status') as ImplTaskStatus | null;
      const tasks = listImplTasks(statusFilter ?? undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks }));
      return;
    }

    if (parsedUrl.pathname === '/impl/next' && req.method === 'GET') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      const task = getNextImplTask();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task }));
      return;
    }

    if (parsedUrl.pathname === '/impl/result' && req.method === 'POST') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      parseBody(req, 1 * 1024 * 1024).then(async (body) => {
        try {
          const payload = JSON.parse(body) as {
            id: number;
            status: ImplTaskStatus;
            result?: string;
            branch?: string;
            commit_sha?: string;
          };
          if (!payload.id || !payload.status) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'id and status are required' }));
            return;
          }
          const existing = getImplTask(payload.id);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'task not found' }));
            return;
          }
          updateImplTaskStatus(payload.id, payload.status, payload.result, payload.branch, payload.commit_sha);

          if (['in_progress', 'done', 'failed'].includes(payload.status)) {
            const statusLabels: Record<string, string> = {
              in_progress: 'В работе',
              done: 'Выполнена',
              failed: 'Ошибка',
            };
            const label = statusLabels[payload.status] ?? payload.status;
            const { escV2: esc2 } = await import('./shared');
            const lines = [
              `*Задача \\#${esc2(String(payload.id))}: ${esc2(label)}*`,
              `${esc2(existing.title)}`,
            ];
            if (payload.result) lines.push(`\nРезультат: ${esc2(payload.result.slice(0, 500))}`);
            if (payload.branch) lines.push(`Ветка: ${esc2(payload.branch)}`);
            bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join('\n'), {
              parse_mode: 'MarkdownV2',
            }).catch(() => {});
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (err) {
          log.warn('invalid JSON in /impl/result endpoint', { error: String(err) });
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      }).catch((err) => {
        if (err.message === 'PAYLOAD_TOO_LARGE') { sendPayloadTooLarge(res); }
        else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'read error' })); }
      });
      return;
    }

    if (parsedUrl.pathname === '/impl/create' && req.method === 'POST') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      parseBody(req, 1 * 1024 * 1024).then((body) => {
        try {
          const payload = JSON.parse(body) as {
            title: string;
            spec: string;
            priority?: string;
          };
          if (!payload.title || !payload.spec) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'title and spec are required' }));
            return;
          }
          const taskId = createImplTask(payload.title, payload.spec, 'manual', payload.priority ?? 'P2');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', id: taskId }));
        } catch (err) {
          log.warn('invalid JSON in /impl/create endpoint', { error: String(err) });
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      }).catch((err) => {
        if (err.message === 'PAYLOAD_TOO_LARGE') { sendPayloadTooLarge(res); }
        else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'read error' })); }
      });
      return;
    }

    // --- Proposal endpoints (strategist -> admin approval -> backlog) ---

    if (parsedUrl.pathname === '/proposal' && req.method === 'POST') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      parseBody(req, 512 * 1024).then((body) => {
        try {
          const payload = JSON.parse(body) as { task_text: string };
          if (!payload.task_text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'task_text is required' }));
            return;
          }
          const id = saveProposal(payload.task_text);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', id }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      }).catch((err) => {
        if (err.message === 'PAYLOAD_TOO_LARGE') { sendPayloadTooLarge(res); }
        else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'read error' })); }
      });
      return;
    }

    if (parsedUrl.pathname === '/proposals' && req.method === 'GET') {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      const approved = getApprovedProposals();
      if (approved.length > 0) {
        deleteProposals(approved.map(p => p.id));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proposals: approved.map(p => ({ id: p.id, taskText: p.task_text })) }));
      return;
    }

    // --- Report file endpoints ---

    const filePath = reportFiles[req.url ?? ''];
    if (filePath) {
      if (!checkAuth(req, config)) { sendUnauthorized(res); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      if (fs.existsSync(filePath)) {
        res.end(fs.readFileSync(filePath, 'utf8'));
      } else {
        res.end(JSON.stringify({ status: 'pending', message: 'report not generated yet', data: null }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown endpoint' }));
    }
  });

  server.listen(port, () => {
    log.info(`report server on :${port} — /report/community /report/analytics /packet /health /trigger-analytics /impl/* /proposal /proposals`);
  });

  return server;
}
