/**
 * Shared constants and utility functions used across multiple modules.
 */

export const CATEGORY_RU: Record<string, string> = {
  stretching: 'стретчинг',
  strength: 'сила',
  mobility: 'мобильность',
};

export const DIFFICULTY_RU: Record<string, string> = {
  beginner: 'начинающий',
  intermediate: 'средний',
  advanced: 'продвинутый',
};

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
