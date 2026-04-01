/**
 * Member-related DB helpers: members, UGC submissions, moderation, captcha, stop phrases.
 *
 * Split out of db.ts to reduce file size while keeping the same public API
 * (db.ts re-exports everything from here).
 */

import { getDb } from './db';
import { createLogger } from './logger';

const log = createLogger('db-members');

// --- Member helpers ---

export function upsertMember(userId: number, username: string | null, firstName: string | null): void {
  getDb().prepare(`
    INSERT INTO members (telegram_user_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(userId, username, firstName);
}

export function setMemberGoal(userId: number, goal: string): void {
  getDb().prepare(`
    UPDATE members SET fitness_goal = ?, first_action_at = COALESCE(first_action_at, datetime('now'))
    WHERE telegram_user_id = ?
  `).run(goal, userId);
}

export function addWarning(userId: number): number {
  const db = getDb();
  db.prepare(`UPDATE members SET warning_count = warning_count + 1 WHERE telegram_user_id = ?`).run(userId);
  const row = db.prepare(`SELECT warning_count FROM members WHERE telegram_user_id = ?`).get(userId) as { warning_count: number } | undefined;
  return row?.warning_count ?? 1;
}

export function muteMember(userId: number, hours: number): void {
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  getDb().prepare(`
    UPDATE members SET is_muted = 1, muted_until = ? WHERE telegram_user_id = ?
  `).run(until, userId);
}

// --- Member levels ---

export type MemberLevel = 'новичок' | 'практик' | 'наставник';

export function getMemberLevel(userId: number): { level: MemberLevel; completions: number } {
  const row = getDb().prepare(
    `SELECT COALESCE(completions_total, 0) as completions FROM members WHERE telegram_user_id = ?`
  ).get(userId) as { completions: number } | undefined;

  const completions = row?.completions ?? 0;
  let level: MemberLevel = 'новичок';
  if (completions >= 30) level = 'наставник';
  else if (completions >= 10) level = 'практик';

  return { level, completions };
}

// --- Buddy invite ---

export function wasBuddyInviteSent(userId: number): boolean {
  const row = getDb().prepare(
    `SELECT buddy_invite_sent FROM members WHERE telegram_user_id = ?`
  ).get(userId) as { buddy_invite_sent: number } | undefined;
  return (row?.buddy_invite_sent ?? 0) === 1;
}

export function markBuddyInviteSent(userId: number): void {
  getDb().prepare(
    `UPDATE members SET buddy_invite_sent = 1 WHERE telegram_user_id = ?`
  ).run(userId);
}

export interface MemberProfile {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  fitness_goal: string | null;
  joined_at: string;
  completions_total: number;
}

export function getMemberProfile(userId: number): MemberProfile | null {
  return getDb().prepare(`
    SELECT telegram_user_id, username, first_name, fitness_goal, joined_at,
           COALESCE(completions_total, 0) as completions_total
    FROM members WHERE telegram_user_id = ?
  `).get(userId) as MemberProfile | null;
}

// --- New members tracking in DB ---

export function getNewMembersToday(date: string): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM members WHERE date(joined_at) = ?`
  ).get(date) as { cnt: number };
  return row.cnt;
}

// --- Member joined_at helper ---

export function getMemberJoinedAt(userId: number): string | null {
  const row = getDb().prepare(
    `SELECT joined_at FROM members WHERE telegram_user_id = ?`
  ).get(userId) as { joined_at: string } | undefined;
  return row?.joined_at ?? null;
}

// --- Inactive users (48h reminder) ---

export interface InactiveUser {
  telegram_user_id: number;
  first_name: string;
  last_activity_at: string;
}

/**
 * Get users who completed at least 1 workout but haven't been active for `hours` hours.
 * Excludes users who were already reminded (reminder_sent_at within last 72h).
 */
export function getInactiveUsers(hours: number): InactiveUser[] {
  return getDb().prepare(`
    SELECT m.telegram_user_id, COALESCE(m.first_name, 'Участник') as first_name, m.last_activity_at
    FROM members m
    WHERE m.completions_total >= 1
      AND m.last_activity_at IS NOT NULL
      AND datetime(m.last_activity_at) < datetime('now', '-' || ? || ' hours')
      AND (m.reminder_sent_at IS NULL OR datetime(m.reminder_sent_at) < datetime('now', '-72 hours'))
  `).all(hours) as InactiveUser[];
}

export function markReminderSent(userId: number): void {
  getDb().prepare(
    `UPDATE members SET reminder_sent_at = datetime('now') WHERE telegram_user_id = ?`
  ).run(userId);
}

