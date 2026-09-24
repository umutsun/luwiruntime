import { describe, expect, it } from 'vitest';

import {
  buildPulseSnapshot,
  deriveClientKind,
  labelSessionStatus,
  scopePulseSnapshotToProjects,
  type PulseInput,
  type PulseSession,
} from './model.js';

const baseInput = (): PulseInput => ({
  measuredLatencyMs: 42,
  snapshotAt: '2026-08-05T08:00:00.000Z',
  health: {
    state: 'ready',
    data: {
      status: 'ok',
      runtimeState: 'ready',
      uptimeMs: 1000,
      redis: { connected: true, status: 'connected', latencyMs: 3 },
    },
  },
  projects: { state: 'ready', data: [] },
  sessions: { state: 'ready', data: [] },
  agents: { state: 'ready', data: [] },
  usage: { state: 'ready', data: [] },
  context: { state: 'ready', data: [] },
  activity: { state: 'ready', data: [] },
  findings: { state: 'ready', data: [] },
});

describe('client kind derivation', () => {
  it('takes an explicit marker only when it names a known kind', () => {
    expect(deriveClientKind({ client: 'gui' })).toBe('gui');
    expect(deriveClientKind({ client: 'ide' })).toBe('ide');
    expect(deriveClientKind({ client: 'bridge' })).toBe('bridge');
    // An unknown string is not honoured — it falls through to derivation.
    expect(deriveClientKind({ client: 'nonsense' })).toBe('cli');
  });

  it('derives bridge, then gui (native title), then cli when unmarked', () => {
    expect(deriveClientKind({ bridge: 'native-headless' })).toBe('bridge');
    // An explicit marker still wins over a derivable signal.
    expect(deriveClientKind({ bridge: 'native-headless', client: 'ide' })).toBe('ide');
    expect(deriveClientKind({ title: 'Fix the router' })).toBe('gui');
    expect(deriveClientKind({ model: 'claude-opus-4-8' })).toBe('cli');
    expect(deriveClientKind(undefined)).toBe('cli');
    // Empty strings state nothing.
    expect(deriveClientKind({ bridge: '', title: '' })).toBe('cli');
  });
});

describe('flow roles by project (ADR 0036)', () => {
  it('keeps only enabled bindings that hold a role, keyed by project then agent', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      bindings: {
        state: 'ready',
        data: {
          truncated: false,
          entries: [
            {
              projectId: 'p',
              bindings: {
                state: 'ready',
                data: [
                  { agentId: 'a', enabled: true, flowRoles: ['implementer'] },
                  { agentId: 'b', enabled: true, flowRoles: ['verifier', 'implementer'] },
                  { agentId: 'c', enabled: false, flowRoles: ['verifier'] },
                  { agentId: 'd', enabled: true, flowRoles: [] },
                ],
              },
            },
            { projectId: 'q', bindings: { state: 'unavailable' } },
          ],
        },
      },
    });

    expect(snapshot.flowRolesByProject).toEqual({
      p: { a: ['implementer'], b: ['verifier', 'implementer'] },
    });
    expect(snapshot.bindingsState).toBe('ready');
    expect(snapshot.partial).toBe(false);
  });

  it('reads as none when the fan-out was not requested, and partial only when it failed', () => {
    expect(buildPulseSnapshot(baseInput()).flowRolesByProject).toEqual({});
    expect(buildPulseSnapshot(baseInput()).partial).toBe(false);
    expect(buildPulseSnapshot({ ...baseInput(), bindings: { state: 'unavailable' } }).partial).toBe(
      true,
    );
  });
});

