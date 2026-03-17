/**
 * All dates in SAMI community bot are in Moscow timezone (Europe/Moscow, UTC+3).
 * Cron jobs run in MSK, approval sessions store MSK dates, posts use MSK dates.
 */

function moscowNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
}

/** Today's date in Moscow as YYYY-MM-DD */
export function todayMsk(): string {
  const d = moscowNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Tomorrow's date in Moscow as YYYY-MM-DD */
export function tomorrowMsk(): string {
  const d = moscowNow();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Current ISO week string like "2026-W10" based on Moscow time */
export function currentWeekMsk(): string {
  const now = moscowNow();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now.getTime() - start.getTime();
  const week = Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Current hour in Moscow (0-23) */
export function moscowHour(): number {
  return moscowNow().getHours();
}

/** Day of week in Moscow: 0=Sun, 1=Mon … 6=Sat (JS convention) */
export function dayOfWeekMsk(): number {
  return moscowNow().getDay();
}

/** YYYY-MM-DD of the next Monday in MSK (or today if today is Monday) */
export function nextMondayMsk(): string {
  const d = moscowNow();
  const day = d.getDay(); // 0=Sun … 6=Sat
  const daysUntilMon = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  d.setDate(d.getDate() + daysUntilMon);
  return formatDate(d);
}

/** YYYY-MM-DD of this week's Monday in MSK (current or past Monday) */
export function thisMondayMsk(): string {
  const d = moscowNow();
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  return formatDate(d);
}

/** Yesterday's date in Moscow as YYYY-MM-DD */
export function yesterdayMsk(): string {
  const d = moscowNow();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

/** Difference in days: b - a (positive if b is later) */
export function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** Add N days to a YYYY-MM-DD string, returns YYYY-MM-DD */
export function addDaysMsk(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
