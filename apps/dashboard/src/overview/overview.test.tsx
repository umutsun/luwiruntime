// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoordinatorMutations } from '../api/coordinator-mutations.js';
import { ToastProvider } from '../components/toast.js';
import { buildPulseSnapshot, type PulseInput } from '../pulse/model.js';
import type { DashboardEvent } from '../realtime/schema.js';
import { RUNTIME_FOCUS, type Focus } from './model.js';
import { Overview } from './overview.js';
import type { ViewChoice } from './use-view-choice.js';

afterEach(cleanup);

const NOW = Date.parse('2026-09-11T10:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function input(): PulseInput {
  return {
    measuredLatencyMs: 12,
    snapshotAt: new Date(NOW).toISOString(),
    health: {
      state: 'ready',
      data: {
        status: 'ok',
        runtimeState: 'ready',
        uptimeMs: 60_000,
        redis: { connected: true, status: 'connected', latencyMs: 2 },
      },
    },
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
          startedAt: minutesAgo(20),
          lastHeartbeatAt: minutesAgo(0),
          taskSummary: 'Refactor the tile grid',
        },
        {
          id: 's2',
          agentId: 'a2',
          projectId: 'p2',
          status: 'blocked',
          presence: 'online',
          startedAt: minutesAgo(5),
          lastHeartbeatAt: minutesAgo(0),
        },
      ],
    },
    agents: { state: 'ready', data: [] },
    usage: { state: 'ready', data: [] },
    context: { state: 'ready', data: [] },
    activity: { state: 'ready', data: [] },
    findings: { state: 'ready', data: [] },
  };
}

const events: DashboardEvent[] = [
  {
    streamId: '1-0',
    id: 'e1',
    version: 1,
    type: 'session.registered',
    occurredAt: minutesAgo(3),
    workspaceId: 'local',
    projectId: 'p1',
    sessionId: 's1',
    payload: {},
  },
  {
    streamId: '2-0',
    id: 'e2',
    version: 1,
    type: 'lease.denied',
    occurredAt: minutesAgo(1),
    workspaceId: 'local',
    projectId: 'p2',
    sessionId: 's2',
    payload: { path: 'src/app.ts' },
  },
];

function subject(
  view: ViewChoice,
  overrides: Partial<{ focus: Focus; following: boolean; pendingCount: number }> = {},
) {
  const onFocus = vi.fn();
  const onInspect = vi.fn();
  render(
    <Overview
      snapshot={buildPulseSnapshot(input())}
      events={events}
      nowMs={NOW}
      view={view}
      focus={overrides.focus ?? RUNTIME_FOCUS}
      following={overrides.following ?? true}
      pendingCount={overrides.pendingCount ?? 0}
      realtime="live"
      onFocus={onFocus}
      onInspect={onInspect}
    />,
  );
  return { onFocus, onInspect };
}

