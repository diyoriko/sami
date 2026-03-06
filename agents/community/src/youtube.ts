import { getConfig } from './config';
import { wasPostedRecently, VideoRow } from './db';

export type Category = 'stretching' | 'strength' | 'mobility';

// Russian-first queries aligned with SAMI values:
// Calm, instructional, bodyweight, no hype, audience 25-45
const CATEGORY_QUERIES: Record<Category, string[]> = {
  stretching: [
    'утренняя растяжка дома',
    'растяжка всего тела для начинающих',
    'стретчинг для гибкости',
    'утренняя разминка 10 минут',
    'растяжка после тренировки',
  ],
  strength: [
    'силовая тренировка дома без инвентаря',
    'тренировка с весом тела',
    'функциональная тренировка дома',
    'силовая тренировка 20 минут',
    'бодивейт тренировка для начинающих',
  ],
  mobility: [
    'мобильность суставов тренировка',
    'мобильность тазобедренных суставов',
    'суставная гимнастика утром',
    'мобильность позвоночника',
    'упражнения на подвижность суставов',
  ],
};

// Hype / noise / wrong-audience signals → penalty
const HYPE_PATTERNS = [
  /безумн|сумасшедш/i,
  /трансформац|до и после/i,
  /похудеть за \d|сжечь жир за \d/i,
  /best ever|insane|crazy|extreme|epic|incredible/i,
  /burn fat fast|lose weight fast/i,
  /не поверишь/i,
];

// SAMI brand: calm, instructional, rhythm > bursts
const CALM_PATTERNS = [
  /практика|программа|комплекс|система|план/i,
  /routine|practice|program|tutorial|guide|flow/i,
  /для начинающих|beginner/i,
  /ежедневн|каждый день|daily/i,
  /дыхание|breathwork|breath/i,
  /mindful|осознанн/i,
  /постепенно|медленно|gentle|slow/i,
  /восстановление|recovery/i,
];

const SAMI_CONTENT_PATTERNS = [
  /мобильность|mobility/i,
  /гибкость|flexibility/i,
  /растяжка|stretching|stretch/i,
  /суставы|joints/i,
  /без инвентаря|no equipment|bodyweight|бодивейт/i,
  /дома|home workout/i,
];

function scoreBrandAlignment(title: string, description: string, channelName: string): number {
  const text = (title + ' ' + description).toLowerCase();
  let score = 50;

  for (const pattern of HYPE_PATTERNS) {
    if (pattern.test(text)) score -= 15;
  }

  // ALL CAPS title = hype signal
  const upperRatio = (title.match(/[A-ZА-ЯЁ]/g) || []).length / title.length;
  if (upperRatio > 0.6) score -= 20;

  // Wrong audience
  if (/детей|kids|беременн|pregnancy|пожилых|senior/.test(text)) score -= 40;

  for (const pattern of CALM_PATTERNS) {
    if (pattern.test(text)) score += 8;
  }

  for (const pattern of SAMI_CONTENT_PATTERNS) {
    if (pattern.test(text)) score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

function scoreViewCount(viewCount: number): number {
  if (viewCount >= 1_000_000) return 100;
  if (viewCount >= 500_000) return 85;
  if (viewCount >= 100_000) return 70;
  if (viewCount >= 50_000) return 55;
  if (viewCount >= 10_000) return 40;
  if (viewCount >= 1_000) return 20;
  return 5;
}

function scoreDuration(seconds: number): number {
  if (seconds >= 480 && seconds <= 1200) return 100; // 8-20 min sweet spot
  if (seconds >= 300 && seconds < 480) return 65;
  if (seconds > 1200 && seconds <= 1500) return 70;
  if (seconds > 1500 && seconds <= 1800) return 40;
  return 15;
}

export function computeTotalScore(brandScore: number, viewScore: number, durationScore: number): number {
  return Math.round(brandScore * 0.50 + viewScore * 0.35 + durationScore * 0.15);
}

function parseDuration(iso: string): { seconds: number; label: string } {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return { seconds: 0, label: '?' };
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseInt(match[3] || '0');
  const total = h * 3600 + m * 60 + s;
  const label = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  return { seconds: total, label };
}

function guessDifficulty(title: string, description: string): 'beginner' | 'intermediate' | 'advanced' {
  const text = (title + ' ' + description).toLowerCase();
  if (/beginner|начинающ|для новичк|easy|лёгк|light|простой/.test(text)) return 'beginner';
  if (/advanced|сложн|hard|intense|профи|тяжёл/.test(text)) return 'advanced';
  return 'intermediate';
}

function guessMuscles(title: string, category: Category): string[] {
  const text = title.toLowerCase();
  const muscles: string[] = [];
  const muscleMap: [RegExp, string][] = [
    [/back|спин/, 'спина'], [/hip|бедр/, 'бёдра'],
    [/shoulder|плеч/, 'плечи'], [/chest|грудь|грудн/, 'грудь'],
    [/leg|нога|ног/, 'ноги'], [/core|пресс|abs/, 'кор/пресс'],
    [/arm|рук|bicep|tricep/, 'руки'], [/neck|ше[ия]/, 'шея'],
    [/glute|ягодиц/, 'ягодицы'], [/hamstring|подколен/, 'задняя бедра'],
    [/quad|четырехглав/, 'квадрицепс'], [/calf|икр/, 'икры'],
  ];
  for (const [re, label] of muscleMap) {
    if (re.test(text)) muscles.push(label);
  }
  if (muscles.length === 0) {
    return { stretching: ['всё тело'], strength: ['всё тело'], mobility: ['суставы, всё тело'] }[category];
  }
  return muscles;
}

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    channelTitle: string;
    description: string;
    thumbnails: { high?: { url: string }; default?: { url: string } };
  };
}

