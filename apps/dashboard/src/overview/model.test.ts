import { describe, expect, it } from 'vitest';

import { buildPulseSnapshot, type PulseInput } from '../pulse/model.js';
import type { DashboardEvent } from '../realtime/schema.js';
import {
  blockedEvidence,
  buildOverview,
  eventDetail,
  formatClock,
  formatDuration,
  formatTokens,
  layoutFlow,
  layoutRadial,
  layoutTimeline,
  NOW_FRACTION,
  panelFor,
  planTiles,
  resolveFocus,
  RUNTIME_FOCUS,
  sessionBadge,
  toneOf,
  type TimelineBar,
  type TimelineLane,
} from './model.js';

const NOW = Date.parse('2026-09-11T10:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const event = (
  streamId: string,
  type: string,
  minutes: number,
  extra: Partial<DashboardEvent> = {},
): DashboardEvent => ({
  streamId,
  id: `evt-${streamId}`,
  version: 1,
  type,
  occurredAt: minutesAgo(minutes),
  workspaceId: 'local',
  payload: {},
  ...extra,
});

/**
 * Two projects, four sessions, a retained window of five minutes. Alpha holds
 * a thinking session and a blocked one whose lease was denied; Beta a waiting
 * session; a completed session ended an hour ago.
 */
function input(): PulseInput {
  return {
    measuredLatencyMs: 12,
    snapshotAt: new Date(NOW).toISOString(),
    health: {
      state: 'ready',
      data: {
        status: 'ok',
        runtimeState: 'ready',
        uptimeMs: 6 * 3_600_000 + 4 * 60_000,
        redis: { connected: true, status: 'connected', latencyMs: 2 },
      },
    },
    runtime: {
      state: 'ready',
      data: {
        workspaceId: 'local',
        version: '0.4.2',
        protocolVersion: 1,
        runtimeState: 'ready',
        runtimeInstanceId: 'inst',
        startedAt: minutesAgo(400),
        uptimeMs: 6 * 3_600_000,
        host: '127.0.0.1',
        port: 4782,
      },
    },
    projects: {
      state: 'ready',
      data: [
        { id: 'p1', name: 'Alpha Project', localPath: 'C:/a' },
        { id: 'p2', name: 'Beta', localPath: 'C:/b' },
        { id: 'p3', name: 'Gamma', localPath: 'C:/c' },
      ],
    },
    git: {
      state: 'ready',
      data: {
        truncated: false,
        entries: [
          {
            projectId: 'p1',
            git: {
              state: 'ready',
              data: {
                branch: 'feature/graph',
                headSha: '31c4f54abcdef0123456',
                clean: false,
                untrackedCount: 3,
                tagCount: 2,
                observedAt: minutesAgo(1),
              },
            },
          },
          { projectId: 'p2', git: { state: 'not-observed' } },
        ],
      },
    },
    sessions: {
      state: 'ready',
      data: [
        {
          id: 's-think',
          agentId: 'a1',
          projectId: 'p1',
          status: 'thinking',
          presence: 'online',
          startedAt: minutesAgo(84),
          lastHeartbeatAt: minutesAgo(0),
          branch: 'feature/graph',
          taskSummary: 'Implement graph generation transition',
          metadata: { model: 'model-x' },
        },
        {
          id: 's-blocked',
          agentId: 'a2',
          projectId: 'p1',
          status: 'blocked',
          presence: 'online',
          startedAt: minutesAgo(38),
          lastHeartbeatAt: minutesAgo(1),
        },
        {
          id: 's-wait',
          agentId: 'a1',
          projectId: 'p2',
          status: 'waiting_for_input',
          presence: 'online',
          startedAt: minutesAgo(13),
          lastHeartbeatAt: minutesAgo(0),
        },
        {
          id: 's-done',
          agentId: 'a2',
          projectId: 'p1',
          status: 'completed',
          presence: 'offline',
          startedAt: minutesAgo(200),
          lastHeartbeatAt: minutesAgo(150),
        },
      ],
    },
    agents: {
      state: 'ready',
      data: [
        {
          id: 'a1',
          kind: 'other',
          displayName: 'Runner One',
          adapterId: 'adapter-x',
          enabled: true,
          updatedAt: minutesAgo(10),
        },
      ],
    },
    usage: {
      state: 'ready',
      data: [
        { source: 'agent-exact', recordCount: 4, totalTokens: 18_400 },
        { source: 'agent-reported', recordCount: 2, totalTokens: 7_200 },
        { source: 'unavailable', recordCount: 1 },
      ],
    },
    context: {
      state: 'ready',
      data: [
        { sessionId: 's-think', assigned: true, effective: true, loaded: true, invoked: true },
        { sessionId: 's-think', assigned: true, effective: true, loaded: true, invoked: false },
        { assigned: 'unknown', effective: 'unknown', loaded: 'unknown', invoked: 'unknown' },
      ],
    },
    activity: { state: 'ready', data: [] },
    findings: { state: 'ready', data: [] },
  };
}

