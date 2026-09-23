import { describe, expect, it } from 'vitest';

import { forEachSpaced } from './scan-spacing.js';

describe('forEachSpaced', () => {
  it('runs each item with a wait between them, but not after the last', async () => {
    const seen: string[] = [];
    const waits: number[] = [];
    await forEachSpaced(['a', 'b', 'c'], (x) => seen.push(x), {
      spacingMs: 5,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(waits).toEqual([5, 5]); // between the 3 items → 2 waits, none trailing
  });

  it('stops early when keepGoing turns false', async () => {
    const seen: string[] = [];
    let checks = 0;
    await forEachSpaced(['a', 'b', 'c'], (x) => seen.push(x), {
      spacingMs: 0,
      wait: async () => {},
      keepGoing: () => {
        checks += 1;
        return checks <= 1; // true before 'a', false before 'b'
      },
    });
    expect(seen).toEqual(['a']);
  });

  it('does nothing and never waits for an empty list', async () => {
    let waited = false;
    await forEachSpaced([], () => {}, {
      spacingMs: 1,
      wait: async () => {
        waited = true;
      },
    });
    expect(waited).toBe(false);
  });
});