/** Get top active members for weekly progress digest */
export function getWeeklyTopMembers(weekStart: string, limit: number = 5): { telegram_user_id: number; username: string | null; first_name: string | null; count: number }[] {
  return getDb().prepare(`
    SELECT m.telegram_user_id, m.username, m.first_name, COUNT(*) as count
    FROM completions c
    JOIN members m ON m.telegram_user_id = c.telegram_user_id
    WHERE c.completed_at >= ?
    GROUP BY c.telegram_user_id
    ORDER BY count DESC
    LIMIT ?
  `).all(weekStart, limit) as { telegram_user_id: number; username: string | null; first_name: string | null; count: number }[];
}

// --- Captcha state (persistent) ---

export interface CaptchaRow {
  telegram_user_id: number;
  chat_id: string;
  answer: number;
  first_name: string;
  captcha_message_id: number | null;
  expires_at: string;
}

export function saveCaptcha(userId: number, chatId: number | string, answer: number, firstName: string, captchaMessageId: number, expiresAt: Date): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO pending_captchas (telegram_user_id, chat_id, answer, first_name, captcha_message_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, String(chatId), answer, firstName, captchaMessageId, expiresAt.toISOString());
}

export function getCaptcha(userId: number): CaptchaRow | null {
  return getDb().prepare(`SELECT * FROM pending_captchas WHERE telegram_user_id = ?`).get(userId) as CaptchaRow | null;
}

export function deleteCaptcha(userId: number): void {
  getDb().prepare(`DELETE FROM pending_captchas WHERE telegram_user_id = ?`).run(userId);
}

export function getExpiredCaptchas(): CaptchaRow[] {
  return getDb().prepare(`SELECT * FROM pending_captchas WHERE expires_at <= datetime('now')`).all() as CaptchaRow[];
}

// --- UGC conversation state (persistent) ---

export type UgcStep = 'waiting_link' | 'waiting_category' | 'waiting_difficulty' | 'waiting_duration' | 'waiting_equipment' | 'waiting_rubric' | 'waiting_title' | 'cs_name' | 'cs_duration' | 'cs_category' | 'edit_title';

export interface UgcConversationRow {
  telegram_user_id: number;
  step: UgcStep;
  submission_id: number | null;
}

export function saveUgcState(userId: number, step: UgcStep, submissionId?: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO ugc_conversation_state (telegram_user_id, step, submission_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(userId, step, submissionId ?? null);
}

export function getUgcState(userId: number): UgcConversationRow | null {
  return getDb().prepare(`SELECT * FROM ugc_conversation_state WHERE telegram_user_id = ?`).get(userId) as UgcConversationRow | null;
}

export function deleteUgcState(userId: number): void {
  getDb().prepare(`DELETE FROM ugc_conversation_state WHERE telegram_user_id = ?`).run(userId);
}

// --- UGC submissions ---

export interface UgcSubmission {
  id: number;
  telegram_user_id: number;
  username: string | null;
  video_url: string;
  youtube_id: string | null;
  title: string | null;
  category: string | null;
  difficulty: string | null;
  duration_seconds: number | null;
  duration_label: string | null;
  muscles: string | null;
  equipment: string | null;
  rubric: string | null;
  status: string;
  admin_message_id: number | null;
  created_at: string;
  decided_at: string | null;
  published_at: string | null;
}

export function isUgcDuplicate(youtubeId: string): boolean {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM ugc_submissions WHERE youtube_id = ? AND deleted_at IS NULL`
  ).get(youtubeId) as { cnt: number };
  return row.cnt > 0;
}

export function createUgcSubmission(userId: number, username: string | null, videoUrl: string, youtubeId: string | null): number {
  const result = getDb().prepare(`
    INSERT INTO ugc_submissions (telegram_user_id, username, video_url, youtube_id)
    VALUES (?, ?, ?, ?)
  `).run(userId, username, videoUrl, youtubeId);
  return Number(result.lastInsertRowid);
}

export function updateUgcSubmission(id: number, fields: Partial<Pick<UgcSubmission, 'title' | 'category' | 'difficulty' | 'duration_seconds' | 'duration_label' | 'muscles' | 'equipment' | 'rubric' | 'status' | 'admin_message_id' | 'published_at'>>): void {
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (sets.length === 0) return;
  if (fields.status === 'approved' || fields.status === 'rejected') {
    sets.push(`decided_at = datetime('now')`);
  }
  values.push(id);
  getDb().prepare(`UPDATE ugc_submissions SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values);
}

export function getUgcSubmission(id: number): UgcSubmission | null {
  return (getDb().prepare(`SELECT * FROM ugc_submissions WHERE id = ? AND deleted_at IS NULL`).get(id) as UgcSubmission | undefined) ?? null;
}

