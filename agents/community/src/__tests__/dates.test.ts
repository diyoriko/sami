import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  todayMsk, tomorrowMsk, yesterdayMsk,
  currentWeekMsk, moscowHour, dayOfWeekMsk,
  nextMondayMsk, thisMondayMsk,
  dateDiffDays, addDaysMsk,
} from '../dates';

// Helper: mock moscowNow by freezing time
function freezeMoscow(isoString: string) {
  // moscowNow() does: new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }))
  // We fake Date so that toLocaleString with Moscow TZ returns our target time.
  // Simplest approach: fake Date constructor to return a fixed UTC time that,
  // when converted to Moscow, gives us the desired date/time.
  // Moscow = UTC+3, so if we want "2026-03-16 10:00 MSK", we set UTC to "2026-03-16 07:00 UTC".
  const target = new Date(isoString);
  vi.useFakeTimers({ now: target });
}

afterEach(() => {
  vi.useRealTimers();
});

// ─── Pure functions (no time dependency) ─────────────────────────────────────

describe('dateDiffDays', () => {
  it('returns 0 for same date', () => {
    expect(dateDiffDays('2026-03-15', '2026-03-15')).toBe(0);
  });

  it('returns positive when b is later', () => {
    expect(dateDiffDays('2026-03-10', '2026-03-15')).toBe(5);
  });

  it('returns negative when b is earlier', () => {
    expect(dateDiffDays('2026-03-15', '2026-03-10')).toBe(-5);
  });

  it('works across month boundaries', () => {
    expect(dateDiffDays('2026-01-30', '2026-02-02')).toBe(3);
  });

  it('works across year boundaries', () => {
    expect(dateDiffDays('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('handles leap year', () => {
    // 2024 is a leap year
    expect(dateDiffDays('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('handles non-leap year', () => {
    expect(dateDiffDays('2025-02-28', '2025-03-01')).toBe(1);
  });
});

describe('addDaysMsk', () => {
  it('adds positive days', () => {
    expect(addDaysMsk('2026-03-15', 3)).toBe('2026-03-18');
  });

  it('adds zero days', () => {
    expect(addDaysMsk('2026-03-15', 0)).toBe('2026-03-15');
  });

  it('subtracts with negative days', () => {
    expect(addDaysMsk('2026-03-15', -5)).toBe('2026-03-10');
  });

  it('crosses month boundary forward', () => {
    expect(addDaysMsk('2026-03-30', 3)).toBe('2026-04-02');
  });

  it('crosses month boundary backward', () => {
    expect(addDaysMsk('2026-04-02', -3)).toBe('2026-03-30');
  });

  it('crosses year boundary', () => {
    expect(addDaysMsk('2025-12-30', 5)).toBe('2026-01-04');
  });

  it('handles 7-day week addition', () => {
    expect(addDaysMsk('2026-03-16', 7)).toBe('2026-03-23');
  });
});

// ─── Time-dependent functions ────────────────────────────────────────────────

describe('todayMsk', () => {
  it('returns YYYY-MM-DD format', () => {
    const result = todayMsk();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns correct date for frozen time', () => {
    // 2026-03-16 07:00 UTC = 2026-03-16 10:00 MSK
    freezeMoscow('2026-03-16T07:00:00Z');
    expect(todayMsk()).toBe('2026-03-16');
  });

  it('handles midnight boundary (23:30 MSK = same day)', () => {
    // 2026-03-16 20:30 UTC = 2026-03-16 23:30 MSK
    freezeMoscow('2026-03-16T20:30:00Z');
    expect(todayMsk()).toBe('2026-03-16');
  });

  it('handles just after midnight MSK (next day)', () => {
    // 2026-03-16 21:30 UTC = 2026-03-17 00:30 MSK
    freezeMoscow('2026-03-16T21:30:00Z');
    expect(todayMsk()).toBe('2026-03-17');
  });
});

describe('tomorrowMsk', () => {
  it('returns day after today', () => {
    freezeMoscow('2026-03-16T07:00:00Z');
    expect(tomorrowMsk()).toBe('2026-03-17');
  });

  it('crosses month boundary', () => {
    freezeMoscow('2026-03-31T07:00:00Z');
    expect(tomorrowMsk()).toBe('2026-04-01');
  });
});

describe('yesterdayMsk', () => {
  it('returns day before today', () => {
    freezeMoscow('2026-03-16T07:00:00Z');
    expect(yesterdayMsk()).toBe('2026-03-15');
  });

  it('crosses month boundary backward', () => {
    freezeMoscow('2026-04-01T07:00:00Z');
    expect(yesterdayMsk()).toBe('2026-03-31');
  });
});

describe('moscowHour', () => {
  it('returns hour in Moscow timezone', () => {
    // 07:00 UTC = 10:00 MSK
    freezeMoscow('2026-03-16T07:00:00Z');
    expect(moscowHour()).toBe(10);
  });

  it('handles wrap-around midnight', () => {
    // 22:00 UTC = 01:00 MSK next day
    freezeMoscow('2026-03-16T22:00:00Z');
    expect(moscowHour()).toBe(1);
  });
});

describe('dayOfWeekMsk', () => {
  it('returns 1 for Monday', () => {
    // 2026-03-16 is Monday
    freezeMoscow('2026-03-16T07:00:00Z');
    expect(dayOfWeekMsk()).toBe(1);
  });

  it('returns 0 for Sunday', () => {
    // 2026-03-15 is Sunday
    freezeMoscow('2026-03-15T07:00:00Z');
    expect(dayOfWeekMsk()).toBe(0);
  });

  it('returns 5 for Friday', () => {
    // 2026-03-20 is Friday
    freezeMoscow('2026-03-20T07:00:00Z');
    expect(dayOfWeekMsk()).toBe(5);
  });
});

describe('currentWeekMsk', () => {
  it('returns YYYY-Wnn format', () => {
    const result = currentWeekMsk();
    expect(result).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('returns consistent week for frozen time', () => {
    freezeMoscow('2026-03-16T07:00:00Z');
    const result = currentWeekMsk();
    expect(result).toMatch(/^2026-W\d{2}$/);
  });
});

describe('thisMondayMsk', () => {
  it('returns same date on Monday', () => {
    // 2026-03-16 is Monday
    freezeMoscow('2026-03-16T07:00:00Z');
    expect(thisMondayMsk()).toBe('2026-03-16');
  });

  it('returns past Monday on Wednesday', () => {
    // 2026-03-18 is Wednesday
    freezeMoscow('2026-03-18T07:00:00Z');
    expect(thisMondayMsk()).toBe('2026-03-16');
  });

  it('returns past Monday on Saturday', () => {
    // 2026-03-21 is Saturday
    freezeMoscow('2026-03-21T07:00:00Z');
    expect(thisMondayMsk()).toBe('2026-03-16');
  });

  it('returns past Monday on Sunday', () => {
    // 2026-03-22 is Sunday
    freezeMoscow('2026-03-22T07:00:00Z');
    expect(thisMondayMsk()).toBe('2026-03-16');
  });

  it('returns this Monday on Friday', () => {
    // 2026-03-20 is Friday
    freezeMoscow('2026-03-20T07:00:00Z');
    expect(thisMondayMsk()).toBe('2026-03-16');
  });
});

describe('nextMondayMsk', () => {
  it('returns same date on Monday', () => {
    // 2026-03-16 is Monday
    freezeMoscow('2026-03-16T07:00:00Z');
    expect(nextMondayMsk()).toBe('2026-03-16');
  });

  it('returns next Monday on Tuesday', () => {
    // 2026-03-17 is Tuesday → next Monday is 2026-03-23
    freezeMoscow('2026-03-17T07:00:00Z');
    expect(nextMondayMsk()).toBe('2026-03-23');
  });

  it('returns next Monday on Sunday', () => {
    // 2026-03-22 is Sunday → next Monday is 2026-03-23
    freezeMoscow('2026-03-22T07:00:00Z');
    expect(nextMondayMsk()).toBe('2026-03-23');
  });

  it('returns next Monday on Saturday', () => {
    // 2026-03-21 is Saturday → next Monday is 2026-03-23
    freezeMoscow('2026-03-21T07:00:00Z');
    expect(nextMondayMsk()).toBe('2026-03-23');
  });

  it('returns next Monday on Friday', () => {
    // 2026-03-20 is Friday → next Monday is 2026-03-23
    freezeMoscow('2026-03-20T07:00:00Z');
    expect(nextMondayMsk()).toBe('2026-03-23');
  });

  it('crosses month boundary', () => {
    // 2026-03-31 is Tuesday → next Monday is 2026-04-06
    freezeMoscow('2026-03-31T07:00:00Z');
    expect(nextMondayMsk()).toBe('2026-04-06');
  });
});
