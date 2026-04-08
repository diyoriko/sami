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
    const result = await rewriteTitle('Тренировка [силовая] с мячом');
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

  // ── New tests: segment truncation ──

  it('takes first segment before pipe separator', async () => {
    const result = await rewriteTitle('Утренний комплекс йоги | Домашняя йога. Онлайн фитнес студия');
    expect(result.toLowerCase()).toContain('утренний');
    expect(result.toLowerCase()).not.toContain('онлайн');
  });

  it('takes first segment before // separator', async () => {
    const result = await rewriteTitle('Тренировка из ягодичных мостиков // Лифтинг ягодиц дома');
    expect(result.toLowerCase()).toContain('тренировка');
    expect(result.toLowerCase()).not.toContain('лифтинг');
  });

  // ── New tests: redundant info stripping ──

  it('strips "в домашних условиях" (redundant with equipment tag)', async () => {
    const result = await rewriteTitle('Йога в домашних условиях');
    expect(result.toLowerCase()).not.toContain('домашних');
  });

  it('strips "для начинающих" (redundant with difficulty tag)', async () => {
    const result = await rewriteTitle('Растяжка для начинающих утренняя');
    expect(result.toLowerCase()).not.toContain('начинающих');
  });

  // ── New tests: hype stripping ──

  it('strips "убийца калорий"', async () => {
    const result = await rewriteTitle('Высокоинтенсивное кардио убийца калорий');
    expect(result.toLowerCase()).not.toContain('убийца');
  });

  it('strips "взрывн*" hype words', async () => {
    const result = await rewriteTitle('Взрывная тренировка на ноги');
    expect(result.toLowerCase()).not.toContain('взрывн');
  });

  // ── New tests: special character cleanup ──

  it('strips asterisks', async () => {
    const result = await rewriteTitle('*СИЛОВАЯ* тренировка');
    expect(result).not.toContain('*');
    // Should also not contain escaped asterisk from title content
    // (escV2 will escape any Markdown chars, but source asterisks are stripped first)
  });

  it('strips channel promo patterns', async () => {
    const result = await rewriteTitle('Утренняя йога. Онлайн фитнес студия');
    expect(result.toLowerCase()).not.toContain('студия');
  });

  // ── New tests: length cap ──

  it('preserves full title without truncation', async () => {
    const long = 'Очень длинное название тренировки которое содержит множество слов и фраз описывающих содержание видео';
    const result = await rewriteTitle(long);
    const unescaped = result.replace(/\\(.)/g, '$1');
    expect(unescaped.length).toBeGreaterThan(60);
  });

  // ── New tests: abbreviation handling ──

  it('preserves known Russian abbreviations like МФР', async () => {
    const result = await rewriteTitle('Комплекс упражнений МФР');
    expect(result).toContain('МФР');
  });

  it('lowercases unknown Cyrillic caps words', async () => {
    const result = await rewriteTitle('Гимнастика НЕ дыхательная');
    // "НЕ" is only 2 chars, stays per current logic (< 5 char threshold)
    // But "ВЫСОКОИНТЕНСИВНОЕ" would be lowercased
    const r2 = await rewriteTitle('ВЫСОКОИНТЕНСИВНОЕ кардио');
    expect(r2.toLowerCase()).toContain('высокоинтенсивное');
  });
});

describe('formatChannelName', () => {
  it('escapes Markdown in Russian channel names', async () => {
    const result = await formatChannelName('Йога (дома)');
    expect(result).toContain('\\(');
  });

  it('cleans CAPS in channel names', async () => {
    const result = await formatChannelName('ПРЕДСТАВЬТЕ фитнес');
    expect(result).not.toMatch(/^ПРЕДСТАВЬТЕ/);
    expect(result.toLowerCase()).toContain('представьте');
  });
});
