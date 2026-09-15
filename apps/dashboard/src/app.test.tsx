// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfigMutations } from './api/config-mutations.js';
import type { AgentMessage } from './api/messages-scope.js';
import { DashboardApp } from './app.js';
import { buildPulseSnapshot, type PulseInput } from './pulse/model.js';
import { createActivityState } from './realtime/activity-store.js';

/*
 * Adapted, not discarded, for the 2026-09-11 overview redesign. Every honesty
 * assertion that still has a surface keeps its assertion on the new surface;
 * what described the rail, the command bar and the old Pulse panels left with
 * those components. The `now` prop pins the header clock so the shell renders
 * the same at every run.
 */

/*
 * jsdom here exposes no `localStorage`; the view and theme hooks tolerate that
 * (they catch and fall back), but the persistence assertions need a real one.
 */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
});

afterEach(() => {
  cleanup();
  window.location.hash = '#/pulse';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const NOW = Date.parse('2026-08-05T08:00:00.000Z');
const now = () => NOW;

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

const session = (
  id: string,
  overrides: Partial<{
    agentId: string;
    projectId: string;
    status: string;
    presence: 'online' | 'offline';
  }> = {},
) => ({
  id,
  agentId: overrides.agentId ?? 'runner-main',
  projectId: overrides.projectId ?? 'p1',
  status: overrides.status ?? 'thinking',
  presence: overrides.presence ?? ('online' as const),
  startedAt: '2026-08-05T07:00:00.000Z',
  lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
});

const routedMessage: AgentMessage = {
  id: 'message-1',
  correlationId: 'corr-1',
  projectId: 'p1',
  sourceSessionId: 's1',
  sourceAgentId: 'agent-a',
  targetSessionId: 's2',
  targetAgentId: 'agent-b',
  selectionReason: 'direct target',
  kind: 'question',
  subject: 'Drawer precedence',
  content: 'Can two drawers mount?',
  evidenceRequirements: [],
  state: 'responded',
  createdAt: '2026-08-05T07:00:00.000Z',
  updatedAt: '2026-08-05T07:00:01.000Z',
  deadlineAt: '2026-08-05T07:02:00.000Z',
  respondedAt: '2026-08-05T07:00:01.000Z',
  response: {
    status: 'answered',
    answer: 'Only one drawer may mount.',
    evidenceCount: 0,
    verifiedAt: '2026-08-05T07:00:01.000Z',
  },
};

const shell = (value: PulseInput, props: Partial<Parameters<typeof DashboardApp>[0]> = {}) =>
  render(
    <DashboardApp
      snapshot={buildPulseSnapshot(value)}
      websocketState="live"
      onRetry={vi.fn()}
      now={now}
      {...props}
    />,
  );

const drillDown = () => screen.getByRole('complementary', { name: 'Drill-down' });

describe('skip link', () => {
  it('moves focus to the main region without changing the route', () => {
    window.location.hash = '#/sessions';
    shell(input());

    fireEvent.click(screen.getByRole('link', { name: /skip to/i }));

    // The bypass mechanism must not be the one control that resets the
    // user's context: '#main-content' is not a route.
    expect(window.location.hash).toBe('#/sessions');
    expect(document.activeElement).toBe(document.querySelector('#main-content'));
  });

  it('leaves the main region focusable only programmatically', () => {
    shell(input());
    expect(document.querySelector('#main-content')?.getAttribute('tabindex')).toBe('-1');
  });
});

describe('Runtime health panel', () => {
  it('reports only what it actually read', () => {
    window.location.hash = '#/runtime';
    shell(input());

    // Runtime is a drawer over the overview, not a page of its own.
    const drawer = screen.getByRole('dialog', { name: 'Runtime' });
    expect(drillDown()).toBeTruthy();
    // No "Function library" or "Projection health" rows may reappear, on any
    // route, without a daemon read behind them.
    expect(within(drawer).queryByText('Function library')).toBeNull();
    expect(within(drawer).queryByText('Projection health')).toBeNull();
    expect(within(drawer).getByText('Uptime')).toBeTruthy();
    expect(within(drawer).getByText('Realtime')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close drawer' }));
    expect(window.location.hash).toBe('#/pulse');
  });
});

describe('overview shell', () => {
  it('does not render an Inspector before a subject is selected', () => {
    shell(input());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the identity and the lens switch, and no navigation rail', () => {
    shell(input());

    expect(screen.getByRole('link', { name: 'Luwi Runtime overview' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy();
    // The Ctrl K command palette was removed (2026-09-15): the overview's own
    // drill-down links reach the detail routes, and the palette's route/search
    // list was redundant after the redesign.
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('renders empty states without treating them as unavailable', () => {
    shell(input(), { websocketState: 'disconnected' });

    expect(screen.getByText('No registered projects')).toBeTruthy();
    expect(within(drillDown()).getByText('No active sessions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Realtime disconnected' })).toBeTruthy();
  });

  it('switches the lens and remembers the choice', () => {
    shell(input());
    const view = screen.getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.click(within(view).getByRole('button', { name: 'Flow' }));
    expect(within(view).getByRole('button', { name: 'Flow' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('Status')).toBeTruthy();
    expect(window.localStorage.getItem('luwi.view')).toBe('flow');

    fireEvent.click(within(view).getByRole('button', { name: 'Timeline' }));
    expect(screen.getByText('NOW')).toBeTruthy();
    fireEvent.click(within(view).getByRole('button', { name: 'Radial' }));
    expect(screen.getByText('ring = share of retained events')).toBeTruthy();
  });

  it('preserves the usage confidence labels on the Usage route', () => {
    window.location.hash = '#/usage';
    shell(input());
    for (const label of ['Exact', 'Reported', 'Extracted', 'Estimated', 'Unavailable']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('shows the token figure by its grade and never as a sum across grades', () => {
    shell(input());
    const totals = screen.getByRole('group', { name: 'Runtime totals' });
    // The unified stat strip renders the grade label as-is (the old Board `inline`
    // variant lowercased it); the figure is still one grade, never the sum.
    expect(within(totals).getByText('Tokens · exact')).toBeTruthy();
    expect(within(totals).getByText('10')).toBeTruthy();
    expect(within(totals).queryByText('100')).toBeNull();
  });

  it('shows daemon and Redis failures without exposing connection strings', () => {
    const unavailable = input();
    unavailable.health = { state: 'unavailable' };
    shell(unavailable, { websocketState: 'disconnected' });

    expect(within(drillDown()).getByText(/Daemon offline/)).toBeTruthy();
    expect(screen.getAllByText('OFFLINE').length).toBeGreaterThan(0);
    // A Redis verdict needs a daemon answer behind it.
    expect(screen.queryByText(/Redis (connected|disconnected)/)).toBeNull();
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
    shell(degraded, { websocketState: 'disconnected' });

    expect(within(drillDown()).getByText(/Daemon degraded · Redis disconnected/)).toBeTruthy();
    expect(screen.queryByText(/Daemon offline/)).toBeNull();
    expect(document.body.textContent).not.toContain('redis://');
  });

  it('states daemon and Redis health in the runtime drill-down', () => {
    shell(input());
    expect(within(drillDown()).getByText(/Daemon online · Redis connected · 2 ms/)).toBeTruthy();
  });

  it('marks a partial snapshot and offers a bounded manual retry', () => {
    const partial = input();
    partial.findings = { state: 'unavailable' };
    const onRetry = vi.fn();
    shell(partial, { onRetry });

    const retry = screen.getByRole('button', { name: 'Retry snapshot' });
    expect(retry.getAttribute('title')).toContain('Partial snapshot');
    expect(retry.textContent).toBe('PARTIAL');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers no retry tag while the snapshot is current and whole', () => {
    shell(input());
    expect(screen.queryByRole('button', { name: 'Retry snapshot' })).toBeNull();
  });

  it('labels preserved data as stale without pretending it is unavailable', () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Retained Project', localPath: 'C:/retained' }],
    };
    shell(value, { freshness: 'stale', staleResources: ['projects'] });

    const tag = screen.getByRole('button', { name: 'Retry snapshot' });
    expect(tag.getAttribute('title')).toContain('Stale: projects');
    expect(screen.getByRole('button', { name: 'Focus project Retained Project' })).toBeTruthy();
  });

  it('keeps retained data visible while announcing an authoritative refresh', () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Retained Project', localPath: 'C:/retained' }],
    };
    shell(value, { freshness: 'refreshing' });

    expect(screen.getByRole('button', { name: 'Retry snapshot' }).getAttribute('title')).toContain(
      'Refreshing snapshot',
    );
    expect(screen.getByRole('button', { name: 'Focus project Retained Project' })).toBeTruthy();
  });

  it('exposes Activity as a real route with its own heading', () => {
    window.location.hash = '#/activity';
    shell(input(), { websocketState: 'reconnecting' });

    expect(screen.getByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Realtime reconnecting' })).toBeTruthy();
  });

  it('uses explicit empty and unavailable session states', () => {
    const unavailable = input();
    unavailable.sessions = { state: 'unavailable' };
    const view = shell(unavailable);
    expect(within(drillDown()).getByText('Session data unavailable')).toBeTruthy();
    const totals = screen.getByRole('group', { name: 'Runtime totals' });
    expect(within(totals).getByText('sessions unavailable')).toBeTruthy();

    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
        now={now}
      />,
    );
    expect(within(drillDown()).getByText('No active sessions')).toBeTruthy();
  });
});

describe('inspectors from the overview', () => {
  const withProject = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'LUWI Runtime', localPath: 'C:/xampp/htdocs/luwiruntime' }],
    };
    return value;
  };

  it('opens a read-only project inspector from the focused project drill-down', () => {
    shell(withProject());

    fireEvent.click(screen.getByRole('button', { name: 'Focus project LUWI Runtime' }));
    fireEvent.click(
      within(drillDown()).getByRole('button', { name: 'Inspect project LUWI Runtime' }),
    );
    expect(screen.getByRole('dialog', { name: 'Project inspector' })).toBeTruthy();
    expect(screen.getAllByText('C:/xampp/htdocs/luwiruntime').length).toBeGreaterThan(0);
  });

  it('reconciles an open project inspector against refreshed authoritative snapshots', () => {
    const initial = input();
    initial.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Old Project', localPath: 'C:/old' }],
    };
    const view = shell(initial);
    fireEvent.click(screen.getByRole('button', { name: 'Focus project Old Project' }));
    fireEvent.click(
      within(drillDown()).getByRole('button', { name: 'Inspect project Old Project' }),
    );

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
        now={now}
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
    const view = shell(initial);
    fireEvent.click(screen.getByRole('button', { name: 'Focus project Deleted Project' }));
    fireEvent.click(
      within(drillDown()).getByRole('button', { name: 'Inspect project Deleted Project' }),
    );

    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        onRetry={vi.fn()}
        now={now}
      />,
    );

    expect(screen.getByText('Selected project unavailable')).toBeTruthy();
    expect(screen.queryByText('C:/deleted')).toBeNull();
    // The drill-down fell back to the runtime rather than naming a project that is gone.
    expect(within(drillDown()).getByRole('heading', { name: 'Luwi Runtime' })).toBeTruthy();
  });

  it('updates an open session inspector to terminal state and clears its duration clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const initial = withProject();
    initial.sessions = { state: 'ready', data: [session('s1')] };
    const view = shell(initial);
    fireEvent.click(within(drillDown()).getByRole('button', { name: 'Focus session s1' }));
    fireEvent.click(within(drillDown()).getByRole('button', { name: 'Inspect session s1' }));
    expect(screen.getByRole('dialog', { name: 'Session inspector' })).toBeTruthy();
    clearIntervalSpy.mockClear();

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
        now={now}
      />,
    );

    expect(screen.getAllByText('completed').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Session duration: Unavailable')).toBeTruthy();
    // Only the inspector's duration clock stops; the header clock keeps ticking.
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });
});

describe('Projects route', () => {
  const withProjects = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Scoped Project', localPath: 'C:/work/scoped' }],
    };
    return value;
  };

  it('renders the project registry when the route is active', () => {
    window.location.hash = '#/projects';
    shell(withProjects());

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    expect(screen.getAllByText('Scoped Project').length).toBeGreaterThan(0);
    expect(screen.getByText(/load its scoped evidence/i)).toBeTruthy();
  });

  it('reports a loading state for the selected project scope', () => {
    window.location.hash = '#/projects/p1';
    shell(withProjects(), { projectScopeLoading: true });
    expect(screen.getByText(/loading project evidence/i)).toBeTruthy();
  });

  it('treats every unscoped project resource as unavailable rather than empty', () => {
    window.location.hash = '#/projects/p1';
    shell(withProjects());
    const repository = screen.getByRole('region', { name: /repository/i });
    expect(within(repository).getByText('Unavailable')).toBeTruthy();
  });

  it('leaves the overview one link away from every detail route', () => {
    window.location.hash = '#/projects';
    shell(withProjects());
    expect(screen.getByRole('link', { name: '← Overview' }).getAttribute('href')).toBe('#/pulse');
  });
});

