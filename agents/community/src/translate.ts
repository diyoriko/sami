/**
 * Title rewriting for SAMI tone of voice + EN→RU translation.
 *
 * SAMI tone: спокойный, конкретный, уважающий время.
 * Архетип: Опекун + Мудрец, не инфлюенсер.
 * No hype, no clickbait, no ALL CAPS.
 */

function isLatin(text: string): boolean {
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
  const cyrillic = text.match(/[а-яА-ЯёЁ]/g)?.length ?? 0;
  return latin > cyrillic;
}

async function googleTranslate(text: string): Promise<string> {
  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', 'ru');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);

    const res = await fetch(url.toString());
    if (!res.ok) return text;

    const data = await res.json() as any[][];
    return data[0]?.map((s: any[]) => s[0]).join('') ?? text;
  } catch {
    return text;
  }
}

// Hype/clickbait phrases to strip (both RU and EN)
const HYPE_STRIP: RegExp[] = [
  /\b(best ever|most intense|you won't believe|insane|crazy|epic|ultimate|killer)\b/gi,
  /(?:^|\s)(невероятн\S*|безумн\S*|сумасшедш\S*|убийственн\S*|лучшая .* всех времён)(?:\s|$)/gi,
  /\b(no clickbait|not clickbait|real results)\b/gi,
  /[!]{2,}/g,           // excessive !!!
  /[🔥💪🏆⚡]{2,}/g,    // emoji spam
  /\|\s*$/,             // trailing pipe
  /^\s*\|/,             // leading pipe
];

// Patterns to clean but keep meaning
const NORMALIZE: [RegExp, string][] = [
  [/#\w+/g, ''],                              // hashtags
  [/\s{2,}/g, ' '],                           // double spaces
  [/\s*[|]\s*/g, ' — '],                      // pipes → dash
  [/\s*[-–—]\s*$/g, ''],                      // trailing dashes
  [/^\s*[-–—]\s*/g, ''],                      // leading dashes
];

function toSentenceCase(str: string): string {
  let isFirst = true;
  return str.replace(/\S+/g, (word) => {
    // Keep short abbreviations like "TRX", "HIIT" (2-4 uppercase letters)
    if (/^[A-ZА-ЯЁ]{2,4}$/.test(word)) return word;
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
    // Keep short abbreviations
    if (/^[A-ZА-ЯЁ]{2,4}$/.test(word)) return word;
    // Lowercase words that are 5+ uppercase letters (possibly with trailing punctuation)
    const core = word.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
    if (core.length >= 5 && core === core.toUpperCase() && /[A-ZА-ЯЁ]/.test(core)) {
      return word.toLowerCase();
    }
    return word;
  });
}

function cleanTitle(text: string): string {
  let result = text.trim();

  // Fix ALL CAPS or mostly-caps → sentence case
  const letters = result.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  const upperCount = (letters.match(/[A-ZА-ЯЁ]/g) || []).length;
  if (letters.length > 3 && upperCount / letters.length > 0.5) {
    result = toSentenceCase(result);
  }

  // Lowercase individual CAPS words even in mixed-case text (e.g. "делать КАЖДЫЙ")
  result = lowercaseCapsWords(result);

  // Strip hype
  for (const pattern of HYPE_STRIP) {
    result = result.replace(pattern, '');
  }

  // Normalize
  for (const [pattern, replacement] of NORMALIZE) {
    result = result.replace(pattern, replacement);
  }

  return result.trim().replace(/\s{2,}/g, ' ');
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}

/**
 * Rewrite a video title for SAMI:
 * 1. Clean clickbait/hype/caps
 * 2. Translate to Russian if English
 * 3. Escape Markdown special chars
 */
export async function rewriteTitle(title: string): Promise<string> {
  let clean = cleanTitle(title);

  if (isLatin(clean)) {
    clean = await googleTranslate(clean);
    clean = cleanTitle(clean); // re-clean after translation
  }

  return escapeMarkdown(clean);
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
  return escapeMarkdown(result);
}
