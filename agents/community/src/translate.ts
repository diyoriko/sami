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
  /\b(невероятн\S*|безумн\S*|сумасшедш\S*|убийственн\S*|лучшая .* всех времён)\b/gi,
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

function cleanTitle(text: string): string {
  let result = text.trim();

  // Fix ALL CAPS → sentence case
  const upperRatio = (result.match(/[A-ZА-ЯЁ]/g) || []).length / result.length;
  if (upperRatio > 0.6 && result.length > 5) {
    result = result.charAt(0).toUpperCase() + result.slice(1).toLowerCase();
  }

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
  let result = name;
  if (isLatin(result)) {
    result = await googleTranslate(result);
  }
  return escapeMarkdown(result);
}
