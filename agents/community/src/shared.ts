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
    'утренняя растяжка дома на коврике',
    'растяжка всего тела для начинающих без инвентаря',
    'стретчинг для гибкости дома',
    'утренняя разминка суставов 10 минут',
    'растяжка после тренировки восстановление',
    'full body stretching routine no equipment',
    'morning stretch routine 10 min mat only',
    'gentle flexibility routine beginner',
  ],
  strength: [
    'силовая тренировка дома без инвентаря на коврике',
    'тренировка с весом тела для начинающих',
    'функциональная тренировка дома без оборудования',
    'бодивейт тренировка 20 минут дома',
    'силовая тренировка без гантелей',
    'bodyweight workout at home no equipment',
    'mat only strength training beginner',
    'full body workout no equipment 15 min',
  ],
  mobility: [
    'мобильность суставов тренировка дома',
    'мобильность тазобедренных суставов на коврике',
    'суставная гимнастика утром для начинающих',
    'мобильность позвоночника упражнения',
    'подвижность суставов ежедневная практика',
    'joint mobility routine morning',
    'hip mobility flow mat only',
    'spine mobility exercises daily routine',
  ],
  yoga: [
    'йога для начинающих дома на коврике',
    'утренняя йога 15 минут',
    'виньяса йога без инвентаря',
    'хатха йога дома для начинающих',
    'yoga for beginners at home no equipment',
    'morning yoga flow 15 min',
    'gentle yoga stretch routine',
    'vinyasa yoga mat only',
  ],
  breathing: [
    'дыхательная гимнастика утром',
    'пранаяма для начинающих',
    'дыхательные упражнения для расслабления',
    'breathing exercises for relaxation',
    'pranayama for beginners',
    'breathwork morning routine',
    'бодифлекс дыхательная гимнастика',
    'wim hof breathing technique',
  ],
  recovery: [
    'миофасциальный релиз на коврике',
    'раскатка на ролле для восстановления',
    'восстановительная тренировка после нагрузки',
    'foam rolling recovery routine',
    'self massage recovery workout',
    'восстановление мышц упражнения дома',
    'gentle recovery stretching',
    'yin yoga recovery routine',
  ],
  cardio: [
    'кардио тренировка дома без инвентаря',
    'кардио на коврике без прыжков',
    'интервальная тренировка дома для начинающих',
    'HIIT тренировка без инвентаря 15 минут',
    'cardio workout at home no equipment',
    'low impact cardio no jumping',
    'HIIT no equipment mat only',
    'bodyweight cardio 20 min',
  ],
};

// ─── SQL helpers ─────────────────────────────────────────────────────────────

/** For DB CHECK constraints — comma-separated quoted values */
export const CATEGORIES_SQL = CATEGORIES.map(c => `'${c}'`).join(',');
export const DIFFICULTIES_SQL = DIFFICULTIES.map(d => `'${d}'`).join(',');

// ─── UTILITY FUNCTIONS ───────────────────────────────────────────────────────

export function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
