/**
 * Story image generator for Telegram channel stories.
 *
 * Generates a 1080×1920 PNG from post data (title, category, duration, difficulty, equipment).
 * Uses sharp with SVG overlay + embedded Oceanic Grotesk font.
 *
 * Flow: after posting to channel → generateStory() → send image to admin DM.
 */

import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { type Category, type Difficulty, CATEGORY_RU, DIFFICULTY_RU, EQUIPMENT_NO_GEAR } from './shared';
import { detectEquipment } from './youtube';
import { createLogger } from './logger';

const log = createLogger('story');

const W = 1080;
const H = 1920;

// ── Install fonts to system for librsvg (fontconfig) ────────────────────────

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

/** Copy OTF fonts to ~/.fonts/ so librsvg can find them via fontconfig */
function ensureFontsInstalled(): void {
  try {
    const fontsDir = path.join(process.env.HOME || '/root', '.fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    let copied = false;
    for (const font of ['OceanicGrotesk-Bold.otf', 'OceanicGrotesk-Regular.otf']) {
      const src = path.join(ASSETS_DIR, font);
      const dst = path.join(fontsDir, font);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        copied = true;
      }
    }
    if (copied) {
      require('child_process').execSync('fc-cache -f 2>/dev/null || true');
      log.info('fonts installed to ~/.fonts/');
    }
  } catch (err) {
    log.warn('failed to install fonts', { error: String(err) });
  }
}

let _fontsReady = false;
function fontsReady(): void {
  if (!_fontsReady) { ensureFontsInstalled(); _fontsReady = true; }
}

// Font family name from OTF metadata (fc-query shows "Oceanic Grotesk TRIAL")
const FONT_TITLE = "'Oceanic Grotesk TRIAL', 'Helvetica Neue', Arial, sans-serif";
const FONT_MONO = "'SF Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace";

// ── SVG helpers ─────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Word-wrap text to fit within maxWidth (approximate, assumes ~0.55em per char for bold) */
function wrapTitle(text: string, fontSize: number, maxWidth: number): string[] {
  const charWidth = fontSize * 0.55;
  const maxChars = Math.floor(maxWidth / charWidth);
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Main generator ──────────────────────────────────────────────────────────

export interface StoryData {
  title: string;
  category: Category;
  durationLabel: string;
  difficulty: Difficulty;
  equipment?: string[];
  rawTitle?: string; // original YouTube title for equipment detection
}

export async function generateStory(data: StoryData): Promise<Buffer> {
  fontsReady();

  const categoryRu = (CATEGORY_RU[data.category] ?? data.category).toUpperCase();
  const difficultyRu = DIFFICULTY_RU[data.difficulty] ?? data.difficulty;
  const gear = data.equipment && data.equipment.length > 0
    ? data.equipment.join(', ')
    : EQUIPMENT_NO_GEAR;

  // Auto-size title: shrink font until longest word fits in width
  const maxWidth = W - 180;
  const longestWord = data.title.split(' ').reduce((a, b) => a.length > b.length ? a : b, '');
  let titleSize = 120;
  while (titleSize > 60 && longestWord.length * titleSize * 0.55 > maxWidth) {
    titleSize -= 4;
  }

  const titleLines = wrapTitle(data.title, titleSize, maxWidth);
  const lineHeight = Math.round(titleSize * 1.2);
  const titleY = 420;

  const titleSvgLines = titleLines.map((line, i) =>
    `<text x="90" y="${titleY + i * lineHeight}" font-family="${FONT_TITLE}" font-size="${titleSize}" font-weight="bold" fill="#FAFAFA">${esc(line)}</text>`
  ).join('\n    ');

  // Meta rows below title
  const metaStartY = titleY + titleLines.length * lineHeight + 80;
  const dividerY = metaStartY - 30;
  const rowH = 80;
  const valX = 470;

  const meta = [
    ['ВРЕМЯ', data.durationLabel || '—'],
    ['УРОВЕНЬ', difficultyRu],
    ['ИНВЕНТАРЬ', gear],
  ];

  const metaSvg = meta.map(([label, value], i) => {
    const y = metaStartY + i * rowH;
    return `<text x="90" y="${y}" font-family="${FONT_MONO}" font-size="44" fill="#555555">${esc(label!)}</text>
    <text x="${valX}" y="${y}" font-family="${FONT_MONO}" font-size="44" font-weight="bold" fill="#BBBBBB">${esc(value!)}</text>`;
  }).join('\n    ');

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#0A0A0A"/>

  <!-- Geometric accents -->
  <ellipse cx="${W + 25}" cy="75" rx="325" ry="325" fill="none" stroke="#1A1A1A" stroke-width="1"/>
  <ellipse cx="50" cy="${H - 100}" rx="450" ry="350" fill="none" stroke="#1A1A1A" stroke-width="1"/>

  <!-- Category tag -->
  <text x="90" y="270" font-family="${FONT_MONO}" font-size="52" fill="#666666">${esc(categoryRu)}</text>

  <!-- Title -->
  ${titleSvgLines}

  <!-- Divider -->
  <rect x="90" y="${dividerY}" width="150" height="4" fill="#444444"/>

  <!-- Meta -->
  ${metaSvg}

  <!-- Logo placeholder (composited separately) -->
</svg>`;

  // Render SVG to PNG, then composite logo on top
  const svgBuffer = Buffer.from(svg);
  let image = sharp(svgBuffer, { density: 72 }).png();

  // Try to composite logo
  try {
    const logoPath = path.join(ASSETS_DIR, 'logo.png');
    if (fs.existsSync(logoPath)) {
      const logoResized = await sharp(logoPath)
        .resize({ height: 200 })
        .negate({ alpha: false }) // invert to white
        .ensureAlpha()
        .toBuffer();

      const base = await image.toBuffer();
      const logoMeta = await sharp(logoResized).metadata();
      const logoW = logoMeta.width ?? 400;

      image = sharp(base).composite([{
        input: logoResized,
        left: Math.round((W - logoW) / 2),
        top: H - 340,
      }]);
    }
  } catch (err) {
    log.warn('failed to composite logo', { error: String(err) });
  }

  return image.png().toBuffer();
}

// ── Send story to admin ─────────────────────────────────────────────────────

import { Bot, InputFile } from 'grammy';
import { getConfig } from './config';

export async function sendStoryToAdmin(bot: Bot, data: StoryData): Promise<void> {
  try {
    const config = getConfig();
    const buf = await generateStory(data);
    await bot.api.sendPhoto(
      config.TELEGRAM_ADMIN_USER_ID,
      new InputFile(buf, 'story.png'),
      { caption: '📸 Сторис готова — пости в канал' },
    );
    log.info('story sent to admin', { title: data.title, category: data.category });
  } catch (err) {
    log.error('failed to generate/send story', { error: String(err) });
  }
}
