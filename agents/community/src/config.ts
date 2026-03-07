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
  // Schedule (cron expressions, defaults match the plan)
  CRON_SEARCH_VIDEOS: z.string().default('0 19 * * *'),     // 19:00 — search & send for approval (for tomorrow)
  CRON_POST_STRETCHING: z.string().default('30 7 * * *'),    // 07:30 — stretching (утро)
  CRON_POST_STRENGTH: z.string().default('0 12 * * *'),      // 12:00 — strength (обед)
  CRON_POST_MOBILITY: z.string().default('0 19 * * *'),      // 19:00 — mobility (вечер)
  // Analytics agent
  CRON_ANALYTICS_DAILY: z.string().default('30 0 * * *'),    // 00:30 — daily metrics
  CRON_ANALYTICS_WEEKLY: z.string().default('0 10 * * 0'),   // Sunday 10:00 — weekly dashboard
  ANALYTICS_REPORT_DIR: z.string().default('../../reports/analytics/.internal'),
  ANALYTICS_WEEKLY_DIR: z.string().default('../../reports/analytics'),
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
