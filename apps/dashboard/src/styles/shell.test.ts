import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const shell = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('desktop shell CSS contract', () => {
  it('prevents page overflow and supports the approved desktop widths', () => {
    expect(shell).toContain('overflow-x: hidden');
    expect(shell).toContain('@media (max-width: 1399px)');
    expect(shell).toContain('minmax(0, 1fr)');
  });

  /**
   * The rail width used to be the literal `220px`, asserted here as a string.
   * It is a token now because the collapsed rail needs a second width and the
   * fixed sidebar needs the same number as the grid track that reserves its
   * gutter — three use sites for one measurement. The assertion moved with it:
   * what matters is that the rail is 220px and that both use sites read the
   * same token, not that a literal appears in the stylesheet.
   */
  it('states the rail width once, as a token', () => {
    expect(tokens).toContain('--rail-width: 220px');
    expect(shell).toContain('grid-template-columns: var(--rail-width) minmax(0, 1fr)');
    expect(shell).toContain('width: var(--rail-width);');
  });

  /**
   * A fixed sidebar over a grid gutter desynchronises the moment the two widths
   * disagree, which is what put content under the rail before. Collapsing must
   * move both. The same applies to the docked inspector on the other edge.
   */
  it('moves the grid track and the fixed rail together when collapsed', () => {
    expect(shell).toMatch(
      /\.app-shell--rail-collapsed \{\s*grid-template-columns: var\(--rail-width-collapsed\)/u,
    );
    expect(shell).toContain(
      '.app-shell--rail-collapsed .sidebar {\n  width: var(--rail-width-collapsed);\n}',
    );
  });

  it('reserves a grid track for the docked inspector', () => {
    expect(tokens).toContain('--inspector-width:');
    expect(shell).toMatch(
      /\.app-shell \{\s*display: grid;\s*grid-template-columns: var\(--rail-width\) minmax\(0, 1fr\) var\(--inspector-width\);/u,
    );
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
});
