/**
 * Story image generator for Telegram channel stories.
 *
 * Generates a 1080×1920 PNG from post data using @napi-rs/canvas (Skia).
 * No dependency on system fontconfig — fonts registered directly via Skia.
 *
 * Flow: after posting to channel → generateStory() → send image to admin DM.
 */

import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import { type Category, type Difficulty, CATEGORY_RU, DIFFICULTY_RU, EQUIPMENT_NO_GEAR } from './shared';
import { createLogger } from './logger';

const log = createLogger('story');

const W = 1080;
const H = 1920;
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

// ── Register fonts once ─────────────────────────────────────────────────────

let _fontsRegistered = false;

function registerFonts(): void {
  if (_fontsRegistered) return;
  _fontsRegistered = true;
  try {
    const bold = path.join(ASSETS_DIR, 'OceanicGrotesk-Bold.otf');
    const reg = path.join(ASSETS_DIR, 'OceanicGrotesk-Regular.otf');
    if (fs.existsSync(bold)) GlobalFonts.registerFromPath(bold, 'Oceanic');
    if (fs.existsSync(reg)) GlobalFonts.registerFromPath(reg, 'OceanicReg');
    log.info('fonts registered via Skia');
  } catch (err) {
    log.warn('font registration failed', { error: String(err) });
  }
}

// ── Text helpers ────────────────────────────────────────────────────────────

/** Word-wrap using actual canvas measureText, with orphan prevention */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  // Fix orphans: if a line is very short (≤ 3 chars), merge with previous line
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length <= 3 && lines[i - 1]) {
      const merged = `${lines[i - 1]} ${lines[i]}`;
      // Only merge if it fits, otherwise leave as-is
      // Be generous for short orphans (single prepositions like "о", "в", "с")
      const tolerance = lines[i].length <= 2 ? 1.2 : 1.05;
      if (ctx.measureText(merged).width <= maxWidth * tolerance) {
        lines[i - 1] = merged;
        lines.splice(i, 1);
        i--;
      }
    }
  }

  return lines;
}

/** Find font size where the longest word fits within maxWidth */
function fitTitleSize(ctx: SKRSContext2D, text: string, maxWidth: number, maxSize: number, minSize: number): number {
  const longestWord = text.split(' ').reduce((a, b) => a.length > b.length ? a : b, '');
  for (let size = maxSize; size >= minSize; size -= 4) {
    ctx.font = `bold ${size}px Oceanic, sans-serif`;
    if (ctx.measureText(longestWord).width <= maxWidth) return size;
  }
  return minSize;
}

// ── Main generator ──────────────────────────────────────────────────────────

export interface StoryData {
  title: string;
  category: Category;
  durationLabel: string;
  difficulty: Difficulty;
  equipment?: string[];
  rawTitle?: string;
  thumbnailUrl?: string;
}

