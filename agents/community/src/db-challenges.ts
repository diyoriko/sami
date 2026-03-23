/**
 * Challenge-related DB helpers: challenges, weekly schedule, challenge series, proposals.
 *
 * Split out of db.ts to reduce file size while keeping the same public API
 * (db.ts re-exports everything from here).
 */

import { getDb } from './db';

// ─── CHALLENGES (21-day cycles) ─────────────────────────────────────────────

export interface ChallengeRow {
  id: number;
  number: number;
  start_date: string;
  end_date: string;
  status: 'active' | 'completed' | 'upcoming';
  created_at: string;
}

export interface WeeklySlotRow {
  id: number;
  challenge_id: number;
  day_number: number;
  video_id: number | null;
  status: 'empty' | 'queued' | 'posted';
  queued_at: string | null;
  posted_at: string | null;
}

export function createChallenge(num: number, startDate: string, endDate: string): number {
  const info = getDb().prepare(
    `INSERT INTO challenges (number, start_date, end_date, status) VALUES (?, ?, ?, 'upcoming')`
  ).run(num, startDate, endDate);
  return Number(info.lastInsertRowid);
}

export function getActiveChallenge(): ChallengeRow | null {
  return getDb().prepare(`SELECT * FROM challenges WHERE status = 'active' LIMIT 1`).get() as ChallengeRow | null;
}

export function getUpcomingChallenge(): ChallengeRow | null {
  return getDb().prepare(`SELECT * FROM challenges WHERE status = 'upcoming' ORDER BY start_date LIMIT 1`).get() as ChallengeRow | null;
}

export function getLatestChallenge(): ChallengeRow | null {
  return getDb().prepare(`SELECT * FROM challenges ORDER BY number DESC LIMIT 1`).get() as ChallengeRow | null;
}

export function activateChallenge(challengeId: number): void {
  getDb().prepare(`UPDATE challenges SET status = 'active' WHERE id = ?`).run(challengeId);
}

export function completeChallenge(challengeId: number): void {
  getDb().prepare(`UPDATE challenges SET status = 'completed' WHERE id = ?`).run(challengeId);
}

