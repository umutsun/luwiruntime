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

/**
 * Guards the other half of the same bug. A hardcoded colour outside this file
 * cannot follow the theme, so it keeps whichever mode it was written in — which
 * is how the inspector header ended up near-black on near-black.
 *
 * Translucent values are exempt: an overlay or a scrim composites over whatever
 * themed ground is beneath it and therefore does follow the theme. Anything
 * opaque must come from a token, including a brand colour, which is what
 * `--brand-mark-*` exists for.
 */
const STYLESHEETS = [
  'shell.css',
  'activity.css',
  'pulse.css',
  'projects.css',
  'overview.css',
] as const;

const colourProperty = /^\s*(background|background-color|color|border-top-color)\s*:\s*([^;]+);/gmu;

function isTranslucent(value: string): boolean {
  return [...value.matchAll(/rgba?\(([^)]*)\)/gu)].every((match) => {
    const parts = (match[1] ?? '').split(/[,/]/u).map((part) => part.trim());
    const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
    return Number.isFinite(alpha) && alpha < 1;
  });
}

describe('colour literals outside tokens.css', () => {
  it.each(STYLESHEETS)('%s uses tokens for every opaque colour', (file) => {
    const sheet = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const offenders: string[] = [];

    for (const [, property, rawValue] of sheet.matchAll(colourProperty)) {
      const value = (rawValue ?? '').trim();
      if (!/#[0-9a-f]{3,8}\b|rgba?\(/iu.test(value)) continue;
      // A hex literal is always opaque enough to freeze a theme; an rgba() is
      // only a problem when it is fully opaque.
      if (!/#[0-9a-f]{3,8}\b/iu.test(value) && isTranslucent(value)) continue;
      offenders.push(`${property!}: ${value}`);
    }

    expect(offenders, 'move these into tokens.css and reference them').toEqual([]);
  });
});

/**
 * Spacing drifted the way colour once did.
 *
 * The scale in tokens.css runs 2px through 32px, but 45 declarations carried
 * raw pixels instead — `9px`, `11px 12px`, `8px 9px`, `8px 10px` — so nothing
 * lined up with anything else and the owner's read of the running product was
 * that labels sat against borders and table cells had no room to breathe. A
 * scale that is not referenced is not a scale.
 */
describe('spacing literals outside tokens.css', () => {
  const spacingProperty = /(padding|gap|row-gap|column-gap)\s*:\s*([^;]+);/gu;

  it.each(STYLESHEETS)('%s uses tokens for every non-zero spacing value', (file) => {
    const sheet = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const offenders: string[] = [];

    for (const [, property, rawValue] of sheet.matchAll(spacingProperty)) {
      const value = (rawValue ?? '').trim();
      // A pixel length is the drift this guards; 0, percentages, and the
      // intrinsic keywords carry no scale to drift from.
      if (!/\b\d+px\b/u.test(value)) continue;
      offenders.push(`${property!}: ${value}`);
    }

    expect(offenders, 'use a --space-* token instead of a raw pixel length').toEqual([]);
  });
});

/**
 * Font sizes drifted the same way spacing did: 47 raw-pixel `font-size` values
 * and `font` shorthands (`font: 12px var(--font-mono)`) stood against the
 * `--font-size-*` scale, so the type never lined up with the scale it was meant
 * to. The `font` shorthand is expanded into `font-family` + `font-size` longhands
 * on tokenisation, because a `var()` inside the shorthand grammar is fragile;
 * this guard only reads `font`/`font-size` declarations, leaving letter-spacing
 * and line-height alone.
 */
describe('font-size literals outside tokens.css', () => {
  it.each(STYLESHEETS)('%s references the type scale for every font size', (file) => {
    const sheet = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const offenders = [...sheet.matchAll(/font(?:-size)?\s*:[^;{}]*/gu)]
      .map((match) => match[0])
      .filter((declaration) => /\b\d+(\.\d+)?px/u.test(declaration))
      .filter((declaration) => !declaration.includes('var(--font-size-'));

    expect(offenders, `${file} hard-codes a font size`).toEqual([]);
  });
});
