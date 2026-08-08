import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('desktop shell CSS contract', () => {
  it('prevents page overflow and supports the approved desktop widths', () => {
    const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');

    expect(css).toContain('overflow-x: hidden');
    expect(css).toContain('width: 220px');
    expect(css).toContain('@media (max-width: 1399px)');
    expect(css).toContain('minmax(0, 1fr)');
  });
});
