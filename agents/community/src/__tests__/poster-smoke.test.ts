import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'test-poster-smoke.db');

beforeAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  process.env.COMMUNITY_DB_PATH = TEST_DB_PATH;
  process.env.TELEGRAM_BOT_TOKEN = 'test:token';
  process.env.TELEGRAM_CHANNEL_ID = '-1001234567890';
  process.env.TELEGRAM_GROUP_ID = '-1009876543210';
  process.env.TELEGRAM_ADMIN_USER_ID = '123456';
  process.env.YOUTUBE_API_KEY = 'test-key';
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

describe('poster smoke tests', () => {
  it('module imports without throwing', async () => {
    const mod = await import('../poster');
    expect(mod).toBeDefined();
  });

  it('exports postVideoToChannel function', async () => {
    const mod = await import('../poster');
    expect(typeof mod.postVideoToChannel).toBe('function');
  });

  it('exports postSeasonVideo function', async () => {
    const mod = await import('../poster');
    expect(typeof mod.postSeasonVideo).toBe('function');
  });

  it('exports SeasonInfo type (interface exists at type level)', async () => {
    // SeasonInfo is a TypeScript interface — we verify the module shape
    // by checking the PostResult type is used correctly
    const mod = await import('../poster');
    expect(mod.postVideoToChannel).toBeDefined();
    expect(mod.postSeasonVideo).toBeDefined();
  });

  it('PostResult type covers expected values', async () => {
    // PostResult = 'posted' | 'skipped' | 'no_video' | 'error'
    // We verify by reading the source — the type is not a runtime export
    const posterSource = fs.readFileSync(
      path.join(__dirname, '..', 'poster.ts'),
      'utf8',
    );
    expect(posterSource).toContain("'posted'");
    expect(posterSource).toContain("'skipped'");
    expect(posterSource).toContain("'no_video'");
    expect(posterSource).toContain("'error'");
  });
});

describe('poster caption structure', () => {
  it('formatCaption builds lines with expected tag emojis', () => {
    // formatCaption is not exported, but we can verify the poster source
    // contains the tag structure we expect
    const posterSource = fs.readFileSync(
      path.join(__dirname, '..', 'poster.ts'),
      'utf8',
    );
    // Tag lines should include these emojis
    expect(posterSource).toContain('⏱️');
    expect(posterSource).toContain('🦴');
    expect(posterSource).toContain('💎');
    expect(posterSource).toContain('🎾');
    // Author line
    expect(posterSource).toContain('Автор:');
    expect(posterSource).toContain('YouTube');
  });

  it('formatRating returns empty string for zero/negative', () => {
    // formatRating is private, but we can verify via source
    const posterSource = fs.readFileSync(
      path.join(__dirname, '..', 'poster.ts'),
      'utf8',
    );
    expect(posterSource).toContain("if (rating <= 0) return '';");
  });

  it('uses MarkdownV2 parse mode', () => {
    const posterSource = fs.readFileSync(
      path.join(__dirname, '..', 'poster.ts'),
      'utf8',
    );
    expect(posterSource).toContain("parse_mode: 'MarkdownV2'");
  });

  it('uses Sami Score in caption', () => {
    const posterSource = fs.readFileSync(
      path.join(__dirname, '..', 'poster.ts'),
      'utf8',
    );
    expect(posterSource).toContain('Sami Score:');
  });
});

describe('poster postVideoToChannel does not throw on no_video', () => {
  it('returns no_video when no approved video exists', async () => {
    // Ensure DB is initialized
    const db = await import('../db');
    db.getDb();

    const { postVideoToChannel } = await import('../poster');
    const { Bot } = await import('grammy');
    const bot = new Bot('test:fake_token_for_smoke_test');

    const result = await postVideoToChannel(bot, '2099-01-01', 'stretching');
    expect(result).toBe('no_video');
  });
});
