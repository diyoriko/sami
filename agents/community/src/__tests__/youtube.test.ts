import { describe, it, expect, vi } from 'vitest';

// Mock config to avoid process.exit in CI (no env vars)
vi.mock('../config', () => ({
  getConfig: () => ({
    SCORE_BRAND_WEIGHT: 0.5,
    SCORE_VIEW_WEIGHT: 0.35,
    SCORE_DURATION_WEIGHT: 0.15,
    VIDEO_PENALTY_CAP: 60,
    VIDEO_MIN_DURATION: 240,
    VIDEO_IDEAL_MIN: 480,
    VIDEO_IDEAL_MAX: 1200,
    VIDEO_MAX_DURATION: 1800,
  }),
}));

import { computeTotalScore, detectEquipment } from '../youtube';
import { extractYoutubeId } from '../bot-menu';

// ─── extractYoutubeId ────────────────────────────────────────────────────────

describe('extractYoutubeId', () => {
  it('extracts from standard watch URL', () => {
    expect(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from watch URL with extra params', () => {
    expect(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120&list=PLx')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from short youtu.be URL', () => {
    expect(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from youtu.be with params', () => {
    expect(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ?t=30')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from Shorts URL', () => {
    expect(extractYoutubeId('https://www.youtube.com/shorts/abc123def45')).toBe('abc123def45');
  });

  it('extracts from URL without www', () => {
    expect(extractYoutubeId('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from URL with http', () => {
    expect(extractYoutubeId('http://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('handles IDs with hyphens and underscores', () => {
    expect(extractYoutubeId('https://youtu.be/a-B_c1D2e3f')).toBe('a-B_c1D2e3f');
  });

  it('returns null for non-YouTube URL', () => {
    expect(extractYoutubeId('https://vimeo.com/123456')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractYoutubeId('')).toBeNull();
  });

  it('returns null for random text', () => {
    expect(extractYoutubeId('just some text')).toBeNull();
  });

  it('returns null for YouTube URL without video ID', () => {
    expect(extractYoutubeId('https://www.youtube.com/channel/UCxyz')).toBeNull();
  });

  it('extracts from URL embedded in text', () => {
    expect(extractYoutubeId('check this https://youtu.be/dQw4w9WgXcQ cool!')).toBe('dQw4w9WgXcQ');
  });
});

// ─── computeTotalScore ───────────────────────────────────────────────────────

describe('computeTotalScore', () => {
  it('returns weighted sum of three scores', () => {
    // Default weights: brand=0.5, view=0.3, duration=0.2 (from config)
    const result = computeTotalScore(100, 100, 100);
    expect(result).toBe(100);
  });

  it('returns 0 for all zeros', () => {
    expect(computeTotalScore(0, 0, 0)).toBe(0);
  });

  it('rounds to integer', () => {
    const result = computeTotalScore(33, 33, 33);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('brand score has highest weight', () => {
    const highBrand = computeTotalScore(100, 0, 0);
    const highView = computeTotalScore(0, 100, 0);
    const highDuration = computeTotalScore(0, 0, 100);
    expect(highBrand).toBeGreaterThan(highView);
    expect(highView).toBeGreaterThanOrEqual(highDuration);
  });
});

// ─── detectEquipment ─────────────────────────────────────────────────────────

describe('detectEquipment', () => {
  it('returns empty array for bodyweight title', () => {
    expect(detectEquipment('Утренняя растяжка без инвентаря', '')).toEqual([]);
  });

  it('detects гантели (dumbbells)', () => {
    const result = detectEquipment('Тренировка с гантели дома', '');
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(e => /гантел/i.test(e))).toBe(true);
  });

  it('detects dumbbell in English title', () => {
    const result = detectEquipment('Full body dumbbell workout', '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects resistance band', () => {
    const result = detectEquipment('Workout with resistance band', '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects резинка (resistance band in Russian)', () => {
    const result = detectEquipment('Тренировка с резинкой', '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects скакалка (jump rope)', () => {
    const result = detectEquipment('Jump rope HIIT workout скакалка', '');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects equipment from description too', () => {
    const result = detectEquipment('Simple workout', 'You will need a dumbbell');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects multiple equipment', () => {
    const result = detectEquipment('Dumbbell and resistance band workout', '');
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('is case insensitive', () => {
    const lower = detectEquipment('dumbbell workout', '');
    const upper = detectEquipment('DUMBBELL WORKOUT', '');
    expect(lower).toEqual(upper);
  });
});
