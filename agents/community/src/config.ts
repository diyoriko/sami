import * as dotenv from 'dotenv';
import * as path from 'path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHANNEL_ID: z.string().min(1),   // e.g. "@sami_daily" or "-100123456789"
  TELEGRAM_GROUP_ID: z.string().min(1),      // e.g. "@sami_chat" or "-100987654321"
  TELEGRAM_ADMIN_USER_ID: z.string().transform(Number),
  YOUTUBE_API_KEY: z.string().min(1),
  COMMUNITY_DB_PATH: z.string().default('./data/community.sqlite'),
  STRATEGIST_LATEST_JSON: z.string().default('../../reports/strategist/.internal/latest.json'),
  COMMUNITY_REPORT_DIR: z.string().default('../../reports/community/.internal'),
  // Analytics agent
  CRON_ANALYTICS_DAILY: z.string().default('30 0 * * *'),    // 00:30 — daily metrics
  CRON_ANALYTICS_WEEKLY: z.string().default('0 10 * * 0'),   // Sunday 10:00 — weekly dashboard
  ANALYTICS_REPORT_DIR: z.string().default('../../reports/analytics/.internal'),
  ANALYTICS_WEEKLY_DIR: z.string().default('../../reports/analytics'),
  // Strategist agent
  CRON_STRATEGIST: z.string().default('30 12 * * *'),           // 12:30 MSK — daily strategist run
  STRATEGIST_API_KEY: z.string().optional(),                     // separate key for /packet endpoint
  GITHUB_TOKEN: z.string().optional(),                            // GitHub PAT for backlog updates
  // Season auto-publish
  CRON_SEASON_PUBLISH: z.string().default('0 8 * * *'),   // 08:00 MSK (timezone: Europe/Moscow)
  // Video search scoring weights (0-1, must sum to 1)
  SCORE_BRAND_WEIGHT: z.string().default('0.50').transform(Number),
  SCORE_VIEW_WEIGHT: z.string().default('0.35').transform(Number),
  SCORE_DURATION_WEIGHT: z.string().default('0.15').transform(Number),
  // Post rating weights (0-1, must sum to 1) — displayed in channel posts
  RATING_VIEW_WEIGHT: z.string().default('0.35').transform(Number),
  RATING_LIKE_WEIGHT: z.string().default('0.30').transform(Number),
  RATING_CHANNEL_WEIGHT: z.string().default('0.20').transform(Number),
  RATING_COMPLETION_WEIGHT: z.string().default('0.15').transform(Number),
  // Video duration range (seconds)
  VIDEO_MIN_DURATION: z.string().default('240').transform(Number),   // 4 min
  VIDEO_MAX_DURATION: z.string().default('1800').transform(Number),  // 30 min
  VIDEO_IDEAL_MIN: z.string().default('480').transform(Number),      // 8 min (sweet spot start)
  VIDEO_IDEAL_MAX: z.string().default('1200').transform(Number),     // 20 min (sweet spot end)
  // Recency window — skip videos posted within last N days
  VIDEO_RECENCY_DAYS: z.string().default('30').transform(Number),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Missing environment variables:');
    result.error.issues.forEach(i => console.error(` - ${i.path.join('.')}: ${i.message}`));
    process.exit(1);
  }
  _config = result.data;
  return _config;
}
