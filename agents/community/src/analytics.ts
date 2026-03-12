import { Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { createLogger } from './logger';
import { type Category, CATEGORY_RU, escV2 } from './shared';

const log = createLogger('analytics');
import {
  writeChannelStats,
  getChannelStats,
  getWeeklyStats,
  getPostCountForDate,
  getCompletionCountForDate,
  getUniqueCompletionUsersForDate,
  getTopVideosByCompletions,
  getRetention,
  getCompletionsByCategory,
  getPostTypeBreakdown,
  getCumulativeStats,
  getRecentPosts,
} from './db';

// ---------------------------------------------------------------------------
// Daily analytics: collect Telegram stats, write report, DM admin
// ---------------------------------------------------------------------------

export async function runDailyAnalytics(bot: Bot, date: string): Promise<void> {
  const config = getConfig();
  log.info(`running daily analytics for ${date}`);

  // 1. Collect channel/group stats from Telegram API
  let subscriberCount = 0;
  let groupMemberCount = 0;

  try {
    subscriberCount = await bot.api.getChatMemberCount(config.TELEGRAM_CHANNEL_ID);
  } catch (err) {
    log.error('failed to get channel member count', { error: String(err) });
  }

  try {
    groupMemberCount = await bot.api.getChatMemberCount(config.TELEGRAM_GROUP_ID);
  } catch (err) {
    log.error('failed to get group member count', { error: String(err) });
  }

  // 2. Get today's community stats from DB
  const postsToday = getPostCountForDate(date);
  const completionsToday = getCompletionCountForDate(date);
  const completionUsers = getUniqueCompletionUsersForDate(date);

  // 2b. Extended metrics
  const topVideos = getTopVideosByCompletions(date, 5);
  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const retention = getRetention(date, yesterdayStr);
  const completionsByCat = getCompletionsByCategory(date);
  const postTypes = getPostTypeBreakdown(date);
  const cumulative = getCumulativeStats();

  // 3. Write to channel_stats table
  writeChannelStats(date, subscriberCount, groupMemberCount, postsToday);

  // 4. Calculate delta vs yesterday
  const prevStats = getChannelStats(yesterdayStr);
  const subDelta = prevStats ? subscriberCount - prevStats.subscriber_count : 0;
  const subDeltaStr = subDelta >= 0 ? `+${subDelta}` : `${subDelta}`;

  // 5. Write JSON report (extended for strategist)
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
    top_videos: topVideos,
    retention: {
      yesterday_active: retention.yesterday_active,
      returned_today: retention.returned_today,
      rate: retention.yesterday_active > 0
        ? Math.round((retention.returned_today / retention.yesterday_active) * 100)
        : 0,
    },
    completions_by_category: completionsByCat,
    post_type_breakdown: postTypes,
    cumulative,
    written_at: new Date().toISOString(),
  };

  const reportPath = path.join(reportDir, 'latest.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  log.info(`wrote daily report: ${reportPath}`);

  // 6. DM admin

  const retentionPct = retention.yesterday_active > 0
    ? Math.round((retention.returned_today / retention.yesterday_active) * 100)
    : 0;

  const videoCount = postTypes.find(p => p.post_type === 'video')?.count ?? 0;
  const linkCount = postTypes.find(p => p.post_type === 'link')?.count ?? 0;

  const catLines = completionsByCat.map(c =>
    `  ${escV2(CATEGORY_RU[c.category as Category] ?? c.category)}: ${escV2(String(c.completions))} \\(${escV2(String(c.users))} чел\\.\\)`
  );

  const topLines = topVideos.slice(0, 3).map((v, i) => {
    const title = v.title.length > 35 ? v.title.slice(0, 32) + '...' : v.title;
    return `  ${escV2(String(i + 1))}\\. ${escV2(title)} — ${escV2(String(v.completions))}`;
  });

  const lines = [
    `*Аналитика за ${escV2(date)}*`,
    '',
    `Подписчики: ${escV2(String(subscriberCount))} \\(${escV2(subDeltaStr)}\\)`,
    `Группа: ${escV2(String(groupMemberCount))}`,
    '',
    `Постов: ${escV2(String(postsToday))}` + (linkCount > 0 ? ` \\(${escV2(String(videoCount))} видео, ${escV2(String(linkCount))} ссылок\\)` : ''),
    `Выполнений: ${escV2(String(completionsToday))} \\(${escV2(String(completionUsers))} чел\\.\\)`,
    ...(catLines.length > 0 ? ['', '*По категориям:*', ...catLines] : []),
    ...(topLines.length > 0 ? ['', '*Топ видео:*', ...topLines] : []),
    '',
    `Retention: ${escV2(String(retention.returned_today))}/${escV2(String(retention.yesterday_active))} \\(${escV2(String(retentionPct))}%\\)`,
    `Всего: ${escV2(String(cumulative.total_completions))} выполнений, ${escV2(String(cumulative.total_active_users))} активных`,
  ];

  try {
    await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join('\n'), {
      parse_mode: 'MarkdownV2',
    });
    log.info('sent daily DM to admin');
  } catch (err) {
    log.error('failed to send DM', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Weekly analytics: generate dashboard, DM admin
// ---------------------------------------------------------------------------

export async function runWeeklyAnalytics(bot: Bot, weekStr: string): Promise<void> {
  const config = getConfig();
  log.info(`running weekly analytics for ${weekStr}`);

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
    log.info('no data for this week, skipping dashboard');
    return;
  }

  const totals = days.reduce(
    (acc, d) => ({ newMembers: acc.newMembers + d.new_members }),
    { newMembers: 0 }
  );

  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const subGrowth = lastDay.subscriber_count - firstDay.subscriber_count;

  // Weekly completions and post breakdown
  const cumulative = getCumulativeStats();
  const recentPosts = getRecentPosts(7);
  const weeklyCompletions = recentPosts.reduce((sum, p) => sum + p.completions, 0);
  const weeklyVideoCount = recentPosts.filter(p => p.post_type === 'video').length;
  const weeklyLinkCount = recentPosts.filter(p => p.post_type === 'link').length;

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
    `| Постов за неделю | ${recentPosts.length} (${weeklyVideoCount} видео, ${weeklyLinkCount} ссылок) |`,
    `| Выполнений за неделю | ${weeklyCompletions} |`,
    `| Всего выполнений | ${cumulative.total_completions} |`,
    `| Всего активных | ${cumulative.total_active_users} |`,
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
  log.info(`wrote weekly dashboard: ${dashPath}`);

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
    weekly_completions: weeklyCompletions,
    weekly_posts: recentPosts.length,
    weekly_video_posts: weeklyVideoCount,
    weekly_link_posts: weeklyLinkCount,
    cumulative,
    written_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(reportDir, 'latest-weekly.json'), JSON.stringify(weeklyJson, null, 2) + '\n', 'utf8');

  // DM admin
  const subGrowthStr = subGrowth >= 0 ? `\\+${subGrowth}` : `${subGrowth}`;
  const dmLines = [
    `*Недельный дашборд — ${escV2(weekStr)}*`,
    `${escV2(startDate)} — ${escV2(endDate)}`,
    '',
    `Подписчики: ${escV2(String(lastDay.subscriber_count))} \\(${subGrowthStr}\\)`,
    `Группа: ${escV2(String(lastDay.group_member_count))}`,
    `Новых: ${escV2(String(totals.newMembers))}`,
    '',
    `Постов: ${escV2(String(recentPosts.length))}` + (weeklyLinkCount > 0 ? ` \\(${escV2(String(weeklyVideoCount))} видео, ${escV2(String(weeklyLinkCount))} ссылок\\)` : ''),
    `Выполнений: ${escV2(String(weeklyCompletions))}`,
    '',
    `Всего: ${escV2(String(cumulative.total_completions))} выполнений, ${escV2(String(cumulative.total_active_users))} активных`,
  ];

  try {
    await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, dmLines.join('\n'), {
      parse_mode: 'MarkdownV2',
    });
    log.info('sent weekly DM to admin');
  } catch (err) {
    log.error('failed to send weekly DM', { error: String(err) });
  }
}
