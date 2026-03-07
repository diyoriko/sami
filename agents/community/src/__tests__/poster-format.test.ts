import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const srcDir = path.join(__dirname, '..');

function readSrc(filename: string): string {
  return fs.readFileSync(path.join(srcDir, filename), 'utf8');
}

describe('post format vision compliance', () => {
  const posterSource = readSrc('poster.ts');

  it('caption has no hashtags', () => {
    expect(posterSource).not.toContain('#stretching');
    expect(posterSource).not.toContain('#сила');
    expect(posterSource).not.toContain('#стретчинг');
  });

  it('uses monospace backtick tags with emojis', () => {
    expect(posterSource).toContain('`${tagParts.join');
    expect(posterSource).toMatch(/🏷/);
    expect(posterSource).toMatch(/⏱/);
    expect(posterSource).toMatch(/💪/);
    expect(posterSource).toMatch(/📊/);
    expect(posterSource).toMatch(/🎒/);
  });

  it('has rating display with star', () => {
    expect(posterSource).toContain('★');
    expect(posterSource).toContain('ratingStr');
  });

  it('button text is "Я сделал(а)"', () => {
    expect(posterSource).toContain("'Я сделал(а)'");
  });

  it('has YouTube link labeled "оригинал"', () => {
    expect(posterSource).toContain('оригинал');
    expect(posterSource).toContain('video.video_url');
  });

  it('disables link preview for text fallback posts', () => {
    expect(posterSource).toContain('link_preview_options');
    expect(posterSource).toContain('is_disabled: true');
  });

  it('does NOT use link_preview_options on sendVideo', () => {
    const sendVideoBlock = posterSource.slice(
      posterSource.indexOf('sendVideo'),
      posterSource.indexOf('download.cleanup()')
    );
    expect(sendVideoBlock).not.toContain('link_preview_options');
  });
});

describe('moderation done button', () => {
  const modSource = readSrc('moderation.ts');

  it('handles done callback pattern', () => {
    expect(modSource).toContain("done:(\\d+)");
    expect(modSource).toContain('Я сделал(а) · ${count}');
    expect(modSource).toContain('hasUserCompleted');
  });
});

describe('content curator removed', () => {
  it('no curator references in scheduler', () => {
    const schedulerSource = readSrc('scheduler.ts');
    expect(schedulerSource).not.toContain('curator');
    expect(schedulerSource).not.toContain('content-curator');
  });

  it('no curator command in index startup message', () => {
    const indexSource = readSrc('index.ts');
    expect(indexSource).not.toContain('/curator');
  });
});

describe('analytics', () => {
  const analyticsSource = readSrc('analytics.ts');

  it('reports completion metrics', () => {
    expect(analyticsSource).toContain('completions_today');
    expect(analyticsSource).toContain('completion_users');
    expect(analyticsSource).toContain('getCompletionCountForDate');
  });

  it('has no checkin references', () => {
    expect(analyticsSource).not.toContain('checkin_did');
    expect(analyticsSource).not.toContain('getCheckinStats');
  });
});
