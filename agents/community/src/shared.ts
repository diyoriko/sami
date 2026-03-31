/**
 * Shared constants and utility functions used across multiple modules.
 *
 * SINGLE SOURCE OF TRUTH for all training metadata:
 * categories, difficulties, muscles, equipment, emojis.
 * All other modules (poster, approval, bot-menu, youtube) import from here.
 */

// ─── CATEGORIES ─────────────────────────────────────────────────────────────

export const CATEGORIES = [
  'stretching', 'strength', 'mobility',
  'yoga', 'breathing', 'recovery', 'cardio',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_RU: Record<Category, string> = {
  stretching: 'стретчинг',
  strength: 'сила',
  mobility: 'мобильность',
  yoga: 'йога',
  breathing: 'дыхание',
  recovery: 'восстановление',
  cardio: 'кардио',
};

export const CATEGORY_EMOJI: Record<Category, string> = {
  stretching: '🧘',
  strength: '💪',
  mobility: '🐍',
  yoga: '🧘‍♂️',
  breathing: '🫁',
  recovery: '🧊',
  cardio: '🏃',
};

/** Inline keyboard buttons for UGC flow and filters (two rows) */
export const CATEGORY_BUTTONS: { label: string; value: Category }[] = [
  { label: '🧘 Стретчинг', value: 'stretching' },
  { label: '💪 Силовая', value: 'strength' },
  { label: '🐍 Мобильность', value: 'mobility' },
  { label: '🧘‍♂️ Йога', value: 'yoga' },
  { label: '🫁 Дыхание', value: 'breathing' },
  { label: '🧊 Восстановление', value: 'recovery' },
  { label: '🏃 Кардио', value: 'cardio' },
];

// ─── DIFFICULTY ──────────────────────────────────────────────────────────────

export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_RU: Record<Difficulty, string> = {
  beginner: 'начинающий',
  intermediate: 'средний',
  advanced: 'продвинутый',
};

export const DIFFICULTY_EMOJI: Record<Difficulty, string> = {
  beginner: '💎',
  intermediate: '💎💎',
  advanced: '💎💎💎',
};

export const DIFFICULTY_BUTTONS: { label: string; value: Difficulty }[] = [
  { label: '💎 Легко', value: 'beginner' },
  { label: '💎💎 Средне', value: 'intermediate' },
  { label: '💎💎💎 Сложно', value: 'advanced' },
];

// ─── MUSCLES ─────────────────────────────────────────────────────────────────

/** Detection patterns: [regex for title/description, Russian label] */
export const MUSCLE_PATTERNS: [RegExp, string][] = [
  [/back|спин/i, 'спина'],
  [/hip|бедр/i, 'бёдра'],
  [/shoulder|плеч/i, 'плечи'],
  [/chest|грудь|грудн/i, 'грудь'],
  [/leg|нога|ног/i, 'ноги'],
  [/core|пресс|abs/i, 'кор/пресс'],
  [/arm|рук|bicep|tricep/i, 'руки'],
  [/neck|ше[ия]/i, 'шея'],
  [/glute|ягодиц/i, 'ягодицы'],
  [/hamstring|подколен/i, 'задняя бедра'],
  [/quad|четырехглав/i, 'квадрицепс'],
  [/calf|икр/i, 'икры'],
];

export const MUSCLE_DEFAULTS: Record<string, string[]> = {
  stretching: ['всё тело'],
  strength: ['всё тело'],
  mobility: ['суставы, всё тело'],
  yoga: ['всё тело'],
  breathing: ['диафрагма'],
  recovery: ['всё тело'],
  cardio: ['всё тело'],
};

// ─── EQUIPMENT ───────────────────────────────────────────────────────────────

/** Detection patterns: [regex for title/description, Russian label] */
export const EQUIPMENT_PATTERNS: [RegExp, string][] = [
  [/гантели|dumbbell/i, 'гантели'],
  [/штанга|barbell/i, 'штанга'],
  [/резинк|эспандер|resistance band/i, 'резинка'],
  [/гиря|kettlebell/i, 'гиря'],
  [/тренажёр|тренажер|machine/i, 'тренажёр'],
  [/скакалка|jump rope/i, 'скакалка'],
  [/турник|pull.?up bar/i, 'турник'],
  [/петли|trx/i, 'петли TRX'],
  [/ролл|foam roller|roller/i, 'ролл'],
  [/мяч|ball/i, 'мяч'],
  [/блок|block|кирпич|brick/i, 'блок для йоги'],
  [/ремень|strap|belt/i, 'ремень'],
];

export const EQUIPMENT_NO_GEAR = 'без инвентаря';

/** Equipment buttons for UGC flow (short values for callback data) */
export const EQUIPMENT_BUTTONS: { label: string; value: string }[] = [
  { label: '✋ Без инвентаря', value: 'none' },
  { label: '🏋️ Гантели', value: 'dumbbells' },
  { label: '🔗 Резинка', value: 'band' },
  { label: '🧶 Ролл', value: 'roller' },
  { label: '🧱 Блок', value: 'block' },
  { label: '📦 Другое', value: 'other' },
];

export const EQUIPMENT_VALUES = ['none', 'dumbbells', 'band', 'roller', 'block', 'other'] as const;
export type EquipmentValue = (typeof EQUIPMENT_VALUES)[number];

export const EQUIPMENT_VALUE_RU: Record<EquipmentValue, string> = {
  none: EQUIPMENT_NO_GEAR,
  dumbbells: 'гантели',
  band: 'резинка',
  roller: 'ролл',
  block: 'блок для йоги',
  other: 'другое',
};

/** Duration buttons for UGC flow */
export const DURATION_BUTTONS: { label: string; seconds: number }[] = [
  { label: '⏱ 5 мин', seconds: 300 },
  { label: '⏱ 10 мин', seconds: 600 },
  { label: '⏱ 15 мин', seconds: 900 },
  { label: '⏱ 20 мин', seconds: 1200 },
  { label: '⏱ 30 мин', seconds: 1800 },
  { label: '⏱ 45+ мин', seconds: 2700 },
];

export function formatDurationLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return '< 1 мин';
  return `${m} мин`;
}

