// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardApp } from './app.js';
import { buildPulseSnapshot, type PulseInput } from './pulse/model.js';

afterEach(() => {
  cleanup();
  window.location.hash = '#/pulse';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const input = (): PulseInput => ({
  measuredLatencyMs: 18,
  snapshotAt: '2026-08-05T08:00:00.000Z',
  health: {
    state: 'ready',
    data: {
      status: 'ok',
      runtimeState: 'ready',
      uptimeMs: 120_000,
      redis: { connected: true, status: 'connected', latencyMs: 2 },
    },
  },
  projects: { state: 'ready', data: [] },
  sessions: { state: 'ready', data: [] },
  agents: { state: 'ready', data: [] },
  usage: {
    state: 'ready',
    data: [
      { source: 'agent-exact', recordCount: 1, totalTokens: 10 },
      { source: 'agent-reported', recordCount: 1, totalTokens: 20 },
      { source: 'adapter-extracted', recordCount: 1, totalTokens: 30 },
      { source: 'luwi-estimated', recordCount: 1, totalTokens: 40 },
      { source: 'unavailable', recordCount: 1 },
    ],
  },
  context: {
    state: 'ready',
    data: [
      { assigned: true, effective: true, loaded: true, invoked: true },
      { assigned: 'unknown', effective: 'unknown', loaded: 'unknown', invoked: 'unknown' },
    ],
  },
  activity: { state: 'ready', data: [] },
  findings: { state: 'ready', data: [] },
});

describe('LUWI Pulse shell', () => {
  it('renders identity, the supported route, and disabled planned destinations', () => {
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('LUWI Runtime')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pulse' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Graph' })).toBeTruthy();
    expect(screen.queryByText('Welcome back')).toBeNull();
  });

  it('renders empty states without treating them as unavailable', () => {
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="disconnected"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('No registered projects')).toBeTruthy();
    expect(screen.getByText('No active sessions')).toBeTruthy();
    expect(screen.getByText('Realtime disconnected')).toBeTruthy();
  });

  it('preserves usage confidence and context state labels', () => {
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    for (const label of ['Exact', 'Reported', 'Extracted', 'Estimated', 'Unavailable']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    for (const label of ['Assigned', 'Effective', 'Loaded', 'Invoked', 'Unknown']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('shows daemon and Redis failures without exposing connection strings', () => {
    const unavailable = input();
    unavailable.health = { state: 'unavailable' };
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(unavailable)}
        websocketState="disconnected"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('Daemon unavailable')).toBeTruthy();
    expect(document.body.textContent).not.toContain('redis://');
    expect(document.body.textContent).not.toContain('6379');
  });

  it('shows a validated Redis failure as degraded rather than daemon-offline', () => {
    const degraded = input();
    degraded.health = {
      state: 'ready',
      data: {
        status: 'degraded',
        runtimeState: 'degraded',
        uptimeMs: 120_000,
        redis: { connected: false, status: 'disconnected' },
      },
    };
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(degraded)}
        websocketState="disconnected"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('Redis unavailable')).toBeTruthy();
    expect(screen.queryByText('Daemon unavailable')).toBeNull();
    expect(document.body.textContent).not.toContain('redis://');
  });

  it('marks a partial snapshot and offers a bounded manual retry', () => {
    const partial = input();
    partial.findings = { state: 'unavailable' };
    const onRetry = vi.fn();
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(partial)}
        websocketState="live"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('Partial snapshot')).toBeTruthy();
    screen.getByRole('button', { name: 'Retry snapshot' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('exposes Activity as a real route while leaving future destinations disabled', () => {
    window.location.hash = '#/activity';
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="reconnecting"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: 'Activity' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Activity', level: 2 })).toBeTruthy();
    expect(screen.getByText('Realtime reconnecting')).toBeTruthy();
  });

  it('opens a read-only project inspector from supported snapshot data', () => {
    const withProject = input();
    withProject.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'LUWI Runtime', localPath: 'C:/xampp/htdocs/luwiruntime' }],
    };
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(withProject)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Inspect project LUWI Runtime' }));
    expect(screen.getByRole('dialog', { name: 'Project inspector' })).toBeTruthy();
    expect(screen.getAllByText('C:/xampp/htdocs/luwiruntime')).toHaveLength(2);
  });

  it('reconciles an open project inspector against refreshed authoritative snapshots', () => {
    const initial = input();
    initial.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Old Project', localPath: 'C:/old' }],
    };
    const view = render(
      <DashboardApp
        snapshot={buildPulseSnapshot(initial)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect project Old Project' }));

    const refreshed = input();
    refreshed.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Current Project', localPath: 'C:/current' }],
    };
    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(refreshed)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Current Project').length).toBeGreaterThan(0);
    expect(screen.getAllByText('C:/current').length).toBeGreaterThan(0);
    expect(screen.queryByText('C:/old')).toBeNull();
  });

  it('removes stale project data when a selected project disappears', () => {
    const initial = input();
    initial.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Deleted Project', localPath: 'C:/deleted' }],
    };
    const view = render(
      <DashboardApp
        snapshot={buildPulseSnapshot(initial)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect project Deleted Project' }));

    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('Selected project unavailable')).toBeTruthy();
    expect(screen.queryByText('C:/deleted')).toBeNull();
  });

  it('updates an open session inspector to terminal state and clears its duration clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T08:00:00.000Z'));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const initial = input();
    initial.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'LUWI Runtime', localPath: 'C:/luwi' }],
    };
    initial.sessions = {
      state: 'ready',
      data: [
        {
          id: 's1',
          agentId: 'codex-main',
          projectId: 'p1',
          status: 'thinking',
          presence: 'online',
          startedAt: '2026-08-05T07:00:00.000Z',
          lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
        },
      ],
    };
    const view = render(
      <DashboardApp
        snapshot={buildPulseSnapshot(initial)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect session s1' }));
    expect(intervalSpy).toHaveBeenCalledOnce();

    const refreshed = structuredClone(initial);
    if (refreshed.sessions.state === 'ready') {
      refreshed.sessions.data[0] = {
        ...refreshed.sessions.data[0]!,
        status: 'completed',
        presence: 'offline',
      };
    }
    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(refreshed)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByLabelText('Session duration: Unavailable')).toBeTruthy();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('aligns Active Sessions headers and cells with an accessible final Inspect action', () => {
    const withSession = input();
    withSession.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'LUWI Runtime', localPath: 'C:/luwi' }],
    };
    withSession.sessions = {
      state: 'ready',
      data: [
        {
          id: 'session-1',
          agentId: 'codex-main',
          projectId: 'p1',
          status: 'thinking',
          presence: 'online',
          startedAt: '2026-08-05T07:00:00.000Z',
          lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
        },
      ],
    };
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(withSession)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    const table = screen.getByRole('table', { name: 'Active LUWI agent sessions' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent?.trim()),
    ).toEqual(['Agent', 'Project', 'State', 'Started', 'Last heartbeat', 'Inspect']);
    const cells = within(table).getAllByRole('cell');
    expect(cells).toHaveLength(6);
    expect(cells[0]?.textContent).toBe('codex-main');
    expect(cells[1]?.textContent).toBe('LUWI Runtime');
    expect(cells[2]?.textContent).toBe('thinking');
    expect(cells[3]?.querySelector('time')?.dateTime).toBe('2026-08-05T07:00:00.000Z');
    expect(cells[4]?.querySelector('time')?.dateTime).toBe('2026-08-05T07:59:00.000Z');
    const inspect = within(cells[5] as HTMLElement).getByRole('button', {
      name: 'Inspect session session-1',
    });
    inspect.focus();
    fireEvent.click(inspect, { detail: 0 });
    expect(screen.getByRole('dialog', { name: 'Session inspector' })).toBeTruthy();
  });

  it('uses explicit empty and unavailable session states instead of an invalid table', () => {
    const unavailable = input();
    unavailable.sessions = { state: 'unavailable' };
    const view = render(
      <DashboardApp
        snapshot={buildPulseSnapshot(unavailable)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('Session data unavailable')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Active LUWI agent sessions' })).toBeNull();

    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('No active sessions')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Active LUWI agent sessions' })).toBeNull();
  });

  it('labels preserved data as stale without pretending it is unavailable', () => {
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        freshness="stale"
        staleResources={['projects']}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('Stale: projects')).toBeTruthy();
    expect(screen.getByText('No registered projects')).toBeTruthy();
  });

  it('keeps retained data visible while announcing an authoritative refresh', () => {
    const withProject = input();
    withProject.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Retained Project', localPath: 'C:/retained' }],
    };
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(withProject)}
        websocketState="live"
        freshness="refreshing"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('Refreshing snapshot')).toBeTruthy();
    expect(screen.getByText('Retained Project')).toBeTruthy();
  });
});