const events = (): DashboardEvent[] => [
  event('1-0', 'session.registered', 5, { projectId: 'p1', sessionId: 's-think', agentId: 'a1' }),
  event('2-0', 'context.capability.loaded', 4, {
    projectId: 'p1',
    sessionId: 's-think',
    agentId: 'a1',
  }),
  event('3-0', 'lease.denied', 3, {
    projectId: 'p1',
    sessionId: 's-blocked',
    agentId: 'a2',
    payload: { leaseId: 'lease-1', path: 'src/inventory/packages.ts', reason: 'edit' },
  }),
  event('4-0', 'session.heartbeat', 1, { projectId: 'p2', sessionId: 's-wait', agentId: 'a1' }),
  event('5-0', 'git.observed', 0, {
    projectId: 'p1',
    payload: { headSha: '31c4f54abcdef0123456' },
  }),
];

const overview = () => buildOverview(buildPulseSnapshot(input()), events(), NOW);

describe('tones and badges', () => {
  it('maps the nine statuses to five tones and leaves labels alone', () => {
    expect(toneOf('thinking')).toBe('working');
    expect(toneOf('tool_running')).toBe('working');
    expect(toneOf('blocked')).toBe('blocked');
    expect(toneOf('waiting_for_agent')).toBe('waiting');
    expect(toneOf('starting')).toBe('waiting');
    expect(toneOf('idle')).toBe('quiet');
    expect(toneOf('completed')).toBe('done');
    expect(toneOf('something-new')).toBe('quiet');
  });

  it('derives a badge from sessions only, with blocked outranking a count', () => {
    const model = overview();
    const alpha = model.projects.find((project) => project.id === 'p1');
    const beta = model.projects.find((project) => project.id === 'p2');
    const gamma = model.projects.find((project) => project.id === 'p3');
    expect(alpha?.badge).toEqual({ label: '1 BLOCKED', tone: 'ink' });
    expect(beta?.badge).toEqual({ label: '1 ACTIVE', tone: 'outline' });
    expect(gamma?.badge).toEqual({ label: 'QUIET', tone: 'dim' });
    expect(sessionBadge([])).toEqual({ label: 'QUIET', tone: 'dim' });
  });
});

