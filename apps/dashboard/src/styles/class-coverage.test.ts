import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Every class a route view names must exist in a stylesheet.
 *
 * A `className` that no rule matches fails silently: the markup is correct, the
 * render test passes because the text is present, and the page is wrong. That
 * is exactly how `.plan-change__head` shipped — the path, the operation chip
 * and the management mode had no gap between them and rendered as one string.
 *
 * Scoped to the route views rather than the whole app, because shared
 * components compose class names from template strings and a literal scan would
 * report those as missing.
 */

const VIEWS = [
  '../routes/capabilities-view.tsx',
  '../routes/config-view.tsx',
  '../routes/messages-view.tsx',
  '../projects/lease-panel.tsx',
  /*
   * The 2026-09-11 overview redesign introduced a whole new set of class names
   * in one change — exactly the situation this guard exists for. The blind spot
   * above still applies: state variants are composed from template literals and
   * stay invisible here, so the base classes are the ones this covers.
   */
  '../overview/overview.tsx',
  '../overview/stats-row.tsx',
  '../overview/ticker.tsx',
  '../overview/drill-down.tsx',
  '../overview/board-view.tsx',
  '../overview/flow-view.tsx',
  '../overview/radial-view.tsx',
  '../overview/timeline-view.tsx',
  '../app.tsx',
  '../routes/runtime-view.tsx',
  /*
   * Extended to every view and component that carries literal class names, so a
   * className no rule matches fails the guard rather than the page. Views that
   * compose classes from template literals still slip past the literal scan, but
   * their base classes are covered here.
   */
  '../projects/projects-view.tsx',
  '../routes/sessions-view.tsx',
  '../routes/usage-view.tsx',
  '../routes/context-view.tsx',
  '../routes/optimization-view.tsx',
  '../routes/graph-view.tsx',
  '../inspectors/inspector-panel.tsx',
  '../components/detail-drawer.tsx',
  '../routes/ask-session-dialog.tsx',
  '../components/project-form.tsx',
  '../components/luwibot-chat.tsx',
  '../knowledge/knowledge-view.tsx',
  '../knowledge/knowledge-canvas.tsx',
  '../knowledge/knowledge-inspector.tsx',
] as const;

const STYLESHEETS = [
  './tokens.css',
  './shell.css',
  './pulse.css',
  './activity.css',
  './projects.css',
  './overview.css',
  './knowledge.css',
] as const;

function definedClasses(): Set<string> {
  const defined = new Set<string>();
  for (const sheet of STYLESHEETS) {
    const css = readFileSync(new URL(sheet, import.meta.url), 'utf8');
    for (const match of css.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      const name = match[1];
      if (name !== undefined) defined.add(name);
    }
  }
  return defined;
}

function usedClasses(view: string): string[] {
  const source = readFileSync(new URL(view, import.meta.url), 'utf8');
  const used = new Set<string>();
  for (const match of source.matchAll(/className="([^"{}]+)"/g)) {
    const value = match[1];
    if (value === undefined) continue;
    for (const name of value.split(/\s+/).filter((entry) => entry !== '')) used.add(name);
  }
  return [...used].sort();
}

describe('route view class coverage', () => {
  it.each(VIEWS)('%s names only classes a stylesheet defines', (view) => {
    const defined = definedClasses();
    const missing = usedClasses(view).filter((name) => !defined.has(name));

    expect(missing).toEqual([]);
  });

  it('reads real class names, so the scan itself cannot pass by finding nothing', () => {
    // Every view must contribute at least one literal class, and the whole set a
    // substantial number, so neither the per-view scan nor the guard as a whole
    // can pass by matching nothing. A view like usage-view carries only a couple
    // of literal classes (the rest are composed), so the per-view floor is one.
    for (const view of VIEWS) expect(usedClasses(view).length).toBeGreaterThan(0);
    const total = VIEWS.reduce((sum, view) => sum + usedClasses(view).length, 0);
    expect(total).toBeGreaterThan(40);
    expect(definedClasses().has('route-stack')).toBe(true);
  });
});