interface YouTubeVideoDetail {
  id: string;
  contentDetails: { duration: string };
  statistics: { viewCount?: string };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type ScoredVideo = Omit<VideoRow, 'id'> & {
  search_query: string;
  view_count: number;
  brand_score: number;
  total_score: number;
};

export async function searchVideos(
  category: Category,
  count = 3,
  customQuery?: string
): Promise<ScoredVideo[]> {
  const config = getConfig();
  const queries = customQuery ? [customQuery] : CATEGORY_QUERIES[category];
  const query = queries[Math.floor(Math.random() * queries.length)];

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('videoDuration', 'medium');
  searchUrl.searchParams.set('videoEmbeddable', 'true');
  searchUrl.searchParams.set('maxResults', '20');
  searchUrl.searchParams.set('relevanceLanguage', 'ru');
  searchUrl.searchParams.set('regionCode', 'RU');
  searchUrl.searchParams.set('key', config.YOUTUBE_API_KEY);

  const searchData = await fetchJson<{ items: YouTubeSearchItem[] }>(searchUrl.toString());
  const items = searchData.items || [];
  if (items.length === 0) return [];

  const videoIds = items.map(i => i.id.videoId).join(',');
  const detailUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailUrl.searchParams.set('part', 'contentDetails,statistics');
  detailUrl.searchParams.set('id', videoIds);
  detailUrl.searchParams.set('key', config.YOUTUBE_API_KEY);

  const detailData = await fetchJson<{ items: YouTubeVideoDetail[] }>(detailUrl.toString());
  const detailMap = new Map(detailData.items.map(d => [d.id, d]));

  const candidates: ScoredVideo[] = [];

  for (const item of items) {
    const videoId = item.id.videoId;
    if (wasPostedRecently(videoId, 30)) continue;

    const detail = detailMap.get(videoId);
    if (!detail) continue;

    const { seconds, label } = parseDuration(detail.contentDetails.duration);
    if (seconds < 240 || seconds > 1800) continue;

    const viewCount = parseInt(detail.statistics.viewCount ?? '0', 10);
    const title = item.snippet.title;
    const description = item.snippet.description;
    const channelName = item.snippet.channelTitle;
    const thumbnail = item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.default?.url ?? null;

    const brandScore = scoreBrandAlignment(title, description, channelName);
    const viewScore = scoreViewCount(viewCount);
    const durationScore = scoreDuration(seconds);
    const totalScore = computeTotalScore(brandScore, viewScore, durationScore);

    candidates.push({
      youtube_id: videoId,
      title,
      channel_name: channelName,
      channel_url: `https://www.youtube.com/@${channelName.replace(/\s+/g, '')}`,
      duration_seconds: seconds,
      duration_label: label,
      difficulty: guessDifficulty(title, description),
      category,
      muscles: JSON.stringify(guessMuscles(title, category)),
      thumbnail_url: thumbnail,
      video_url: `https://www.youtube.com/watch?v=${videoId}`,
      search_query: query,
      view_count: viewCount,
      brand_score: brandScore,
      total_score: totalScore,
    });
  }

  return candidates.sort((a, b) => b.total_score - a.total_score).slice(0, count);
}

export async function searchAllCategories(
  keywords?: { stretching?: string; strength?: string; mobility?: string }
): Promise<Record<Category, ScoredVideo[]>> {
  const categories: Category[] = ['stretching', 'strength', 'mobility'];
  const result = {} as Record<Category, ScoredVideo[]>;

  for (const cat of categories) {
    try {
      result[cat] = await searchVideos(cat, 3, keywords?.[cat]);
      const top = result[cat][0];
      console.log(`[youtube] ${cat}: ${result[cat].length} found, best="${top?.title}" score=${top?.total_score}`);
    } catch (err) {
      console.error(`[youtube] error searching ${cat}:`, err);
      result[cat] = [];
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return result;
}
