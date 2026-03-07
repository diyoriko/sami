import { Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import {
  writeChannelStats,
  getChannelStats,
  getWeeklyStats,
  getPostCountForDate,
  getCompletionCountForDate,
  getUniqueCompletionUsersForDate,
} from './db';

// ---------------------------------------------------------------------------
// Daily analytics: collect Telegram stats, write report, DM admin
// ---------------------------------------------------------------------------

export async function runDailyAnalytics(bot: Bot, date: string): Promise<void> {
  const config = getConfig();
  console.log(`[analytics] Running daily analytics for ${date}`);

  // 1. Collect channel/group stats from Telegram API
  let subscriberCount = 0;
  let groupMemberCount = 0;

  try {
    subscriberCount = await bot.api.getChatMemberCount(config.TELEGRAM_CHANNEL_ID);
  } catch (err) {
    console.error('[analytics] Failed to get channel member count:', err);
  }

  try {
    groupMemberCount = await bot.api.getChatMemberCount(config.TELEGRAM_GROUP_ID);
  } catch (err) {
    console.error('[analytics] Failed to get group member count:', err);
  }

  // 2. Get today's community stats from DB
  const postsToday = getPostCountForDate(date);
  const completionsToday = getCompletionCountForDate(date);
  const completionUsers = getUniqueCompletionUsersForDate(date);

  // 3. Write to channel_stats table
  writeChannelStats(date, subscriberCount, groupMemberCount, postsToday);

  // 4. Calculate delta vs yesterday
  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const prevStats = getChannelStats(yesterdayStr);
  const subDelta = prevStats ? subscriberCount - prevStats.subscriber_count : 0;
  const subDeltaStr = subDelta >= 0 ? `+${subDelta}` : `${subDelta}`;

  // 5. Write JSON report
  const reportDir = path.resolve(__dirname, '..', config.ANALYTICS_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });

  const report = {
    date,
    subscriber_count: subscriberCount,
    subscriber_delta: subDelta,
    group_member_count: groupMemberCount,
    posts_today: postsToday,
    completions_today: completionsToday,
    completion_users: completionUsers,
    written_at: new Date().toISOString(),
  };

  const reportPath = path.join(reportDir, 'latest.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`[analytics] Wrote daily report: ${reportPath}`);

  // 6. DM admin
  const lines = [
    `*Аналитика за ${date}*`,
    '',
    `Подписчики канала: ${subscriberCount} (${subDeltaStr})`,
    `Участники группы: ${groupMemberCount}`,
    `Постов: ${postsToday}`,
    `Выполнений: ${completionsToday} (${completionUsers} чел.)`,
  ];

  try {
    await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join('\n'), {
      parse_mode: 'Markdown',
    });
    console.log('[analytics] Sent daily DM to admin');
  } catch (err) {
    console.error('[analytics] Failed to send DM:', err);
  }
}

// ---------------------------------------------------------------------------
// Weekly analytics: generate dashboard, DM admin
// ---------------------------------------------------------------------------

export async function runWeeklyAnalytics(bot: Bot, weekStr: string): Promise<void> {
  const config = getConfig();
  console.log(`[analytics] Running weekly analytics for ${weekStr}`);

  // Calculate week boundaries (current week: Mon-Sun)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startDate = monday.toISOString().slice(0, 10);
  const endDate = sunday.toISOString().slice(0, 10);

  const days = getWeeklyStats(startDate, endDate);

  if (days.length === 0) {
    console.log('[analytics] No data for this week, skipping dashboard');
    return;
  }

  const totals = days.reduce(
    (acc, d) => ({ newMembers: acc.newMembers + d.new_members }),
    { newMembers: 0 }
  );

  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const subGrowth = lastDay.subscriber_count - firstDay.subscriber_count;

  // Write markdown dashboard
  const weeklyDir = path.resolve(__dirname, '..', config.ANALYTICS_WEEKLY_DIR);
  fs.mkdirSync(weeklyDir, { recursive: true });

  const dashPath = path.join(weeklyDir, `weekly-${weekStr}.md`);
  const md = [
    `# SAMI Analytics — Неделя ${weekStr}`,
    `> ${startDate} — ${endDate}`,
    '',
    '## Ключевые метрики',
    '',
    `| Метрика | Значение |`,
    `|---|---|`,
    `| Подписчики канала | ${lastDay.subscriber_count} (${subGrowth >= 0 ? '+' : ''}${subGrowth} за неделю) |`,
    `| Участники группы | ${lastDay.group_member_count} |`,
    `| Новые участники | ${totals.newMembers} |`,
    '',
    '## По дням',
    '',
    '| Дата | Новые | Подписчики |',
    '|---|---|---|',
    ...days.map(
      (d) => `| ${d.date} | ${d.new_members} | ${d.subscriber_count} |`
    ),
    '',
  ].join('\n');

  fs.writeFileSync(dashPath, md, 'utf8');
  console.log(`[analytics] Wrote weekly dashboard: ${dashPath}`);

  // Also write latest weekly report as JSON for strategist
  const reportDir = path.resolve(__dirname, '..', config.ANALYTICS_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });
  const weeklyJson = {
    week: weekStr,
    start_date: startDate,
    end_date: endDate,
    subscriber_count: lastDay.subscriber_count,
    subscriber_growth: subGrowth,
    group_member_count: lastDay.group_member_count,
    new_members: totals.newMembers,
    written_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(reportDir, 'latest-weekly.json'), JSON.stringify(weeklyJson, null, 2) + '\n', 'utf8');

  // DM admin
  const dmLines = [
    `*Недельный дашборд — ${weekStr}*`,
    '',
    `Подписчики: ${lastDay.subscriber_count} (${subGrowth >= 0 ? '+' : ''}${subGrowth})`,
    `Новых: ${totals.newMembers}`,
  ];

  try {
    await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, dmLines.join('\n'), {
      parse_mode: 'Markdown',
    });
    console.log('[analytics] Sent weekly DM to admin');
  } catch (err) {
    console.error('[analytics] Failed to send weekly DM:', err);
  }
}