describe('Projects route', () => {
  const withProjects = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Scoped Project', localPath: 'C:/work/scoped' }],
    };
    return buildPulseSnapshot(value);
  };

  it('promotes Projects from a disabled label to a real link', () => {
    render(<DashboardApp snapshot={withProjects()} websocketState="live" onRetry={vi.fn()} />);

    // "Projects" also labels a Pulse operational-strip counter, so this is
    // scoped to the navigation rail rather than matched globally.
    const nav = screen.getByRole('navigation', { name: /primary/i });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toBeTruthy();
    expect(within(nav).getByText('Projects').closest('[aria-disabled="true"]')).toBeNull();
  });

  it('enables Graph now that the bounded summary contract exists', () => {
    render(<DashboardApp snapshot={withProjects()} websocketState="live" onRetry={vi.fn()} />);

    const nav = screen.getByRole('navigation', { name: /primary/i });
    expect(within(nav).getByRole('link', { name: 'Graph' }).getAttribute('href')).toBe('#/graph');
    expect(within(nav).getByText('Graph').closest('[aria-disabled="true"]')).toBeNull();
  });

  it('renders the project registry when the route is active', () => {
    window.location.hash = '#/projects';
    render(<DashboardApp snapshot={withProjects()} websocketState="live" onRetry={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByText('Scoped Project')).toBeTruthy();
    // The command bar carries its own "Select a project" hint, so this matches
    // the detail prompt specifically.
    expect(screen.getByText(/load its scoped evidence/i)).toBeTruthy();
  });

  it('reports a loading state for the selected project scope', () => {
    window.location.hash = '#/projects/p1';
    render(
      <DashboardApp
        snapshot={withProjects()}
        websocketState="live"
        projectScopeLoading
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText(/loading project evidence/i)).toBeTruthy();
  });

  it('treats every unscoped project resource as unavailable rather than empty', () => {
    window.location.hash = '#/projects/p1';
    render(<DashboardApp snapshot={withProjects()} websocketState="live" onRetry={vi.fn()} />);

    const repository = screen.getByRole('region', { name: /repository/i });
    expect(within(repository).getByText('Unavailable')).toBeTruthy();
  });

  it('leaves Pulse and Activity reachable from the projects route', () => {
    window.location.hash = '#/projects';
    render(<DashboardApp snapshot={withProjects()} websocketState="live" onRetry={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Pulse' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Activity/ })).toBeTruthy();
  });
});

describe('Phase 5D routes', () => {
  const snapshot = () => {
    const value = input();
    value.agents = {
      state: 'ready',
      data: [
        {
          id: 'a1',
          kind: 'other',
          displayName: 'Runner',
          adapterId: 'adapter-x',
          enabled: true,
          updatedAt: '2026-08-05T08:00:00.000Z',
        },
      ],
    };
    return buildPulseSnapshot(value);
  };

  const routes = [
    ['#/sessions', 'Sessions'],
    ['#/agents', 'Agents'],
    ['#/usage', 'Usage'],
    ['#/context', 'Context'],
    ['#/optimization', 'Optimization'],
    ['#/graph', 'Graph'],
  ] as const;

  it.each(routes)('activates %s with its own heading', (hash, heading) => {
    window.location.hash = hash;
    render(<DashboardApp snapshot={snapshot()} websocketState="live" onRetry={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: /primary/i });
    expect(within(nav).getByRole('link', { name: heading }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('leaves no disabled destination in the rail', () => {
    render(<DashboardApp snapshot={snapshot()} websocketState="live" onRetry={vi.fn()} />);

    const nav = screen.getByRole('navigation', { name: /primary/i });
    const disabled = within(nav)
      .getAllByText(/.+/)
      .filter((node) => node.closest('[aria-disabled="true"]') !== null);
    expect(disabled).toHaveLength(0);
    for (const [, heading] of routes) {
      expect(within(nav).getByRole('link', { name: heading })).toBeTruthy();
    }
  });

  it('renders agent kinds verbatim without a vendor label map', () => {
    window.location.hash = '#/agents';
    render(<DashboardApp snapshot={snapshot()} websocketState="live" onRetry={vi.fn()} />);

    expect(screen.getByText('other')).toBeTruthy();
    expect(screen.getByText('adapter-x')).toBeTruthy();
  });

  it('treats unloaded intelligence collections as unavailable, not empty', () => {
    window.location.hash = '#/optimization';
    render(<DashboardApp snapshot={snapshot()} websocketState="live" onRetry={vi.fn()} />);

    const panel = screen.getByRole('region', { name: /proposals/i });
    expect(within(panel).getByText('Unavailable')).toBeTruthy();
  });
});
