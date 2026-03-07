import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { writeDailyStats, getCompletionCountForDate, getUniqueCompletionUsersForDate } from './db';

export interface CommunityPacket {
  week_focus: 'stretching' | 'strength' | 'mobility' | 'general';
  content_themes: string[];
  challenge_active: boolean;
  challenge_name: string | null;
  search_keywords: {
    stretching?: string;
    strength?: string;
    mobility?: string;
  };
  community_priority: 'activation' | 'retention' | 'waitlist' | 'feedback';
}

const DEFAULT_PACKET: CommunityPacket = {
  week_focus: 'general',
  content_themes: ['всё тело', 'ежедневная практика'],
  challenge_active: false,
  challenge_name: null,
  search_keywords: {},
  community_priority: 'activation',
};

export function readCommunityPacket(): CommunityPacket {
  const config = getConfig();
  const latestJsonPath = path.resolve(__dirname, '..', config.STRATEGIST_LATEST_JSON);

  // First try the report directory for the latest report
  const reportDir = path.resolve(path.dirname(latestJsonPath));

  try {
    if (!fs.existsSync(latestJsonPath)) {
      console.log('[sync] strategist latest.json not found, using defaults');
      return DEFAULT_PACKET;
    }

    const latest = JSON.parse(fs.readFileSync(latestJsonPath, 'utf-8')) as { report_path?: string };
    if (!latest.report_path || !fs.existsSync(latest.report_path)) {
      return DEFAULT_PACKET;
    }

    const reportText = fs.readFileSync(latest.report_path, 'utf-8');
    const packet = extractCommunityPacket(reportText);
    console.log('[sync] loaded community packet from strategist report');
    return packet;
  } catch (err) {
    console.warn('[sync] failed to read strategist data, using defaults:', err);
    return DEFAULT_PACKET;
  }
}

function extractCommunityPacket(reportText: string): CommunityPacket {
  const match = reportText.match(/\/\/ COMMUNITY_PACKET_START\s*([\s\S]*?)\/\/ COMMUNITY_PACKET_END/);
  if (!match) return DEFAULT_PACKET;

  try {
    const json = match[1].trim();
    const parsed = JSON.parse(json) as Partial<CommunityPacket>;
    return { ...DEFAULT_PACKET, ...parsed };
  } catch (err) {
    console.warn('[sync] failed to parse community packet JSON:', err);
    return DEFAULT_PACKET;
  }
}

export function writeCommunityReport(date: string, newMembers: number): void {
  const config = getConfig();
  writeDailyStats(date, newMembers);

  const completions = getCompletionCountForDate(date);
  const completionUsers = getUniqueCompletionUsersForDate(date);

  const report = {
    date,
    completions,
    completion_users: completionUsers,
    new_members: newMembers,
    written_at: new Date().toISOString(),
  };

  const reportDir = path.resolve(__dirname, '..', config.COMMUNITY_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });

  const outPath = path.join(reportDir, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[sync] wrote community report to ${outPath}`);
}
