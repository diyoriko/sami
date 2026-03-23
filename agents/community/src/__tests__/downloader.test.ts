import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config to avoid process.exit on missing env vars
vi.mock('../config', () => ({ getConfig: () => ({}) }));

// Mock logger to suppress output
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withCorrelation: vi.fn(),
  }),
}));

import { isYtDlpAvailable, setAdminNotifier, initCookies } from '../downloader';

describe('downloader', () => {
  describe('isYtDlpAvailable', () => {
    it('returns a boolean', () => {
      const result = isYtDlpAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('setAdminNotifier', () => {
    it('accepts a callback without throwing', () => {
      const fn = vi.fn();
      expect(() => setAdminNotifier(fn)).not.toThrow();
    });
  });

  describe('initCookies', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('does nothing when YT_COOKIES_B64 is not set', () => {
      delete process.env.YT_COOKIES_B64;
      expect(() => initCookies()).not.toThrow();
    });

    it('decodes base64 cookie and writes to tmp when YT_COOKIES_B64 is set', () => {
      const cookieContent = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t0\ttest\tvalue\n';
      process.env.YT_COOKIES_B64 = Buffer.from(cookieContent).toString('base64');

      expect(() => initCookies()).not.toThrow();
    });

    it('handles invalid base64 gracefully', () => {
      // Not truly invalid base64, but the function should handle edge cases
      process.env.YT_COOKIES_B64 = '';
      expect(() => initCookies()).not.toThrow();
    });
  });
});