describe('buildOverview', () => {
  it('states the observed branch as the project eyebrow and the reason when there is none', () => {
    const model = overview();
    expect(model.projects.map((project) => project.eyebrow)).toEqual([
      'FEATURE/GRAPH',
      'NOT OBSERVED',
      'GIT UNAVAILABLE',
    ]);
  });

  it('keeps active and observed sessions apart and counts retained events per subject', () => {
    const model = overview();
    expect(model.sessions.map((session) => session.id)).toEqual(['s-wait', 's-blocked', 's-think']);
    expect(model.allSessions).toHaveLength(4);
    const alpha = model.projects.find((project) => project.id === 'p1');
    expect(alpha?.sessions).toHaveLength(2);
    expect(alpha?.allSessions).toHaveLength(3);
    expect(alpha?.eventCount).toBe(4);
    expect(alpha?.working).toBe(true);
    expect(alpha?.blocked).toBe(true);
    expect(model.agents.map((agent) => [agent.id, agent.name, agent.known])).toEqual([
      ['a1', 'Runner One', true],
      ['a2', 'a2', false],
    ]);
    expect(model.agents[0]?.models).toEqual(['model-x']);
  });

  it('lists the statuses present in vocabulary order, never a "running"', () => {
    const model = overview();
    expect(model.statuses.map((status) => status.status)).toEqual([
      'thinking',
      'waiting_for_input',
      'blocked',
    ]);
    expect(model.statuses.map((status) => status.label)).toEqual([
      'thinking',
      'waiting for input',
      'blocked',
    ]);
  });

  it('reports the rate over the retained span and never as a per-minute figure under a minute', () => {
    const model = overview();
    expect(model.rate.total).toBe(5);
    expect(model.rate.spanLabel).toBe('5m');
    expect(model.rate.perMinute).toBeCloseTo(1, 5);
    expect(model.rate.label).toBe('1.0');

    const burst = buildOverview(
      buildPulseSnapshot(input()),
      [event('1-0', 'a', 0.1), event('2-0', 'b', 0.2)],
      NOW,
    );
    expect(burst.rate.perMinute).toBeUndefined();
    expect(burst.rate.label).toMatch(/^2 in /u);
  });

  it('shows the four newest events first, with a payload detail and the project name', () => {
    const model = overview();
    expect(model.ticker.map((row) => row.type)).toEqual([
      'git.observed',
      'session.heartbeat',
      'lease.denied',
      'context.capability.loaded',
    ]);
    expect(model.ticker[2]?.detail).toBe('src/inventory/packages.ts');
    expect(model.ticker[2]?.project).toBe('Alpha Project');
    expect(model.ticker[0]?.detail).toBe('31c4f54abcde');
  });

  it('never sums tokens across grades and labels the figure with its grade', () => {
    const tokens = overview().stats.find((stat) => stat.key === 'tokens');
    expect(tokens?.label).toBe('Tokens · exact');
    expect(tokens?.value).toBe('18.4k');
    expect(tokens?.sub).toBe('reported 7.2k');
    expect(tokens?.sub).not.toContain('25.6');
  });

  it('renders an unavailable read as a dash with the word, never as zero', () => {
    const failed = input();
    failed.sessions = { state: 'unavailable' };
    failed.usage = { state: 'unavailable' };
    failed.context = { state: 'unavailable' };
    failed.projects = { state: 'unavailable' };
    failed.activity = { state: 'unavailable' };
    const model = buildOverview(buildPulseSnapshot(failed), [], NOW);
    for (const key of ['sessions', 'projects', 'tokens', 'context', 'events']) {
      const stat = model.stats.find((candidate) => candidate.key === key);
      expect(stat?.value, key).toBe('—');
      expect(stat?.unavailable, key).toBe(true);
      expect(stat?.sub, key).toMatch(/unavailable/u);
    }
    expect(model.health.label).toBe('HEALTHY');
  });

  it('breaks the sessions stat down by real status words', () => {
    const sessions = overview().stats.find((stat) => stat.key === 'sessions');
    expect(sessions?.value).toBe('3');
    expect(sessions?.sub).toBe('1 thinking · 1 waiting for input · 1 blocked');
    const context = overview().stats.find((stat) => stat.key === 'context');
    expect(context?.value).toBe('2');
    expect(context?.sub).toBe('1 invoked · 1 loaded, never invoked');
  });

  it('gives no Redis verdict without a daemon answer', () => {
    const offline = input();
    offline.health = { state: 'unavailable' };
    const model = buildOverview(buildPulseSnapshot(offline), [], NOW);
    expect(model.health).toEqual({ label: 'OFFLINE', daemon: 'Daemon offline' });
  });
});

