import { describe, it, expect } from 'vitest';

// We test the internal helpers by importing the module and calling rewriteTitle
// Since googleTranslate is a network call, we only test non-Latin (Russian) titles
// that skip translation, and the cleaning logic.

// Import the module — rewriteTitle is the public API
import { rewriteTitle, formatChannelName } from '../translate';

describe('rewriteTitle', () => {
  it('converts ALL CAPS to sentence case', async () => {
    const result = await rewriteTitle('УТРЕННЯЯ РАСТЯЖКА НА 15 МИНУТ');
    expect(result).not.toMatch(/^[А-ЯЁ\s\d]+$/);
    expect(result.charAt(0)).toMatch(/[А-ЯЁ]/);
  });

  it('preserves short abbreviations like HIIT, TRX', async () => {
    const result = await rewriteTitle('HIIT тренировка на 20 минут');
    expect(result).toContain('HIIT');
  });

  it('strips excessive exclamation marks', async () => {
    const result = await rewriteTitle('Отличная тренировка!!!');
    expect(result).not.toContain('!!!');
  });

  it('strips hashtags', async () => {
    const result = await rewriteTitle('Растяжка #fitness #yoga');
    expect(result).not.toContain('#');
  });

  it('replaces pipes with dashes', async () => {
    const result = await rewriteTitle('Йога | 30 минут | для начинающих');
    expect(result).not.toContain('|');
  });

  it('strips hype words in Russian', async () => {
    const result = await rewriteTitle('Невероятная тренировка для тела');
    expect(result.toLowerCase()).not.toContain('невероятн');
  });

  it('escapes Markdown special chars', async () => {
    const result = await rewriteTitle('Тренировка *силовая* для [начинающих]');
    expect(result).toContain('\\*');
    expect(result).toContain('\\[');
  });

  it('handles empty string', async () => {
    const result = await rewriteTitle('');
    expect(result).toBe('');
  });

  it('lowercases individual CAPS words in mixed text', async () => {
    const result = await rewriteTitle('8 упражнений которые должен делать КАЖДЫЙ');
    expect(result).not.toContain('КАЖДЫЙ');
    expect(result).toContain('каждый');
  });

  it('preserves short abbreviations in mixed text', async () => {
    const result = await rewriteTitle('Лучшая HIIT тренировка');
    expect(result).toContain('HIIT');
  });
});

describe('formatChannelName', () => {
  it('escapes Markdown in Russian channel names', async () => {
    const result = await formatChannelName('Йога *дома*');
    expect(result).toContain('\\*');
  });

  it('cleans CAPS in channel names', async () => {
    const result = await formatChannelName('ПРЕДСТАВЬТЕ фитнес');
    expect(result).not.toMatch(/^ПРЕДСТАВЬТЕ/);
    expect(result.toLowerCase()).toContain('представьте');
  });
});
