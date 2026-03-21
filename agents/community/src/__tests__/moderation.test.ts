/**
 * Moderation behavior tests: spam detection, captcha generation.
 */
import { describe, it, expect } from 'vitest';
import { isSpam, generateCaptcha } from '../moderation';

describe('isSpam', () => {
  const spamTexts = [
    'Заработок в интернете без вложений',
    'Crypto trading signals FREE',
    'Casino online 24/7',
    'Passive income from home',
    'Пассивный доход без усилий',
    'Join our MLM network marketing',
    'Сетевой маркетинг, зарабатывай с нами',
    '18+ dating site, знакомства',
    'OnlyFans link in bio',
    'Forex trading binance invest',
    'Ставки на спорт betting',
  ];

  const cleanTexts = [
    'Привет, как дела?',
    'Отличная тренировка!',
    'Спасибо за видео 🔥',
    'Какая категория лучше для новичка?',
    'https://youtube.com/watch?v=abc123',
    'https://youtu.be/abc123',
    'https://t.me/sami_workouts',
    'Сделаль! Растяжка огонь',
    'Мне нравится силовая по утрам',
    'Могу предложить тренировку',
    // Links are now allowed (moderation relaxed for small community)
    'Check https://example.com for the article',
    'Подпишись на мой канал t.me/coolchannel',
    'Телеграм канал с тренировками',
  ];

  it.each(spamTexts)('detects spam: "%s"', (text) => {
    expect(isSpam(text)).toBe(true);
  });

  it.each(cleanTexts)('allows clean text: "%s"', (text) => {
    expect(isSpam(text)).toBe(false);
  });
});

describe('generateCaptcha', () => {
  it('returns a brand-aligned question', () => {
    const { question } = generateCaptcha();
    expect(typeof question).toBe('string');
    expect(question.length).toBeGreaterThan(5);
  });

  it('has exactly 4 options including the answer', () => {
    for (let i = 0; i < 10; i++) {
      const { answer, options } = generateCaptcha();
      expect(options).toHaveLength(4);
      expect(options.some(o => o.value === answer)).toBe(true);
    }
  });

  it('all option values are unique', () => {
    for (let i = 0; i < 10; i++) {
      const { options } = generateCaptcha();
      const values = options.map(o => o.value);
      expect(new Set(values).size).toBe(4);
    }
  });

  it('options have text labels', () => {
    const { options } = generateCaptcha();
    for (const opt of options) {
      expect(typeof opt.text).toBe('string');
      expect(opt.text.length).toBeGreaterThan(0);
    }
  });
});
