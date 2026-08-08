import { describe, expect, it } from 'vitest';

import { abbreviatePath, abbreviateSha } from './format.js';

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