describe('panelFor', () => {
  it('describes the runtime with health words, facts and the active sessions', () => {
    const panel = panelFor(overview(), RUNTIME_FOCUS, 'live');
    expect(panel.title).toBe('Luwi Runtime');
    expect(panel.badge).toEqual({ label: 'HEALTHY', tone: 'ink' });
    expect(panel.sub).toBe('Daemon online · Redis connected · 2 ms · Realtime live');
    expect(panel.facts).toEqual([
      { k: 'Uptime', v: '6h 04m' },
      { k: 'Redis', v: '2 ms' },
      { k: 'Version', v: '0.4.2' },
    ]);
    expect(panel.list.rows.map((row) => row.id)).toEqual(['s-wait', 's-blocked', 's-think']);
    expect(panel.block).toBeUndefined();
  });

  it('explains a blocked project from the newest lease denial for that session', () => {
    const panel = panelFor(overview(), { kind: 'project', id: 'p1' }, 'live');
    expect(panel.eyebrow).toBe('FEATURE/GRAPH');
    expect(panel.badge.label).toBe('1 BLOCKED');
    expect(panel.sub).toBe('2 active · 3 observed · HEAD 31c4f54');
    expect(panel.block?.title).toBe('Lease denied on src/inventory/packages.ts');
    expect(panel.block?.rows).toEqual([
      ['Denied', '3m ago'],
      ['Reason', 'edit'],
      ['Lease', 'lease-1'],
      ['Session', 'heartbeat 1m ago'],
    ]);
    expect(panel.facts).toEqual([
      { k: 'HEAD', v: '31c4f54' },
      { k: 'State', v: '3 untracked' },
      { k: 'Tags', v: '2' },
    ]);
    expect(panel.links.map((link) => link.kind)).toEqual(['inspect-project', 'route']);
  });

  it('says so when a blocked session has no denial in the retained stream', () => {
    const model = overview();
    const blocked = model.allSessions.find((session) => session.id === 's-blocked');
    expect(blocked).toBeDefined();
    if (blocked === undefined) return;
    const block = blockedEvidence(blocked, [], NOW);
    expect(block.title).toBe('Session reports blocked');
    expect(block.rows[0]).toEqual(['Evidence', 'No lease denial in the retained stream']);
  });

  it('describes a session by what it reported and lists the rest of its project', () => {
    const panel = panelFor(overview(), { kind: 'session', id: 's-think' }, 'live');
    expect(panel.title).toBe('Implement graph generation transition');
    expect(panel.eyebrow).toBe('Alpha Project · Runner One');
    expect(panel.badge).toEqual({ label: 'THINKING', tone: 'ink' });
    // Context is the session's prompt size; the skills evidence sits in the detail.
    expect(panel.facts).toEqual([
      { k: 'Model', v: 'model-x' },
      { k: 'Tokens', v: '\u2014' },
      { k: 'Context', v: '\u2014', detail: 'skills 2 loaded \u00b7 1 invoked' },
    ]);
    expect(panel.copyId).toEqual({ label: 'session', id: 's-think' });
    expect(panel.list.rows.map((row) => row.id)).toEqual(['s-blocked', 's-done']);
    expect(panel.list.selectedId).toBe('s-think');
  });

  it('takes a session model and tokens from its attributed usage when it declared none', () => {
    const focus = { kind: 'session', id: 's-blocked' } as const;
    const ready = {
      sessionId: 's-blocked',
      state: {
        state: 'ready' as const,
        data: {
          models: ['model-y', 'model-z'],
          sources: [
            { source: 'agent-reported', label: 'reported', records: 1 },
            { source: 'adapter-extracted', label: 'extracted', records: 3, totalTokens: 18_400 },
          ],
          counters: {},
          recordCount: 4,
          truncated: true,
        },
      },
    };
    expect(panelFor(overview(), focus, 'live', { sessionUsage: ready }).facts.slice(0, 2)).toEqual([
      { k: 'Model', v: 'model-y, model-z' },
      { k: 'Tokens', v: '18.4k extracted+' },
    ]);
    // Extracted records report counters and no total: each counter is summed on
    // its own, and the newest request's prompt is the context the session carries.
    const counted = {
      sessionId: 's-blocked',
      state: {
        state: 'ready' as const,
        data: {
          models: ['model-new', 'model-old'],
          latestModel: 'model-new',
          sources: [{ source: 'adapter-extracted', label: 'extracted', records: 2 }],
          counters: { input: 102, output: 4740, cacheCreation: 4124, cacheRead: 508_374 },
          latestContext: { tokens: 511_600, observedAt: minutesAgo(50) },
          recordCount: 2,
          truncated: false,
        },
      },
    };
    expect(panelFor(overview(), focus, 'live', { sessionUsage: counted }).facts).toEqual([
      { k: 'Model', v: 'model-new' },
      {
        k: 'Tokens',
        v: '4.7k out · 4.2k in',
        detail:
          'output 4,740 · input 102 · cache written 4,124 · cache read 508,374 · over 2 records',
      },
      {
        k: 'Context',
        v: '511.6k',
        detail: `latest request sent 511,600 tokens · observed ${formatClock(NOW - 50 * 60_000)} · skills not observed`,
      },
    ]);
    const loading = { sessionId: 's-blocked', state: { state: 'loading' as const } };
    expect(
      panelFor(overview(), focus, 'live', { sessionUsage: loading }).facts.slice(0, 2),
    ).toEqual([
      { k: 'Model', v: 'loading\u2026' },
      { k: 'Tokens', v: 'loading\u2026' },
    ]);
    const failed = { sessionId: 's-blocked', state: { state: 'unavailable' as const } };
    expect(panelFor(overview(), focus, 'live', { sessionUsage: failed }).facts[1]).toEqual({
      k: 'Tokens',
      v: 'unavailable',
    });
    // Another session's usage is never shown under this one.
    const other = { ...ready, sessionId: 's-think' };
    expect(panelFor(overview(), focus, 'live', { sessionUsage: other }).facts[0]).toEqual({
      k: 'Model',
      v: '\u2014',
    });
    // Only a session offers its id to copy; the project head names the project.
    expect(panelFor(overview(), { kind: 'project', id: 'p1' }, 'live').copyId).toBeUndefined();
  });

  it('describes an agent across its projects and marks an id no definition covers', () => {
    const panel = panelFor(overview(), { kind: 'agent', id: 'a2' }, 'live');
    expect(panel.eyebrow).toBe('Unregistered agent id');
    expect(panel.title).toBe('a2');
    expect(panel.sub).toBe('1 active sessions across 1 project');
    expect(panel.facts).toEqual([
      { k: 'Models', v: '—' },
      { k: 'Waiting', v: '0' },
      { k: 'Blocked', v: '1' },
    ]);
  });

  it('falls back to the runtime when the focused subject is gone', () => {
    const model = overview();
    expect(resolveFocus(model, { kind: 'project', id: 'nope' })).toEqual(RUNTIME_FOCUS);
    expect(panelFor(model, { kind: 'session', id: 'nope' }, 'live').title).toBe('Luwi Runtime');
  });
});

