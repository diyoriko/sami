/**
 * YouTube search with SAMI brand alignment scoring.
 *
 * SAMI values (from Figma Strategy):
 * - "Тренируюсь, чтобы жить лучше, а не быстрее похудеть" → NO weight loss content
 * - "Тело = партнёр, не проект" → no "fix your body" framing
 * - "Нужен только коврик" → bodyweight/no equipment only
 * - "Поддержка, не соревнование" → no competitive/ranking content
 * - Tone: спокойно, конкретно. Архетип: Опекун + Мудрец (не инфлюенсер)
 * - "Красота из дисциплины" → instructional, methodical, aesthetic
 */

import { getConfig } from './config';
import { wasPostedRecently, VideoRow } from './db';

export type Category = 'stretching' | 'strength' | 'mobility';

// Russian-first queries. "Только коврик" — no equipment framing.
const CATEGORY_QUERIES: Record<Category, string[]> = {
  stretching: [
    'утренняя растяжка дома на коврике',
    'растяжка всего тела для начинающих без инвентаря',
    'стретчинг для гибкости дома',
    'утренняя разминка суставов 10 минут',
    'растяжка после тренировки восстановление',
  ],
  strength: [
    'силовая тренировка дома без инвентаря на коврике',
    'тренировка с весом тела для начинающих',
    'функциональная тренировка дома без оборудования',
    'бодивейт тренировка 20 минут дома',
    'силовая тренировка без гантелей',
  ],
  mobility: [
    'мобильность суставов тренировка дома',
    'мобильность тазобедренных суставов на коврике',
    'суставная гимнастика утром для начинающих',
    'мобильность позвоночника упражнения',
    'подвижность суставов ежедневная практика',
  ],
};

// ─── PENALTY PATTERNS ────────────────────────────────────────────────────────

// Anti-value 1: "жить лучше, а НЕ быстрее похудеть"
const WEIGHT_LOSS_PATTERNS = [
  /похудеть за \d|похудеть быстро/i,
  /сжечь жир|жиросжигание|fat burn|burn fat/i,
  /до и после|before.?after|трансформация тела/i,
  /убрать живот|убрать бока|плоский живот/i,
  /lose weight|weight loss/i,
  /diet|диета для/i,
];

// Anti-value 2: "не проект" — aggressive "fix yourself" language
const FIX_BODY_PATTERNS = [
  /исправь|прокачай с нуля/i,
  /идеальное тело|perfect body/i,
  /убери целлюлит/i,
];

// Anti-value 3: "поддержка, не соревнование"
const COMPETITION_PATTERNS = [
  /соревновани|таблица лидеров|leaderboard/i,
  /vs |против |challenge accepted/i,
  /рекорд за \d|world record/i,
];

// Anti-tone: агрессивный мотивационный сленг
const HYPE_PATTERNS = [
  /безумн|сумасшедш|insane|crazy|extreme|epic/i,
  /лучшая тренировка всех времён|best ever|most intense/i,
  /не поверишь|you won't believe/i,
  /🔥{2,}|💪{3,}/,
];

// Anti-value 4: "только коврик" — equipment required
const EQUIPMENT_PATTERNS = [
  /гантели|со штангой|тренажёр|kettlebell|dumbbell|barbell/i,
  /в зале|в спортзале|gym workout(?! alternative)/i,
];

// Wrong audience
const WRONG_AUDIENCE_PATTERNS = [
  /детей|kids|беременн|pregnancy|пожилых|senior for/i,
];

// ─── BONUS PATTERNS ──────────────────────────────────────────────────────────

// Core value: "только коврик", bodyweight
const BODYWEIGHT_PATTERNS = [
  /без инвентаря|без оборудования|no equipment|bodyweight|бодивейт/i,
  /на коврике|дома|home workout/i,
];

// SAMI tone: спокойно, конкретно, Опекун + Мудрец
const CALM_INSTRUCTIONAL_PATTERNS = [
  /практика|программа|комплекс|система/i,
  /routine|practice|program|tutorial|guide|flow/i,
  /для начинающих|beginner/i,
  /ежедневн|каждый день|daily/i,
  /восстановление|recovery/i,
  /постепенно|медленно|gentle|slow/i,
  /правильная техника|proper form|техника выполнения/i,
];

