import { describe, expect, it } from 'vitest';

import {
  abbreviateId,
  abbreviatePath,
  abbreviateSha,
  formatRelativeTime,
  monogramInitials,
  paletteIndex,
} from './format.js';

describe('abbreviatePath', () => {
  it('returns a short path unchanged', () => {
    expect(abbreviatePath('C:/work/demo')).toBe('C:/work/demo');
  });

  it('returns a path at the boundary unchanged', () => {
    const path = 'a'.repeat(42);
    expect(abbreviatePath(path)).toBe(path);
  });

  it('keeps head and tail so both root and leaf stay readable', () => {
    const path = `C:/xampp/htdocs/very/deep/nested/project/src/module.ts`;
    const result = abbreviatePath(path);

    expect(result).toContain('…');
    expect(result.startsWith('C:/xampp/htdocs/v')).toBe(true);
    expect(result.endsWith('src/module.ts')).toBe(true);
    expect(result.length).toBeLessThan(path.length);
  });
});

describe('abbreviateSha', () => {
  it('shortens a full commit sha', () => {
    expect(abbreviateSha('b'.repeat(40))).toBe('b'.repeat(12));
  });

  it('leaves an already short value alone', () => {
    expect(abbreviateSha('abc')).toBe('abc');
  });
});

describe('abbreviateId', () => {
  it('keeps the first UUID group so rows stay comparable', () => {
    expect(abbreviateId('d01ed09b-0783-4ff4-b875-8cc61d39792b')).toBe('d01ed09b');
  });

  it('leaves a short opaque id alone', () => {
    expect(abbreviateId('codex-sim')).toBe('codex-sim');
  });

  it('truncates a long id without hyphens', () => {
    expect(abbreviateId('a'.repeat(30))).toBe(`${'a'.repeat(12)}…`);
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-08-09T12:00:00.000Z');

  it('reports seconds as just now', () => {
    expect(formatRelativeTime('2026-08-09T11:59:41.000Z', now)).toBe('just now');
  });

  it('reports minutes', () => {
    expect(formatRelativeTime('2026-08-09T11:55:00.000Z', now)).toBe('5m ago');
  });

  it('reports hours', () => {
    expect(formatRelativeTime('2026-08-09T09:30:00.000Z', now)).toBe('2h ago');
  });

  it('reports days', () => {
    expect(formatRelativeTime('2026-08-06T12:00:00.000Z', now)).toBe('3d ago');
  });

  it('never claims the future; a clock skew reads as just now', () => {
    expect(formatRelativeTime('2026-08-09T12:00:30.000Z', now)).toBe('just now');
  });

  it('reports an unparseable timestamp as unavailable rather than inventing one', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('unavailable');
  });
});

describe('monogramInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(monogramInitials('LUWI Runtime')).toBe('LR');
    expect(monogramInitials('fly by deniz')).toBe('FB');
  });

  it('takes two letters when there is only one word', () => {
    expect(monogramInitials('Luwi')).toBe('LU');
  });

  it('never returns an empty mark, because a blank tile reads as a render fault', () => {
    expect(monogramInitials('')).toBe('??');
    expect(monogramInitials('   ')).toBe('??');
  });

  it('skips separators rather than turning them into initials', () => {
    expect(monogramInitials('luwi-runtime_core')).toBe('LR');
  });
});

describe('paletteIndex', () => {
  it('is stable for the same identifier', () => {
    expect(paletteIndex('project-1', 5)).toBe(paletteIndex('project-1', 5));
  });

  it('stays inside the palette', () => {
    for (const id of ['a', 'project-1', 'x'.repeat(64), '']) {
      const index = paletteIndex(id, 5);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(5);
    }
  });

  it('separates identifiers that differ only in their last character', () => {
    // Ids here are sequential fixtures far more often than they are random, so
    // a hash that ignores position would paint a whole registry one colour.
    expect(paletteIndex('project-1', 5)).not.toBe(paletteIndex('project-2', 5));
  });
});