describe('coordinator switch in the drill-down (ADR 0035)', () => {
  const sessionFocus: Focus = { kind: 'session', id: 's1' };
  const mutations = (claim: CoordinatorMutations['claim']): CoordinatorMutations =>
    ({ claim, release: vi.fn() }) as unknown as CoordinatorMutations;

  it('claims for the focused session, states the outcome, and re-reads the snapshot', async () => {
    const claim = vi.fn<CoordinatorMutations['claim']>().mockResolvedValue({
      state: 'ok',
      httpStatus: 201,
      data: {
        projectId: 'p1',
        sessionId: 's1',
        agentId: 'a1',
        claimId: 'claim-1',
        claimedAt: minutesAgo(0),
        version: 1,
      },
    });
    const onCoordinatorMutated = vi.fn();
    render(
      <ToastProvider>
        <Overview
          snapshot={buildPulseSnapshot(input())}
          events={events}
          nowMs={NOW}
          view="radial"
          focus={sessionFocus}
          following
          pendingCount={0}
          realtime="live"
          onFocus={vi.fn()}
          onInspect={vi.fn()}
          coordinatorMutations={mutations(claim)}
          onCoordinatorMutated={onCoordinatorMutated}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make coordinator for session s1' }));
    expect(await screen.findByText('Coordinator assigned.')).toBeTruthy();
    expect(claim).toHaveBeenCalledWith('p1', 's1');
    expect(onCoordinatorMutated).toHaveBeenCalledTimes(1);
  });

  it('shows the daemon refusal in words and does not re-read', async () => {
    const claim = vi.fn<CoordinatorMutations['claim']>().mockResolvedValue({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'COORDINATOR_CONFLICT',
      message: 'Session s9 holds the coordinator role.',
    });
    const onCoordinatorMutated = vi.fn();
    render(
      <ToastProvider>
        <Overview
          snapshot={buildPulseSnapshot(input())}
          events={events}
          nowMs={NOW}
          view="radial"
          focus={sessionFocus}
          following
          pendingCount={0}
          realtime="live"
          onFocus={vi.fn()}
          onInspect={vi.fn()}
          coordinatorMutations={mutations(claim)}
          onCoordinatorMutated={onCoordinatorMutated}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make coordinator for session s1' }));
    expect(await screen.findByText('Session s9 holds the coordinator role.')).toBeTruthy();
    expect(onCoordinatorMutated).not.toHaveBeenCalled();
  });

  it('shows no switch when the shell wires no mutation', () => {
    render(
      <Overview
        snapshot={buildPulseSnapshot(input())}
        events={events}
        nowMs={NOW}
        view="radial"
        focus={sessionFocus}
        following
        pendingCount={0}
        realtime="live"
        onFocus={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Make coordinator/ })).toBeNull();
    expect(screen.getByText('Coordinator').nextElementSibling?.textContent).toBe('none');
  });
});

describe('Overview lenses', () => {
  it('renders the Board with a tile per project and reports a tile click as a focus', () => {
    const { onFocus } = subject('board');
    expect(screen.getByRole('button', { name: 'Focus runtime' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Focus project Alpha' }));
    expect(onFocus).toHaveBeenCalledWith({ kind: 'project', id: 'p1' });
    // Blocked is written, not only coloured.
    expect(screen.getByText('1 BLOCKED')).toBeTruthy();
  });

  it('renders the Flow with a Status column instead of release readiness', () => {
    subject('flow');
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.queryByText(/release/i)).toBeNull();
    expect(screen.getByText('THINKING')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Focus agent a1' })).toBeTruthy();
  });

  it('renders the Radial with its honest legend and zooms into a project', () => {
    const { onFocus } = subject('radial');
    expect(screen.getByText('ring = share of retained events')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Focus project Beta' }));
    expect(onFocus).toHaveBeenCalledWith({ kind: 'project', id: 'p2' });
  });

  it('renders the Timeline with a NOW marker and its own window control', () => {
    subject('timeline');
    expect(screen.getByText('NOW')).toBeTruthy();
    const window = screen.getByRole('group', { name: 'Timeline window' });
    expect(
      within(window).getByRole('button', { name: '90 min' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(within(window).getByRole('button', { name: '24 h' }));
    expect(within(window).getByRole('button', { name: '24 h' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // The lane bar and the drill-down row both name the session; the bar is the lens's own.
    const bars = screen.getAllByRole('button', { name: 'Focus session s1' });
    expect(bars.some((button) => button.classList.contains('bar'))).toBe(true);
  });
});

describe('Overview drill-down and ticker', () => {
  it('describes the focused project and opens the inspector from its link', () => {
    const { onInspect } = subject('board', { focus: { kind: 'project', id: 'p2' } });
    const aside = screen.getByRole('complementary', { name: 'Drill-down' });
    expect(within(aside).getByRole('heading', { name: 'Beta' })).toBeTruthy();
    expect(within(aside).getByText('WHY BLOCKED')).toBeTruthy();
    expect(within(aside).getByText('Lease denied on src/app.ts')).toBeTruthy();
    fireEvent.click(within(aside).getByRole('button', { name: 'Inspect project Beta' }));
    expect(onInspect).toHaveBeenCalledWith({ kind: 'project', projectId: 'p2' });
    // Detail opens the drawer over the overview, never the registry route.
    expect(within(aside).getByRole('link', { name: 'Detail ›' }).getAttribute('href')).toBe(
      '#/pulse/p2/detail',
    );
    // A session with no task summary titles the row by its id, not a second copy of the status.
    expect(within(aside).getByText('Session s2')).toBeTruthy();
  });

  it('focuses a session from a drill-down row and inspects it from the session panel', () => {
    const { onFocus } = subject('board');
    fireEvent.click(screen.getByRole('button', { name: 'Focus session s1' }));
    expect(onFocus).toHaveBeenCalledWith({ kind: 'session', id: 's1' });
    cleanup();
    const { onInspect } = subject('board', { focus: { kind: 'session', id: 's1' } });
    const aside = screen.getByRole('complementary', { name: 'Drill-down' });
    expect(within(aside).getByRole('heading', { name: 'Refactor the tile grid' })).toBeTruthy();
    fireEvent.click(within(aside).getByRole('button', { name: 'Inspect session s1' }));
    expect(onInspect).toHaveBeenCalledWith({ kind: 'session', sessionId: 's1' });
  });

  it('offers the session and agent ids to copy, and reads the model from usage on focus', async () => {
    const loadSessionUsage = vi.fn().mockResolvedValue({
      state: 'ready',
      data: {
        models: ['model-z'],
        sources: [{ source: 'agent-exact', label: 'exact', records: 2, totalTokens: 2_500 }],
        recordCount: 2,
        truncated: false,
      },
    });
    render(
      <Overview
        snapshot={buildPulseSnapshot(input())}
        events={events}
        nowMs={NOW}
        view="board"
        focus={{ kind: 'session', id: 's1' }}
        following
        pendingCount={0}
        realtime="live"
        onFocus={vi.fn()}
        onInspect={vi.fn()}
        loadSessionUsage={loadSessionUsage}
      />,
    );
    const aside = screen.getByRole('complementary', { name: 'Drill-down' });
    // One icon beside the status badge takes the full session id; the head
    // already names the agent, so nothing else is offered to copy.
    expect(within(aside).getByRole('button', { name: 'Copy session id s1' })).toBeTruthy();
    expect(within(aside).queryByRole('button', { name: /Copy agent id/ })).toBeNull();
    expect(await within(aside).findByText('model-z')).toBeTruthy();
    expect(within(aside).getByText('2.5k exact')).toBeTruthy();
    expect(loadSessionUsage).toHaveBeenCalledWith('s1', expect.anything());
  });

  it('streams the newest events and says when it is paused', () => {
    subject('board', { following: false, pendingCount: 2 });
    const ticker = screen.getByRole('log', { name: 'Realtime stream' });
    expect(within(ticker).getByText('PAUSED · 2 NEW')).toBeTruthy();
    expect(within(ticker).getByText('lease.denied')).toBeTruthy();
    expect(within(ticker).getByText('src/app.ts')).toBeTruthy();
  });
});

describe('Overview Knowledge lens', () => {
  const ready = {
    state: 'ready' as const,
    data: {
      summary: {
        nodeCount: 1,
        edgeCount: 0,
        communityCount: 1,
        hubCount: 0,
        embeddings: 0 as const,
        builtAtCommit: 'abc123',
        observedAt: '2026-09-11T09:00:00.000Z',
        truncated: false,
      },
      communities: [{ id: 0, name: 'core', size: 1 }],
      nodes: [
        {
          id: 'core::god',
          label: 'god',
          sourceFile: 'src/core.ts',
          community: 0,
          communityName: 'core',
          kind: 'god' as const,
          degree: 0,
        },
      ],
      edges: [],
    },
  };

  it('reads the focused project once, draws it, and swaps the aside for its inspector', async () => {
    const loadKnowledge = vi.fn().mockResolvedValue(ready);
    const { rerender } = render(
      <Overview
        snapshot={buildPulseSnapshot(input())}
        events={events}
        nowMs={NOW}
        view="knowledge"
        focus={{ kind: 'session', id: 's2' }}
        following
        pendingCount={0}
        realtime="live"
        onFocus={vi.fn()}
        onInspect={vi.fn()}
        loadKnowledge={loadKnowledge}
      />,
    );
    // A session focus resolves to its project (s2 belongs to Beta).
    expect(loadKnowledge).toHaveBeenCalledWith('p2', expect.anything());
    expect(screen.queryByRole('complementary', { name: 'Drill-down' })).toBeNull();
    const aside = screen.getByRole('complementary', { name: 'Knowledge inspector' });
    expect(within(aside).getByRole('heading', { name: 'Beta' })).toBeTruthy();
    // The node on the canvas and its row in the inspector both select it.
    expect(await screen.findAllByRole('button', { name: 'Select god' })).toHaveLength(2);
    expect(within(aside).getByText('COMPLETE')).toBeTruthy();
    // The stat strip and the ticker stay: the lens sits in the same frame as the other four.
    expect(screen.getByRole('group', { name: 'Runtime totals' })).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Realtime stream' })).toBeTruthy();
    // A re-render with the same project does not read again.
    rerender(
      <Overview
        snapshot={buildPulseSnapshot(input())}
        events={events}
        nowMs={NOW + 1}
        view="knowledge"
        focus={{ kind: 'session', id: 's2' }}
        following
        pendingCount={0}
        realtime="live"
        onFocus={vi.fn()}
        onInspect={vi.fn()}
        loadKnowledge={loadKnowledge}
      />,
    );
    expect(loadKnowledge).toHaveBeenCalledTimes(1);
  });

  it('shows the project picker with nothing focused and never reads on another lens', () => {
    const loadKnowledge = vi.fn().mockResolvedValue(ready);
    render(
      <Overview
        snapshot={buildPulseSnapshot(input())}
        events={events}
        nowMs={NOW}
        view="board"
        focus={RUNTIME_FOCUS}
        following
        pendingCount={0}
        realtime="live"
        onFocus={vi.fn()}
        onInspect={vi.fn()}
        loadKnowledge={loadKnowledge}
      />,
    );
    expect(loadKnowledge).not.toHaveBeenCalled();
    cleanup();
    const onFocus = vi.fn();
    render(
      <Overview
        snapshot={buildPulseSnapshot(input())}
        events={events}
        nowMs={NOW}
        view="knowledge"
        focus={RUNTIME_FOCUS}
        following
        pendingCount={0}
        realtime="live"
        onFocus={onFocus}
        onInspect={vi.fn()}
        loadKnowledge={loadKnowledge}
      />,
    );
    // Nothing focused: the projects are the canvas and no graph is read.
    expect(loadKnowledge).not.toHaveBeenCalled();
    const aside = screen.getByRole('complementary', { name: 'Knowledge inspector' });
    expect(within(aside).getByText('NO PROJECT')).toBeTruthy();
    // Clicking a project on the picker focuses it.
    fireEvent.click(screen.getByRole('button', { name: 'Focus project Beta' }));
    expect(onFocus).toHaveBeenCalledWith({ kind: 'project', id: 'p2' });
  });
});
