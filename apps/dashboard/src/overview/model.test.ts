import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../api/messages-scope.js';
import { buildPulseSnapshot, type PulseInput } from '../pulse/model.js';
import type { DashboardEvent } from '../realtime/schema.js';
import {
  autopilotFlowPanel,
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
  type AutopilotFlowState,
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
                recentCommitCount: 7,
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

describe('coordinator role in the drill-down (ADR 0035)', () => {
  const withHolder = (sessionId: string, live: boolean): PulseInput => ({
    ...input(),
    coordinator: {
      state: 'ready',
      data: {
        truncated: false,
        entries: [{ projectId: 'p1', coordinator: { state: 'ready', data: { sessionId, live } } }],
      },
    },
  });
  const model = (source: PulseInput) => buildOverview(buildPulseSnapshot(source), events(), NOW);
  const coordinatorFactOf = (panel: ReturnType<typeof panelFor>) =>
    panel.facts.find((fact) => fact.k === 'Coordinator')?.v;

  it('states the live holder on the project panel, named as its row is, and none when free', () => {
    const held = panelFor(
      model(withHolder('s-think', true)),
      { kind: 'project', id: 'p1' },
      'live',
    );
    expect(coordinatorFactOf(held)).toBe('Implement graph generation transition');
    expect(coordinatorFactOf(panelFor(overview(), { kind: 'project', id: 'p1' }, 'live'))).toBe(
      'none',
    );
  });

  it('offers Release to the holder, and hides Make coordinator while the role is held (no evicting a live holder)', () => {
    const held = model(withHolder('s-think', true));
    const holder = panelFor(held, { kind: 'session', id: 's-think' }, 'live');
    expect(coordinatorFactOf(holder)).toBe('this session');
    expect(holder.links).toContainEqual({
      kind: 'coordinator',
      label: 'Release role',
      action: 'release',
      projectId: 'p1',
      sessionId: 's-think',
    });
    // A live holder cannot be evicted, so another active session is offered no
    // claim (the button that would only 409) — it still reads who holds the role.
    const other = panelFor(held, { kind: 'session', id: 's-blocked' }, 'live');
    expect(coordinatorFactOf(other)).toBe('Implement graph generation transition');
    expect(other.links.some((link) => link.kind === 'coordinator')).toBe(false);
    const done = panelFor(held, { kind: 'session', id: 's-done' }, 'live');
    expect(done.links.some((link) => link.kind === 'coordinator')).toBe(false);
  });

  it('reads a terminal holder as none, so the role is shown as takeable', () => {
    const panel = panelFor(
      model(withHolder('s-done', false)),
      { kind: 'project', id: 'p1' },
      'live',
    );
    expect(coordinatorFactOf(panel)).toBe('none');
    const other = panelFor(
      model(withHolder('s-done', false)),
      { kind: 'session', id: 's-think' },
      'live',
    );
    expect(other.links.some((link) => link.kind === 'coordinator' && link.action === 'claim')).toBe(
      true,
    );
  });
});

describe('autopilot mode switch in the drill-down (ADR 0035)', () => {
  const autopilotFactOf = (panel: ReturnType<typeof panelFor>) =>
    panel.facts.find((fact) => fact.k === 'Autopilot');

  it('states the mode and offers only the other modes, once the mode is read', () => {
    const panel = panelFor(overview(), { kind: 'project', id: 'p1' }, 'live', {
      autopilot: {
        projectId: 'p1',
        state: {
          state: 'ready',
          data: { mode: 'supervised', configured: true, coordinatorOnline: true },
        },
      },
    });
    expect(autopilotFactOf(panel)).toEqual({
      k: 'Autopilot',
      v: 'supervised',
      detail: 'supervised · policy set · coordinator online',
    });
    expect(panel.links.filter((link) => link.kind === 'autopilot')).toEqual([
      { kind: 'autopilot', label: 'Turn off', mode: 'off', projectId: 'p1' },
      { kind: 'autopilot', label: 'Enable autopilot', mode: 'autopilot', projectId: 'p1' },
    ]);
  });

  it('reads as a dash with no links until the shell reads the mode', () => {
    const panel = panelFor(overview(), { kind: 'project', id: 'p1' }, 'live');
    expect(autopilotFactOf(panel)).toEqual({ k: 'Autopilot', v: '—' });
    expect(panel.links.some((link) => link.kind === 'autopilot')).toBe(false);
    const loading = panelFor(overview(), { kind: 'project', id: 'p1' }, 'live', {
      autopilot: { projectId: 'p1', state: { state: 'loading' } },
    });
    expect(autopilotFactOf(loading)?.v).toBe('loading…');
    expect(loading.links.some((link) => link.kind === 'autopilot')).toBe(false);
  });
});

// The drill-down no longer draws the flow (the LuwiBot cockpit does); the model is the cockpit's.
describe('autopilotFlowPanel (ADR 0035)', () => {
  const flowOf = (state: AutopilotFlowState) =>
    autopilotFlowPanel({ autopilotFlow: { projectId: 'p1', state } }, 'p1');

  it('maps active goals and tasks to toned chips in plan order', () => {
    const flow = flowOf({
      state: 'ready',
      data: {
        more: 1,
        goals: [
          {
            id: 'g1',
            title: 'Ship admin',
            objective: 'Localize the admin dates',
            acceptanceCriteria: ['Dates render in the local timezone'],
            state: 'running',
            tasks: [
              {
                id: 't1',
                kind: 'work',
                title: 'Localize date rendering',
                brief: 'Format dates through the user locale.',
                paths: ['apps/admin/dates.ts'],
                doneCriteria: 'All admin dates show the local timezone.',
                agentId: 'antigravity',
                state: 'dispatched',
                verdict: undefined,
              },
              {
                id: 't2',
                kind: 'review',
                title: 'Review the date change',
                brief: 'Confirm the fix and run the tests.',
                paths: [],
                agentId: 'codex',
                state: 'done',
                verdict: 'accept',
              },
            ],
          },
        ],
      },
    });
    expect(flow).toEqual({
      status: 'ready',
      more: 1,
      goals: [
        {
          id: 'g1',
          title: 'Ship admin',
          objective: 'Localize the admin dates',
          acceptanceCriteria: ['Dates render in the local timezone'],
          state: { label: 'running', tone: 'info' },
          tasks: [
            {
              id: 't1',
              label: 'work · antigravity',
              title: 'Localize date rendering',
              detail: {
                agent: 'antigravity',
                brief: 'Format dates through the user locale.',
                paths: ['apps/admin/dates.ts'],
                doneCriteria: 'All admin dates show the local timezone.',
              },
              state: { label: 'dispatched', tone: 'info' },
            },
            {
              id: 't2',
              label: 'review · codex',
              title: 'Review the date change',
              detail: { agent: 'codex', brief: 'Confirm the fix and run the tests.', paths: [] },
              state: { label: 'done', tone: 'success' },
              verdict: { label: 'accept', tone: 'success' },
            },
          ],
        },
      ],
    });
  });

  it('spells a task with no agent and underscores as words', () => {
    const flow = flowOf({
      state: 'ready',
      data: {
        more: 0,
        goals: [
          {
            id: 'g1',
            title: 'g',
            acceptanceCriteria: [],
            state: 'plan_review',
            tasks: [
              {
                id: 't1',
                kind: 'work',
                title: 'Do the thing',
                brief: 'No agent assigned yet.',
                paths: [],
                agentId: undefined,
                state: 'awaiting_approval',
                verdict: undefined,
              },
            ],
          },
        ],
      },
    });
    expect(flow?.goals[0]?.state).toEqual({ label: 'plan review', tone: 'warning' });
    expect(flow?.goals[0]?.tasks[0]).toEqual({
      id: 't1',
      label: 'work · unassigned',
      title: 'Do the thing',
      detail: { agent: 'unassigned', brief: 'No agent assigned yet.', paths: [] },
      state: { label: 'awaiting approval', tone: 'warning' },
    });
  });

  it('is empty when nothing is in flight, and absent when no read is wired', () => {
    expect(flowOf({ state: 'ready', data: { goals: [], more: 0 } })?.status).toBe('empty');
    expect(flowOf({ state: 'loading' })?.status).toBe('loading');
    expect(flowOf({ state: 'unavailable' })?.status).toBe('unavailable');
    expect(autopilotFlowPanel({}, 'p1')).toBeUndefined();
    expect(panelFor(overview(), { kind: 'project', id: 'p1' }, 'live')).not.toHaveProperty('flow');
  });
});

describe('flow roles in the drill-down (ADR 0036)', () => {
  const withRoles = (): PulseInput => ({
    ...input(),
    bindings: {
      state: 'ready',
      data: {
        truncated: false,
        entries: [
          {
            projectId: 'p1',
            bindings: {
              state: 'ready',
              data: [
                { agentId: 'a2', enabled: true, flowRoles: ['verifier'] },
                { agentId: 'a1', enabled: true, flowRoles: ['implementer'] },
              ],
            },
          },
        ],
      },
    },
  });
  const model = (source: PulseInput) => buildOverview(buildPulseSnapshot(source), events(), NOW);
  const factOf = (panel: ReturnType<typeof panelFor>, key: string) =>
    panel.facts.find((fact) => fact.k === key)?.v;

  it('states every bound agent’s roles on the project panel, sorted by agent, and none when unread', () => {
    expect(
      factOf(panelFor(model(withRoles()), { kind: 'project', id: 'p1' }, 'live'), 'Flow roles'),
    ).toBe('a1: implementer · a2: verifier');
    expect(factOf(panelFor(overview(), { kind: 'project', id: 'p1' }, 'live'), 'Flow roles')).toBe(
      'none',
    );
  });

  it('gives a session its agent’s role in its own project only', () => {
    const held = model(withRoles());
    expect(factOf(panelFor(held, { kind: 'session', id: 's-think' }, 'live'), 'Flow role')).toBe(
      'implementer',
    );
    expect(factOf(panelFor(held, { kind: 'session', id: 's-blocked' }, 'live'), 'Flow role')).toBe(
      'verifier',
    );
    // a1 holds implementer in p1; s-wait is a1's session in p2, where nothing is bound.
    expect(factOf(panelFor(held, { kind: 'session', id: 's-wait' }, 'live'), 'Flow role')).toBe(
      'none',
    );
  });
});

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

  it('marks a session live on a recent non-presence event, never on heartbeats alone', () => {
    const model = overview();
    const live = new Map(model.sessions.map((session) => [session.id, session.live]));
    // s-think: a context event 4 min ago; s-blocked: a lease event 3 min ago.
    expect(live.get('s-think')).toBe(true);
    expect(live.get('s-blocked')).toBe(true);
    // s-wait has a heartbeat only, which every online session emits regardless.
    expect(live.get('s-wait')).toBe(false);
    const ribbons = layoutFlow(model, RUNTIME_FOCUS).ribbons;
    expect(
      new Set(ribbons.filter((ribbon) => ribbon.live).map((ribbon) => ribbon.sessionId)),
    ).toEqual(new Set(['s-think', 's-blocked']));
    // Seven minutes later the 4-minute-old event is past the window; the 3-minute one is on it.
    const later = buildOverview(buildPulseSnapshot(input()), events(), NOW + 7 * 60_000);
    expect(later.sessions.find((session) => session.id === 's-think')?.live).toBe(false);
    expect(later.sessions.find((session) => session.id === 's-blocked')?.live).toBe(true);
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

  it('enriches a message stream row with its subject, outcome and answer, linking the exchange', () => {
    const message: AgentMessage = {
      id: 'm-1',
      correlationId: 'corr-1',
      projectId: 'p1',
      sourceSessionId: 'src',
      sourceAgentId: 'codex',
      targetSessionId: 's-think',
      targetAgentId: 'claude-code',
      selectionReason: 'direct',
      kind: 'instruction',
      subject: 'Inspect ALB-1',
      content: 'Inspect and report.',
      evidenceRequirements: [],
      state: 'responded',
      createdAt: minutesAgo(2),
      updatedAt: minutesAgo(1),
      deadlineAt: minutesAgo(0),
      respondedAt: minutesAgo(1),
      response: {
        status: 'answered',
        answer: 'Done — all 14 checks pass on the branch.',
        evidenceCount: 1,
        evidenceTypes: ['session_state'],
        verifiedAt: minutesAgo(1),
      },
    };
    const model = buildOverview(
      buildPulseSnapshot(input()),
      [event('9-0', 'message.responded', 0, { projectId: 'p1', payload: { messageId: 'm-1' } })],
      NOW,
      0,
      [message],
    );
    expect(model.ticker[0]?.type).toBe('message.responded');
    expect(model.ticker[0]?.detail).toBe(
      'Inspect ALB-1 · answered: Done — all 14 checks pass on the branch.',
    );
    expect(model.ticker[0]?.correlationId).toBe('corr-1');
  });

  it('falls back to the plain detail when the message is older than the bounded list', () => {
    const model = buildOverview(
      buildPulseSnapshot(input()),
      [
        event('9-0', 'message.responded', 0, {
          sessionId: 'abcdef12-0000-0000-0000-000000000000',
          payload: { messageId: 'gone' },
        }),
      ],
      NOW,
      0,
      [],
    );
    expect(model.ticker[0]?.detail).toBe('abcdef12');
    expect(model.ticker[0]?.correlationId).toBeUndefined();
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
    failed.git = { state: 'unavailable' };
    failed.projects = { state: 'unavailable' };
    failed.activity = { state: 'unavailable' };
    const model = buildOverview(buildPulseSnapshot(failed), [], NOW);
    for (const key of ['sessions', 'projects', 'tokens', 'commits']) {
      const stat = model.stats.find((candidate) => candidate.key === key);
      expect(stat?.value, key).toBe('—');
      expect(stat?.unavailable, key).toBe(true);
      expect(stat?.sub, key).toMatch(/unavailable/u);
    }
    expect(model.health.label).toBe('HEALTHY');
  });

  it('derives fleet delivery quality (answered rate, latency, failures) from the message list', () => {
    const base: AgentMessage = {
      id: 'm',
      correlationId: 'c',
      projectId: 'p1',
      sourceSessionId: 's',
      sourceAgentId: 'a',
      targetSessionId: 't',
      targetAgentId: 'b',
      selectionReason: 'r',
      kind: 'instruction',
      content: 'x',
      evidenceRequirements: [],
      state: 'responded',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:30.000Z',
      deadlineAt: '2026-07-29T12:02:00.000Z',
    };
    const answered = (
      id: string,
      respondedAt: string,
      evidenceTypes: string[] = [],
      retryOf?: string,
    ): AgentMessage => ({
      ...base,
      id,
      ...(retryOf === undefined ? {} : { retryOf }),
      state: 'responded',
      respondedAt,
      response: {
        status: 'answered',
        answer: 'ok',
        evidenceCount: evidenceTypes.length,
        evidenceTypes,
        verifiedAt: respondedAt,
      },
    });
    const messages: AgentMessage[] = [
      // Re-asked after an earlier exchange, and answered with a test result attached.
      answered('m1', '2026-07-29T12:00:30.000Z', ['test_result', 'file_reference'], 'c0'), // 30s
      answered('m2', '2026-07-29T12:01:30.000Z'), // 90s
      { ...base, id: 'm3', state: 'failed' },
      { ...base, id: 'm4', state: 'timed_out' },
      // Terminal (responded) but NOT answered → counts in the denominator, never as answered.
      {
        ...base,
        id: 'm5',
        state: 'responded',
        respondedAt: '2026-07-29T12:00:30.000Z',
        response: {
          status: 'partially_answered',
          answer: 'part',
          evidenceCount: 0,
          evidenceTypes: [],
          verifiedAt: '2026-07-29T12:00:30.000Z',
        },
      },
      { ...base, id: 'm6', state: 'rejected' },
    ];
    const model = buildOverview(buildPulseSnapshot(input()), [], NOW, 0, messages);
    const delivery = model.stats.find((stat) => stat.key === 'delivery');
    expect(delivery?.value).toBe('33%'); // 2 answered of 6 terminal — partial_answered is NOT answered
    // Failure as a SHARE of terminal, not a bare count: 3 of 6 = 50% (failed + timed_out + rejected).
    expect(delivery?.sub).toContain('50% failed/timed out');
    expect(delivery?.sub).toContain('recent 6');
    // The two facts Faz 3.2 deferred: exchanges declared as a re-dispatch (m1), and answered
    // exchanges carrying test or build evidence (m1 of the 2 answered) — facts, never a score.
    expect(delivery?.sub).toContain('1 re-dispatched');
    expect(delivery?.sub).toContain('verified 50%');
    // True median of 30s and 90s is 60s, not the lower-middle 30s.
    expect(delivery?.sub).toMatch(/p50 60s/u);
    expect(delivery?.route).toBe('#/messages');
    expect(delivery?.unavailable).toBe(false);
  });

  it('shows delivery as unavailable, not "no exchanges", when the messages read failed', () => {
    const model = buildOverview(buildPulseSnapshot(input()), [], NOW, 0, [], true);
    const delivery = model.stats.find((stat) => stat.key === 'delivery');
    expect(delivery?.value).toBe('—');
    expect(delivery?.sub).toBe('messages unavailable');
    expect(delivery?.unavailable).toBe(true);
  });

  it('shows delivery as a dash with no exchanges when the message list is empty', () => {
    const delivery = overview().stats.find((stat) => stat.key === 'delivery');
    expect(delivery?.value).toBe('—');
    expect(delivery?.sub).toBe('no exchanges');
  });

  it('breaks the sessions stat down by real status words', () => {
    const sessions = overview().stats.find((stat) => stat.key === 'sessions');
    expect(sessions?.value).toBe('3');
    expect(sessions?.sub).toBe('1 thinking · 1 waiting for input · 1 blocked');
    // Commits replaced the always-empty Context tile: p1's Git fan-out observed 7
    // recent commits, p2 is not-observed, p3 has no Git entry.
    const commits = overview().stats.find((stat) => stat.key === 'commits');
    expect(commits?.value).toBe('7');
    expect(commits?.sub).toBe('1 of 1 projects · observed window');
    expect(commits?.route).toBe('#/projects');
  });

  it('reads the commits tile as none when nothing was observed in the window', () => {
    const quiet = input();
    quiet.git = {
      state: 'ready',
      data: { truncated: false, entries: [{ projectId: 'p1', git: { state: 'not-observed' } }] },
    };
    const model = buildOverview(buildPulseSnapshot(quiet), [], NOW);
    const commits = model.stats.find((stat) => stat.key === 'commits');
    expect(commits?.value).toBe('0');
    expect(commits?.unavailable).toBe(false);
    expect(commits?.sub).toBe('no repositories scanned');
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
    // Activity opens from here now that the Delivery tile took the events tile's hero slot.
    expect(panel.links.some((link) => link.kind === 'route' && link.href === '#/activity')).toBe(
      true,
    );
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
      { k: 'Commits', v: '7 recent' },
      // "N new" fits one fact card line; the full "untracked" wording is the hover detail.
      { k: 'State', v: '3 new', detail: '3 untracked' },
      // No Tags fact: the owner dropped it (2026-09-25), so HEAD/Commits/State fill one row.
      // No coordinator read in this fixture: the role reads as free (ADR 0035).
      { k: 'Coordinator', v: 'none' },
      // No autopilot read passed in this fixture: the mode fact reads as a dash (ADR 0035).
      { k: 'Autopilot', v: '—' },
      // No bindings read either: no flow roles to state (ADR 0036).
      { k: 'Flow roles', v: 'none' },
    ]);
    // Inspect + Detail only; the redundant Knowledge-graph link was dropped (Knowledge is a lens).
    expect(panel.links.map((link) => link.kind)).toEqual(['inspect-project', 'route']);
    expect(panel.links.map((link) => link.label)).toEqual(['Inspect', 'Detail']);
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
      { k: 'Coordinator', v: 'none' },
      { k: 'Flow role', v: 'none' },
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
      { k: 'Coordinator', v: 'none' },
      { k: 'Flow role', v: 'none' },
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

  it("lists a session's own sub-agents read-only, in honest words when there are none", () => {
    const focus = { kind: 'session', id: 's-think' } as const;
    const listing = (over: Record<string, unknown> = {}) => ({
      sessionId: 's-think',
      state: {
        state: 'ready' as const,
        data: {
          sessionId: 's-think',
          status: 'observed' as const,
          subagents: [
            {
              agentId: 'agent-7f3a9c',
              workflowId: '5c1e2d7a-99aa-4bcd-8e1f',
              agentType: 'reviewer',
              description: 'Review the lease diff',
              state: 'running' as const,
              lastActivityAt: minutesAgo(3),
              lastToolName: 'Grep',
              workingDirectory: 'C:\\work\\alpha-project',
            },
            {
              agentId: 'bb91e0',
              agentType: 'explorer',
              state: 'finished' as const,
              lastActivityAt: minutesAgo(40),
            },
            { agentId: 'cc02', state: 'quiet' as const, lastActivityAt: minutesAgo(90) },
          ],
          truncated: false,
          observedAt: minutesAgo(0),
          ...over,
        },
      },
    });
    const section = (sessionSubagents: unknown) =>
      panelFor(overview(), focus, 'live', {
        sessionSubagents: sessionSubagents as never,
      }).subagents;

    expect(section(listing())).toEqual({
      label: 'Sub-agents · 1 running',
      rows: [
        {
          id: 'agent-7f3a9c',
          title: 'Review the lease diff',
          meta: 'running · 3m ago · Grep · alpha-project · workflow 5c1e2d7a',
          tone: 'working',
        },
        { id: 'bb91e0', title: 'explorer', meta: 'finished · 40m ago', tone: 'done' },
        { id: 'cc02', title: 'agent cc02', meta: 'quiet · 1h ago', tone: 'quiet' },
      ],
      truncated: false,
    });
    expect(section(listing({ truncated: true }))?.truncated).toBe(true);
    // Observed with nothing running inside it: said, never a fabricated row.
    expect(section(listing({ subagents: [] }))).toEqual({
      label: 'Sub-agents',
      rows: [],
      empty: 'none',
      truncated: false,
    });
    // No native binding, or one the reader does not support: not observed.
    expect(section(listing({ status: 'unbound', subagents: [] }))?.empty).toBe('not observed');
    expect(section(listing({ status: 'unsupported', subagents: [] }))?.empty).toBe('not observed');
    expect(section({ sessionId: 's-think', state: { state: 'loading' } })?.empty).toBe(
      'loading\u2026',
    );
    expect(section({ sessionId: 's-think', state: { state: 'unavailable' } })?.empty).toBe(
      'unavailable',
    );
    // Another session's listing is never shown under this one.
    expect(section({ ...listing(), sessionId: 's-blocked' })?.rows).toEqual([]);
    // No reader wired: no section at all.
    expect(panelFor(overview(), focus, 'live').subagents).toBeUndefined();
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

  it('focuses a status tile and lights only the flow that reaches it', () => {
    const layout = layoutFlow(overview(), { kind: 'status', value: 'thinking' });
    const thinking = layout.statuses.find((node) => node.key === 'status:thinking');
    expect(thinking?.selected).toBe(true);
    expect(thinking?.focus).toEqual({ kind: 'status', value: 'thinking' });
    expect(thinking?.dim).toBe(false);
    const lit = layout.ribbons.filter((ribbon) => !ribbon.dim).map((ribbon) => ribbon.sessionId);
    expect(new Set(lit)).toEqual(new Set(['s-think']));
    expect(layout.statuses.find((node) => node.key === 'status:blocked')?.dim).toBe(true);
    expect(layout.agents.find((node) => node.key === 'agent:a2')?.dim).toBe(true);
  });

  it('tallies a project card by tone, severity-first, and leaves a quiet project empty', () => {
    const layout = layoutFlow(overview(), RUNTIME_FOCUS);
    expect(layout.projects.find((node) => node.key === 'project:p1')?.tones).toEqual([
      { tone: 'blocked', count: 1 },
      { tone: 'working', count: 1 },
    ]);
    expect(layout.projects.find((node) => node.key === 'project:p3')?.tones).toEqual([]);
  });
});

describe('status focus drill-down', () => {
  it('lists the sessions in the focused status', () => {
    const panel = panelFor(overview(), { kind: 'status', value: 'thinking' }, 'live');
    expect(panel.eyebrow).toBe('Status');
    expect(panel.title).toBe('THINKING');
    expect(panel.badge.label).toBe('1');
    expect(panel.list.rows.map((row) => row.id)).toEqual(['s-think']);
    expect(panel.facts.find((fact) => fact.k === 'Category')?.v).toBe('working');
  });

  it('falls back to the runtime when the status is no longer present', () => {
    expect(resolveFocus(overview(), { kind: 'status', value: 'nope' })).toEqual(RUNTIME_FOCUS);
    expect(panelFor(overview(), { kind: 'status', value: 'nope' }, 'live').title).toBe(
      'Luwi Runtime',
    );
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

  it('carries the focused project so deselecting a session stays in it, and none at runtime', () => {
    // Deselecting a session returns to layout.projectFocus (its project's orbit),
    // not all the way out to runtime.
    const zoomed = layoutRadial(overview(), { kind: 'session', id: 's-blocked' });
    expect(zoomed.projectFocus).toEqual({ kind: 'project', id: 'p1' });
    expect(layoutRadial(overview(), RUNTIME_FOCUS).projectFocus).toBeUndefined();
  });

  it('hints a session node with its GUI title, falling back to the session id', () => {
    // The node already shows agent + status, so the hint carries only the GUI title
    // that names which session a node is — not a repeat of what is already visible.
    const projects = layoutRadial(overview(), RUNTIME_FOCUS);
    expect(projects.nodes[0]?.hint).toBe('Alpha Project · 2 sessions');

    // No session in the fixture reported a GUI title, so the hint falls back to the
    // session id — never the task subject, which is a different thing.
    const untitled = layoutRadial(overview(), { kind: 'project', id: 'p1' });
    expect(untitled.nodes[1]?.hint).toBe('Session s-think · cli');
    expect(untitled.nodes[1]?.hint).not.toContain('Implement graph generation transition');
    expect(untitled.nodes[0]?.hint).toBe('Session s-blocked · cli');

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
    expect(titled.nodes[1]?.hint).toBe('Investigate R3-3 hardening · cli');

    // The client kind rides the hint, so a bridge worker is told from a GUI attach.
    const bridged = layoutRadial(
      {
        ...base,
        projects: base.projects.map((project) =>
          project.id === 'p1'
            ? {
                ...project,
                sessions: project.sessions.map((session) =>
                  session.id === 's-think'
                    ? { ...session, clientKind: 'bridge' as const }
                    : session,
                ),
              }
            : project,
        ),
      },
      { kind: 'project', id: 'p1' },
    );
    expect(bridged.nodes[1]?.hint).toBe('Session s-think · bridge');
  });

  it('shows a session name as a truncated third label line, full name on hover', () => {
    // No GUI title → the visible name line falls back to the session id (short, untruncated).
    const untitled = layoutRadial(overview(), { kind: 'project', id: 'p1' });
    expect(untitled.nodes[1]?.name).toBe('Session s-think');
    expect(untitled.nodes[1]?.hint).toBe('Session s-think · cli');
    // A long GUI title is truncated on the visible line but kept whole in the hover hint.
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
                    ? { ...session, title: 'Investigate R3-3 hardening e2e failure' }
                    : session,
                ),
              }
            : project,
        ),
      },
      { kind: 'project', id: 'p1' },
    );
    expect(titled.nodes[1]?.name).toMatch(/^Investigate R3-3.*…$/u);
    expect((titled.nodes[1]?.name ?? '').length).toBeLessThanOrEqual(18);
    expect(titled.nodes[1]?.hint).toBe('Investigate R3-3 hardening e2e failure · cli');
    // A project node carries no name line.
    const projects = layoutRadial(overview(), RUNTIME_FOCUS);
    expect(projects.nodes[0]?.name).toBe('');
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

describe('responded transient', () => {
  const responded = (updatedAt: string): AgentMessage => ({
    id: 'm-r',
    correlationId: 'corr-r',
    projectId: 'p1',
    sourceSessionId: 'src',
    sourceAgentId: 'codex',
    targetSessionId: 's-think',
    targetAgentId: 'claude-code',
    selectionReason: 'direct',
    kind: 'instruction',
    content: 'x',
    evidenceRequirements: [],
    state: 'responded',
    createdAt: minutesAgo(2),
    updatedAt,
    deadlineAt: minutesAgo(0),
  });
  const idleSnapshot = () => {
    const base = buildPulseSnapshot(input());
    return {
      ...base,
      sessions: base.sessions.map((s) =>
        s.id === 's-think' ? { ...s, status: 'idle', statusLabel: 'idle' } : s,
      ),
    };
  };

  it('labels an idle session "Responded" when its answer is within the window', () => {
    const model = buildOverview(idleSnapshot(), events(), NOW, 0, [
      responded(new Date(NOW - 20_000).toISOString()),
    ]);
    const session = model.allSessions.find((x) => x.id === 's-think');
    expect(session?.statusLabel).toBe('Responded');
    expect(session?.tone).toBe('working');
  });

  it('reads as idle once the responded window has passed', () => {
    const model = buildOverview(idleSnapshot(), events(), NOW, 0, [
      responded(new Date(NOW - 60_000).toISOString()),
    ]);
    const session = model.allSessions.find((x) => x.id === 's-think');
    expect(session?.statusLabel).toBe('idle');
    expect(session?.tone).toBe('quiet');
  });

  it('never labels a non-idle (still working) session as responded', () => {
    // s-think stays `thinking` here; a recent answer must not override real work.
    const model = buildOverview(buildPulseSnapshot(input()), events(), NOW, 0, [
      responded(new Date(NOW - 20_000).toISOString()),
    ]);
    const session = model.allSessions.find((x) => x.id === 's-think');
    expect(session?.statusLabel).not.toBe('Responded');
  });
});
