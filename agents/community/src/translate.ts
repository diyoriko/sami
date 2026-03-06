/**
 * Lightweight translation for English video titles → Russian.
 * Uses free Google Translate endpoint (no API key needed).
 */

function isLatin(text: string): boolean {
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
  const cyrillic = text.match(/[а-яА-ЯёЁ]/g)?.length ?? 0;
  return latin > cyrillic;
}

export async function translateToRussian(text: string): Promise<string> {
  if (!isLatin(text)) return text;

  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'en');
    url.searchParams.set('tl', 'ru');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);

    const res = await fetch(url.toString());
    if (!res.ok) return text;

    const data = await res.json() as any[][];
    const translated = data[0]?.map((s: any[]) => s[0]).join('') ?? text;
    return translated;
  } catch {
    return text;
  }
}