export async function generateStory(data: StoryData): Promise<Buffer> {
  registerFonts();

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const categoryRu = (CATEGORY_RU[data.category] ?? data.category).toUpperCase();
  const difficultyRu = DIFFICULTY_RU[data.difficulty] ?? data.difficulty;
  const gear = data.equipment && data.equipment.length > 0
    ? data.equipment.join(', ')
    : EQUIPMENT_NO_GEAR;

  // ── Background ──
  ctx.fillStyle = '#0A0A0A';
  ctx.fillRect(0, 0, W, H);

  // ── Geometric accents ──
  ctx.strokeStyle = '#1A1A1A';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(W + 25, 75, 325, 325, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(50, H - 100, 450, 350, 0, 0, Math.PI * 2);
  ctx.stroke();

  // ── Category tag ──
  ctx.font = '52px OceanicReg, sans-serif';
  ctx.fillStyle = '#666666';
  ctx.fillText(categoryRu, 90, 270);

  // ── Title (Oceanic Bold, auto-sized, max 3 lines) ──
  const maxWidth = W - 180;
  const titleSize = fitTitleSize(ctx, data.title, maxWidth, 120, 64);
  ctx.font = `bold ${titleSize}px Oceanic, sans-serif`;
  const allTitleLines = wrapText(ctx, data.title, maxWidth);
  let titleLines = allTitleLines;
  if (allTitleLines.length > 3) {
    titleLines = allTitleLines.slice(0, 3);
    // Add ellipsis to last line if truncated
    titleLines[2] = titleLines[2].replace(/\s+\S*$/, '') + '...';
  }
  const lineHeight = Math.round(titleSize * 1.08);

  ctx.fillStyle = '#FAFAFA';
  const titleY = 420;
  for (let i = 0; i < titleLines.length; i++) {
    ctx.fillText(titleLines[i], 90, titleY + i * lineHeight);
  }

  // ── Meta rows ──
  const metaY = titleY + titleLines.length * lineHeight + 60;
  const valX = 470;
  const rowH = 64;
  // Replace : with . — Oceanic TRIAL font is missing the colon glyph
  const duration = (data.durationLabel || '—').replace(/:/g, '.');
  const meta = [
    ['ВРЕМЯ', duration],
    ['УРОВЕНЬ', difficultyRu],
    ['ИНВЕНТАРЬ', gear],
  ];

  for (let i = 0; i < meta.length; i++) {
    const y = metaY + i * rowH;
    ctx.font = '44px OceanicReg, sans-serif';
    ctx.fillStyle = '#555555';
    ctx.fillText(meta[i][0], 90, y);

    ctx.font = 'bold 44px Oceanic, sans-serif';
    ctx.fillStyle = '#BBBBBB';
    ctx.fillText(meta[i][1], valX, y);
  }

  // ── Thumbnail (small rounded rectangle after meta) ──
  if (data.thumbnailUrl) {
    try {
      const { loadImage } = await import('@napi-rs/canvas');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(data.thumbnailUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const thumb = await loadImage(buf);
        const thumbW = 400;
        const thumbH = Math.round(thumbW * 9 / 16); // 16:9 aspect
        const thumbX = 90;
        const thumbY = metaY + meta.length * rowH + 40;
        const radius = 16;

        // Clip to rounded rect
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(thumbX, thumbY, thumbW, thumbH, radius);
        ctx.clip();

        // Draw thumbnail scaled to fill
        const scale = Math.max(thumbW / thumb.width, thumbH / thumb.height);
        const tw = thumb.width * scale;
        const th = thumb.height * scale;
        const tx = thumbX + (thumbW - tw) / 2;
        const ty = thumbY + (thumbH - th) / 2;
        ctx.drawImage(thumb, tx, ty, tw, th);
        ctx.restore();

        // Border
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(thumbX, thumbY, thumbW, thumbH, radius);
        ctx.stroke();
      }
    } catch {
      // Thumbnail fetch failed — skip silently
    }
  }

  // ── Logo (invert to white via offscreen canvas) ──
  try {
    const logoPath = path.join(ASSETS_DIR, 'logo.png');
    if (fs.existsSync(logoPath)) {
      const { loadImage } = await import('@napi-rs/canvas');
      const logo = await loadImage(logoPath);
      const lh = 200;
      const lw = Math.round(logo.width * lh / logo.height);

      // Draw logo on offscreen canvas and invert colors
      const offscreen = createCanvas(lw, lh);
      const offCtx = offscreen.getContext('2d');
      offCtx.drawImage(logo, 0, 0, lw, lh);
      const imgData = offCtx.getImageData(0, 0, lw, lh);
      const d = imgData.data;
      for (let p = 0; p < d.length; p += 4) {
        d[p] = 255 - d[p];       // R
        d[p + 1] = 255 - d[p + 1]; // G
        d[p + 2] = 255 - d[p + 2]; // B
        // alpha stays
      }
      offCtx.putImageData(imgData, 0, 0);

      const lx = Math.round((W - lw) / 2);
      const ly = H - 340;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(offscreen, lx, ly);
      ctx.globalAlpha = 1.0;
    }
  } catch (err) {
    log.warn('logo composite failed', { error: String(err) });
  }

  return Buffer.from(canvas.toBuffer('image/png'));
}

// ── Send story to admin ─────────────────────────────────────────────────────

import { Bot, InputFile } from 'grammy';
import { getConfig } from './config';

export async function sendStoryToAdmin(bot: Bot, data: StoryData, postMessageId?: number): Promise<void> {
  try {
    const config = getConfig();
    const buf = await generateStory(data);
    const channelId = config.TELEGRAM_CHANNEL_ID.toString().replace('-100', '');
    const postLink = postMessageId
      ? `https://t.me/sami_workouts/${postMessageId}`
      : '';
    const caption = postLink
      ? `📸 Сторис готова — пости в канал\n\n🔗 ${postLink}`
      : '📸 Сторис готова — пости в канал';
    await bot.api.sendPhoto(
      config.TELEGRAM_ADMIN_USER_ID,
      new InputFile(buf, 'story.png'),
      { caption },
    );
    log.info('story sent to admin', { title: data.title, category: data.category });
  } catch (err) {
    log.error('failed to generate/send story', { error: String(err) });
  }
}
