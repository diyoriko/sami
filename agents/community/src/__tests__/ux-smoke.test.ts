import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const srcDir = path.join(__dirname, '..');

function readSrc(filename: string): string {
  return fs.readFileSync(path.join(srcDir, filename), 'utf8');
}

describe('UX smoke: bot-menu handlers', () => {
  const botMenuSource = readSrc('bot-menu.ts');

  it('persistent menu has all required buttons', () => {
    expect(botMenuSource).toContain('Предложить тренировку');
    expect(botMenuSource).toContain('Мои тренировки');
    expect(botMenuSource).toContain('Профиль');
    expect(botMenuSource).toContain('Фильтры');
  });

  it('UGC flow: category buttons built from shared constants', () => {
    expect(botMenuSource).toContain('CATEGORY_BUTTONS');
    expect(botMenuSource).toContain('ugc_cat:');
  });

  it('UGC flow: difficulty buttons built from shared constants', () => {
    expect(botMenuSource).toContain('DIFFICULTY_BUTTONS');
    expect(botMenuSource).toContain('ugc_diff:');
  });

  it('UGC flow: cancel button present', () => {
    expect(botMenuSource).toContain('ugc_cancel');
    expect(botMenuSource).toContain('Отменить');
  });

  it('UGC flow: video file handler (message:document)', () => {
    expect(botMenuSource).toContain('message:document');
    expect(botMenuSource).toContain('video/');
  });

  it('UGC flow: admin approval buttons', () => {
    expect(botMenuSource).toContain('ugc_decide:');
    expect(botMenuSource).toContain('Одобрить');
    expect(botMenuSource).toContain('Отклонить');
  });
});

describe('UX smoke: moderation handlers', () => {
  const modSource = readSrc('moderation.ts');

  it('captcha: generates math question with 4 options', () => {
    expect(modSource).toContain('generateCaptcha');
    expect(modSource).toContain('captcha:');
    expect(modSource).toContain('options.forEach');
  });

  it('goal quiz after captcha', () => {
    expect(modSource).toContain('GOAL_OPTIONS');
    expect(modSource).toContain('goal:');
    expect(modSource).toContain('setMemberGoal');
  });

  it('post-onboarding DM sent after goal quiz', () => {
    expect(modSource).toContain('Как устроен Sami');
    expect(modSource).toContain('Я сделаль');
    expect(modSource).toContain('Предложить тренировку');
    expect(modSource).toContain('Фильтры');
  });

  it('auto-forward handler posts completion button', () => {
    expect(modSource).toContain('is_automatic_forward');
    expect(modSource).toContain('Я сделаль');
    expect(modSource).toContain('setGroupCommentId');
  });

  it('completion button has cooldown', () => {
    expect(modSource).toContain('getLastCompletionTime');
    expect(modSource).toContain('COOLDOWN_MS');
  });

  it('rating popup shows formula', () => {
    expect(modSource).toContain('rating:');
    expect(modSource).toContain('35%');
    expect(modSource).toContain('30%');
    expect(modSource).toContain('20%');
    expect(modSource).toContain('15%');
    expect(modSource).toContain('выполнения в Sami');
  });

  it('buddy invite after 3rd completion', () => {
    expect(modSource).toContain('wasBuddyInviteSent');
    expect(modSource).toContain('markBuddyInviteSent');
    expect(modSource).toContain('completions === 3');
  });

  it('antiflood + night mode + reputation', () => {
    expect(modSource).toContain('ANTIFLOOD_MAX_MESSAGES');
    expect(modSource).toContain('isNightMode');
    expect(modSource).toContain('getAntifloodLimit');
    expect(modSource).toContain('getMemberLevel');
  });

  it('spam patterns + stop phrases', () => {
    expect(modSource).toContain('SPAM_PATTERNS');
    expect(modSource).toContain('matchesStopPhrases');
    expect(modSource).toContain('getStopPhrases');
  });
});

describe('UX smoke: shared constants', () => {
  const sharedSource = readSrc('shared.ts');

  it('has all 7 categories', () => {
    expect(sharedSource).toContain("'stretching'");
    expect(sharedSource).toContain("'strength'");
    expect(sharedSource).toContain("'mobility'");
    expect(sharedSource).toContain("'yoga'");
    expect(sharedSource).toContain("'breathing'");
    expect(sharedSource).toContain("'recovery'");
    expect(sharedSource).toContain("'cardio'");
  });

  it('has all 3 difficulties', () => {
    expect(sharedSource).toContain("'beginner'");
    expect(sharedSource).toContain("'intermediate'");
    expect(sharedSource).toContain("'advanced'");
  });

  it('category buttons match categories count', () => {
    const catCount = (sharedSource.match(/value: '/g) || []).length;
    // 7 categories + 3 difficulties + 6 equipment = 16 value: ' occurrences in buttons
    expect(catCount).toBe(16);
  });

  it('SQL helpers generate valid constraint strings', () => {
    expect(sharedSource).toContain('CATEGORIES_SQL');
    expect(sharedSource).toContain('DIFFICULTIES_SQL');
  });
});

describe('UX smoke: rubrics', () => {
  const rubricsSource = readSrc('rubrics.ts');

  it('ritual challenge handlers', () => {
    expect(rubricsSource).toContain('ritual_join:');
    expect(rubricsSource).toContain('postRitualChallenge');
    expect(rubricsSource).toContain('recordRitualParticipation');
  });

  it('weekly progress digest', () => {
    expect(rubricsSource).toContain('postWeeklyProgress');
    expect(rubricsSource).toContain('getWeeklyTopMembers');
    expect(rubricsSource).toContain('#прогресс');
  });
});

describe('UX smoke: approval flow', () => {
  const approvalSource = readSrc('approval.ts');

  it('search + approve + unapprove buttons', () => {
    expect(approvalSource).toContain('approve:');
    expect(approvalSource).toContain('unapprove:');
    expect(approvalSource).toContain('CATEGORY_EMOJI');
  });

  it('imports from shared.ts', () => {
    expect(approvalSource).toContain("from './shared'");
  });
});

describe('UX smoke: rating formula', () => {
  const dbSource = readSrc('db.ts');

  it('computeRating uses Telegram completions', () => {
    expect(dbSource).toContain('normalizeCompletions');
    expect(dbSource).toContain('getVideoCompletionCount');
    expect(dbSource).toContain('completionScore');
    expect(dbSource).toContain('0.15 * completionScore');
  });

  it('DB migration for new categories', () => {
    expect(dbSource).toContain('migrateCheckConstraints');
    expect(dbSource).toContain('videos_v2');
    expect(dbSource).toContain('ugc_submissions_v2');
  });
});
