import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The light theme has two declaration lists — one under
 * `@media (prefers-color-scheme: light)` and one under `[data-theme='light']` —
 * because plain CSS cannot share a declaration list between a media query and
 * an attribute selector. They drifted once, and the drift was invisible: the
 * media block is the one the app actually reaches (nothing sets `data-theme`),
 * so tokens that existed only in the attribute block kept their dark values on
 * a light surface. That is what made the inspector unreadable.
 *
 * These tests are the mechanism that replaces the deduplication CSS cannot do.
 */

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  expect(start, `expected to find ${marker}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
    found.set(name!, value!.trim());
  }
  return found;
}

const root = declarations(blockAfter('\n:root {'));
const media = declarations(blockAfter('@media (prefers-color-scheme: light)'));
const attribute = declarations(blockAfter(":root[data-theme='light']"));

/** A token whose value can make text or a mark unreadable on the wrong ground. */
function isColourToken(name: string, value: string): boolean {
  if (name.startsWith('--font') || name.startsWith('--space')) return false;
  if (name.startsWith('--radius') || name.startsWith('--z-')) return false;
  return /#[0-9a-f]{3,8}\b|rgba?\(/iu.test(value);
}

describe('theme tokens', () => {
  it('defines the same token names in both light blocks', () => {
    expect([...attribute.keys()].sort()).toEqual([...media.keys()].sort());
  });

  it('gives every token the same value in both light blocks', () => {
    for (const [name, value] of media) {
      expect(attribute.get(name), `${name} differs between the two light blocks`).toBe(value);
    }
  });

  it('overrides every colour token the dark root defines', () => {
    const missing = [...root]
      .filter(([name, value]) => isColourToken(name, value))
      .map(([name]) => name)
      .filter((name) => !media.has(name));

    expect(missing, 'these keep a dark value on a light surface').toEqual([]);
  });

  it('keeps the media block scoped so an explicit dark choice still wins', () => {
    expect(css).toContain(":root:not([data-theme='dark'])");
  });

  it('declares a focus ring in light, because every focus site drops the UA outline', () => {
    expect(media.get('--focus')).toBeDefined();
    expect(media.get('--focus')).not.toBe(root.get('--focus'));
  });
});
