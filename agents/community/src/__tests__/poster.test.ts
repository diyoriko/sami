import { describe, it, expect, vi } from 'vitest';

// Mock translate module (network calls)
vi.mock('../translate', () => ({
  rewriteTitle: vi.fn(async (t: string) => t),
  formatChannelName: vi.fn(async (n: string) => n),
}));

import { formatCaption } from '../poster';
import type { VideoRow } from '../db';

function makeVideo(overrides: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 1,
    youtube_id: 'abc123',
    title: 'Утренняя растяжка для начинающих',
    display_title: null,
    channel_name: 'FitChannel',
    video_url: 'https://www.youtube.com/watch?v=abc123',
    category: 'stretching',
    difficulty: 'beginner',
    duration_label: '12:30',
    duration_seconds: 750,
    muscles: 'спина, плечи',
    rating: 8.5,
    search_query: 'утренняя растяжка',
    ...overrides,
  } as VideoRow;
}

describe('formatCaption', () => {
  it('includes title in bold', async () => {
    const result = await formatCaption(makeVideo());
    expect(result).toContain('*Утренняя растяжка для начинающих*');
  });

  it('includes category tag', async () => {
    const result = await formatCaption(makeVideo());
    expect(result).toContain('стретчинг');
  });

  it('includes duration tag', async () => {
    const result = await formatCaption(makeVideo());
    expect(result).toContain('12:30');
  });

  it('includes difficulty tag', async () => {
    const result = await formatCaption(makeVideo());
    expect(result).toContain('начинающий');
  });

  it('includes muscles tag', async () => {
    const result = await formatCaption(makeVideo());
    expect(result).toContain('спина');
  });

  it('includes YouTube link', async () => {
    const result = await formatCaption(makeVideo());
    expect(result).toContain('[YouTube]');
    expect(result).toContain('youtube.com/watch');
  });

  it('includes author', async () => {
    const result = await formatCaption(makeVideo());
    expect(result).toContain('Автор: FitChannel');
  });

  it('shows Sami Score when rating > 0', async () => {
    const result = await formatCaption(makeVideo({ rating: 8.5 }));
    expect(result).toContain('Sami Score: 85%');
    expect(result).toContain('качество и популярность');
  });

  it('hides Sami Score when rating = 0', async () => {
    const result = await formatCaption(makeVideo({ rating: 0 }));
    expect(result).not.toContain('Sami Score');
  });

  it('escapes ) and \\ in URL', async () => {
    const result = await formatCaption(makeVideo({
      video_url: 'https://youtube.com/watch?v=abc(123)test',
    }));
    // Only ) and \ are escaped for MarkdownV2 link syntax
    expect(result).toContain('abc(123\\)test');
  });

  it('overrideCategory replaces video category', async () => {
    const result = await formatCaption(makeVideo({ category: 'stretching' }), undefined, undefined, 'cardio' as any);
    expect(result).toContain('кардио');
    expect(result).not.toContain('стретчинг');
  });

  it('includes series header when seriesInfo provided', async () => {
    const result = await formatCaption(makeVideo(), undefined, {
      name: 'Утренний марафон',
      dayNumber: 3,
      totalDays: 7,
      participants: 5,
    });
    expect(result).toContain('Утренний марафон');
    expect(result).toContain('День 3/7');
    expect(result).toContain('5 участников');
  });

  it('pluralizes participants correctly', async () => {
    const r1 = await formatCaption(makeVideo(), undefined, { name: 'T', dayNumber: 1, totalDays: 7, participants: 1 });
    expect(r1).toContain('1 участник\n');

    const r2 = await formatCaption(makeVideo(), undefined, { name: 'T', dayNumber: 1, totalDays: 7, participants: 3 });
    expect(r2).toContain('3 участника');

    const r5 = await formatCaption(makeVideo(), undefined, { name: 'T', dayNumber: 1, totalDays: 7, participants: 10 });
    expect(r5).toContain('10 участников');
  });

  it('uses tag lines in backticks', async () => {
    const result = await formatCaption(makeVideo());
    const backtickLines = result.split('\n').filter(l => l.startsWith('`') && l.endsWith('`'));
    expect(backtickLines.length).toBeGreaterThanOrEqual(5); // category, duration, muscles, difficulty, equipment
  });

  it('shows "Без инвентаря" for bodyweight video', async () => {
    const result = await formatCaption(makeVideo({ title: 'Простая растяжка дома' }));
    expect(result).toMatch(/[Бб]ез инвентаря/);
  });

  it('uses display_title when set', async () => {
    const result = await formatCaption(makeVideo({ display_title: 'Мой заголовок' }));
    expect(result).toContain('Мой заголовок');
  });

  it('falls back to rewriteTitle when display_title is null', async () => {
    const result = await formatCaption(makeVideo({ display_title: null }));
    // rewriteTitle mock returns title as-is
    expect(result).toContain('Утренняя растяжка для начинающих');
  });
});