describe('Pulse snapshot mapping', () => {
  it('tags each session with its derived client kind', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      sessions: {
        state: 'ready',
        data: [
          {
            id: 'b',
            agentId: 'a',
            projectId: 'p',
            status: 'idle',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:50.000Z',
            metadata: { bridge: 'native-headless' },
          },
          {
            id: 'g',
            agentId: 'a',
            projectId: 'p',
            status: 'idle',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:50.000Z',
            metadata: { title: 'A task' },
          },
        ],
      },
    });
    expect(snapshot.sessions.map((session) => session.clientKind)).toEqual(['bridge', 'gui']);
  });

  it('distinguishes empty projects and no active sessions from unavailable data', () => {
    const empty = buildPulseSnapshot(baseInput());
    const unavailable = buildPulseSnapshot({
      ...baseInput(),
      projects: { state: 'unavailable' },
      sessions: { state: 'unavailable' },
    });

    expect(empty.projectCount).toEqual({ state: 'empty', value: 0 });
    expect(empty.activeSessionCount).toEqual({ state: 'empty', value: 0 });
    expect(unavailable.projectCount).toEqual({ state: 'unavailable' });
    expect(unavailable.activeSessionCount).toEqual({ state: 'unavailable' });
  });

  it('joins active online sessions to projects without inventing missing project names', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      projects: {
        state: 'ready',
        data: [{ id: 'p1', name: 'LUWI', localPath: 'C:\\work\\luwi' }],
      },
      sessions: {
        state: 'ready',
        data: [
          {
            id: 's1',
            agentId: 'codex-main',
            projectId: 'p1',
            status: 'thinking',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:50.000Z',
          },
          {
            id: 's2',
            agentId: 'other',
            projectId: 'missing',
            status: 'completed',
            presence: 'offline',
            startedAt: '2026-08-05T06:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T06:30:00.000Z',
          },
        ],
      },
    });

    expect(snapshot.activeSessions).toHaveLength(1);
    expect(snapshot.activeSessions[0]).toMatchObject({ projectName: 'LUWI' });
    expect(snapshot.projects[0]?.activeSessions).toEqual({ state: 'ready', value: 1 });
  });

  it('preserves all usage evidence sources as separate rows', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      usage: {
        state: 'ready',
        data: [
          { source: 'agent-exact', recordCount: 1, totalTokens: 10 },
          { source: 'agent-reported', recordCount: 1, totalTokens: 20 },
          { source: 'adapter-extracted', recordCount: 1, totalTokens: 30 },
          { source: 'luwi-estimated', recordCount: 1, totalTokens: 40 },
          { source: 'unavailable', recordCount: 2 },
        ],
      },
    });

    expect(snapshot.usage.map((row) => row.label)).toEqual([
      'Exact',
      'Reported',
      'Extracted',
      'Estimated',
      'Unavailable',
    ]);
    expect(snapshot.usage[4]).toMatchObject({ records: 2, totalTokens: undefined });
  });

  it('keeps assigned, effective, loaded, invoked, and unknown context distinct', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      context: {
        state: 'ready',
        data: [
          { assigned: true, effective: false, loaded: false, invoked: false },
          { assigned: true, effective: true, loaded: false, invoked: false },
          { assigned: true, effective: true, loaded: true, invoked: false },
          { assigned: true, effective: true, loaded: true, invoked: true },
          { assigned: 'unknown', effective: 'unknown', loaded: 'unknown', invoked: 'unknown' },
        ],
      },
    });

    expect(snapshot.context).toEqual({
      assigned: 4,
      effective: 3,
      loaded: 2,
      invoked: 1,
      unknown: 1,
    });
  });

  it('derives the two efficiency insights only from certain observations', () => {
    // "6 assigned sources were never loaded" in the comp. Honest version:
    // count only rows where both sides are observed booleans — an `unknown`
    // must never be counted as unused, per the ADR 0010 rule.
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      context: {
        state: 'ready',
        data: [
          { assigned: true, effective: true, loaded: false, invoked: false },
          { assigned: true, effective: true, loaded: false, invoked: false },
          { assigned: true, effective: true, loaded: true, invoked: false },
          { assigned: true, effective: true, loaded: 'unknown', invoked: 'unknown' },
          { assigned: true, effective: true, loaded: true, invoked: true },
        ],
      },
    });

    expect(snapshot.contextInsights).toEqual({ assignedNeverLoaded: 2, loadedNotInvoked: 1 });
  });

  it('joins per-project git facts to projects and keeps failures apart', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      projects: {
        state: 'ready',
        data: [
          { id: 'p1', name: 'LUWI', localPath: 'C:/luwi' },
          { id: 'p2', name: 'Other', localPath: 'C:/other' },
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
                  branch: 'main',
                  headSha: 'abc123def4567890abc123def4567890abc123de',
                  clean: false,
                  untrackedCount: 3,
                  tagCount: 2,
                  recentCommitCount: 5,
                  observedAt: '2026-08-05T08:00:00.000Z',
                },
              },
            },
            { projectId: 'p2', git: { state: 'not-observed' } },
          ],
        },
      },
    });

    expect(snapshot.repositoryFacts[0]).toMatchObject({
      projectId: 'p1',
      name: 'LUWI',
      git: { state: 'ready', data: { branch: 'main', untrackedCount: 3, recentCommitCount: 5 } },
    });
    expect(snapshot.repositoryFacts[1]).toMatchObject({
      projectId: 'p2',
      git: { state: 'not-observed' },
    });
    expect(snapshot.gitState).toBe('ready');
  });

  it('passes the runtime info through untouched', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      runtime: {
        state: 'ready',
        data: {
          workspaceId: 'local',
          version: '0.2.0',
          protocolVersion: 1,
          runtimeState: 'ready',
          runtimeInstanceId: 'r1',
          startedAt: '2026-08-05T08:00:00.000Z',
          uptimeMs: 1000,
          host: '127.0.0.1',
          port: 4782,
        },
      },
    });

    expect(snapshot.runtime.state).toBe('ready');
  });

  it('tolerates a future session status in presentation code', () => {
    expect(labelSessionStatus('handoff_pending')).toBe('Unknown');
  });

  it('carries per-project session availability rather than collapsing it to zero', () => {
    // A failed sessions read used to leave `activeSessions: 0` on every
    // project, so one screen could show "0 active" directly beneath a panel
    // saying "Session data unavailable".
    const unavailable = buildPulseSnapshot({
      ...baseInput(),
      projects: {
        state: 'ready',
        data: [{ id: 'p1', name: 'LUWI', localPath: 'C:/work/luwi' }],
      },
      sessions: { state: 'unavailable' },
    });

    expect(unavailable.projects[0]?.activeSessions).toEqual({ state: 'unavailable' });
  });

  it('reports a real zero when the sessions read succeeded and found none', () => {
    const empty = buildPulseSnapshot({
      ...baseInput(),
      projects: {
        state: 'ready',
        data: [{ id: 'p1', name: 'LUWI', localPath: 'C:/work/luwi' }],
      },
      sessions: { state: 'ready', data: [] },
    });

    expect(empty.projects[0]?.activeSessions).toEqual({ state: 'empty', value: 0 });
  });

  it('resolves an agent display name and falls back to the raw id', () => {
    // An opaque agent id must never imply a definition: the fallback is the id
    // itself, and the row is told which of the two it got so it can present an
    // unresolved id as an identifier rather than as a name.
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      agents: {
        state: 'ready',
        data: [
          {
            id: 'a1',
            kind: 'other',
            displayName: 'Primary Runner',
            adapterId: 'x',
            enabled: true,
            updatedAt: '2026-08-05T08:00:00.000Z',
          },
        ],
      },
      sessions: {
        state: 'ready',
        data: [
          {
            id: 's1',
            agentId: 'a1',
            projectId: 'p1',
            status: 'thinking',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
          },
          {
            id: 's2',
            agentId: 'a-unregistered',
            projectId: 'p1',
            status: 'idle',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
          },
        ],
      },
    });

    expect(snapshot.activeSessions[0]).toMatchObject({
      agentName: 'Primary Runner',
      agentKnown: true,
    });
    expect(snapshot.activeSessions[1]).toMatchObject({
      agentName: 'a-unregistered',
      agentKnown: false,
    });
  });

  it('leaves every agent name a fallback when the agent read failed', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      agents: { state: 'unavailable' },
      sessions: {
        state: 'ready',
        data: [
          {
            id: 's1',
            agentId: 'a1',
            projectId: 'p1',
            status: 'thinking',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
          },
        ],
      },
    });

    expect(snapshot.activeSessions[0]).toMatchObject({ agentName: 'a1', agentKnown: false });
  });

  it('scopes context evidence to the session that reported it', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      sessions: {
        state: 'ready',
        data: [
          {
            id: 's1',
            agentId: 'a1',
            projectId: 'p1',
            status: 'thinking',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
          },
          {
            id: 's2',
            agentId: 'a1',
            projectId: 'p1',
            status: 'idle',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
          },
        ],
      },
      context: {
        state: 'ready',
        data: [
          { sessionId: 's1', assigned: true, effective: true, loaded: true, invoked: true },
          { sessionId: 's1', assigned: true, effective: true, loaded: true, invoked: false },
          { sessionId: 's1', assigned: true, effective: true, loaded: 'unknown', invoked: false },
          { assigned: true, effective: true, loaded: true, invoked: true },
        ],
      },
    });

    expect(snapshot.activeSessions[0]?.context).toEqual({
      state: 'ready',
      assigned: 3,
      loaded: 2,
      invoked: 1,
    });
    // A contribution with no sessionId belongs to no session, so it may not be
    // borrowed by one that reported nothing.
    expect(snapshot.activeSessions[1]?.context).toEqual({ state: 'not-observed' });
  });

  it('never reports per-session context as zero when the context read failed', () => {
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      sessions: {
        state: 'ready',
        data: [
          {
            id: 's1',
            agentId: 'a1',
            projectId: 'p1',
            status: 'thinking',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
          },
        ],
      },
      context: { state: 'unavailable' },
    });

    expect(snapshot.activeSessions[0]?.context).toEqual({ state: 'unavailable' });
  });

  it('breaks active sessions down by their real status vocabulary', () => {
    const session = (id: string, status: string) => ({
      id,
      agentId: 'a1',
      projectId: 'p1',
      status,
      presence: 'online' as const,
      startedAt: '2026-08-05T07:00:00.000Z',
      lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
    });
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      sessions: {
        state: 'ready',
        data: [
          session('s1', 'thinking'),
          session('s2', 'tool_running'),
          session('s3', 'waiting_for_input'),
          session('s4', 'waiting_for_agent'),
          session('s5', 'blocked'),
          session('s6', 'idle'),
          session('s7', 'handoff_pending'),
        ],
      },
    });

    // No "running" bucket: it is not one of the nine observed statuses, and
    // merging thinking with tool_running would invent it.
    expect(snapshot.statusBreakdown).toEqual([
      { status: 'idle', label: 'idle', count: 1 },
      { status: 'thinking', label: 'thinking', count: 1 },
      { status: 'tool_running', label: 'tool running', count: 1 },
      { status: 'waiting_for_input', label: 'waiting for input', count: 1 },
      { status: 'waiting_for_agent', label: 'waiting for agent', count: 1 },
      { status: 'blocked', label: 'blocked', count: 1 },
      { status: 'unknown', label: 'Unknown', count: 1 },
    ]);
    expect(snapshot.waitingCount).toEqual({ state: 'ready', value: 2 });
    expect(snapshot.blockedCount).toEqual({ state: 'ready', value: 1 });
  });

  it('reports waiting and blocked as unavailable rather than zero when sessions failed', () => {
    const snapshot = buildPulseSnapshot({ ...baseInput(), sessions: { state: 'unavailable' } });

    expect(snapshot.statusBreakdown).toEqual([]);
    expect(snapshot.waitingCount).toEqual({ state: 'unavailable' });
    expect(snapshot.blockedCount).toEqual({ state: 'unavailable' });
  });

  it('counts the distinct agents observed in a project rather than its bindings', () => {
    // Project-agent bindings are a separate scoped read. What the snapshot can
    // support is the number of distinct agents holding an active session here,
    // which is a different claim and is labelled as one.
    const session = (id: string, agentId: string) => ({
      id,
      agentId,
      projectId: 'p1',
      status: 'thinking',
      presence: 'online' as const,
      startedAt: '2026-08-05T07:00:00.000Z',
      lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
    });
    const ready = buildPulseSnapshot({
      ...baseInput(),
      projects: { state: 'ready', data: [{ id: 'p1', name: 'LUWI', localPath: 'C:/luwi' }] },
      sessions: {
        state: 'ready',
        data: [session('s1', 'a1'), session('s2', 'a1'), session('s3', 'a2')],
      },
    });
    const unavailable = buildPulseSnapshot({
      ...baseInput(),
      projects: { state: 'ready', data: [{ id: 'p1', name: 'LUWI', localPath: 'C:/luwi' }] },
      sessions: { state: 'unavailable' },
    });

    expect(ready.projects[0]?.activeAgents).toEqual({ state: 'ready', value: 2 });
    expect(unavailable.projects[0]?.activeAgents).toEqual({ state: 'unavailable' });
  });

  it('counts sessions per agent only when the read succeeded', () => {
    const ready = buildPulseSnapshot({
      ...baseInput(),
      agents: {
        state: 'ready',
        data: [
          {
            id: 'a1',
            kind: 'other',
            displayName: 'Agent',
            adapterId: 'x',
            enabled: true,
            updatedAt: '2026-08-05T08:00:00.000Z',
          },
        ],
      },
      sessions: {
        state: 'ready',
        data: [
          {
            id: 's1',
            agentId: 'a1',
            projectId: 'p1',
            status: 'thinking',
            presence: 'online',
            startedAt: '2026-08-05T08:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T08:00:00.000Z',
          },
        ],
      },
    });
    const unavailable = buildPulseSnapshot({
      ...baseInput(),
      agents: {
        state: 'ready',
        data: [
          {
            id: 'a1',
            kind: 'other',
            displayName: 'Agent',
            adapterId: 'x',
            enabled: true,
            updatedAt: '2026-08-05T08:00:00.000Z',
          },
        ],
      },
      sessions: { state: 'unavailable' },
    });

    expect(ready.agents[0]?.sessionCount).toEqual({ state: 'ready', value: 1 });
    expect(unavailable.agents[0]?.sessionCount).toEqual({ state: 'unavailable' });
  });

  it('collects the models sessions reported per agent and lists ids no definition covers', () => {
    const sessionAt = (id: string, agentId: string, model?: string): PulseSession => {
      const base: PulseSession = {
        id,
        agentId,
        projectId: 'p1',
        status: 'thinking',
        presence: 'online',
        startedAt: '2026-08-05T08:00:00.000Z',
        lastHeartbeatAt: '2026-08-05T08:00:00.000Z',
      };
      return model === undefined ? base : { ...base, metadata: { model } };
    };
    const agent = {
      id: 'a1',
      kind: 'other',
      displayName: 'Agent',
      adapterId: 'x',
      enabled: true,
      updatedAt: '2026-08-05T08:00:00.000Z',
    };
    const snapshot = buildPulseSnapshot({
      ...baseInput(),
      agents: { state: 'ready', data: [agent] },
      sessions: {
        state: 'ready',
        data: [
          sessionAt('s1', 'a1', 'model-b'),
          sessionAt('s2', 'a1', 'model-a'),
          sessionAt('s3', 'a1', 'model-a'),
          sessionAt('s4', 'a1'),
          sessionAt('s5', 'hooked', 'model-c'),
          sessionAt('s6', 'hooked'),
        ],
      },
    });

    expect(snapshot.agents[0]?.models).toEqual(['model-a', 'model-b']);
    expect(snapshot.unregisteredAgents).toEqual([
      { id: 'hooked', sessionCount: 2, models: ['model-c'] },
    ]);

    // An unavailable read on either side lists nothing: every id would look
    // unregistered against an agents read that never happened.
    const unavailable = buildPulseSnapshot({
      ...baseInput(),
      agents: { state: 'unavailable' },
      sessions: { state: 'ready', data: [sessionAt('s5', 'hooked', 'model-c')] },
    });
    expect(unavailable.unregisteredAgents).toEqual([]);
  });
});