describe('detail routes', () => {
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
    return value;
  };

  const routes = [
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

  it.each(routes)(
    'activates %s with its own heading and a way back to the overview',
    (hash, heading) => {
      window.location.hash = hash;
      shell(snapshot());

      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
      expect(screen.getByRole('link', { name: '← Overview' }).getAttribute('href')).toBe('#/pulse');
    },
  );

  /**
   * The capability is threaded as a prop rather than imported by the view, so
   * a shell constructed without one is a genuinely read-only config route.
   */
  it('carries no mutation capability into the config route unless given one', () => {
    window.location.hash = '#/config';
    const { unmount } = shell(snapshot(), {
      configResources: { drifts: { state: 'ready', data: [] } },
    });
    expect(screen.queryByRole('button', { name: 'Rescan drift' })).toBeNull();
    unmount();

    shell(snapshot(), {
      configResources: { drifts: { state: 'ready', data: [] } },
      configMutations: createConfigMutations(vi.fn() as unknown as typeof fetch),
    });
    expect(screen.getByRole('button', { name: 'Rescan drift' })).toBeTruthy();
  });

  it('renders agent kinds verbatim without a vendor label map', () => {
    window.location.hash = '#/agents';
    shell(snapshot());
    expect(screen.getByText('other')).toBeTruthy();
    expect(screen.getByText('adapter-x')).toBeTruthy();
  });

  it('treats unloaded intelligence collections as unavailable, not empty', () => {
    window.location.hash = '#/optimization';
    shell(snapshot());
    const panel = screen.getByRole('region', { name: /proposals/i });
    expect(within(panel).getByText('Unavailable')).toBeTruthy();
  });

  it('opens the session inspector from the sessions route', () => {
    window.location.hash = '#/sessions';
    const value = input();
    value.sessions = { state: 'ready', data: [session('s1', { agentId: 'a1' })] };
    shell(value);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect session s1' }));
    expect(screen.getByRole('dialog', { name: /session inspector/i })).toBeTruthy();
  });

  it('dispatches a bounded session question and routes to its correlation', async () => {
    window.location.hash = '#/sessions';
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Runtime', localPath: 'C:/work/runtime' }],
    };
    value.sessions = {
      state: 'ready',
      data: [
        session('source', { agentId: 'agent-a' }),
        session('target', { agentId: 'agent-b', status: 'idle' }),
      ],
    };
    const ask = vi.fn().mockResolvedValue({
      state: 'ok',
      httpStatus: 202,
      data: { correlationId: 'corr/created', targetSessionId: 'target', idempotent: false },
    });
    shell(value, { messageMutations: { ask } });

    fireEvent.click(screen.getByRole('button', { name: 'Ask session target' }));
    fireEvent.change(screen.getByLabelText('Question'), {
      target: { value: 'Who owns this change?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch question' }));

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(window.location.hash).toBe('#/messages/corr%2Fcreated');
  });
});

