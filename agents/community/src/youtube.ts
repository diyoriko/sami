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
import { wasPostedEver, isVideoRejected, VideoRow } from './db';
import { createLogger } from './logger';
import {
  type Category, type Difficulty,
  CATEGORIES, CATEGORY_QUERIES,
  EQUIPMENT_PATTERNS as EQUIPMENT_DETECT_PATTERNS,
  MUSCLE_PATTERNS, MUSCLE_DEFAULTS,
} from './shared';

// Re-export for backward compatibility (other modules import Category from youtube)
export type { Category } from './shared';

const log = createLogger('youtube');

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

// Heavy gym equipment — strong penalty
const HEAVY_EQUIPMENT_PATTERNS = [
  /со штангой|тренажёр|barbell|smith machine/i,
  /в зале|в спортзале|gym workout(?! alternative)/i,
  /турник|pull.?up bar/i,
];

// Wrong audience
const WRONG_AUDIENCE_PATTERNS = [
  /детей|kids|беременн|pregnancy|пожилых|senior for/i,
  /для мужчин|для женщин|for men|for women|мужская|женская/i,
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
  /ежедневн|каждый день|daily/i,
  /восстановление|recovery/i,
  /правильная техника|proper form|техника выполнения/i,
  /прогрессия|progression|разбор|breakdown/i,
  /наука|science.based|биомеханика|biomechanics/i,
  /начинающ|beginner|для новичк/i,
  /мягк|gentle|slow|спокойн|calm/i,
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

// MAX_PENALTY loaded from config.VIDEO_PENALTY_CAP

function scoreBrandAlignment(title: string, description: string): number {
  const text = (title + ' ' + description).toLowerCase();
  let penalty = 0;

  // Heavy penalties (anti-SAMI values) — each match adds to penalty pool
  for (const p of WEIGHT_LOSS_PATTERNS) if (p.test(text)) penalty += 25;
  for (const p of FIX_BODY_PATTERNS) if (p.test(text)) penalty += 20;
  for (const p of COMPETITION_PATTERNS) if (p.test(text)) penalty += 15;
  for (const p of HYPE_PATTERNS) if (p.test(text)) penalty += 15;
  for (const p of HEAVY_EQUIPMENT_PATTERNS) if (p.test(text)) penalty += 20;
  for (const p of WRONG_AUDIENCE_PATTERNS) if (p.test(text)) penalty += 50;

  // ALL CAPS title = hype / anti-calm
  const upperRatio = (title.match(/[A-ZА-ЯЁ]/g) || []).length / title.length;
  if (upperRatio > 0.6) penalty += 20;

  // Apply capped penalty
  const config = getConfig();
  let score = 50 - Math.min(penalty, config.VIDEO_PENALTY_CAP);

  // Bonuses (pro-SAMI values)
  for (const p of BODYWEIGHT_PATTERNS) if (p.test(text)) score += 12;
  for (const p of CALM_INSTRUCTIONAL_PATTERNS) if (p.test(text)) score += 8;
  for (const p of SAMI_CONTENT_PATTERNS) if (p.test(text)) score += 6;

  return Math.max(0, Math.min(100, score));
}

// Log curve: monotonically increasing with diminishing returns.
// 1K=30, 10K=57, 50K=77, 100K=86, 500K=97, 1M+=100.
// No penalty for popular videos — high views are a positive signal.
function scoreViewCount(viewCount: number): number {
  if (viewCount <= 0) return 0;
  const log = Math.log10(viewCount);
  return Math.min(Math.round(Math.max((log - 2) / 3.5, 0) * 100), 100);
}

// Engagement rate: like_ratio as a quality signal independent of views
function scoreEngagement(likeRatio: number): number {
  if (likeRatio <= 0) return 0;
  // 1% = mediocre (30), 3% = good (71), 5% = excellent (91), 6%+ = 100
  return Math.min(Math.round(Math.sqrt(likeRatio / 0.06) * 100), 100);
}

function scoreDuration(seconds: number): number {
  const config = getConfig();
  const { VIDEO_MIN_DURATION: minDur, VIDEO_IDEAL_MIN: idealMin, VIDEO_IDEAL_MAX: idealMax, VIDEO_MAX_DURATION: maxDur } = config;
  if (seconds >= idealMin && seconds <= idealMax) return 100;
  if (seconds >= minDur && seconds < idealMin) return 65;
  if (seconds > idealMax && seconds <= idealMax + (maxDur - idealMax) / 2) return 70;
  if (seconds > idealMax + (maxDur - idealMax) / 2 && seconds <= maxDur) return 40;
  return 15;
}

export function computeTotalScore(brandScore: number, viewScore: number, durationScore: number, engagementScore: number = 0): number {
  const config = getConfig();
  return Math.round(
    brandScore * config.SCORE_BRAND_WEIGHT +
    viewScore * config.SCORE_VIEW_WEIGHT +
    engagementScore * config.SCORE_ENGAGEMENT_WEIGHT +
    durationScore * config.SCORE_DURATION_WEIGHT
  );
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

/** Fetch duration for a single YouTube video by ID. Returns null if unavailable. */
export async function fetchVideoDuration(youtubeId: string): Promise<{ seconds: number; label: string } | null> {
  const config = getConfig();
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'contentDetails');
  url.searchParams.set('id', youtubeId);
  url.searchParams.set('key', config.YOUTUBE_API_KEY);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json() as { items?: YouTubeVideoDetail[] };
    const item = data.items?.[0];
    if (!item?.contentDetails?.duration) return null;
    return parseDuration(item.contentDetails.duration);
  } catch {
    return null;
  }
}