describe('project-filtered snapshot', () => {
  const twoProjects = (): PulseInput => ({
    ...baseInput(),
    projects: {
      state: 'ready',
      data: [
        { id: 'p1', name: 'Alpha', localPath: 'C:/a' },
        { id: 'p2', name: 'Beta', localPath: 'C:/b' },
      ],
    },
    sessions: {
      state: 'ready',
      data: [
        {
          id: 's1',
          agentId: 'a1',
          projectId: 'p1',
          status: 'thinking',
          presence: 'online',
          startedAt: '2026-08-05T07:00:00.000Z',
          lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
        },
        {
          id: 's2',
          agentId: 'a1',
          projectId: 'p2',
          status: 'blocked',
          presence: 'online',
          startedAt: '2026-08-05T07:00:00.000Z',
          lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
        },
      ],
    },
    activity: {
      state: 'ready',
      data: [
        {
          streamId: '1-0',
          id: 'e1',
          type: 'session.registered',
          occurredAt: '2026-08-05T07:00:00.000Z',
          workspaceId: 'w',
          projectId: 'p2',
          payload: {},
        },
        {
          streamId: '2-0',
          id: 'e2',
          type: 'runtime.started',
          occurredAt: '2026-08-05T07:00:01.000Z',
          workspaceId: 'w',
          payload: {},
        },
      ] as never,
    },
    git: {
      state: 'ready',
      data: {
        truncated: false,
        entries: [
          { projectId: 'p1', git: { state: 'not-observed' } },
          { projectId: 'p2', git: { state: 'not-observed' } },
        ],
      },
    },
  });

  it('narrows rows to the visible projects and recomputes every count', () => {
    const scoped = scopePulseSnapshotToProjects(buildPulseSnapshot(twoProjects()), new Set(['p1']));

    expect(scoped.projects.map((project) => project.id)).toEqual(['p1']);
    expect(scoped.activeSessions.map((session) => session.id)).toEqual(['s1']);
    expect(scoped.projectCount).toEqual({ state: 'ready', value: 1 });
    expect(scoped.activeSessionCount).toEqual({ state: 'ready', value: 1 });
    expect(scoped.blockedCount).toEqual({ state: 'empty', value: 0 });
    expect(scoped.statusBreakdown).toEqual([{ status: 'thinking', label: 'thinking', count: 1 }]);
    expect(scoped.repositoryFacts.map((row) => row.projectId)).toEqual(['p1']);
    // A runtime-level event carries no projectId and belongs to every view of
    // the runtime; a hidden project's event goes with the project.
    expect(scoped.activity.map((event) => event.id)).toEqual(['e2']);
  });

  it('keeps failed reads failed instead of turning them into empty filters', () => {
    const value = twoProjects();
    value.sessions = { state: 'unavailable' };
    const scoped = scopePulseSnapshotToProjects(buildPulseSnapshot(value), new Set(['p1']));

    expect(scoped.activeSessionCount).toEqual({ state: 'unavailable' });
    expect(scoped.waitingCount).toEqual({ state: 'unavailable' });
  });

  it('returns the snapshot untouched without a filter', () => {
    const snapshot = buildPulseSnapshot(twoProjects());
    expect(scopePulseSnapshotToProjects(snapshot, undefined)).toBe(snapshot);
  });
});