describe('project filter', () => {
  const twoProjects = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [
        { id: 'p1', name: 'Alpha', localPath: 'C:/a' },
        { id: 'p2', name: 'Beta', localPath: 'C:/b' },
      ],
    };
    value.sessions = { state: 'ready', data: [session('s1', { projectId: 'p1' })] };
    return value;
  };
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Project scope' }));
  const trigger = () => screen.getByRole('button', { name: 'Project scope' }).textContent ?? '';

  it('switches a project off and on with one click each, and keeps the choice', () => {
    shell(twoProjects());
    expect(screen.getByRole('button', { name: 'Focus project Beta' })).toBeTruthy();
    expect(trigger()).toContain('All projects');

    openMenu();
    const beta = screen.getByRole('button', { name: 'Show Beta' });
    expect(beta.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(beta);
    expect(screen.queryByRole('button', { name: 'Focus project Beta' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Focus project Alpha' })).toBeTruthy();
    expect(trigger()).toContain('1 of 2');
    expect(JSON.parse(window.localStorage.getItem('luwi.projects') ?? '{}')).toEqual({
      hidden: ['p2'],
      hideQuiet: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show Beta' }));
    expect(screen.getByRole('button', { name: 'Focus project Beta' })).toBeTruthy();
    expect(trigger()).toContain('All projects');
  });

  it('keeps only one project on request and brings every project back', () => {
    shell(twoProjects());
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Show only Beta' }));
    expect(screen.queryByRole('button', { name: 'Focus project Alpha' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Focus project Beta' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(screen.getByRole('button', { name: 'Focus project Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Focus project Beta' })).toBeTruthy();
  });

  it('hides quiet projects on one switch and lists the active ones first', () => {
    window.localStorage.setItem('luwi.projects', JSON.stringify({ hidden: [], hideQuiet: true }));
    shell(twoProjects());
    // Beta has no active session, so the persisted rule already hides it.
    expect(screen.queryByRole('button', { name: 'Focus project Beta' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Focus project Alpha' })).toBeTruthy();

    openMenu();
    const rows = screen.getAllByRole('button', { name: /^Show (Alpha|Beta)$/ });
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Show Alpha', 'Show Beta']);
    const quiet = screen.getByRole('button', { name: 'Hide quiet projects' });
    expect(quiet.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(quiet);
    expect(screen.getByRole('button', { name: 'Focus project Beta' })).toBeTruthy();
  });

  it('says how many projects the filter hid rather than claiming none are registered', () => {
    const value = twoProjects();
    value.sessions = { state: 'ready', data: [] };
    window.localStorage.setItem('luwi.projects', JSON.stringify({ hidden: [], hideQuiet: true }));
    shell(value);

    expect(screen.getByText('2 projects hidden by the filter')).toBeTruthy();
    expect(screen.queryByText('No registered projects')).toBeNull();
    expect(trigger()).toContain('0 of 2');
  });
});

describe('focus in the hash', () => {
  const twoProjects = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [
        { id: 'p1', name: 'Alpha', localPath: 'C:/a' },
        { id: 'p2', name: 'Beta', localPath: 'C:/b' },
      ],
    };
    value.sessions = { state: 'ready', data: [session('s1', { projectId: 'p1' })] };
    return value;
  };

  it('restores the focused project from the hash on load', () => {
    window.location.hash = '#/pulse/p2';
    shell(twoProjects());

    expect(within(drillDown()).getByRole('heading', { name: 'Beta' })).toBeTruthy();
  });

  it('writes the focused project into the hash without a history entry, and clears it', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    shell(twoProjects());

    fireEvent.click(screen.getByRole('button', { name: 'Focus project Alpha' }));
    expect(window.location.hash).toBe('#/pulse/p1');
    // A session focus keeps its project in the hash.
    fireEvent.click(within(drillDown()).getByRole('button', { name: 'Focus session s1' }));
    expect(window.location.hash).toBe('#/pulse/p1');
    expect(within(drillDown()).getByRole('button', { name: 'Inspect session s1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Focus runtime' }));
    expect(window.location.hash).toBe('#/pulse');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('returns from a detail route to the project that was focused', () => {
    window.location.hash = '#/pulse/p1';
    shell(twoProjects());
    window.location.hash = '#/sessions';
    fireEvent(window, new Event('hashchange'));

    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '← Overview' }).getAttribute('href')).toBe(
      '#/pulse/p1',
    );
  });
});

describe('project settings', () => {
  const twoProjects = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [
        { id: 'p1', name: 'Alpha', localPath: 'C:/a' },
        { id: 'p2', name: 'Beta', localPath: 'C:/b' },
      ],
    };
    value.sessions = { state: 'ready', data: [session('s1', { projectId: 'p1' })] };
    return value;
  };
  const registered = {
    id: 'p3',
    name: 'Gamma',
    localPath: 'C:/g',
    canonicalPath: 'C:/g',
    createdAt: '2026-08-05T08:00:00.000Z',
    updatedAt: '2026-08-05T08:00:00.000Z',
  };
  const api = () => ({
    register: vi.fn().mockResolvedValue({ state: 'ok', httpStatus: 201, data: registered }),
    update: vi.fn().mockResolvedValue({ state: 'ok', httpStatus: 200, data: registered }),
  });

  it('offers registration from the PROJECTS menu only when it can write, and re-reads after', async () => {
    shell(twoProjects());
    fireEvent.click(screen.getByRole('button', { name: 'Project scope' }));
    expect(screen.queryByRole('button', { name: /Register a project/ })).toBeNull();
    cleanup();

    const mutations = api();
    const onProjectMutated = vi.fn();
    shell(twoProjects(), { projectMutations: mutations, onProjectMutated });
    fireEvent.click(screen.getByRole('button', { name: 'Project scope' }));
    fireEvent.click(screen.getByRole('button', { name: /Register a project/ }));
    const dialog = screen.getByRole('dialog', { name: 'Register a project' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Gamma' } });
    fireEvent.change(within(dialog).getByLabelText('Local path'), { target: { value: 'C:/g' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register project' }));

    await waitFor(() => expect(onProjectMutated).toHaveBeenCalledTimes(1));
    expect(mutations.register).toHaveBeenCalledWith({ name: 'Gamma', localPath: 'C:/g' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // The project just registered is the focus the re-read will land on.
    expect(window.location.hash).toBe('#/pulse/p3');
  });

  it('edits a project in place inside its detail drawer, over the overview', async () => {
    window.location.hash = '#/pulse/p1/detail';
    const mutations = api();
    const onProjectMutated = vi.fn();
    shell(twoProjects(), { projectMutations: mutations, onProjectMutated });

    const drawer = screen.getByRole('dialog', { name: 'Project detail' });
    // The overview is still underneath: the drill-down and its focus are unchanged.
    expect(within(drillDown()).getByRole('heading', { name: 'Alpha' })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit project Alpha' }));
    expect((within(drawer).getByLabelText('Name') as HTMLInputElement).value).toBe('Alpha');
    expect(within(drawer).queryByLabelText('Local path')).toBeNull();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    expect(within(drawer).queryByLabelText('Name')).toBeNull();
    // Focus returns to the control that opened the form, inside the drawer.
    expect(document.activeElement).toBe(
      within(drawer).getByRole('button', { name: 'Edit project Alpha' }),
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit project Alpha' }));
    fireEvent.change(within(drawer).getByLabelText('Name'), { target: { value: 'Alpha 2' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProjectMutated).toHaveBeenCalledTimes(1));
    expect(mutations.update).toHaveBeenCalledWith('p1', { name: 'Alpha 2' });
    expect(within(drawer).queryByLabelText('Name')).toBeNull();

    // Closing returns to the focused project on the overview, not to a registry.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close drawer' }));
    expect(window.location.hash).toBe('#/pulse/p1');
  });

  it('shows no edit control when the shell carries no project mutation capability', () => {
    window.location.hash = '#/pulse/p1/detail';
    shell(twoProjects());
    const drawer = screen.getByRole('dialog', { name: 'Project detail' });
    expect(within(drawer).queryByRole('button', { name: /Edit project/ })).toBeNull();
  });
});

describe('project evidence drawer', () => {
  const withDrawerProject = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'p1', name: 'Drawer Project', localPath: 'C:/work/drawer' }],
    };
    return value;
  };

  it('shows the selected project evidence in the right drawer, not below the table', () => {
    window.location.hash = '#/projects/p1';
    shell(withDrawerProject());

    const drawer = screen.getByRole('dialog', { name: 'Project detail' });
    expect(within(drawer).getByRole('region', { name: /repository/i })).toBeTruthy();
    const registry = screen.getByRole('region', { name: /registered projects/i });
    expect(within(registry).queryByRole('region', { name: /repository/i })).toBeNull();
  });

  it('closes back to the registry', () => {
    window.location.hash = '#/projects/p1';
    shell(withDrawerProject());
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(window.location.hash).toBe('#/projects');
  });

  it('closes on Escape and returns focus to the row that opened it', async () => {
    window.location.hash = '#/projects';
    shell(withDrawerProject());

    const opener = screen.getByRole('button', { name: 'Drawer Project' });
    opener.focus();
    fireEvent.click(opener);
    expect(window.location.hash).toBe('#/projects/p1');
    fireEvent(window, new Event('hashchange'));
    const drawer = screen.getByRole('dialog', { name: 'Project detail' });

    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(window.location.hash).toBe('#/projects');
    fireEvent(window, new Event('hashchange'));
    expect(screen.queryByRole('dialog', { name: 'Project detail' })).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('dismisses the inspector before a routed project drawer opens', () => {
    window.location.hash = '#/pulse';
    const value = withDrawerProject();
    value.sessions = { state: 'ready', data: [session('s1')] };
    shell(value);

    fireEvent.click(within(drillDown()).getByRole('button', { name: 'Focus session s1' }));
    fireEvent.click(within(drillDown()).getByRole('button', { name: 'Inspect session s1' }));
    window.location.hash = '#/projects/p1';
    fireEvent(window, new Event('hashchange'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Project detail' })).toBeTruthy();
  });

  it('dismisses the inspector before a routed message drawer opens', () => {
    window.location.hash = '#/pulse';
    const value = withDrawerProject();
    value.sessions = { state: 'ready', data: [session('s1', { agentId: 'agent-a' })] };
    shell(value, {
      messageResources: {
        messages: { state: 'ready', data: { items: [routedMessage], truncated: false } },
      },
    });

    fireEvent.click(within(drillDown()).getByRole('button', { name: 'Focus session s1' }));
    fireEvent.click(within(drillDown()).getByRole('button', { name: 'Inspect session s1' }));
    window.location.hash = '#/messages/corr-1';
    fireEvent(window, new Event('hashchange'));

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Message detail' })).toBeTruthy();
  });
});

describe('shell controls', () => {
  const activityEvent = (streamId: string, type = 'session.updated') => ({
    streamId,
    id: `evt-${streamId}`,
    type,
    version: 1 as const,
    occurredAt: '2026-08-05T07:00:00.000Z',
    workspaceId: 'local',
    payload: {},
  });

  it('offers the three theme choices as a segmented control and applies the pressed one', () => {
    shell(input());

    const theme = screen.getByRole('group', { name: 'Theme' });
    expect(within(theme).getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(theme).getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(within(theme).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(within(theme).getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    fireEvent.click(within(theme).getByRole('button', { name: 'Auto' }));
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('pauses and resumes the feed on one pressed switch that counts what arrived', () => {
    const onActivityStateChange = vi.fn();
    const state = createActivityState();
    const view = shell(input(), { activityState: state, onActivityStateChange });

    const live = screen.getByRole('button', { name: 'Live' });
    expect(live.getAttribute('aria-pressed')).toBe('true');
    expect(live.textContent).toContain('LIVE');
    fireEvent.click(live);
    expect(onActivityStateChange.mock.lastCall?.[0]).toMatchObject({ following: false });

    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        activityState={{ ...state, following: false, pendingCount: 3 }}
        onActivityStateChange={onActivityStateChange}
        onRetry={vi.fn()}
        now={now}
      />,
    );
    const paused = screen.getByRole('button', { name: 'Paused · 3 new · resume' });
    expect(paused.getAttribute('aria-pressed')).toBe('false');
    expect(paused.textContent).toContain('PAUSED · 3 NEW');
    fireEvent.click(paused);
    expect(onActivityStateChange.mock.lastCall?.[0]).toMatchObject({
      following: true,
      pendingCount: 0,
    });
  });

  it('keeps a connection fault on the switch rather than reading Live over a dead socket', () => {
    shell(input(), { websocketState: 'reconnecting' });
    const toggle = screen.getByRole('button', { name: 'Realtime reconnecting' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('RECONNECTING');
    expect(screen.queryByRole('button', { name: 'Live' })).toBeNull();
  });

  it('holds the stream while paused and releases it on resume', () => {
    const paused = {
      ...createActivityState(),
      following: false,
      pendingCount: 0,
      events: [activityEvent('1-0')],
    };
    const view = shell(input(), { activityState: paused, onActivityStateChange: vi.fn() });
    const ticker = () => screen.getByRole('log', { name: 'Realtime stream' });
    expect(within(ticker()).getByText('session.updated')).toBeTruthy();

    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        activityState={{
          ...paused,
          pendingCount: 1,
          events: [activityEvent('1-0'), activityEvent('2-0', 'project.updated')],
        }}
        onActivityStateChange={vi.fn()}
        onRetry={vi.fn()}
        now={now}
      />,
    );
    // The new event is counted on the switch, not painted into the held stream.
    expect(within(ticker()).getByText('PAUSED · 1 NEW')).toBeTruthy();
    expect(within(ticker()).queryByText('project.updated')).toBeNull();

    view.rerender(
      <DashboardApp
        snapshot={buildPulseSnapshot(input())}
        websocketState="live"
        activityState={{
          ...paused,
          following: true,
          events: [activityEvent('1-0'), activityEvent('2-0', 'project.updated')],
        }}
        onActivityStateChange={vi.fn()}
        onRetry={vi.fn()}
        now={now}
      />,
    );
    expect(within(ticker()).getByText('project.updated')).toBeTruthy();
    expect(within(ticker()).queryByText(/PAUSED/)).toBeNull();
  });
});