function guessDifficulty(title: string, description: string): Difficulty {
  const text = (title + ' ' + description).toLowerCase();
  if (/beginner|начинающ|для новичк|easy|лёгк|light|простой/.test(text)) return 'beginner';
  if (/advanced|сложн|hard|intense|профи|тяжёл/.test(text)) return 'advanced';
  return 'intermediate';
}

function guessMuscles(title: string, category: Category): string[] {
  const text = title.toLowerCase();
  const muscles: string[] = [];
  for (const [re, label] of MUSCLE_PATTERNS) {
    if (re.test(text)) muscles.push(label);
  }
  return muscles.length > 0
    ? muscles
    : (MUSCLE_DEFAULTS[category] ?? ['всё тело']);
}

// ─── API TYPES ───────────────────────────────────────────────────────────────

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    channelId: string;
    channelTitle: string;
    description: string;
    thumbnails: { high?: { url: string }; default?: { url: string } };
  };
}

interface YouTubeVideoDetail {
  id: string;
  contentDetails: { duration: string };
  statistics: { viewCount?: string; likeCount?: string };
}

interface YouTubeChannelDetail {
  id: string;
  statistics: { subscriberCount?: string };
}

const FETCH_TIMEOUT_MS = 15_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000; // 5 min

let circuitFailures = 0;
let circuitOpenUntil = 0;

