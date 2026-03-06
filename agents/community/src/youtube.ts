import { getConfig } from './config';
import { wasPostedRecently, upsertVideo, VideoRow } from './db';

export type Category = 'stretching' | 'strength' | 'mobility';

const CATEGORY_QUERIES: Record<Category, string[]> = {
  stretching: [
    'full body stretching routine',
    'morning stretch routine',
    'flexibility workout',
    'растяжка всего тела',
  ],
  strength: [
    'bodyweight strength workout no equipment',
    'home strength training',
    'силовая тренировка дома',
    'full body strength workout',
  ],
  mobility: [
    'mobility workout routine',
    'joint mobility flow',
    'мобильность суставов тренировка',
    'hip mobility workout',
  ],
};

// Duration label from ISO 8601 (PT15M30S → "15:30")
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
  if (/beginner|начинающ|для новичк|easy|лёгк|light/.test(text)) return 'beginner';
  if (/advanced|сложн|hard|intense|профи/.test(text)) return 'advanced';
  return 'intermediate';
}

function guessMuscles(title: string, category: Category): string[] {
  const text = title.toLowerCase();
  const muscles: string[] = [];

  const muscleMap: [RegExp, string][] = [
    [/back|спин/, 'спина'],
    [/hip|бедр/, 'бёдра'],
    [/shoulder|плеч/, 'плечи'],
    [/chest|грудь|грудн/, 'грудь'],
    [/leg|нога|ног/, 'ноги'],
    [/core|пресс|abs/, 'кор/пресс'],
    [/arm|рук|bicep|tricep/, 'руки'],
    [/neck|ше[ия]/, 'шея'],
    [/glute|ягодиц/, 'ягодицы'],
    [/hamstring|подколен/, 'задняя поверхность бедра'],
    [/quad|четырехглав/, 'квадрицепс'],
    [/calf|икр/, 'икры'],
  ];

  for (const [re, label] of muscleMap) {
    if (re.test(text)) muscles.push(label);
  }

  if (muscles.length === 0) {
    const defaults: Record<Category, string[]> = {
      stretching: ['всё тело'],
      strength: ['всё тело'],
      mobility: ['суставы, всё тело'],
    };
    return defaults[category];
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
  statistics: { viewCount: string };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function searchVideos(
  category: Category,
  count = 3,
  customQuery?: string
): Promise<Array<Omit<VideoRow, 'id'> & { search_query: string }>> {
  const config = getConfig();
  const queries = customQuery ? [customQuery] : CATEGORY_QUERIES[category];
  const query = queries[Math.floor(Math.random() * queries.length)];

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('videoDuration', 'medium'); // 4-20 min
  searchUrl.searchParams.set('videoEmbeddable', 'true');
  searchUrl.searchParams.set('maxResults', String(count * 3)); // fetch more to filter
  searchUrl.searchParams.set('relevanceLanguage', 'ru');
  searchUrl.searchParams.set('key', config.YOUTUBE_API_KEY);

  const searchData = await fetchJson<{ items: YouTubeSearchItem[] }>(searchUrl.toString());
  const items = searchData.items || [];

  if (items.length === 0) return [];

  // Fetch video details (duration)
  const videoIds = items.map(i => i.id.videoId).join(',');
  const detailUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailUrl.searchParams.set('part', 'contentDetails,statistics');
  detailUrl.searchParams.set('id', videoIds);
  detailUrl.searchParams.set('key', config.YOUTUBE_API_KEY);

  const detailData = await fetchJson<{ items: YouTubeVideoDetail[] }>(detailUrl.toString());
  const detailMap = new Map(detailData.items.map(d => [d.id, d]));

  const results: Array<Omit<VideoRow, 'id'> & { search_query: string }> = [];

  for (const item of items) {
    if (results.length >= count) break;

    const videoId = item.id.videoId;

    // Skip recently posted
    if (wasPostedRecently(videoId, 30)) continue;

    const detail = detailMap.get(videoId);
    const { seconds, label } = detail
      ? parseDuration(detail.contentDetails.duration)
      : { seconds: 0, label: '?' };

    // Filter: 4–25 minutes for workouts
    if (seconds < 240 || seconds > 1500) continue;

    const title = item.snippet.title;
    const channelName = item.snippet.channelTitle;
    const thumbnail = item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.default?.url ?? null;

    results.push({
      youtube_id: videoId,
      title,
      channel_name: channelName,
      channel_url: `https://www.youtube.com/@${channelName.replace(/\s+/g, '')}`,
      duration_seconds: seconds,
      duration_label: label,
      difficulty: guessDifficulty(title, item.snippet.description),
      category,
      muscles: JSON.stringify(guessMuscles(title, category)),
      thumbnail_url: thumbnail,
      video_url: `https://www.youtube.com/watch?v=${videoId}`,
      search_query: query,
    });
  }

  return results;
}

export async function searchAllCategories(
  keywords?: { stretching?: string; strength?: string; mobility?: string }
): Promise<Record<Category, Array<Omit<VideoRow, 'id'> & { search_query: string }>>> {
  const categories: Category[] = ['stretching', 'strength', 'mobility'];
  const result = {} as Record<Category, Array<Omit<VideoRow, 'id'> & { search_query: string }>>;

  for (const cat of categories) {
    const query = keywords?.[cat];
    try {
      result[cat] = await searchVideos(cat, 3, query);
      console.log(`[youtube] ${cat}: found ${result[cat].length} videos`);
    } catch (err) {
      console.error(`[youtube] error searching ${cat}:`, err);
      result[cat] = [];
    }
    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  return result;
}
