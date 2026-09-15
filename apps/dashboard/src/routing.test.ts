import { describe, expect, it } from 'vitest';

import { SIMPLE_ROUTES, parseRoute, routeHref, type DashboardRoute } from './routing.js';

describe('parseRoute', () => {
  it('defaults to pulse for empty, bare, and unknown hashes', () => {
    for (const hash of ['', '#', '#/', '#/unknown', 'garbage']) {
      expect(parseRoute(hash)).toEqual({ name: 'pulse' });
    }
  });

  it('resolves the two Phase 5B routes', () => {
    expect(parseRoute('#/pulse')).toEqual({ name: 'pulse' });
    expect(parseRoute('#/activity')).toEqual({ name: 'activity' });
  });

  it('resolves every parameterless route', () => {
    for (const name of SIMPLE_ROUTES) {
      expect(parseRoute(`#/${name}`)).toEqual({ name });
    }
  });

  it('does not resolve a parameterless route that carries an extra segment', () => {
    for (const name of SIMPLE_ROUTES) {
      expect(parseRoute(`#/${name}/extra`)).toEqual({ name: 'pulse' });
    }
  });

  it('resolves a correlation-scoped messages route', () => {
    expect(parseRoute('#/messages/corr%2F1')).toEqual({
      name: 'messages',
      correlationId: 'corr/1',
    });
    expect(parseRoute(`#/messages/${'a'.repeat(129)}`)).toEqual({ name: 'messages' });
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
    [{ name: 'pulse', projectId: 'proj-1' }, '#/pulse/proj-1'],
    [{ name: 'activity' }, '#/activity'],
    [{ name: 'sessions' }, '#/sessions'],
    [{ name: 'agents' }, '#/agents'],
    [{ name: 'messages' }, '#/messages'],
    [{ name: 'messages', correlationId: 'corr/1' }, '#/messages/corr%2F1'],
    [{ name: 'capabilities' }, '#/capabilities'],
    [{ name: 'config' }, '#/config'],
    [{ name: 'usage' }, '#/usage'],
    [{ name: 'context' }, '#/context'],
    [{ name: 'optimization' }, '#/optimization'],
    [{ name: 'graph' }, '#/graph'],
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

describe('overview focus route', () => {
  it('resolves the project the overview is focused on', () => {
    expect(parseRoute('#/pulse/proj-1')).toEqual({ name: 'pulse', projectId: 'proj-1' });
    expect(parseRoute('#/pulse/a%2Fb')).toEqual({ name: 'pulse', projectId: 'a/b' });
  });

  it('ignores what follows the project id rather than falling back to the whole runtime', () => {
    expect(parseRoute('#/pulse/proj-1/extra')).toEqual({ name: 'pulse', projectId: 'proj-1' });
  });

  it('drops an over-long or blank id and keeps the overview', () => {
    expect(parseRoute(`#/pulse/${'x'.repeat(129)}`)).toEqual({ name: 'pulse' });
    expect(parseRoute('#/pulse/%20')).toEqual({ name: 'pulse' });
  });

  it('encodes a project id containing a path separator', () => {
    expect(routeHref({ name: 'pulse', projectId: 'a/b' })).toBe('#/pulse/a%2Fb');
  });
});

describe('project-agent pair routes', () => {
  it('parses an agent selected inside a project', () => {
    expect(parseRoute('#/projects/proj-1/agents/agent-1')).toEqual({
      name: 'projects',
      projectId: 'proj-1',
      agentId: 'agent-1',
    });
  });

  it('round-trips a pair through routeHref', () => {
    const route = { name: 'projects', projectId: 'proj/1', agentId: 'agent 1' } as const;
    expect(routeHref(route)).toBe('#/projects/proj%2F1/agents/agent%201');
    expect(parseRoute(routeHref(route))).toEqual(route);
  });

  it('degrades an unknown sub-path to the project rather than to pulse', () => {
    expect(parseRoute('#/projects/proj-1/sessions/x')).toEqual({
      name: 'projects',
      projectId: 'proj-1',
    });
    expect(parseRoute('#/projects/proj-1/agents')).toEqual({
      name: 'projects',
      projectId: 'proj-1',
    });
  });

  it('rejects an over-long agent id without losing the project', () => {
    const route = parseRoute(`#/projects/proj-1/agents/${'a'.repeat(200)}`);
    expect(route).toEqual({ name: 'projects', projectId: 'proj-1' });
  });
});

describe('the knowledge route', () => {
  it('parses and builds the knowledge route with and without a project id', () => {
    expect(parseRoute('#/knowledge/p1')).toEqual({ name: 'knowledge', projectId: 'p1' });
    expect(parseRoute('#/knowledge')).toEqual({ name: 'knowledge' });
    expect(parseRoute('#/knowledge/')).toEqual({ name: 'knowledge' });
    expect(routeHref({ name: 'knowledge', projectId: 'p1' })).toBe('#/knowledge/p1');
    expect(routeHref({ name: 'knowledge' })).toBe('#/knowledge');
    // an id containing a slash is encoded, not forged into a segment
    expect(routeHref({ name: 'knowledge', projectId: 'a/b' })).toBe('#/knowledge/a%2Fb');
  });
});

describe('the overview detail drawer route', () => {
  it('parses the detail drawer, with and without an agent, and degrades bad segments', () => {
    expect(parseRoute('#/pulse/p1/detail')).toEqual({ name: 'pulse', projectId: 'p1', detail: {} });
    expect(parseRoute('#/pulse/p1/detail/a1')).toEqual({
      name: 'pulse',
      projectId: 'p1',
      detail: { agentId: 'a1' },
    });
    // An unknown third segment is the focus alone; an over-long agent id is the drawer alone.
    expect(parseRoute('#/pulse/p1/other')).toEqual({ name: 'pulse', projectId: 'p1' });
    expect(parseRoute(`#/pulse/p1/detail/${'a'.repeat(129)}`)).toEqual({
      name: 'pulse',
      projectId: 'p1',
      detail: {},
    });
  });

  it('round-trips through routeHref with encoded ids', () => {
    for (const route of [
      { name: 'pulse', projectId: 'p/1', detail: {} },
      { name: 'pulse', projectId: 'p1', detail: { agentId: 'a/1' } },
    ] satisfies DashboardRoute[]) {
      expect(parseRoute(routeHref(route))).toEqual(route);
    }
    expect(routeHref({ name: 'pulse', projectId: 'p1', detail: {} })).toBe('#/pulse/p1/detail');
  });
});