describe('board tiles', () => {
  it('sizes tiles by work: blocked first and largest, active wide, quiet small', () => {
    const tiles = planTiles(overview().projects);
    expect(tiles.map((tile) => [tile.project.id, tile.span, tile.rows])).toEqual([
      ['p1', 2, 2],
      ['p2', 2, 1],
      ['p3', 1, 1],
    ]);
  });
});

describe('flow layout', () => {
  it('draws two ribbons per active session and scales the unit to fit', () => {
    const layout = layoutFlow(overview(), RUNTIME_FOCUS);
    expect(layout.ribbons).toHaveLength(6);
    expect(layout.unit).toBeLessThanOrEqual(46);
    expect(layout.projects.find((node) => node.key === 'project:p3')?.quiet).toBe(true);
    expect(layout.statuses.map((node) => node.label)).toEqual([
      'THINKING',
      'WAITING FOR INPUT',
      'BLOCKED',
    ]);
    expect(layout.ribbons.every((ribbon) => !ribbon.dim)).toBe(true);
  });

  it('dims what an agent focus does not relate to', () => {
    const layout = layoutFlow(overview(), { kind: 'agent', id: 'a2' });
    const dimmed = layout.ribbons.filter((ribbon) => ribbon.dim).map((ribbon) => ribbon.sessionId);
    expect(new Set(dimmed)).toEqual(new Set(['s-wait', 's-think']));
    expect(layout.agents.find((node) => node.key === 'agent:a2')?.selected).toBe(true);
    expect(layout.projects.find((node) => node.key === 'project:p2')?.dim).toBe(true);
  });
});

