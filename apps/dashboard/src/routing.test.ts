import { describe, expect, it } from 'vitest';

import { parseRoute, routeHref, type DashboardRoute } from './routing.js';

describe('parseRoute', () => {
  it('defaults to pulse for empty, bare, and unknown hashes', () => {
    for (const hash of ['', '#', '#/', '#/unknown', '#/pulse/extra', 'garbage']) {
      expect(parseRoute(hash)).toEqual({ name: 'pulse' });
    }
  });

  it('resolves the two Phase 5B routes', () => {
    expect(parseRoute('#/pulse')).toEqual({ name: 'pulse' });
    expect(parseRoute('#/activity')).toEqual({ name: 'activity' });
  });

  it('resolves the projects list without a selection', () => {
    expect(parseRoute('#/projects')).toEqual({ name: 'projects' });
    expect(parseRoute('#/projects/')).toEqual({ name: 'projects' });
  });

  it('resolves a selected project id', () => {
    expect(parseRoute('#/projects/proj-1')).toEqual({ name: 'projects', projectId: 'proj-1' });
  });

  it('decodes a percent-encoded project id', () => {
    expect(parseRoute('#/projects/proj%201')).toEqual({ name: 'projects', projectId: 'proj 1' });
  });

  it('keeps a malformed percent sequence as literal text rather than throwing', () => {
    expect(parseRoute('#/projects/proj%ZZ')).toEqual({ name: 'projects', projectId: 'proj%ZZ' });
  });

  it('drops an id longer than the protocol identifier bound of 128', () => {
    expect(parseRoute(`#/projects/${'a'.repeat(128)}`)).toEqual({
      name: 'projects',
      projectId: 'a'.repeat(128),
    });
    expect(parseRoute(`#/projects/${'a'.repeat(129)}`)).toEqual({ name: 'projects' });
  });

  it('ignores extra path segments after the project id', () => {
    expect(parseRoute('#/projects/proj-1/git')).toEqual({ name: 'projects', projectId: 'proj-1' });
  });

  it('treats a whitespace-only id as no selection', () => {
    expect(parseRoute('#/projects/%20%20')).toEqual({ name: 'projects' });
  });
});

describe('routeHref', () => {
  const cases: ReadonlyArray<readonly [DashboardRoute, string]> = [
    [{ name: 'pulse' }, '#/pulse'],
    [{ name: 'activity' }, '#/activity'],
    [{ name: 'projects' }, '#/projects'],
    [{ name: 'projects', projectId: 'proj-1' }, '#/projects/proj-1'],
  ];

  it.each(cases)('builds %j as %s', (route, expected) => {
    expect(routeHref(route)).toBe(expected);
  });

  it('encodes an id containing a path separator so it cannot forge a segment', () => {
    expect(routeHref({ name: 'projects', projectId: 'a/b' })).toBe('#/projects/a%2Fb');
  });

  it('round-trips every href back to the same route', () => {
    for (const [route] of cases) {
      expect(parseRoute(routeHref(route))).toEqual(route);
    }
  });
});
