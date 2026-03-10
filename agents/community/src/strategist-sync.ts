import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { getDb, writeDailyStats, getCompletionCountForDate, getUniqueCompletionUsersForDate, getRecentPosts, getCumulativeStats } from './db';
import { getLatestPacket, type StrategistPacket } from './strategist';

export type { StrategistPacket as CommunityPacket };

/**
 * Read the latest COMMUNITY_PACKET.
 * Primary: from DB (strategist module on Railway).
 * Fallback: from filesystem (legacy Mac strategist via latest.json).
 */
export function readCommunityPacket(): StrategistPacket {
  // Try DB first (new flow: strategist runs on Railway)
  const packet = getLatestPacket();
  if (packet.week_focus !== 'general' || Object.keys(packet.search_keywords).length > 0) {
    console.log('[sync] loaded community packet from DB');
    return packet;
  }

  // Fallback: legacy filesystem path (Mac strategist)
  return readFromFilesystem() ?? packet;
}

function readFromFilesystem(): StrategistPacket | null {
  const config = getConfig();
  const latestJsonPath = path.resolve(__dirname, '..', config.STRATEGIST_LATEST_JSON);

  try {
    if (!fs.existsSync(latestJsonPath)) return null;

    const latest = JSON.parse(fs.readFileSync(latestJsonPath, 'utf-8')) as { report_path?: string };
    if (!latest.report_path || !fs.existsSync(latest.report_path)) return null;

    const reportText = fs.readFileSync(latest.report_path, 'utf-8');
    const match = reportText.match(/\/\/ COMMUNITY_PACKET_START\s*([\s\S]*?)\/\/ COMMUNITY_PACKET_END/);
    if (!match) return null;

    const parsed = JSON.parse(match[1].trim()) as Partial<StrategistPacket>;
    console.log('[sync] loaded community packet from filesystem (legacy)');
    return {
      week_focus: 'general',
      content_themes: ['всё тело', 'ежедневная практика'],
      challenge_active: false,
      challenge_name: null,
      search_keywords: {},
      community_priority: 'activation',
      ...parsed,
    };
  } catch (err) {
    console.warn('[sync] failed to read filesystem packet:', err);
    return null;
  }
}

export function writeCommunityReport(date: string, newMembers: number): void {
  const config = getConfig();
  writeDailyStats(date, newMembers);

  const completions = getCompletionCountForDate(date);
  const completionUsers = getUniqueCompletionUsersForDate(date);
  const recentPosts = getRecentPosts(7);
  const cumulative = getCumulativeStats();

  const report = {
    date,
    completions,
    completion_users: completionUsers,
    new_members: newMembers,
    recent_posts: recentPosts,
    cumulative,
    written_at: new Date().toISOString(),
  };

  const reportDir = path.resolve(__dirname, '..', config.COMMUNITY_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });

  const outPath = path.join(reportDir, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[sync] wrote community report to ${outPath}`);
}
