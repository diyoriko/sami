/**
 * Approval-related DB helpers.
 *
 * Split out of db.ts to reduce file size while keeping the same public API
 * (db.ts re-exports everything from here).
 */

import { getDb } from './db';
import type { VideoRow } from './db';

// --- Approval helpers ---

export function createApprovalSession(date: string, category: string, videoId: number): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO approval_sessions (date, category, video_id, status)
    VALUES (?, ?, ?, 'pending')
  `);
  return Number(stmt.run(date, category, videoId).lastInsertRowid);
}

export function getApprovedVideo(date: string, category: string): VideoRow | null {
  const db = getDb();
  return db.prepare(`
    SELECT v.* FROM approval_sessions a
    JOIN videos v ON v.id = a.video_id
    WHERE a.date = ? AND a.category = ? AND a.status = 'approved' AND a.deleted_at IS NULL
    ORDER BY a.decided_at DESC LIMIT 1
  `).get(date, category) as VideoRow | null;
}

export function setApprovalStatus(sessionId: number, status: 'approved' | 'rejected' | 'pending'): void {
  getDb().prepare(`
    UPDATE approval_sessions SET status = ?, decided_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
  `).run(status, sessionId);
}

export function getApprovalSessionByMessageId(messageId: number): { id: number; video_id: number; category: string; date: string; status: string } | null {
  return getDb().prepare(`
    SELECT id, video_id, category, date, status FROM approval_sessions WHERE message_id = ? AND deleted_at IS NULL
  `).get(messageId) as { id: number; video_id: number; category: string; date: string; status: string } | null;
}

export function getApprovalSessionById(sessionId: number): { id: number; video_id: number; category: string; date: string; status: string } | null {
  return (getDb().prepare(`
    SELECT id, video_id, category, date, status FROM approval_sessions WHERE id = ? AND deleted_at IS NULL
  `).get(sessionId) as { id: number; video_id: number; category: string; date: string; status: string } | undefined) ?? null;
}

export function resetApprovalSessions(date: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date = ? AND deleted_at IS NULL
  `).run(date);
  return result.changes;
}

export function setApprovalMessageId(sessionId: number, messageId: number): void {
  getDb().prepare(`UPDATE approval_sessions SET message_id = ? WHERE id = ? AND deleted_at IS NULL`).run(messageId, sessionId);
}

export function markApprovalPosted(date: string, category: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET status = 'posted', decided_at = datetime('now')
    WHERE date = ? AND category = ? AND status = 'approved' AND deleted_at IS NULL
  `).run(date, category);
  return result.changes;
}

export function storeChallengeContext(sessionId: number, challengeId: number, dayNumber: number): void {
  const json = JSON.stringify({ challengeId, dayNumber });
  getDb().prepare(`UPDATE approval_sessions SET challenge_context = ? WHERE id = ? AND deleted_at IS NULL`).run(json, sessionId);
}

export function getChallengeContext(sessionId: number): { challengeId: number; dayNumber: number } | undefined {
  const row = getDb().prepare(
    `SELECT challenge_context FROM approval_sessions WHERE id = ? AND deleted_at IS NULL`
  ).get(sessionId) as { challenge_context: string | null } | undefined;
  if (!row?.challenge_context) return undefined;
  try { return JSON.parse(row.challenge_context); } catch { return undefined; }
}

export function clearChallengeContext(sessionId: number): void {
  getDb().prepare(`UPDATE approval_sessions SET challenge_context = NULL WHERE id = ?`).run(sessionId);
}

export interface QueueItem {
  date: string;
  category: string;
  status: string;
  title: string;
  video_url: string;
}

export function getApprovalQueue(fromDate?: string, toDate?: string): QueueItem[] {
  const conditions = [`a.status = 'approved'`, `a.deleted_at IS NULL`];
  const params: string[] = [];

  if (fromDate) {
    conditions.push(`a.date >= ?`);
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push(`a.date <= ?`);
    params.push(toDate);
  }

  return getDb().prepare(`
    SELECT a.date, a.category, a.status, v.title, v.video_url
    FROM approval_sessions a
    JOIN videos v ON v.id = a.video_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.date ASC, CASE a.category
      WHEN 'stretching' THEN 1
      WHEN 'strength' THEN 2
      WHEN 'mobility' THEN 3
      ELSE 4 END
  `).all(...params) as QueueItem[];
}

/** Soft-delete old pending/approved sessions older than N days. */
export function cleanupOldApprovalSessions(olderThanDays: number = 2): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date < date('now', '-' || ? || ' days')
      AND status IN ('pending', 'approved')
      AND deleted_at IS NULL
  `).run(olderThanDays);
  return result.changes;
}

/** Soft-delete all non-posted sessions for a date — called after /post to clean up queue. */
export function cleanupUnpostedSessions(date: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date = ? AND status IN ('pending', 'approved') AND deleted_at IS NULL
  `).run(date);
  return result.changes;
}

/** Soft-delete pending sessions for a (date, category) pair — used before creating replacement. */
export function softDeletePendingSessions(date: string, category: string): number {
  const result = getDb().prepare(`
    UPDATE approval_sessions SET deleted_at = datetime('now')
    WHERE date = ? AND category = ? AND status = 'pending' AND deleted_at IS NULL
  `).run(date, category);
  return result.changes;
}
