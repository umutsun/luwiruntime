// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConfigMutations } from './api/config-mutations.js';
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

describe('skip link', () => {
  it('moves focus to the main region without changing the route', () => {
    window.location.hash = '#/sessions';
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('link', { name: /skip to/i }));

    // The bypass mechanism must not be the one control that resets the
    // user's context: '#main-content' is not a route, and parseRoute would
    // fall through to Pulse.
    expect(window.location.hash).toBe('#/sessions');
    expect(document.activeElement).toBe(document.querySelector('#main-content'));
  });

  it('leaves the main region focusable only programmatically', () => {
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    expect(document.querySelector('#main-content')?.getAttribute('tabindex')).toBe('-1');
  });
});

describe('Runtime health panel', () => {
  /*
   * Rewritten for phases 4-5 of the redesign: the panel moved from Pulse to
   * the new #/runtime route, because the stat strip now states daemon,
   * latency and Redis on Pulse and the panel duplicated the line above it.
   * The assertions it carried are unchanged — including the ban it exists
   * for: no "Function library" or "Projection health" rows may reappear,
   * on any route, without a daemon read behind them.
   */
  it('reports only what it actually read', () => {
    window.location.hash = '#/runtime';
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    // Both rows used to render a literal "Unavailable" with no data source
    // behind them. Function-library state is exposed by no daemon route at
    // all, and projection health is read on the Graph route, where ADR 0013's
    // 56-command cost is paid deliberately — so asserting a fault here was
    // claiming evidence the runtime never produced.
    expect(screen.queryByText('Function library')).toBeNull();
    expect(screen.queryByText('Projection health')).toBeNull();
    expect(screen.getByText('Uptime')).toBeTruthy();
    expect(screen.getByText('Realtime')).toBeTruthy();
  });
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

  /*
   * Split for phase 4: the Usage summary panel left Pulse for the mockup's
   * row-3 anatomy — its evidence grades live on #/usage, which the rail links.
   * The five context labels stay on Pulse in the Context Efficiency panel.
   * Both vocabularies must survive verbatim; that is what this test pins.
   */
  it('preserves usage confidence and context state labels', () => {
    window.location.hash = '#/usage';
    const usage = render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );
    for (const label of ['Exact', 'Reported', 'Extracted', 'Estimated', 'Unavailable']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    usage.unmount();

    window.location.hash = '#/pulse';
    render(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );
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
    expect(screen.getByRole('complementary', { name: 'Project inspector' })).toBeTruthy();
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

  /*
   * Rewritten, not patched, for phase 3 of the dashboard redesign.
   *
   * This used to pin an "Active LUWI agent sessions" table by column order and
   * by `cells[3]`/`cells[4]`/`cells[5]` index. Active Work is not that table any
   * more: it is four dual-line columns, and the row itself is the control that
   * drives the docked inspector, so there is no sixth cell holding an Inspect
   * button and no cell indices to align. Adapting the old assertions would have
   * meant asserting positions that no longer describe the component.
   *
   * What survives is the contract the redesign did not change: the action name
   * is still `Inspect session <id>`, keyboard activation still opens the pane,
   * and the row's evidence is still reachable — now as the button's description,
   * because an `aria-label` naming the action would otherwise replace it.
   */
  it('drives the docked inspector from the whole row, keeping its evidence announced', () => {
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

    const work = screen.getByRole('region', { name: 'Active Work' });
    expect(within(work).getByTestId('work-columns').textContent).toBe(
      'Agent · ProjectTask · ScopeContextStatus · Age',
    );

    const row = within(work).getByRole('button', { name: 'Inspect session session-1' });
    const description = document.getElementById(row.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toContain('codex-main');
    expect(description?.textContent).toContain('LUWI Runtime');
    expect(description?.textContent).toContain('thinking');

    row.focus();
    fireEvent.click(row, { detail: 0 });
    expect(screen.getByRole('complementary', { name: 'Session inspector' })).toBeTruthy();
  });

  it('marks the row the docked inspector is showing, since both stay on screen', () => {
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
    const { container } = render(
      <DashboardApp
        snapshot={buildPulseSnapshot(withSession)}
        websocketState="live"
        onRetry={vi.fn()}
      />,
    );

    expect(container.querySelector('.work-row--selected')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect session session-1' }));
    expect(container.querySelector('.work-row--selected')).toBeTruthy();
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
    // Also an <option> in the scope switcher now, hence getAllByText.
    expect(screen.getAllByText('Retained Project').length).toBeGreaterThan(0);
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
    // Also an <option> in the scope switcher now, hence getAllByText.
    expect(screen.getAllByText('Scoped Project').length).toBeGreaterThan(0);
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
    ['#/runtime', 'Runtime'],
    ['#/sessions', 'Sessions'],
    ['#/agents', 'Agents'],
    ['#/messages', 'Messages'],
    ['#/capabilities', 'Capabilities'],
    ['#/config', 'Configuration'],
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

  /**
   * The capability is threaded as a prop rather than imported by the view, so
   * a shell constructed without one is a genuinely read-only config route.
   * `main.tsx` is the only caller that supplies it.
   */
  it('carries no mutation capability into the config route unless given one', () => {
    window.location.hash = '#/config';
    const { unmount } = render(
      <DashboardApp
        snapshot={snapshot()}
        websocketState="live"
        onRetry={vi.fn()}
        configResources={{ drifts: { state: 'ready', data: [] } }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Rescan drift' })).toBeNull();
    unmount();

    render(
      <DashboardApp
        snapshot={snapshot()}
        websocketState="live"
        onRetry={vi.fn()}
        configResources={{ drifts: { state: 'ready', data: [] } }}
        configMutations={createConfigMutations(vi.fn() as unknown as typeof fetch)}
      />,
    );

    expect(screen.getByRole('button', { name: 'Rescan drift' })).toBeTruthy();
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

  it('opens the session inspector from the sessions route', () => {
    window.location.hash = '#/sessions';
    const value = input();
    value.sessions = {
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
    };
    render(
      <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Inspect session s1' }));

    expect(screen.getByRole('complementary', { name: /session inspector/i })).toBeTruthy();
  });
});

describe('command bar scope line', () => {
  it('states what the current route holds instead of advertising an absent search', () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Alpha', localPath: 'C:/work/alpha' }],
    };
    render(
      <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
    );

    const scope = screen.getByLabelText('Current scope');
    expect(scope.textContent).toContain('1 project');
    expect(screen.queryByText(/no read contract yet/i)).toBeNull();
  });

  it('reports an unavailable count as unavailable rather than as zero', () => {
    const value = input();
    value.projects = { state: 'unavailable' };
    render(
      <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
    );

    expect(screen.getByLabelText('Current scope').textContent).toContain('Projects unavailable');
  });

  it('never reports an unavailable activity read as zero retained events', () => {
    window.location.hash = '#/activity';
    const value = input();
    value.activity = { state: 'unavailable' };
    render(
      <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
    );

    const scope = screen.getByLabelText('Current scope').textContent ?? '';
    expect(scope).toContain('Activity unavailable');
    expect(scope).not.toContain('0 retained');
  });

  it('passes the activity availability down so the route can tell the states apart', () => {
    window.location.hash = '#/activity';
    const value = input();
    value.activity = { state: 'unavailable' };
    render(
      <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
    );

    expect(screen.getByText(/activity snapshot unavailable/i)).toBeTruthy();
  });
});

describe('project scope switcher', () => {
  it('narrows the operational rows to the chosen project and back', () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [
        { id: 'p1', name: 'Alpha', localPath: 'C:/a' },
        { id: 'p2', name: 'Beta', localPath: 'C:/b' },
      ],
    };
    value.sessions = {
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
    };
    render(
      <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Inspect session s2' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Project scope'), { target: { value: 'p1' } });
    expect(screen.queryByRole('button', { name: 'Inspect session s2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Inspect session s1' })).toBeTruthy();
    // The scope line follows the scope, so the bar cannot contradict itself.
    expect(screen.getByLabelText('Current scope').textContent).toContain('1 project');

    fireEvent.change(screen.getByLabelText('Project scope'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Inspect session s2' })).toBeTruthy();
  });
});