// SAMI content pillars
const SAMI_CONTENT_PATTERNS = [
  /мобильность|mobility/i,
  /гибкость|flexibility/i,
  /растяжка|stretching|stretch/i,
  /суставы|joints/i,
  /дыхание|breathwork|breath/i,
  /осанка|posture/i,
];

// ─── SCORING ─────────────────────────────────────────────────────────────────

function scoreBrandAlignment(title: string, description: string): number {
  const text = (title + ' ' + description).toLowerCase();
  let score = 50;

  // Heavy penalties (anti-SAMI values)
  for (const p of WEIGHT_LOSS_PATTERNS) if (p.test(text)) score -= 25;
  for (const p of FIX_BODY_PATTERNS) if (p.test(text)) score -= 20;
  for (const p of COMPETITION_PATTERNS) if (p.test(text)) score -= 15;
  for (const p of HYPE_PATTERNS) if (p.test(text)) score -= 15;
  for (const p of EQUIPMENT_PATTERNS) if (p.test(text)) score -= 20;
  for (const p of WRONG_AUDIENCE_PATTERNS) if (p.test(text)) score -= 50;

  // ALL CAPS title = hype / anti-calm
  const upperRatio = (title.match(/[A-ZА-ЯЁ]/g) || []).length / title.length;
  if (upperRatio > 0.6) score -= 20;

  // Bonuses (pro-SAMI values)
  for (const p of BODYWEIGHT_PATTERNS) if (p.test(text)) score += 12;
  for (const p of CALM_INSTRUCTIONAL_PATTERNS) if (p.test(text)) score += 8;
  for (const p of SAMI_CONTENT_PATTERNS) if (p.test(text)) score += 6;

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
  // SAMI audience (25-45): 8-20 min sweet spot
  if (seconds >= 480 && seconds <= 1200) return 100;
  if (seconds >= 300 && seconds < 480) return 65;
  if (seconds > 1200 && seconds <= 1500) return 70;
  if (seconds > 1500 && seconds <= 1800) return 40;
  return 15;
}

export function computeTotalScore(brandScore: number, viewScore: number, durationScore: number): number {
  return Math.round(brandScore * 0.50 + viewScore * 0.35 + durationScore * 0.15);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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
  return muscles.length > 0
    ? muscles
    : { stretching: ['всё тело'], strength: ['всё тело'], mobility: ['суставы, всё тело'] }[category];
}

// ─── API TYPES ───────────────────────────────────────────────────────────────

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

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

// ─── EQUIPMENT DETECTION ─────────────────────────────────────────────────────

const EQUIPMENT_LABELS: [RegExp, string][] = [
  [/гантели|dumbbell/i, 'гантели'],
  [/штанга|barbell/i, 'штанга'],
  [/резинк|эспандер|resistance band/i, 'резинка'],
  [/гиря|kettlebell/i, 'гиря'],
  [/тренажёр|тренажер|machine/i, 'тренажёр'],
  [/скакалка|jump rope/i, 'скакалка'],
  [/турник|pull.?up bar/i, 'турник'],
  [/петли|trx/i, 'петли TRX'],
];

export function detectEquipment(title: string, description: string): string[] {
  const text = (title + ' ' + description).toLowerCase();
  return EQUIPMENT_LABELS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export type ScoredVideo = Omit<VideoRow, 'id'> & {
  search_query: string;
  view_count: number;
  brand_score: number;
  total_score: number;
  equipment: string[]; // empty = mat-only
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
  searchUrl.searchParams.set('videoDuration', 'medium'); // 4-20 min
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

    const brandScore = scoreBrandAlignment(title, description);
    const viewScore = scoreViewCount(viewCount);
    const durationScore = scoreDuration(seconds);
    const totalScore = computeTotalScore(brandScore, viewScore, durationScore);

    const equipment = detectEquipment(title, description);

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
      equipment,
    });
  }

  const sorted = candidates.sort((a, b) => b.total_score - a.total_score);

  // Prefer mat-only videos. Fall back to best overall if none found.
  const matOnly = sorted.filter(v => v.equipment.length === 0);
  const pool = matOnly.length > 0 ? matOnly : sorted;
  return pool.slice(0, count);
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
      console.log(`[youtube] ${cat}: ${result[cat].length} found, best="${top?.title}" score=${top?.total_score} brand=${top?.brand_score}`);
    } catch (err) {
      console.error(`[youtube] error searching ${cat}:`, err);
      result[cat] = [];
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return result;
}
