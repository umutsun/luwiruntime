import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const shell = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');
const overview = readFileSync(new URL('./overview.css', import.meta.url), 'utf8');
const activity = readFileSync(new URL('./activity.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/**
 * The shell contract after the 2026-09-11 overview redesign: a header row over
 * one page region, and the overview's own two-track grid — the picture and the
 * docked drill-down. There is no rail and no rail token; the last of those
 * went with the rail.
 */
describe('desktop shell CSS contract', () => {
  it('prevents page overflow and supports the approved desktop widths', () => {
    expect(shell).toContain('overflow-x: hidden');
    expect(shell).toContain('@media (max-width: 1399px)');
    expect(shell).toContain('minmax(0, 1fr)');
  });

  it('stacks the header over the page and reserves no rail track', () => {
    expect(tokens).not.toContain('--rail-width');
    expect(tokens).toContain('--topbar-height: 56px');
    expect(shell).toMatch(
      /\.app-shell \{\s*display: grid;\s*height: 100vh;\s*min-width: 0;\s*grid-template-rows: var\(--topbar-height\) minmax\(0, 1fr\);/u,
    );
  });

  /**
   * The comps dock the drill-down as a third region at a fixed 360px. It is a
   * grid track, stated once as a token, and it is not a modal: the inspector
   * drawer stays the overlay, at every breakpoint.
   */
  it('docks the drill-down as the overview grid second track, from one token', () => {
    expect(tokens).toContain('--overview-aside-width: 360px');
    expect(overview).toMatch(
      /\.overview \{\s*display: grid;\s*height: 100%;\s*min-height: 0;\s*grid-template-columns: minmax\(0, 1fr\) var\(--overview-aside-width\);/u,
    );
    expect(overview).not.toMatch(/\.drill \{[^}]*position: fixed/u);
  });

  it('keeps detail in a fixed overlay at every breakpoint', () => {
    expect(activity).toMatch(/\.detail-drawer \{\s*position: absolute;/u);
  });

  /**
   * Every tone the overview draws animates from one declaration, so a dot and
   * a chip cannot disagree about what "working" looks like — and reduced
   * motion switches all of them off through the one rule in shell.css.
   */
  it('declares the tone vocabulary once and honours reduced motion', () => {
    for (const tone of ['working', 'waiting', 'blocked', 'quiet', 'done']) {
      expect(overview).toContain(`.tone--${tone}`);
    }
    expect(shell).toContain('@media (prefers-reduced-motion: reduce)');
    expect(shell).toContain('animation-iteration-count: 1 !important');
  });
});

/**
 * The design system encodes a status twice — colour and dot border style —
 * because colour alone disappears under grayscale and colour-vision deficiency.
 * Four of the five tones must therefore differ from the solid default in
 * something other than their hue.
 */
describe('status tone dual encoding', () => {
  it.each(['warning', 'danger', 'unknown', 'info'])(
    '%s draws its dot differently from the solid default',
    (tone) => {
      const rule = shell.slice(shell.indexOf(`.status-chip--${tone} .status-chip__dot {`));
      const body = rule.slice(0, rule.indexOf('}'));
      expect(body, `${tone} relies on hue alone`).toMatch(/border-style|background/u);
    },
  );

  /** The overview's own dots: quiet, waiting and done differ from working by border, not hue. */
  it.each(['waiting', 'quiet', 'done', 'blocked'])(
    'the drill-down %s dot differs from the solid working dot',
    (tone) => {
      const selector = `.drill__status.tone--${tone} .drill__status-dot`;
      const start = overview.indexOf(selector);
      expect(start, `${selector} must be styled`).toBeGreaterThan(-1);
      const body = overview.slice(overview.indexOf('{', start), overview.indexOf('}', start));
      expect(body, `${tone} relies on hue alone`).toMatch(/border-style|background: none/u);
    },
  );
});

/** A rule's declarations, by its exact selector at the start of a line. */
const ruleBody = (css: string, selector: string): string => {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} must be styled`).toBeGreaterThan(-1);
  return css.slice(css.indexOf('{', start), css.indexOf('}', start));
};

/**
 * The Board session pill (ADR 0038 review): a long name plus a sub-agent count
 * squeezed the dot to nothing and painted the count past the pill's border.
 */
describe('Board session pill', () => {
  it('never shrinks its tone dot', () => {
    expect(ruleBody(overview, '.chip__dot')).toContain('flex: none;');
  });

  it('never paints text past its own border', () => {
    expect(ruleBody(overview, '.chip')).toContain('overflow: hidden;');
  });

  /** A long status/age suffix squeezed the agent name to nothing; the suffix gives way first. */
  it('lets the status and age give way before the name, which keeps a floor', () => {
    const age = ruleBody(overview, '.chip__age');
    for (const declaration of [
      'flex: 0 1 auto;',
      'min-width: 0;',
      'overflow: hidden;',
      'text-overflow: ellipsis;',
    ]) {
      expect(age).toContain(declaration);
    }
    const name = ruleBody(overview, '.chip__name');
    expect(name).toMatch(/min-width: [1-9]\d*ch;/u);
    const shrink = (body: string) => Number(/flex: 0 ([\d.]+) auto;/u.exec(body)?.[1]);
    expect(shrink(name)).toBeLessThan(shrink(age));
  });
});

/**
 * Radial node labels: only the name and title were capped, so a long status
 * line still ran the head across its neighbours' nodes, where the clickable
 * name could take a neighbour's click. The whole head is capped now.
 */
describe('Radial node label', () => {
  it('caps the whole head, not only the name', () => {
    const head = ruleBody(overview, '.radial__label-head');
    expect(head).toContain('max-width: 22cqw;');
    expect(head).toContain('min-width: 0;');
  });

  it('lets the status line shrink to an ellipsis', () => {
    expect(overview).toMatch(
      /\.radial__label-sub[^{}]*\{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/u,
    );
  });
});

/** Timeline sub-agent threads (ADR 0038 review): three at a 2 px pitch stay under the label. */
describe('Timeline sub-agent thread', () => {
  it('is one pixel tall', () => {
    expect(ruleBody(overview, '.bar__thread')).toContain('height: 1px;');
  });
});