async function fetchJson<T>(url: string): Promise<T> {
  if (circuitFailures >= CIRCUIT_BREAKER_THRESHOLD && Date.now() < circuitOpenUntil) {
    throw new Error(`YouTube API circuit open (${circuitFailures} consecutive failures, retry after ${new Date(circuitOpenUntil).toISOString()})`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      circuitFailures++;
      circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
      throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
    }
    circuitFailures = 0;
    return res.json() as Promise<T>;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      circuitFailures++;
      circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
      throw new Error(`YouTube API timeout (${FETCH_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch basic info for a single YouTube video by ID (channel name, title) */
export async function fetchYouTubeVideoInfo(videoId: string): Promise<{ channelTitle: string; title: string } | null> {
  const config = getConfig();
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('id', videoId);
    url.searchParams.set('key', config.YOUTUBE_API_KEY);
    const data = await fetchJson<{ items: Array<{ snippet: { channelTitle: string; title: string } }> }>(url.toString());
    if (data.items.length === 0) return null;
    return { channelTitle: data.items[0].snippet.channelTitle, title: data.items[0].snippet.title };
  } catch {
    return null;
  }
}

/** Fetch YouTube video stats (views, likes, subscribers) for Sami Score computation */
export async function fetchYouTubeVideoStats(videoId: string): Promise<{
  viewCount: number; likeRatio: number; channelSubscribers: number;
} | null> {
  const config = getConfig();
  try {
    const vUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    vUrl.searchParams.set('part', 'snippet,statistics');
    vUrl.searchParams.set('id', videoId);
    vUrl.searchParams.set('key', config.YOUTUBE_API_KEY);
    const vData = await fetchJson<{ items: Array<YouTubeSearchItem & YouTubeVideoDetail & { snippet: { channelId: string } }> }>(vUrl.toString());
    if (vData.items.length === 0) return null;
    const item = vData.items[0];
    const viewCount = parseInt(item.statistics.viewCount ?? '0', 10);
    const likeCount = parseInt(item.statistics.likeCount ?? '0', 10);
    const likeRatio = viewCount > 0 ? Math.min(likeCount / viewCount, 1) : 0;

    let channelSubscribers = 0;
    const channelId = item.snippet.channelId;
    if (channelId) {
      const chUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
      chUrl.searchParams.set('part', 'statistics');
      chUrl.searchParams.set('id', channelId);
      chUrl.searchParams.set('key', config.YOUTUBE_API_KEY);
      const chData = await fetchJson<{ items: YouTubeChannelDetail[] }>(chUrl.toString());
      if (chData.items.length > 0) {
        channelSubscribers = parseInt(chData.items[0].statistics.subscriberCount ?? '0', 10);
      }
    }
    return { viewCount, likeRatio, channelSubscribers };
  } catch {
    return null;
  }
}

// ─── EQUIPMENT DETECTION ─────────────────────────────────────────────────────

export function detectEquipment(title: string, description: string): string[] {
  const text = (title + ' ' + description).toLowerCase();
  return EQUIPMENT_DETECT_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export type ScoredVideo = Omit<VideoRow, 'id' | 'display_title'> & {
  search_query: string;
  view_count: number;
  like_ratio: number;
  channel_subscribers: number;
  brand_score: number;
  total_score: number;
  equipment: string[]; // empty = mat-only
};

export async function searchVideos(
  category: Category,
  count = 3,
  customQuery?: string,
  correlationId?: string,
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

  // Fetch channel subscriber counts (batch by unique channelId)
  const channelIds = [...new Set(items.map(i => i.snippet.channelId).filter(Boolean))];
  const subscriberMap = new Map<string, number>();
  if (channelIds.length > 0) {
    try {
      const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
      channelUrl.searchParams.set('part', 'statistics');
      channelUrl.searchParams.set('id', channelIds.join(','));
      channelUrl.searchParams.set('key', config.YOUTUBE_API_KEY);
      const channelData = await fetchJson<{ items: YouTubeChannelDetail[] }>(channelUrl.toString());
      for (const ch of channelData.items) {
        subscriberMap.set(ch.id, parseInt(ch.statistics.subscriberCount ?? '0', 10));
      }
    } catch (err) {
      log.warn('failed to fetch channel subscribers, using 0', { error: String(err) });
    }
  }

  const candidates: ScoredVideo[] = [];

  for (const item of items) {
    const videoId = item.id.videoId;
    if (wasPostedEver(videoId)) continue;
    if (isVideoRejected(videoId)) continue;

    const detail = detailMap.get(videoId);
    if (!detail) continue;

    const { seconds, label } = parseDuration(detail.contentDetails.duration);
    if (seconds < config.VIDEO_MIN_DURATION || seconds > config.VIDEO_MAX_DURATION) continue;

    const viewCount = parseInt(detail.statistics.viewCount ?? '0', 10);
    const likeCount = parseInt(detail.statistics.likeCount ?? '0', 10);
    const likeRatio = viewCount > 0 ? Math.min(likeCount / viewCount, 1) : 0;
    const title = item.snippet.title;
    const description = item.snippet.description;
    const channelName = item.snippet.channelTitle;
    const thumbnail = item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.default?.url ?? null;

    const brandScore = scoreBrandAlignment(title, description);
    const viewScore = scoreViewCount(viewCount);
    const engagementScore = scoreEngagement(likeRatio);
    const durationScore = scoreDuration(seconds);
    const totalScore = computeTotalScore(brandScore, viewScore, durationScore, engagementScore);

    const equipment = detectEquipment(title, description);

    candidates.push({
      youtube_id: videoId,
      title,
      channel_name: channelName,
      channel_url: `https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}`,
      duration_seconds: seconds,
      duration_label: label,
      difficulty: guessDifficulty(title, description),
      category,
      muscles: JSON.stringify(guessMuscles(title, category)),
      thumbnail_url: thumbnail,
      video_url: `https://www.youtube.com/watch?v=${videoId}`,
      search_query: query,
      view_count: viewCount,
      like_ratio: likeRatio,
      channel_subscribers: subscriberMap.get(item.snippet.channelId) ?? 0,
      rating: 0,
      brand_score: brandScore,
      total_score: totalScore,
      equipment,
    });
  }

  const sorted = candidates.sort((a, b) => b.total_score - a.total_score);

  // Dedup by channel: max 1 video per YouTube channel
  const seen = new Set<string>();
  const deduped = sorted.filter(v => {
    const key = v.channel_name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, count);
}

export async function searchAllCategories(
  keywords?: Partial<Record<Category, string>>,
  correlationId?: string,
): Promise<Record<Category, ScoredVideo[]>> {
  const searchLog = correlationId ? log.withCorrelation(correlationId) : log;
  const result = {} as Record<Category, ScoredVideo[]>;

  for (const cat of CATEGORIES) {
    try {
      result[cat] = await searchVideos(cat, 3, keywords?.[cat], correlationId);
      const top = result[cat][0];
      searchLog.info(`${cat}: ${result[cat].length} found`, {
        best: top?.title, score: top?.total_score, brand: top?.brand_score,
      });
    } catch (err) {
      searchLog.error(`error searching ${cat}`, { error: String(err) });
      result[cat] = [];
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return result;
}