describe('radial layout', () => {
  it('orbits the projects around the rate and shares the arc against the busiest', () => {
    const layout = layoutRadial(overview(), RUNTIME_FOCUS);
    expect(layout.nodes.map((node) => node.key)).toEqual(['p1', 'p2', 'p3']);
    expect(layout.nodes[0]?.share).toBe(1);
    expect(layout.nodes[1]?.share).toBe(0.25);
    expect(layout.nodes[0]?.dots.map((dot) => dot.tone)).toEqual(['blocked', 'working']);
    expect(layout.nodes[0]?.packets).toBe(1);
    expect(layout.nodes[0]?.blocked).toBe(true);
    expect(layout.centre.big).toBe('1.0');
    expect(layout.centre.ink).toBe(false);
  });

  it('puts a focused project in the centre and its sessions on the orbit', () => {
    const layout = layoutRadial(overview(), { kind: 'project', id: 'p1' });
    expect(layout.centre).toMatchObject({ big: 'AP', small: '1 BLOCKED', ink: true });
    expect(layout.nodes.map((node) => node.key)).toEqual(['s-blocked', 's-think']);
    expect(layout.nodes[1]?.sub).toBe('FEATURE/GRAPH');
  });

  it('hints a session node with its GUI title, falling back to the session id', () => {
    // The orbit carries only initials, so the hover hint is the only place the
    // native GUI chat title names which session a node is.
    const projects = layoutRadial(overview(), RUNTIME_FOCUS);
    expect(projects.nodes[0]?.hint).toBe('Alpha Project · 2 sessions');

    // No session in the fixture reported a GUI title, so the hint falls back to the
    // session id — never the task subject, which is a different thing.
    const untitled = layoutRadial(overview(), { kind: 'project', id: 'p1' });
    expect(untitled.nodes[1]?.hint).toBe('Runner One · thinking · Session s-think');
    expect(untitled.nodes[1]?.hint).not.toContain('Implement graph generation transition');
    expect(untitled.nodes[0]?.hint).toBe('a2 · blocked · Session s-blocked');

    // When the attach did report a GUI title, that title names the node.
    const base = overview();
    const titled = layoutRadial(
      {
        ...base,
        projects: base.projects.map((project) =>
          project.id === 'p1'
            ? {
                ...project,
                sessions: project.sessions.map((session) =>
                  session.id === 's-think'
                    ? { ...session, title: 'Investigate R3-3 hardening' }
                    : session,
                ),
              }
            : project,
        ),
      },
      { kind: 'project', id: 'p1' },
    );
    expect(titled.nodes[1]?.hint).toBe('Runner One · thinking · Investigate R3-3 hardening');
  });
});