export function getUserDraftSubmission(userId: number): UgcSubmission | null {
  return getDb().prepare(
    `SELECT * FROM ugc_submissions WHERE telegram_user_id = ? AND status = 'draft' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`
  ).get(userId) as UgcSubmission | null;
}

export function deleteUgcSubmission(id: number): void {
  getDb().prepare(`UPDATE ugc_submissions SET deleted_at = datetime('now') WHERE id = ?`).run(id);
}

export function getUserSubmissions(userId: number, limit: number, offset: number): UgcSubmission[] {
  return getDb().prepare(`
    SELECT * FROM ugc_submissions
    WHERE telegram_user_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as UgcSubmission[];
}

export function getUserSubmissionTotal(userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM ugc_submissions WHERE telegram_user_id = ? AND deleted_at IS NULL`
  ).get(userId) as { cnt: number };
  return row.cnt;
}

// --- Dashboard helpers ---

export function getPendingUgcCount(): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM ugc_submissions WHERE status = 'pending' AND deleted_at IS NULL`
  ).get() as { cnt: number };
  return row.cnt;
}

export function getLastStrategistTimestamp(): string | null {
  try {
    const row = getDb().prepare(
      `SELECT created_at FROM strategist_packets ORDER BY created_at DESC LIMIT 1`
    ).get() as { created_at: string } | undefined;
    return row?.created_at ?? null;
  } catch (err) {
    log.warn('failed to get last strategist timestamp', { error: String(err) });
    return null;
  }
}

// --- Moderation log ---

export type ModAction = 'warn' | 'mute' | 'ban' | 'delete' | 'antiflood' | 'cooldown';

export function logModAction(userId: number, action: ModAction, reason: string, messageSnippet?: string): void {
  getDb().prepare(`
    INSERT INTO moderation_log (telegram_user_id, action, reason, message_snippet)
    VALUES (?, ?, ?, ?)
  `).run(userId, action, reason, messageSnippet?.slice(0, 200) ?? null);
}

export function getModLogCount(sinceDays: number = 7): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM moderation_log WHERE created_at > datetime('now', '-' || ? || ' days')`
  ).get(sinceDays) as { cnt: number };
  return row.cnt;
}

export function getRecentModActions(limit: number = 20): Array<{
  telegram_user_id: number; action: string; reason: string; message_snippet: string | null; created_at: string;
}> {
  return getDb().prepare(`
    SELECT telegram_user_id, action, reason, message_snippet, created_at
    FROM moderation_log ORDER BY id DESC LIMIT ?
  `).all(limit) as Array<{
    telegram_user_id: number; action: string; reason: string; message_snippet: string | null; created_at: string;
  }>;
}

// --- Stop phrases (dynamic spam list) ---

export function getStopPhrases(): string[] {
  const rows = getDb().prepare(`SELECT phrase FROM stop_phrases`).all() as Array<{ phrase: string }>;
  return rows.map(r => r.phrase);
}

export function addStopPhrase(phrase: string, addedBy: 'manual' | 'strategist' = 'manual'): boolean {
  try {
    getDb().prepare(`INSERT INTO stop_phrases (phrase, added_by) VALUES (?, ?)`).run(phrase.toLowerCase(), addedBy);
    return true;
  } catch {
    return false; // duplicate
  }
}

export function removeStopPhrase(phrase: string): boolean {
  const result = getDb().prepare(`DELETE FROM stop_phrases WHERE phrase = ?`).run(phrase.toLowerCase());
  return result.changes > 0;
}

// --- Implementor tasks ---

export type ImplTaskStatus = 'pending' | 'approved' | 'in_progress' | 'review' | 'done' | 'failed';
export type ImplTaskSource = 'strategist' | 'manual';

