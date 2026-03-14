/**
 * Moderation behavior tests: spam detection, captcha generation.
 */
import { describe, it, expect } from 'vitest';
import { isSpam, generateCaptcha } from '../moderation';

describe('isSpam', () => {
  const spamTexts = [
    'Check https://scam.com for free stuff',
    'Заработок в интернете без вложений',
    'Crypto trading signals FREE',
    'Подпишись на мой канал t.me/spamchannel',
    'Casino online 24/7',
    'Passive income from home',
    'Пассивный доход без усилий',
    'Join our MLM network marketing',
    'Сетевой маркетинг, зарабатывай с нами',
    '18+ dating site, знакомства',
    'OnlyFans link in bio',
    'Forex trading binance invest',
    'Ставки на спорт betting',
    'Телеграм канал с сигналами',
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
  ];

  it.each(spamTexts)('detects spam: "%s"', (text) => {
    expect(isSpam(text)).toBe(true);
  });

  it.each(cleanTexts)('allows clean text: "%s"', (text) => {
    expect(isSpam(text)).toBe(false);
  });
});

describe('generateCaptcha', () => {
  it('produces correct answer for math question', () => {
    for (let i = 0; i < 20; i++) {
      const { question, answer, options } = generateCaptcha();
      const [a, b] = question.split(' + ').map(Number);
      expect(a + b).toBe(answer);
    }
  });

  it('has exactly 4 options including the answer', () => {
    for (let i = 0; i < 10; i++) {
      const { answer, options } = generateCaptcha();
      expect(options).toHaveLength(4);
      expect(options).toContain(answer);
    }
  });

  it('all options are unique', () => {
    for (let i = 0; i < 10; i++) {
      const { options } = generateCaptcha();
      expect(new Set(options).size).toBe(4);
    }
  });

  it('answer is between 2 and 18', () => {
    for (let i = 0; i < 50; i++) {
      const { answer } = generateCaptcha();
      expect(answer).toBeGreaterThanOrEqual(2);
      expect(answer).toBeLessThanOrEqual(18);
    }
  });
});
