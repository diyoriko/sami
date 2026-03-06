import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { getConfig } from './config';
import { postVideoToChannel, postCheckin } from './poster';
import { runApprovalFlow } from './approval';
import { readCommunityPacket, writeCommunityReport } from './strategist-sync';

let newMembersToday = 0;

export function incrementNewMembers(): void {
  newMembersToday++;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startScheduler(bot: Bot): void {
  const config = getConfig();

  console.log('[scheduler] starting cron jobs...');

  // 19:00 — search videos & send approval to admin
  cron.schedule(config.CRON_SEARCH_VIDEOS, async () => {
    console.log('[scheduler] running video search & approval flow');
    const packet = readCommunityPacket();
    const date = todayDate();
    await runApprovalFlow(bot, date, {
      stretching: packet.search_keywords?.stretching,
      strength: packet.search_keywords?.strength,
      mobility: packet.search_keywords?.mobility,
    });
  }, { timezone: 'Europe/Moscow' });

  // 08:00 — post stretching
  cron.schedule(config.CRON_POST_STRETCHING, async () => {
    console.log('[scheduler] posting stretching');
    await postVideoToChannel(bot, todayDate(), 'stretching');
  }, { timezone: 'Europe/Moscow' });

  // 12:00 — post strength
  cron.schedule(config.CRON_POST_STRENGTH, async () => {
    console.log('[scheduler] posting strength');
    await postVideoToChannel(bot, todayDate(), 'strength');
  }, { timezone: 'Europe/Moscow' });

  // 17:00 — post mobility
  cron.schedule(config.CRON_POST_MOBILITY, async () => {
    console.log('[scheduler] posting mobility');
    await postVideoToChannel(bot, todayDate(), 'mobility');
  }, { timezone: 'Europe/Moscow' });

  // 21:00 — post evening check-in
  cron.schedule(config.CRON_CHECKIN, async () => {
    console.log('[scheduler] posting check-in');
    const date = todayDate();
    await postCheckin(bot, date);
  }, { timezone: 'Europe/Moscow' });

  // 23:55 — write daily report for strategist
  cron.schedule('55 23 * * *', () => {
    console.log('[scheduler] writing daily community report');
    writeCommunityReport(todayDate(), newMembersToday);
    newMembersToday = 0;
  }, { timezone: 'Europe/Moscow' });

  console.log('[scheduler] all cron jobs registered');
}