export interface ImplTask {
  id: number;
  title: string;
  spec: string;
  source: ImplTaskSource;
  status: ImplTaskStatus;
  priority: string;
  branch: string | null;
  commit_sha: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export function createImplTask(title: string, spec: string, source: ImplTaskSource = 'manual', priority: string = 'P2'): number {
  const result = getDb().prepare(`
    INSERT INTO impl_tasks (title, spec, source, priority)
    VALUES (?, ?, ?, ?)
  `).run(title, spec, source, priority);
  return Number(result.lastInsertRowid);
}

export function getImplTask(id: number): ImplTask | null {
  return (getDb().prepare(
    `SELECT * FROM impl_tasks WHERE id = ?`
  ).get(id) as ImplTask | undefined) ?? null;
}

/** Get the oldest approved task — next to be picked up by the implementor. */
export function getNextImplTask(): ImplTask | null {
  return (getDb().prepare(
    `SELECT * FROM impl_tasks WHERE status = 'approved' ORDER BY created_at ASC LIMIT 1`
  ).get() as ImplTask | undefined) ?? null;
}

export function updateImplTaskStatus(
  id: number,
  status: ImplTaskStatus,
  result?: string,
  branch?: string,
  commitSha?: string,
): void {
  getDb().prepare(`
    UPDATE impl_tasks
    SET status = ?, result = ?, branch = COALESCE(?, branch), commit_sha = COALESCE(?, commit_sha), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, result ?? null, branch ?? null, commitSha ?? null, id);
}

export function listImplTasks(status?: ImplTaskStatus): ImplTask[] {
  if (status) {
    return getDb().prepare(
      `SELECT * FROM impl_tasks WHERE status = ? ORDER BY created_at DESC`
    ).all(status) as ImplTask[];
  }
  return getDb().prepare(
    `SELECT * FROM impl_tasks ORDER BY created_at DESC`
  ).all() as ImplTask[];
}

// --- Rubrics ---

export interface RitualRow {
  id: number;
  week_start: string;
  title: string;
  description: string | null;
  category: string | null;
  channel_message_id: number | null;
  participants: number;
  created_at: string;
}

export function createRitual(weekStart: string, title: string, description?: string, category?: string): number {
  const result = getDb().prepare(
    `INSERT INTO rubric_rituals (week_start, title, description, category) VALUES (?, ?, ?, ?)`
  ).run(weekStart, title, description ?? null, category ?? null);
  return Number(result.lastInsertRowid);
}

export function getCurrentRitual(): RitualRow | null {
  return (getDb().prepare(
    `SELECT * FROM rubric_rituals ORDER BY week_start DESC LIMIT 1`
  ).get() as RitualRow | undefined) ?? null;
}

export function setRitualMessageId(ritualId: number, messageId: number): void {
  getDb().prepare('UPDATE rubric_rituals SET channel_message_id = ? WHERE id = ?').run(messageId, ritualId);
}

export function recordRitualParticipation(ritualId: number, userId: number, dayNumber: number): boolean {
  try {
    getDb().prepare(
      `INSERT INTO rubric_ritual_participants (ritual_id, telegram_user_id, day_number) VALUES (?, ?, ?)`
    ).run(ritualId, userId, dayNumber);
    // Update participant count
    const count = getDb().prepare(
      `SELECT COUNT(DISTINCT telegram_user_id) as cnt FROM rubric_ritual_participants WHERE ritual_id = ?`
    ).get(ritualId) as { cnt: number };
    getDb().prepare('UPDATE rubric_rituals SET participants = ? WHERE id = ?').run(count.cnt, ritualId);
    return true;
  } catch {
    return false; // duplicate
  }
}

export function getRitualProgress(ritualId: number, userId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM rubric_ritual_participants WHERE ritual_id = ? AND telegram_user_id = ?`
  ).get(ritualId, userId) as { cnt: number };
  return row.cnt;
}

export function getRitualParticipantCount(ritualId: number): number {
  const row = getDb().prepare(
    `SELECT COUNT(DISTINCT telegram_user_id) as cnt FROM rubric_ritual_participants WHERE ritual_id = ?`
  ).get(ritualId) as { cnt: number };
  return row.cnt;
}

// ─── JOIN SOURCE ──────────────────────────────────────────────────────────────

export function setMemberJoinSource(userId: number, source: string): void {
  getDb().prepare(`UPDATE members SET join_source = ? WHERE telegram_user_id = ?`).run(source, userId);
}

// ─── INVITE LINKS ─────────────────────────────────────────────────────────────

export interface InviteLink {
  id: number;
  label: string;
  url: string;
  clicks: number;
  joins: number;
  created_at: string;
}

export function createInviteLink(label: string, url: string): number {
  const result = getDb().prepare(
    `INSERT INTO invite_links (label, url) VALUES (?, ?)`
  ).run(label, url);
  return Number(result.lastInsertRowid);
}

export function getInviteLinks(): InviteLink[] {
  return getDb().prepare(`SELECT * FROM invite_links ORDER BY id DESC`).all() as InviteLink[];
}

export function incrementInviteLinkClicks(url: string): void {
  getDb().prepare(`UPDATE invite_links SET clicks = clicks + 1 WHERE url = ?`).run(url);
}

export function incrementInviteLinkJoins(url: string): void {
  getDb().prepare(`UPDATE invite_links SET joins = joins + 1 WHERE url = ?`).run(url);
}