describe('timeline layout', () => {
  const barIds = (lane: TimelineLane | undefined): string[] =>
    (lane?.items ?? []).flatMap((item) => (item.kind === 'bar' ? [item.session.id] : []));

  it('clips bars to the window, excludes what ended before it, and marks denials', () => {
    const layout = layoutTimeline(overview(), 90, RUNTIME_FOCUS);
    const alpha = layout.lanes.find((lane) => lane.project.id === 'p1');
    expect(barIds(alpha)).toEqual(['s-think', 's-blocked']);
    const thinking = alpha?.items.find(
      (item): item is TimelineBar => item.kind === 'bar' && item.session.id === 's-think',
    );
    expect(thinking?.x0).toBeCloseTo(NOW_FRACTION * (1 - 84 / 90), 5);
    expect(thinking?.x1).toBe(NOW_FRACTION);
    expect(thinking?.duration).toBe('1h 24m');
    expect(alpha?.marks).toHaveLength(1);
    expect(alpha?.marks[0]?.title).toBe('lease.denied src/inventory/packages.ts');
    expect(alpha?.rows).toBe(2);
    expect(layout.hist).toHaveLength(30);
    expect(layout.total).toBe(5);
    expect(layout.windowLabel).toBe('90 min');
  });

  it('brings a completed session back into a wider window and labels the week by day', () => {
    const day = layoutTimeline(overview(), 1440, RUNTIME_FOCUS);
    const alpha = day.lanes.find((lane) => lane.project.id === 'p1');
    expect(barIds(alpha)).toEqual(['s-done', 's-think', 's-blocked']);
    expect(day.hist).toHaveLength(96);
    expect(day.axis.length).toBeGreaterThan(3);
    const week = layoutTimeline(overview(), 10080, RUNTIME_FOCUS);
    expect(week.hist).toHaveLength(168);
    expect(week.axis[0]?.label).toMatch(/^\d{2}\.\d{2}$/u);
  });

  it('folds terminal sessions too narrow to label into one counted cluster, never an active one', () => {
    const value = input();
    const short = (id: string, startMinutesAgo: number, agentId = 'a1') => ({
      id,
      agentId,
      projectId: 'p2',
      status: 'completed',
      presence: 'offline' as const,
      startedAt: minutesAgo(startMinutesAgo),
      lastHeartbeatAt: minutesAgo(startMinutesAgo - 5),
    });
    if (value.sessions.state === 'ready') {
      value.sessions.data.push(
        short('c1', 200),
        short('c2', 194),
        short('c3', 188),
        short('c4', 182, 'a2'),
      );
    }
    const day = layoutTimeline(
      buildOverview(buildPulseSnapshot(value), events(), NOW),
      1440,
      RUNTIME_FOCUS,
    );
    const beta = day.lanes.find((lane) => lane.project.id === 'p2');
    const cluster = beta?.items.find((item) => item.kind === 'cluster');
    expect(cluster?.kind).toBe('cluster');
    if (cluster?.kind !== 'cluster') return;
    expect(cluster.sessions.map((session) => session.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(cluster.label).toBe('\u00d74');
    expect(cluster.title).toMatch(/^4 sessions \u00b7 RO \u00d73 \u00b7 A2 \u00d71 \u00b7 /u);
    // The waiting session is active, so it stays its own bar beside the cluster.
    expect(barIds(beta)).toEqual(['s-wait']);
    // Packed by what is drawn: the cluster and the bar do not share a row unless they clear each other.
    const rowsUsed = new Set(beta?.items.map((item) => item.row));
    expect(rowsUsed.size).toBe(beta?.rows);
  });

  it('never lets two drawn items overlap in one row', () => {
    const value = input();
    if (value.sessions.state === 'ready') {
      for (let index = 0; index < 6; index += 1) {
        value.sessions.data.push({
          id: `t${String(index)}`,
          agentId: 'a1',
          projectId: 'p3',
          status: 'completed',
          presence: 'offline',
          startedAt: minutesAgo(600 - index),
          lastHeartbeatAt: minutesAgo(599 - index),
        });
      }
    }
    const week = layoutTimeline(
      buildOverview(buildPulseSnapshot(value), [], NOW),
      10080,
      RUNTIME_FOCUS,
    );
    const gamma = week.lanes.find((lane) => lane.project.id === 'p3');
    const byRow = new Map<number, Array<{ x0: number; x1: number }>>();
    for (const item of gamma?.items ?? []) {
      const row = byRow.get(item.row) ?? [];
      row.push({ x0: item.x0, x1: item.x1 });
      byRow.set(item.row, row);
    }
    for (const row of byRow.values()) {
      const sorted = [...row].sort((left, right) => left.x0 - right.x0);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]!.x0).toBeGreaterThanOrEqual(sorted[index - 1]!.x1);
      }
    }
    // Six one-minute sessions a minute apart at 7 d are one cluster of six.
    expect(gamma?.items).toHaveLength(1);
    expect(gamma?.items[0]?.kind).toBe('cluster');
  });
});

describe('formatting', () => {
  it('formats durations, tokens and event details honestly', () => {
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(5 * 60_000)).toBe('5m');
    expect(formatDuration(26 * 3_600_000)).toBe('1d 02h');
    expect(formatDuration(-1)).toBe('unavailable');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(18_400)).toBe('18.4k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(eventDetail(event('1-0', 'x', 0, { sessionId: 'abcdef12-3456' }))).toBe('abcdef12');
    expect(eventDetail(event('1-0', 'x', 0))).toBe('');
  });
});
