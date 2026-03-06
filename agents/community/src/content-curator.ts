import { Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { readCommunityPacket, CommunityPacket } from './strategist-sync';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContentType = 'tip' | 'challenge' | 'motivation' | 'fact' | 'poll';

interface DayPlan {
  day: string; // mon, tue, wed, ...
  type: ContentType;
  title: string;
  description: string;
  source?: string;
}

interface WeeklyPlan {
  week: string; // 2026-W10
  focus: string;
  themes: string[];
  days: DayPlan[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Content templates per day-of-week
// ---------------------------------------------------------------------------

const DAY_SCHEDULE: Array<{ day: string; type: ContentType }> = [
  { day: 'mon', type: 'motivation' },   // Мотивация на начало недели
  { day: 'tue', type: 'tip' },          // Практический совет
  { day: 'wed', type: 'challenge' },    // Мини-челлендж
  { day: 'thu', type: 'fact' },         // Интересный факт
  { day: 'fri', type: 'tip' },          // Совет на выходные
  { day: 'sat', type: 'poll' },         // Опрос / вовлечение
  { day: 'sun', type: 'motivation' },   // Итоги + мотивация
];

// ---------------------------------------------------------------------------
// Content generators per focus area
// ---------------------------------------------------------------------------

const CONTENT_BANK: Record<string, Record<ContentType, string[]>> = {
  stretching: {
    tip: [
      'Как правильно делать наклон к ногам — 3 ошибки',
      '5 растяжек которые можно делать за рабочим столом',
      'Почему статическая растяжка лучше работает вечером',
      'Растяжка для тех кто сидит 8+ часов в день',
      'Как увеличить гибкость за 2 недели — научный подход',
    ],
    challenge: [
      '7-дневный челлендж: шпагат за месяц',
      '5-минутная растяжка каждое утро — неделя подряд',
      'Челлендж: коснись пальцами пола через 14 дней',
    ],
    motivation: [
      'Гибкость = свобода движения. Начни с 5 минут сегодня',
      'Твоё тело создано для движения. Растяжка — не роскошь, а необходимость',
    ],
    fact: [
      'Исследование: 10 минут растяжки снижают кортизол на 28%',
      'Фасции обновляются за 6-24 месяца — регулярность важнее интенсивности',
    ],
    poll: [
      'Когда ты обычно делаешь растяжку? Утро / Обед / Вечер',
      'Какая часть тела у тебя самая зажатая?',
    ],
  },
  strength: {
    tip: [
      'Как делать отжимания правильно — чек-лист',
      'Планка: 3 вариации для разного уровня',
      '5 упражнений с собственным весом для всего тела',
      'Как прогрессировать без железа — принцип перегрузки',
      'Суперсеты без оборудования — экономь время',
    ],
    challenge: [
      '100 приседаний в день — недельный челлендж',
      'Планка-челлендж: от 30 секунд до 3 минут',
      'Отжимания: +5 каждый день в течение недели',
    ],
    motivation: [
      'Сила — это не про тяжёлые веса. Это про контроль своего тела',
      'Каждое повторение — инвестиция в себя',
    ],
    fact: [
      'Мышцы сжигают калории даже в покое — 5.5 ккал/кг в сутки',
      'Тренировки с собственным весом активируют больше стабилизаторов чем тренажёры',
    ],
    poll: [
      'Какое упражнение с собственным весом ты любишь больше всего?',
      'Сколько отжиманий ты можешь сделать за раз?',
    ],
  },
  mobility: {
    tip: [
      'Мобильность тазобедренных — 3 ключевых упражнения',
      'Почему "хруст" в суставах — это нормально',
      'Утренняя мобильность за 5 минут: flow для всех суставов',
      'Как улучшить подвижность плеч для тех кто работает за компом',
      'Голеностоп: самый недооценённый сустав — как его раскрыть',
    ],
    challenge: [
      'Мобильность на каждый день: 7 суставов за 7 дней',
      'Deep squat hold: 30 секунд каждый день неделю',
    ],
    motivation: [
      'Мобильность — это свобода. Каждый сустав заслуживает внимания',
      'Двигайся как ребёнок — без боли и ограничений',
    ],
    fact: [
      'После 30 лет подвижность суставов падает на 1% в год без тренировок',
      'Контролируемые вращения суставов улучшают проприоцепцию за 2 недели',
    ],
    poll: [
      'Какой сустав у тебя самый "деревянный"?',
      'Делаешь ли ты суставную разминку перед тренировкой?',
    ],
  },
  general: {
    tip: [
      'Как выстроить привычку тренироваться каждый день',
      'Отдых — часть тренировки. Почему восстановление важно',
      '3 правила: двигайся, дыши, будь последовательным',
    ],
    challenge: [
      'Неделя без лифта — только лестницы',
      '10 минут движения сразу после пробуждения — 7 дней подряд',
    ],
    motivation: [
      'Не жди мотивации. Создай систему и следуй ей',
      'Маленькие шаги каждый день > редкие марафоны',
    ],
    fact: [
      'WHO рекомендует 150 минут движения в неделю — это всего 21 минута в день',
      'Регулярное движение снижает риск депрессии на 26%',
    ],
    poll: [
      'Что мотивирует тебя больше: результат или процесс?',
      'Утро или вечер — когда ты тренируешься?',
    ],
  },
};

// ---------------------------------------------------------------------------
// Main: generate weekly content plan
// ---------------------------------------------------------------------------

export async function runContentCuration(bot: Bot, weekStr: string): Promise<void> {
  const config = getConfig();
  console.log(`[content-curator] Generating content plan for ${weekStr}`);

  // 1. Read strategist packet for focus & themes
  const packet: CommunityPacket = readCommunityPacket();
  const focus = packet.week_focus || 'general';
  const themes = packet.content_themes.length > 0
    ? packet.content_themes
    : ['всё тело', 'ежедневная практика'];

  // 2. Read analytics to see what worked (optional)
  let analyticsHint = '';
  try {
    const analyticsPath = path.resolve(__dirname, '..', config.ANALYTICS_REPORT_DIR, 'latest-weekly.json');
    if (fs.existsSync(analyticsPath)) {
      const analytics = JSON.parse(fs.readFileSync(analyticsPath, 'utf8'));
      if (analytics.avg_activity_rate_pct !== undefined) {
        analyticsHint = `Прошлая неделя: activity rate ${analytics.avg_activity_rate_pct}%, +${analytics.subscriber_growth} подписчиков`;
      }
    }
  } catch {
    // ok, no analytics data yet
  }

  // 3. Generate content plan
  const bank = CONTENT_BANK[focus] || CONTENT_BANK.general;
  const usedTitles = new Set<string>();

  const days: DayPlan[] = DAY_SCHEDULE.map(({ day, type }) => {
    const options = bank[type] || CONTENT_BANK.general[type];
    // Pick a random unused title
    let title = options[0];
    for (const opt of shuffleArray(options)) {
      if (!usedTitles.has(opt)) {
        title = opt;
        usedTitles.add(opt);
        break;
      }
    }

    return {
      day,
      type,
      title,
      description: `${typeEmoji(type)} ${typeLabel(type)} | Фокус: ${focus}`,
    };
  });

  const plan: WeeklyPlan = {
    week: weekStr,
    focus,
    themes,
    days,
    generated_at: new Date().toISOString(),
  };

  // 4. Write plan to disk
  const reportDir = path.resolve(__dirname, '..', config.CONTENT_CURATOR_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });

  const planPath = path.join(reportDir, 'weekly-plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  console.log(`[content-curator] Wrote weekly plan: ${planPath}`);

  // 5. DM admin
  const dayLabels: Record<string, string> = {
    mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб', sun: 'Вс',
  };

  const planLines = days.map(
    (d) => `${dayLabels[d.day]} ${typeEmoji(d.type)} ${d.title}`
  );

  const dmLines = [
    `📋 *Контент-план — ${weekStr}*`,
    `Фокус: ${focus}`,
    '',
    ...planLines,
  ];

  if (analyticsHint) {
    dmLines.push('', `📊 ${analyticsHint}`);
  }

  try {
    await bot.api.sendMessage(config.TELEGRAM_ADMIN_USER_ID, dmLines.join('\n'), {
      parse_mode: 'Markdown',
    });
    console.log('[content-curator] Sent weekly plan DM to admin');
  } catch (err) {
    console.error('[content-curator] Failed to send DM:', err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeEmoji(type: ContentType): string {
  const map: Record<ContentType, string> = {
    tip: '💡',
    challenge: '🔥',
    motivation: '💪',
    fact: '🧠',
    poll: '📊',
  };
  return map[type] || '📝';
}

function typeLabel(type: ContentType): string {
  const map: Record<ContentType, string> = {
    tip: 'Совет',
    challenge: 'Челлендж',
    motivation: 'Мотивация',
    fact: 'Факт',
    poll: 'Опрос',
  };
  return map[type] || 'Контент';
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
