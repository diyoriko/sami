/**
 * Title rewriting for SAMI tone of voice + EN→RU translation.
 *
 * SAMI tone: спокойный, конкретный, уважающий время.
 * Архетип: Опекун + Мудрец, не инфлюенсер.
 * No hype, no clickbait, no ALL CAPS.
 *
 * Pipeline:
 * 1. Strip special characters (* etc.)
 * 2. Take first segment (before | — // -)
 * 3. Strip info already in post tags (duration, equipment, difficulty)
 * 4. Clean clickbait/hype/caps
 * 5. Translate EN→RU if needed (Google Translate)
 * 6. Apply fitness dictionary (fix common GT mistranslations)
 * 7. Cap length
 * 8. Escape Markdown
 */

import { escV2 } from './shared';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isLatin(text: string): boolean {
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
  const cyrillic = text.match(/[а-яА-ЯёЁ]/g)?.length ?? 0;
  return latin > cyrillic;
}

const TRANSLATE_TIMEOUT_MS = 10_000;
const MAX_TITLE_LENGTH = 60;

async function googleTranslate(text: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', 'ru');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);

    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return text;

    const data = await res.json() as unknown[][];
    return (data[0] as unknown[][])?.map((s) => (s as unknown[])[0]).join('') ?? text;
  } catch {
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ── Take first meaningful segment ────────────────────────────────────────────

function takeFirstSegment(title: string): string {
  // Split at | — // (common YouTube title separators)
  const parts = title.split(/\s*(?:[|]|\/\/|[–—])\s*/);
  if (parts.length > 1 && parts[0].trim().length >= 8) {
    return parts[0].trim();
  }
  // Also try splitting at " - " (spaced dash = clause separator)
  const dashParts = title.split(/\s+-\s+/);
  if (dashParts.length > 1 && dashParts[0].trim().length >= 8) {
    return dashParts[0].trim();
  }
  return title;
}

// ── Strip redundant info (already shown in post tags) ────────────────────────

const STRIP_REDUNDANT: RegExp[] = [
  // Duration EN: "15 Minute", "10 Min", "10-Minute"
  /\b\d+[\s-]?(?:min(?:ute)?s?)\b/gi,
  // Duration RU: "10 мин", "15-минутн*"  (no \b for Cyrillic — JS \b is ASCII-only)
  /\d+[\s-]?мин(?:ут(?:ный|ная|ное|ных|н\w*)?)?(?=\s|$)/gi,
  // "Follow along" / "(FOLLOW ALONG)"
  /\(?follow\s*along\)?/gi,
  // Equipment EN
  /\(?(?:no\s+equipment|bodyweight|equipment[\s-]*free)\)?/gi,
  // Equipment RU (no \b for Cyrillic)
  /без\s+(?:оборудования|инвентаря|снарядов)/gi,
  // At home
  /\b(?:at\s+home)\b/gi,
  /в\s+домашних\s+условиях/gi,
  // Difficulty EN
  /\b(?:beginner|intermediate|advanced)\b/gi,
  // Difficulty RU (no \b for Cyrillic)
  /для\s+начинающих/gi,
  // Filler EN (translate poorly, add noise)
  /\b(?:routine|session|tutorial|guide|challenge)\b/gi,
  // YouTube-specific filler in parens
  /\(\s*(?:official|full\s+video|real\s+time|HD|4K)\s*\)/gi,
];

// ── Hype/clickbait phrases (both RU and EN) ──────────────────────────────────

const HYPE_STRIP: RegExp[] = [
  // English hype
  /\b(?:best ever|most intense|you won't believe|insane|crazy|epic|ultimate|killer|incredible|amazing|guaranteed|life[\s-]?changing|game[\s-]?changer|must[\s-]?watch|no clickbait|not clickbait|real results)\b/gi,
  // Russian hype (no \b for Cyrillic — JS \b is ASCII-only)
  /(?:^|\s)(?:невероятн\S*|безумн\S*|сумасшедш\S*|убийственн\S*)(?:\s|$)/gi,
  /(?:убийца\s+калорий|жиросжигающ\S*|взрывн\S*|экстремальн\S*|адск\S*|бомбическ\S*)/gi,
  /лучш(?:ая|ий|ее)\s+.*?\s+всех\s+времён/gi,
  // Excessive punctuation/emoji
  /[!]{2,}/g,
  /[🔥💪🏆⚡]{2,}/g,
  // Pipe leftovers
  /\|\s*$/,
  /^\s*\|/,
];

// ── Channel promo patterns ───────────────────────────────────────────────────

const CHANNEL_PROMO: RegExp[] = [
  /(?:онлайн\s+)?(?:фитнес|йога)\s*(?:студия|клуб|канал)/gi,
  /\.?\s*(?:подписывайтесь|подпишись|ссылка\s+в\s+описании).*/gi,
];

// ── Normalize ────────────────────────────────────────────────────────────────

const NORMALIZE: [RegExp, string][] = [
  [/\*/g, ''],                                // strip asterisks
  [/\s*\/\/\s*/g, ' — '],                     // // → dash
  [/#\w+/g, ''],                              // hashtags
  [/\s*[|]\s*/g, ' — '],                      // pipes → dash
  [/\s*[-–—]\s*$/g, ''],                      // trailing dashes
  [/^\s*[-–—]\s*/g, ''],                      // leading dashes
  [/\(\s*\)/g, ''],                           // empty parens
  [/\s{2,}/g, ' '],                           // collapse spaces
];

// ── Caps handling ────────────────────────────────────────────────────────────

/** Known abbreviations that should stay uppercase */
const ABBREVIATIONS = new Set([
  'HIIT', 'TRX', 'AMRAP', 'EMOM', 'WOD', 'PR', 'PB', 'RPM',
  'МФР', 'ХОБЛ', 'ЛФК', 'ОФП', 'ЗОЖ', 'ВИИТ',
]);

function toSentenceCase(str: string): string {
  let isFirst = true;
  return str.replace(/\S+/g, (word) => {
    if (ABBREVIATIONS.has(word)) return word;
    if (isFirst) {
      isFirst = false;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word.toLowerCase();
  });
}

/** Lowercase individual ALL-CAPS words (5+ letters), even when rest of text is normal case */
function lowercaseCapsWords(str: string): string {
  return str.replace(/\S+/g, (word) => {
    if (ABBREVIATIONS.has(word)) return word;
    const core = word.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
    if (core.length >= 5 && core === core.toUpperCase() && /[A-ZА-ЯЁ]/.test(core)) {
      return word.toLowerCase();
    }
    return word;
  });
}

// ── Fitness dictionary (fix common Google Translate mistakes) ─────────────────

const FITNESS_FIXES: [RegExp, string][] = [
  // Common Google Translate mistakes for fitness terms (no \b — Cyrillic)
  [/подвижност\S*\s+бед[её]р/gi, 'мобильность тазобедренных'],
  [/мобильност\S*\s+бедр\S*/gi, 'мобильность тазобедренных'],
  [/растяжк\S*\s+гибкост\S*/gi, 'растяжка на гибкость'],
  [/гибкост\S*\s+растяжк\S*/gi, 'растяжка на гибкость'],
  [/расширьте\s+гибкость/gi, 'растяжка на гибкость'],
  [/растяну\S*\s+гибкость/gi, 'растяжка на гибкость'],
  [/тренировк\S*\s+всего\s+тела/gi, 'тренировка на всё тело'],
  [/гибкост\S*\s+всего\s+тела/gi, 'гибкость всего тела'],
  [/(?:простая\s+)?процедур\S*[,]?\s*позволяющ\S*\s*\S*/gi, ''],
  [/следуйте\s+(?:инструкциям|дальше|за\s+нами)/gi, ''],
  [/простая\s+процедура/gi, ''],
  [/чувствовать\s+себя\s+хорошо/gi, ''],
  [/подвижность\s+плеч[а-яё]*/gi, 'мобильность плеч'],
  [/верхн(?:яя|ей|юю)\s+част\S*\s+тела/gi, 'верх тела'],
  [/нижн(?:яя|ей|юю)\s+част\S*\s+тела/gi, 'низ тела'],
];

// ── Cap length ───────────────────────────────────────────────────────────────

function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const truncated = text.substring(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > max * 0.4) {
    return truncated.substring(0, lastSpace).replace(/[,.\s]+$/, '');
  }
  return truncated.replace(/[,.\s]+$/, '');
}

// ── Main cleaning pipeline ───────────────────────────────────────────────────

function cleanTitle(text: string): string {
  let result = text.trim();

  // Fix ALL CAPS or mostly-caps → sentence case
  const letters = result.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  const upperCount = (letters.match(/[A-ZА-ЯЁ]/g) || []).length;
  if (letters.length > 3 && upperCount / letters.length > 0.5) {
    result = toSentenceCase(result);
  }

  // Lowercase individual CAPS words
  result = lowercaseCapsWords(result);

  // Strip hype
  for (const pattern of HYPE_STRIP) {
    result = result.replace(pattern, '');
  }

  // Normalize
  for (const [pattern, replacement] of NORMALIZE) {
    result = result.replace(pattern, replacement);
  }

  // Strip channel promo
  for (const pattern of CHANNEL_PROMO) {
    result = result.replace(pattern, '');
  }

  return result.trim().replace(/\s{2,}/g, ' ');
}

function stripRedundant(text: string): string {
  let result = text;
  for (const pattern of STRIP_REDUNDANT) {
    result = result.replace(pattern, '');
  }
  return result.trim().replace(/\s{2,}/g, ' ');
}

function applyFitnessFixes(text: string): string {
  let result = text;
  for (const [pattern, replacement] of FITNESS_FIXES) {
    result = result.replace(pattern, replacement);
  }
  return result.trim().replace(/\s{2,}/g, ' ');
}

function ensureCapitalized(text: string): string {
  if (text.length === 0) return text;
  return text[0].toUpperCase() + text.slice(1);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Rewrite a video title for SAMI:
 * 1. Take first segment (before | — // -)
 * 2. Strip redundant info (duration, equipment, etc.)
 * 3. Clean clickbait/hype/caps
 * 4. Translate to Russian if English
 * 5. Apply fitness dictionary
 * 6. Cap length
 * 7. Escape Markdown
 */
export async function rewriteTitle(title: string): Promise<string> {
  if (!title.trim()) return '';

  let clean = takeFirstSegment(title);
  clean = stripRedundant(clean);
  clean = cleanTitle(clean);

  if (isLatin(clean)) {
    clean = await googleTranslate(clean);
    clean = cleanTitle(clean); // re-clean after translation
  }

  clean = applyFitnessFixes(clean);
  clean = ensureCapitalized(clean);
  clean = capLength(clean, MAX_TITLE_LENGTH);

  return escV2(clean);
}

/**
 * Translate channel name to Russian if Latin, escape Markdown.
 */
export async function formatChannelName(name: string): Promise<string> {
  let result = cleanTitle(name);
  if (isLatin(result)) {
    result = await googleTranslate(result);
    result = cleanTitle(result);
  }
  result = ensureCapitalized(result);
  return escV2(result);
}
