import { describe, it, expect } from 'vitest';
import { insertTaskIntoBacklog } from '../github';

const SAMPLE_BACKLOG = `# COMMUNITY_TASKS.md — Бэклог Sami Community

## Сделано

- [x] Первая задача

---

## SPRINT 6 — Качество + UX

### P1: UX — в работе

- [x] **Задача один** — описание

### P2: Автоматизация

- [ ] **Существующая P2** — описание

### P2: Баги

- [ ] **Баг один** — описание

### P3: Отложено (после 50+ участников)

- [ ] Монетизация
`;

describe('insertTaskIntoBacklog', () => {
  it('inserts P2 task before P3 section', () => {
    const result = insertTaskIntoBacklog(
      SAMPLE_BACKLOG,
      '**Новая задача** — описание новой задачи',
      'P2'
    );
    expect(result).not.toBeNull();
    expect(result).toContain('- [ ] **Новая задача** — описание новой задачи');
    // Should be before P3
    const taskIdx = result!.indexOf('Новая задача');
    const p3Idx = result!.indexOf('### P3:');
    expect(taskIdx).toBeLessThan(p3Idx);
  });

  it('inserts P1 task in P1 section', () => {
    const result = insertTaskIntoBacklog(
      SAMPLE_BACKLOG,
      '**Важный баг** — нужно починить срочно',
      'P1'
    );
    expect(result).not.toBeNull();
    expect(result).toContain('- [ ] **Важный баг** — нужно починить срочно');
    // Should be after P1 header
    const taskIdx = result!.indexOf('Важный баг');
    const p1Idx = result!.indexOf('### P1: UX');
    expect(taskIdx).toBeGreaterThan(p1Idx);
  });

  it('returns null for duplicate task', () => {
    const result = insertTaskIntoBacklog(
      SAMPLE_BACKLOG,
      '**Существующая P2** — описание',
      'P2'
    );
    expect(result).toBeNull();
  });

  it('handles empty markdown gracefully', () => {
    const result = insertTaskIntoBacklog('# Empty\n', '**Task** — desc', 'P2');
    // No P2 or P3 section → null
    expect(result).toBeNull();
  });

  it('preserves existing content when inserting', () => {
    const result = insertTaskIntoBacklog(
      SAMPLE_BACKLOG,
      '**Retention-фича** — напоминание пользователям',
      'P2'
    );
    expect(result).not.toBeNull();
    // Original tasks still present
    expect(result).toContain('Существующая P2');
    expect(result).toContain('Баг один');
    expect(result).toContain('Монетизация');
  });

  it('does not false-positive on similar but different titles', () => {
    const result = insertTaskIntoBacklog(
      SAMPLE_BACKLOG,
      '**Существующая P2 расширенная** — совсем другая задача',
      'P2'
    );
    // Different bold title → should NOT be duplicate
    expect(result).not.toBeNull();
    expect(result).toContain('Существующая P2 расширенная');
  });

  it('detects exact title duplicate regardless of description', () => {
    const result = insertTaskIntoBacklog(
      SAMPLE_BACKLOG,
      '**Баг один** — совершенно другое описание',
      'P2'
    );
    // Same bold title → duplicate
    expect(result).toBeNull();
  });

  it('inserts task without bold formatting (fallback dedup)', () => {
    const result = insertTaskIntoBacklog(
      SAMPLE_BACKLOG,
      'Простая задача без форматирования — описание',
      'P2'
    );
    expect(result).not.toBeNull();
    expect(result).toContain('- [ ] Простая задача без форматирования');
  });
});