// ─── YOUTUBE SEARCH KEYWORDS (per category) ─────────────────────────────────

export const CATEGORY_QUERIES: Record<Category, string[]> = {
  stretching: [
    'глубокая растяжка всего тела на коврике',
    'PNF stretching technique tutorial',
    'растяжка шпагат прогрессия на коврике',
    'deep hip flexor release routine',
    'loaded progressive stretching bodyweight',
    'растяжка грудного отдела и плеч техника',
    'fascial stretch therapy self routine',
    'утренняя растяжка дома на коврике',
    'pancake stretch progression tutorial',
    'растяжка задней цепи подробный разбор',
  ],
  strength: [
    'calisthenics skill progression bodyweight',
    'тренировка с весом тела сложные упражнения',
    'animal flow workout bodyweight',
    'функциональная тренировка паттерны движений',
    'progressive calisthenics home workout',
    'изометрическая силовая тренировка дома',
    'hollow body planche progression tutorial',
    'силовая тренировка дома без инвентаря',
    'bodyweight strength training advanced progressions',
    'single leg squat pistol progression mat',
    'crawling patterns movement training',
  ],
  mobility: [
    'FRC functional range conditioning routine',
    'kinstretch daily routine',
    'CARs controlled articular rotations full body',
    'мобильность тазобедренных суставов глубокий присед',
    'thoracic spine mobility drills',
    'суставная мобильность вращения контроль',
    'ankle mobility exercises dorsiflexion',
    'shoulder CARs mobility routine',
    'мобильность под нагрузкой end range',
    'hip 90/90 mobility flow routine',
  ],
  yoga: [
    'виньяса йога средний уровень поток',
    'arm balance yoga tutorial transitions',
    'аштанга йога первая серия разбор',
    'yoga hip opening deep practice',
    'инверсии в йоге стойка на руках подготовка',
    'yin yoga deep connective tissue 20 min',
    'yoga backbend progression wheel pose',
    'йога баланс на руках техника входа',
    'yoga flow intermediate 20 min mat',
    'pranayama yoga advanced breathing kriya',
  ],
  breathing: [
    'дыхательная гимнастика Бутейко практика',
    'tummo breathing technique tutorial',
    'дыхание для нервной системы вагус',
    'holotropic breathwork guided session',
    'wim hof advanced breathing rounds',
    'box breathing tactical performance',
    'капалабхати пранаяма техника и эффекты',
    'breathing biomechanics diaphragm training',
    'coherent breathing HRV training',
    'дыхательные практики апноэ таблица',
  ],
  recovery: [
    'миофасциальный релиз триггерные точки техника',
    'self myofascial release deep tissue mat',
    'восстановление нервной системы парасимпатика',
    'foam rolling science based routine',
    'lymphatic drainage self massage technique',
    'йога нидра глубокое восстановление',
    'active recovery mobility flow',
    'nerve flossing routine upper lower body',
    'восстановление фасций самомассаж глубокий',
    'proprioception balance recovery training',
  ],
  cardio: [
    'HIIT Tabata без инвентаря на коврике',
    'shadow boxing cardio workout home',
    'animal flow cardio bodyweight circuit',
    'кардио тренировка без прыжков на коврике',
    'metabolic conditioning bodyweight only',
    'jump rope freestyle tricks workout',
    'burpee variations advanced bodyweight',
    'low impact high intensity training mat',
    'kickboxing cardio home no equipment',
    'EMOM bodyweight conditioning workout',
  ],
};

// ─── CHALLENGES ─────────────────────────────────────────────────────────────

export const CHALLENGE_DURATION = 7; // days per challenge (1 week)

/**
 * Maps JS day-of-week (0=Sun … 6=Sat) to a Category.
 * Mon–Sun = 7 categories, one per day.
 */
export const DAY_CATEGORY_MAP: Record<number, Category> = {
  1: 'stretching',   // Пн
  2: 'strength',     // Вт
  3: 'mobility',     // Ср
  4: 'yoga',         // Чт
  5: 'cardio',       // Пт
  6: 'breathing',    // Сб
  0: 'recovery',     // Вс
};

/** Parse muscles JSON string into comma-separated display string */
export function parseMuscles(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const arr = JSON.parse(raw) as string[];
    return arr.join(', ');
  } catch {
    return raw;
  }
}

// ─── TELEGRAM API LIMITS ─────────────────────────────────────────────────────

/** Max length for chat/channel description (Telegram API) */
export const TG_DESCRIPTION_LIMIT = 255;
/** Max length for bot "About" / description (Telegram API) */
export const TG_BOT_DESCRIPTION_LIMIT = 512;
/** Max length for bot short description (Telegram API) */
export const TG_SHORT_DESCRIPTION_LIMIT = 120;

// ─── SQL helpers ─────────────────────────────────────────────────────────────

/** For DB CHECK constraints — comma-separated quoted values */
export const CATEGORIES_SQL = CATEGORIES.map(c => `'${c}'`).join(',');
export const DIFFICULTIES_SQL = DIFFICULTIES.map(d => `'${d}'`).join(',');

// ─── UTILITY FUNCTIONS ───────────────────────────────────────────────────────

/** Escape text for Telegram MarkdownV2 parse_mode (all special characters) */
export function escV2(text: string): string {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** @deprecated Use escV2 — kept for backward compatibility */
export const escapeMarkdown = escV2;

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
