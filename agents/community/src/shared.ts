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
  'muay_thai',
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
  muay_thai: 'муай-тай',
};

export const CATEGORY_EMOJI: Record<Category, string> = {
  stretching: '🧘',
  strength: '💪',
  mobility: '🐍',
  yoga: '🧘‍♂️',
  breathing: '🫁',
  recovery: '🧊',
  cardio: '🏃',
  muay_thai: '🥊',
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
  { label: '🥊 Муай-Тай', value: 'muay_thai' },
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
  muay_thai: ['всё тело, кор, ноги'],
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
    // Standard (accessible, popular)
    'растяжка для начинающих дома',
    'утренняя растяжка 10 минут',
    'full body stretch routine home',
    'stretching for flexibility beginner',
    'растяжка всего тела на коврике',
    'gentle morning stretch routine',
    // Niche (specialized, hidden gems)
    'PNF stretching technique tutorial',
    'deep hip flexor release routine',
    'fascial stretch therapy self routine',
    'растяжка задней цепи подробный разбор',
  ],
  strength: [
    // Standard
    'силовая тренировка дома без инвентаря',
    'bodyweight workout at home no equipment',
    'тренировка с собственным весом',
    'full body bodyweight strength',
    'home workout no equipment 15 min',
    'упражнения на все тело дома',
    // Niche
    'calisthenics skill progression bodyweight',
    'animal flow workout bodyweight',
    'изометрическая силовая тренировка дома',
    'crawling patterns movement training',
  ],
  mobility: [
    // Standard
    'мобильность суставов упражнения',
    'hip mobility routine',
    'mobility exercises for beginners',
    'разминка суставов утренняя',
    'joint mobility routine morning',
    'мобильность тазобедренных суставов',
    // Niche
    'FRC functional range conditioning routine',
    'CARs controlled articular rotations full body',
    'thoracic spine mobility drills',
    'hip 90/90 mobility flow routine',
  ],
  yoga: [
    // Standard
    'йога для начинающих дома',
    'yoga for beginners 15 min',
    'утренняя йога 10 минут',
    'yoga flow 20 min',
    'хатха йога дома',
    'gentle yoga stretch',
    // Niche
    'виньяса йога средний уровень поток',
    'yin yoga deep connective tissue 20 min',
    'yoga backbend progression wheel pose',
    'аштанга йога первая серия разбор',
  ],
  breathing: [
    // Standard
    'дыхательная гимнастика',
    'breathing exercises for relaxation',
    'дыхание для успокоения',
    'deep breathing exercise 10 min',
    'дыхательные упражнения утро',
    'breathing technique stress relief',
    // Niche
    'дыхательная гимнастика Бутейко практика',
    'tummo breathing technique tutorial',
    'дыхание для нервной системы вагус',
    'coherent breathing HRV training',
  ],
  recovery: [
    // Standard
    'растяжка после тренировки',
    'foam rolling routine',
    'восстановление после тренировки',
    'cool down stretch routine',
    'расслабление мышц на коврике',
    'recovery stretching 10 min',
    // Niche
    'миофасциальный релиз триггерные точки техника',
    'self myofascial release deep tissue mat',
    'йога нидра глубокое восстановление',
    'nerve flossing routine upper lower body',
  ],
  cardio: [
    // Standard
    'кардио тренировка дома без инвентаря',
    'HIIT workout at home no equipment',
    'кардио без прыжков на коврике',
    'cardio workout 15 min home',
    'low impact cardio home',
    'интервальная тренировка дома',
    // Niche
    'shadow boxing cardio workout home',
    'animal flow cardio bodyweight circuit',
    'EMOM bodyweight conditioning workout',
    'kickboxing cardio home no equipment',
  ],
  muay_thai: [
    // Тренировки/техника без снаряжения и без мешка — основной формат для канала
    'muay thai shadow boxing workout home',
    'muay thai basics technique tutorial beginner',
    'muay thai footwork drills no bag',
    'муай тай тренировка дома без мешка',
    'муай тай техника удары для начинающих',
    'муай тай шадоу боксинг дома',
    'muay thai conditioning bodyweight home',
    'muay thai stance and guard tutorial',
    // Бои профи — вдохновляющий контент (legendary fighters)
    'Buakaw best fights highlights',
    'Saenchai technique highlights muay thai',
    'Rodtang ONE Championship best moments',
    'Samart Payakaroon legendary muay thai',
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


export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