/** Simple date+days helper for DB layer (no dependency on dates.ts at module level) */
function addDaysStr(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Ensure there is an active challenge covering today.
 * - If active challenge covers today -> return it.
 * - If active challenge does NOT cover today -> complete it, create new one.
 * - If upcoming.start_date === weekStart -> activate or return it.
 * - Otherwise -> create a new challenge for weekStart.
 */
export function ensureActiveChallenge(today: string, weekStart: string): ChallengeRow {
  const active = getActiveChallenge();
  if (active) {
    // Check if active challenge still covers today
    if (active.start_date <= today && active.end_date >= today) {
      return active;
    }
    // Active challenge no longer covers today — complete it
    completeChallenge(active.id);
  }

  const upcoming = getUpcomingChallenge();
  if (upcoming && upcoming.start_date === weekStart) {
    if (upcoming.start_date <= today) {
      activateChallenge(upcoming.id);
      return { ...upcoming, status: 'active' };
    }
    return upcoming; // not yet started
  }

  // Create new challenge for this week
  const latest = getLatestChallenge();
  const num = latest ? latest.number + 1 : 1;
  const start = weekStart;
  const end = addDaysStr(start, 6); // 7 days: day 0..6
  const id = createChallenge(num, start, end);
  const created: ChallengeRow = { id, number: num, start_date: start, end_date: end, status: 'upcoming', created_at: '' };
  if (start <= today) {
    activateChallenge(id);
    return { ...created, status: 'active' };
  }
  return created;
}

/** Compute challenge day (1-21) from today's date and challenge start */
export function getChallengeDay(challengeStartDate: string, today: string): number {
  const start = new Date(challengeStartDate + 'T00:00:00');
  const now = new Date(today + 'T00:00:00');
  return Math.round((now.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** Which week of the challenge — always 1 now (7-day cycles) */
export function getChallengeWeekNumber(_challengeDay: number): 1 | 2 | 3 {
  return 1;
}

// --- Weekly schedule ---

/** Create 7 empty slots for a week (idempotent) */
export function initWeekSlots(challengeId: number, weekNumber: 1 | 2 | 3): void {
  const startDay = (weekNumber - 1) * 7 + 1;
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO weekly_schedule (challenge_id, day_number, status) VALUES (?, ?, 'empty')`
  );
  for (let d = startDay; d < startDay + 7; d++) {
    stmt.run(challengeId, d);
  }
}

/** Get all 7 slots for a week with video info */
export function getWeekStatus(challengeId: number, weekNumber: 1 | 2 | 3): (WeeklySlotRow & { title?: string })[] {
  const startDay = (weekNumber - 1) * 7 + 1;
  const endDay = startDay + 6;
  return getDb().prepare(`
    SELECT sq.*, v.title
    FROM weekly_schedule sq
    LEFT JOIN videos v ON v.id = sq.video_id
    WHERE sq.challenge_id = ? AND sq.day_number BETWEEN ? AND ?
    ORDER BY sq.day_number
  `).all(challengeId, startDay, endDay) as (WeeklySlotRow & { title?: string })[];
}

/** Fill a queue slot with a video */
export function setWeekSlotVideo(challengeId: number, dayNumber: number, videoId: number): void {
  getDb().prepare(`
    UPDATE weekly_schedule SET video_id = ?, status = 'queued', queued_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(videoId, challengeId, dayNumber);
}

/** Get queue entry for a specific day */
export function getWeekSlotForDay(challengeId: number, dayNumber: number): WeeklySlotRow | null {
  return getDb().prepare(
    `SELECT * FROM weekly_schedule WHERE challenge_id = ? AND day_number = ?`
  ).get(challengeId, dayNumber) as WeeklySlotRow | null;
}

/** Mark a queue slot as posted */
export function markWeekSlotPosted(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE weekly_schedule SET status = 'posted', posted_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(challengeId, dayNumber);
}

/** Reset a slot to empty (for replacing a queued video) */
export function clearWeekSlot(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE weekly_schedule SET video_id = NULL, status = 'empty', queued_at = NULL
    WHERE challenge_id = ? AND day_number = ? AND status = 'queued'
  `).run(challengeId, dayNumber);
}

/** Find first empty slot in a week */
export function getNextEmptySlot(challengeId: number, weekNumber: 1 | 2 | 3): WeeklySlotRow | null {
  const startDay = (weekNumber - 1) * 7 + 1;
  const endDay = startDay + 6;
  return getDb().prepare(`
    SELECT * FROM weekly_schedule
    WHERE challenge_id = ? AND day_number BETWEEN ? AND ? AND status = 'empty'
    ORDER BY day_number LIMIT 1
  `).get(challengeId, startDay, endDay) as WeeklySlotRow | null;
}

// ─── PROPOSALS (strategist -> admin approval -> backlog) ──────────────────────

export function saveProposal(taskText: string): number {
  return Number(getDb().prepare(`INSERT INTO proposals (task_text, status) VALUES (?, 'pending')`).run(taskText).lastInsertRowid);
}
export function getApprovedProposals(): { id: number; task_text: string }[] {
  return getDb().prepare(`SELECT id, task_text FROM proposals WHERE status = 'approved'`).all() as any[];
}
export function updateProposalStatus(id: number, status: 'approved' | 'rejected'): void {
  getDb().prepare(`UPDATE proposals SET status = ? WHERE id = ?`).run(status, id);
}
export function deleteProposals(ids: number[]): void {
  if (!ids.length) return;
  getDb().prepare(`DELETE FROM proposals WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

// ─── CHALLENGE SERIES (named challenges, parallel to weekly schedule) ────────

export interface ChallengeSeriesRow {
  id: number; name: string; duration_days: number; default_category: string | null;
  description: string | null; start_date: string; end_date: string;
  publish_time: string; status: 'draft' | 'active' | 'completed' | 'cancelled';
  created_at: string;
}

export interface ChallengeSeriesDayRow {
  id: number; challenge_id: number; day_number: number; video_id: number | null;
  category: string | null; status: 'empty' | 'queued' | 'posted';
  queued_at: string | null; posted_at: string | null;
}

export function createChallengeSeries(
  name: string, durationDays: number, startDate: string,
  opts?: { defaultCategory?: string; description?: string; publishTime?: string },
): number {
  const endDate = (() => {
    const d = new Date(startDate + 'T00:00:00');
    d.setDate(d.getDate() + durationDays - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const id = Number(getDb().prepare(`
    INSERT INTO challenge_series (name, duration_days, default_category, description, start_date, end_date, publish_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, durationDays, opts?.defaultCategory ?? null, opts?.description ?? null,
    startDate, endDate, opts?.publishTime ?? '09:00').lastInsertRowid);

  // Pre-create day slots
  const db = getDb();
  const stmt = db.prepare(`INSERT OR IGNORE INTO challenge_series_days (challenge_id, day_number, category) VALUES (?, ?, ?)`);
  for (let d = 1; d <= durationDays; d++) {
    stmt.run(id, d, opts?.defaultCategory ?? null);
  }
  return id;
}

export function getChallengeSeries(id: number): ChallengeSeriesRow | null {
  return (getDb().prepare(`SELECT * FROM challenge_series WHERE id = ?`).get(id) as ChallengeSeriesRow | undefined) ?? null;
}

export function getActiveChallengeSeriesList(): ChallengeSeriesRow[] {
  return getDb().prepare(`SELECT * FROM challenge_series WHERE status = 'active' ORDER BY start_date`).all() as ChallengeSeriesRow[];
}

export function listChallengeSeries(statuses?: string[]): ChallengeSeriesRow[] {
  if (!statuses?.length) return getDb().prepare(`SELECT * FROM challenge_series ORDER BY created_at DESC`).all() as ChallengeSeriesRow[];
  const placeholders = statuses.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM challenge_series WHERE status IN (${placeholders}) ORDER BY created_at DESC`).all(...statuses) as ChallengeSeriesRow[];
}

export function updateChallengeSeriesStatus(id: number, status: 'draft' | 'active' | 'completed' | 'cancelled'): void {
  getDb().prepare(`UPDATE challenge_series SET status = ? WHERE id = ?`).run(status, id);
}

export function getChallengeSeriesDaySlot(challengeId: number, dayNumber: number): (ChallengeSeriesDayRow & { title?: string }) | null {
  return (getDb().prepare(`
    SELECT d.*, v.title FROM challenge_series_days d
    LEFT JOIN videos v ON v.id = d.video_id
    WHERE d.challenge_id = ? AND d.day_number = ?
  `).get(challengeId, dayNumber) as (ChallengeSeriesDayRow & { title?: string }) | undefined) ?? null;
}

export function getChallengeSeriesDaysStatus(challengeId: number): (ChallengeSeriesDayRow & { title?: string })[] {
  return getDb().prepare(`
    SELECT d.*, v.title FROM challenge_series_days d
    LEFT JOIN videos v ON v.id = d.video_id
    WHERE d.challenge_id = ?
    ORDER BY d.day_number
  `).all(challengeId) as (ChallengeSeriesDayRow & { title?: string })[];
}

export function setChallengeSeriesDayVideo(challengeId: number, dayNumber: number, videoId: number, category?: string): void {
  getDb().prepare(`
    UPDATE challenge_series_days SET video_id = ?, category = COALESCE(?, category), status = 'queued', queued_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(videoId, category ?? null, challengeId, dayNumber);
}

export function markChallengeSeriesDayPosted(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE challenge_series_days SET status = 'posted', posted_at = datetime('now')
    WHERE challenge_id = ? AND day_number = ?
  `).run(challengeId, dayNumber);
}

export function clearChallengeSeriesDaySlot(challengeId: number, dayNumber: number): void {
  getDb().prepare(`
    UPDATE challenge_series_days SET video_id = NULL, status = 'empty', queued_at = NULL
    WHERE challenge_id = ? AND day_number = ? AND status = 'queued'
  `).run(challengeId, dayNumber);
}

// --- Participants ---

export function joinChallengeSeries(challengeId: number, userId: number): boolean {
  try {
    getDb().prepare(`INSERT INTO challenge_participants (challenge_id, telegram_user_id) VALUES (?, ?)`).run(challengeId, userId);
    return true;
  } catch { return false; } // UNIQUE constraint = already joined
}

export function isChallengeParticipant(challengeId: number, userId: number): boolean {
  const row = getDb().prepare(`SELECT 1 FROM challenge_participants WHERE challenge_id = ? AND telegram_user_id = ?`).get(challengeId, userId);
  return !!row;
}

export function getChallengeParticipantCount(challengeId: number): number {
  return (getDb().prepare(`SELECT COUNT(*) as cnt FROM challenge_participants WHERE challenge_id = ?`).get(challengeId) as { cnt: number }).cnt;
}

// --- Completions ---

export function recordChallengeCompletion(challengeId: number, dayNumber: number, userId: number): boolean {
  try {
    getDb().prepare(`INSERT INTO challenge_completions (challenge_id, day_number, telegram_user_id) VALUES (?, ?, ?)`).run(challengeId, dayNumber, userId);
    return true;
  } catch { return false; } // UNIQUE constraint = already completed
}

export function hasChallengeCompletion(challengeId: number, dayNumber: number, userId: number): boolean {
  return !!getDb().prepare(`SELECT 1 FROM challenge_completions WHERE challenge_id = ? AND day_number = ? AND telegram_user_id = ?`).get(challengeId, dayNumber, userId);
}

export function removeChallengeCompletion(challengeId: number, dayNumber: number, userId: number): boolean {
  return getDb().prepare(`DELETE FROM challenge_completions WHERE challenge_id = ? AND day_number = ? AND telegram_user_id = ?`).run(challengeId, dayNumber, userId).changes > 0;
}

export function getChallengeCompletionCount(challengeId: number, dayNumber: number): number {
  return (getDb().prepare(`SELECT COUNT(*) as cnt FROM challenge_completions WHERE challenge_id = ? AND day_number = ?`).get(challengeId, dayNumber) as { cnt: number }).cnt;
}

export function getUserChallengeProgress(challengeId: number, userId: number): { completed: number; total: number } {
  const series = getChallengeSeries(challengeId);
  const total = series?.duration_days ?? 0;
  const completed = (getDb().prepare(
    `SELECT COUNT(*) as cnt FROM challenge_completions WHERE challenge_id = ? AND telegram_user_id = ?`
  ).get(challengeId, userId) as { cnt: number }).cnt;
  return { completed, total };
}
