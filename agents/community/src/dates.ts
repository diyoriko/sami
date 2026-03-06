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
