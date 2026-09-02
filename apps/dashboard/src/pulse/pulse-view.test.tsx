// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPulseSnapshot, type PulseInput, type PulseSession } from './model.js';
import { collapseRuns, PulseView } from './pulse-view.js';

afterEach(cleanup);

const SNAPSHOT_AT = '2026-08-05T08:00:00.000Z';

const input = (): PulseInput => ({
  measuredLatencyMs: 18,
  snapshotAt: SNAPSHOT_AT,
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
  usage: { state: 'ready', data: [] },
  context: { state: 'ready', data: [] },
  activity: { state: 'ready', data: [] },
  findings: { state: 'ready', data: [] },
});

const session = (overrides: Partial<PulseSession> = {}): PulseSession => ({
  id: 'session-1',
  agentId: 'agent-1',
  projectId: 'project-1',
  status: 'thinking',
  presence: 'online',
  startedAt: '2026-08-05T06:30:00.000Z',
  lastHeartbeatAt: '2026-08-05T07:55:00.000Z',
  ...overrides,
});

const activityEvent = (occurredAt: string, projectId?: string) =>
  ({
    streamId: occurredAt,
    id: occurredAt,
    type: 'session.status_changed',
    occurredAt,
    workspaceId: 'local',
    ...(projectId === undefined ? {} : { projectId }),
    payload: {},
  }) as PulseInput['activity'] extends { state: 'ready'; data: Array<infer T> } ? T : never;

function renderPulse(value: PulseInput, extra: Record<string, unknown> = {}) {
  return render(
    <PulseView
      snapshot={buildPulseSnapshot(value)}
      websocketState="live"
      onOpenProject={vi.fn()}
      onOpenSession={vi.fn()}
      onOpenEvent={vi.fn()}
      {...extra}
    />,
  );
}

describe('stat strip', () => {
  it('links each observed count into the route that holds it', () => {
    const value = input();
    value.projects = { state: 'ready', data: [{ id: 'p1', name: 'LUWI', localPath: 'C:/luwi' }] };
    value.sessions = { state: 'ready', data: [session()] };
    renderPulse(value);

    const strip = screen.getByRole('region', { name: 'Current runtime snapshot' });
    expect(within(strip).getByRole('link', { name: '1 project' }).getAttribute('href')).toBe(
      '#/projects',
    );
    expect(within(strip).getByRole('link', { name: '1 active session' }).getAttribute('href')).toBe(
      '#/sessions',
    );
  });

  it('takes the plural for a count the read never produced', () => {
    const value = input();
    value.projects = { state: 'unavailable' };
    renderPulse(value);

    // "Unavailable project" would read as a claim about one project.
    const strip = screen.getByRole('region', { name: 'Current runtime snapshot' });
    expect(within(strip).getByRole('link', { name: 'Unavailable projects' })).toBeTruthy();
  });

  it('derives waiting and blocked from the real status values, with no running bucket', () => {
    const value = input();
    value.sessions = {
      state: 'ready',
      data: [
        session({ id: 's1', status: 'waiting_for_input' }),
        session({ id: 's2', status: 'waiting_for_agent' }),
        session({ id: 's3', status: 'blocked' }),
        session({ id: 's4', status: 'thinking' }),
      ],
    };
    renderPulse(value);

    const strip = screen.getByRole('region', { name: 'Current runtime snapshot' });
    expect(within(strip).getByRole('link', { name: '2 waiting' })).toBeTruthy();
    expect(within(strip).getByRole('link', { name: '1 blocked' })).toBeTruthy();
    expect(within(strip).queryByText(/running/i)).toBeNull();
  });

  it('shows an unavailable session read as unavailable and never as zero', () => {
    const value = input();
    value.sessions = { state: 'unavailable' };
    renderPulse(value);

    const strip = screen.getByRole('region', { name: 'Current runtime snapshot' });
    expect(within(strip).getByRole('link', { name: 'Unavailable waiting' })).toBeTruthy();
    expect(within(strip).queryByRole('link', { name: '0 waiting' })).toBeNull();
    expect(within(strip).queryByRole('link', { name: '0 blocked' })).toBeNull();
  });
});

describe('retained window sparkline', () => {
  it('labels itself as a retained window rather than as a per-minute rate', () => {
    const value = input();
    value.activity = {
      state: 'ready',
      data: [activityEvent('2026-08-05T06:00:00.000Z'), activityEvent('2026-08-05T08:00:00.000Z')],
    };
    renderPulse(value);

    // `GET /api/v1/events` takes a limit, not a time bound, so no per-minute
    // rate exists to draw. The label must say which window it covers.
    expect(screen.getByText(/retained window/i)).toBeTruthy();
    expect(screen.getByText(/2h 0m/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/events\/min|per minute/i);
  });

  it('draws an empty bucket as a gap and never as a zero mark', () => {
    const value = input();
    value.activity = {
      state: 'ready',
      data: [activityEvent('2026-08-05T06:00:00.000Z'), activityEvent('2026-08-05T08:00:00.000Z')],
    };
    const { container } = renderPulse(value);

    const bars = container.querySelectorAll('.retained-trace__bar');
    // Two observations at the ends of a many-bucket window: the buckets between
    // them are drawn as nothing at all, so no reader can mistake a gap for a
    // measured zero.
    expect(bars.length).toBe(2);
  });

  it('reports an unavailable activity read instead of an empty trace', () => {
    const value = input();
    value.activity = { state: 'unavailable' };
    renderPulse(value);

    const strip = screen.getByRole('region', { name: 'Current runtime snapshot' });
    expect(within(strip).getByText('Unavailable')).toBeTruthy();
    expect(strip.querySelectorAll('.retained-trace__bar')).toHaveLength(0);
  });
});

describe('Active Work', () => {
  const withWork = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'project-1', name: 'LUWI Runtime', localPath: 'C:/luwi' }],
    };
    value.agents = {
      state: 'ready',
      data: [
        {
          id: 'agent-1',
          kind: 'other',
          displayName: 'Primary Runner',
          adapterId: 'adapter-x',
          enabled: true,
          updatedAt: SNAPSHOT_AT,
        },
      ],
    };
    value.sessions = {
      state: 'ready',
      data: [
        session({
          taskSummary: 'Rebuild the retention sweep',
          branch: 'feature/graph',
        }),
      ],
    };
    value.context = {
      state: 'ready',
      data: [
        { sessionId: 'session-1', assigned: true, effective: true, loaded: true, invoked: true },
        { sessionId: 'session-1', assigned: true, effective: true, loaded: true, invoked: false },
      ],
    };
    return value;
  };

  it('names its four columns without claiming a usage figure it never read', () => {
    renderPulse(withWork());

    const panel = screen.getByRole('region', { name: 'Active Work' });
    const headers = within(panel).getByTestId('work-columns');
    expect(headers.textContent).toBe('Agent · ProjectTask · ScopeContextStatus · Age');
  });

  it('states the observed status breakdown instead of a running count', () => {
    const value = withWork();
    value.sessions = {
      state: 'ready',
      data: [
        session({ id: 's1', status: 'thinking' }),
        session({ id: 's2', status: 'tool_running' }),
        session({ id: 's3', status: 'blocked' }),
      ],
    };
    renderPulse(value);

    const panel = screen.getByRole('region', { name: 'Active Work' });
    expect(within(panel).getByText('1 thinking · 1 tool running · 1 blocked')).toBeTruthy();
  });

  it('shows the session-reported task and its branch, and no file count', () => {
    renderPulse(withWork());

    expect(screen.getByText('Rebuild the retention sweep')).toBeTruthy();
    expect(screen.getByText('feature/graph')).toBeTruthy();
    // The comp's "3 files" has no observer behind it.
    expect(document.body.textContent).not.toMatch(/\d+ files/);
  });

  it('says a task was not reported rather than inventing one', () => {
    const value = withWork();
    value.sessions = { state: 'ready', data: [session()] };
    renderPulse(value);

    // Rendered as a muted dash so an empty row stays quiet, with the statement
    // kept for assistive tech rather than dropped.
    expect(screen.getByLabelText('No task reported').textContent?.trim()).toBe('—');
    expect(screen.getByLabelText('No branch observed').textContent?.trim()).toBe('—');
  });

  it('shows the model the session registered with, and nothing when it registered none', () => {
    const value = withWork();
    value.sessions = {
      state: 'ready',
      data: [session({ id: 's1', metadata: { model: 'claude-opus-4-8' } }), session({ id: 's2' })],
    };
    renderPulse(value);

    expect(screen.getAllByText('claude-opus-4-8')).toHaveLength(1);
  });

  it('folds a run of same-type events into one row with its count', () => {
    const value = input();
    value.activity = {
      state: 'ready',
      data: [
        activityEvent('2026-08-05T07:00:00.000Z'),
        activityEvent('2026-08-05T07:00:01.000Z'),
        activityEvent('2026-08-05T07:00:02.000Z'),
      ],
    };
    renderPulse(value);

    expect(screen.getByText('session.status_changed ×3')).toBeTruthy();
    expect(document.querySelectorAll('.stream-row')).toHaveLength(1);
    // A different type breaks the run rather than being absorbed into it.
    const other = activityEvent('2026-08-05T07:00:01.000Z');
    (other as { type: string }).type = 'session.registered';
    expect(
      collapseRuns([
        activityEvent('2026-08-05T07:00:00.000Z'),
        other,
        activityEvent('2026-08-05T07:00:02.000Z'),
      ]).map((run) => run.count),
    ).toEqual([1, 1, 1]);
  });

  it('resolves the agent definition name and marks a bare id as an identifier', () => {
    const value = withWork();
    value.sessions = {
      state: 'ready',
      data: [session({ id: 's1' }), session({ id: 's2', agentId: 'agent-unregistered' })],
    };
    renderPulse(value);

    expect(screen.getByText('Primary Runner')).toBeTruthy();
    const fallback = screen.getByText('agent-unregistered');
    expect(fallback.classList.contains('work-agent--id')).toBe(true);
    expect(fallback.getAttribute('title')).toMatch(/no agent definition/i);
  });

  it('keeps the nine-value status vocabulary on the row', () => {
    const value = withWork();
    value.sessions = { state: 'ready', data: [session({ status: 'tool_running' })] };
    renderPulse(value);

    expect(screen.getByText('tool running')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
  });

  it('states the duration and heartbeat age against the snapshot it was taken from', () => {
    renderPulse(withWork());

    expect(screen.getByText('1h 30m · 5m ago')).toBeTruthy();
  });

  it('counts context per session, and separates not-observed from unavailable', () => {
    const value = withWork();
    value.sessions = {
      state: 'ready',
      data: [session({ id: 'session-1' }), session({ id: 'session-2' })],
    };
    renderPulse(value);

    expect(screen.getByText('2 loaded · 1 invoked')).toBeTruthy();
    expect(screen.getByLabelText('Context not observed').textContent?.trim()).toBe('—');

    cleanup();
    const failed = withWork();
    failed.context = { state: 'unavailable' };
    renderPulse(failed);
    const panel = screen.getByRole('region', { name: 'Active Work' });
    expect(within(panel).getByText('Unavailable')).toBeTruthy();
  });

  it('rails a blocked row without stating a cause the runtime never recorded', () => {
    const value = withWork();
    value.sessions = { state: 'ready', data: [session({ status: 'blocked' })] };
    const { container } = renderPulse(value);

    expect(container.querySelector('.work-row--blocked')).toBeTruthy();
    // Session status carries no reason. A correlated `lease.denied` event is
    // the nearest evidence and it is not a cause.
    expect(document.body.textContent).not.toMatch(/lease conflict|because/i);
  });

  it('opens the detail drawer from the whole row, keeping its action name', () => {
    const onOpenSession = vi.fn();
    renderPulse(withWork(), { onOpenSession });

    fireEvent.click(screen.getByRole('button', { name: 'Inspect session session-1' }));

    expect(onOpenSession).toHaveBeenCalledOnce();
  });

  it('marks the row the detail drawer is currently showing', () => {
    const { container } = renderPulse(withWork(), { selectedSessionId: 'session-1' });

    expect(container.querySelector('.work-row--selected')).toBeTruthy();
  });

  it('describes the row content, so the action name does not hide the evidence', () => {
    renderPulse(withWork());

    const row = screen.getByRole('button', { name: 'Inspect session session-1' });
    const description = document.getElementById(row.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toContain('Primary Runner');
    expect(description?.textContent).toContain('LUWI Runtime');
  });
});

describe('Realtime Stream', () => {
  it('lists retained events as time·source·type rows that open the inspector', () => {
    const value = input();
    value.activity = { state: 'ready', data: [activityEvent('2026-08-05T07:30:00.000Z')] };
    const onOpenEvent = vi.fn();
    renderPulse(value, { onOpenEvent });

    const panel = screen.getByRole('region', { name: 'Realtime Stream' });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Inspect session.status_changed event' }),
    );

    expect(onOpenEvent).toHaveBeenCalledOnce();
  });

  it('keeps the failed read distinct from an empty window', () => {
    const value = input();
    value.activity = { state: 'unavailable' };
    renderPulse(value);
    expect(screen.getByText('Activity snapshot unavailable')).toBeTruthy();

    cleanup();
    renderPulse(input());
    expect(screen.getByText('No retained activity')).toBeTruthy();
  });
});

describe('Context Efficiency', () => {
  it('keeps the five counts and states both insights from certain pairs only', () => {
    const value = input();
    value.context = {
      state: 'ready',
      data: [
        { assigned: true, effective: true, loaded: false, invoked: false },
        { assigned: true, effective: true, loaded: true, invoked: false },
        { assigned: true, effective: true, loaded: 'unknown', invoked: 'unknown' },
      ],
    };
    renderPulse(value);

    for (const label of ['Assigned', 'Effective', 'Loaded', 'Invoked', 'Unknown']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('1 assigned source was never loaded')).toBeTruthy();
    expect(screen.getByText('1 loaded source was not invoked')).toBeTruthy();
  });
});

describe('Repository facts', () => {
  const withGit = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [
        { id: 'p1', name: 'LUWI Runtime', localPath: 'C:/luwi' },
        { id: 'p2', name: 'Unscanned', localPath: 'C:/other' },
      ],
    };
    value.git = {
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
                observedAt: '2026-08-05T07:00:00.000Z',
              },
            },
          },
          { projectId: 'p2', git: { state: 'not-observed' } },
        ],
      },
    };
    return value;
  };

  it('states only observed facts and no readiness verdict', () => {
    renderPulse(withGit());

    const panel = screen.getByRole('region', { name: 'Repository facts' });
    expect(within(panel).getByText('main')).toBeTruthy();
    expect(within(panel).getByText('abc123def456')).toBeTruthy();
    expect(within(panel).getByText(/3 untracked/)).toBeTruthy();
    expect(within(panel).getByText(/2 tags/)).toBeTruthy();
    // The comp's Release Readiness verdicts must not resurface here.
    expect(within(panel).queryByText(/ready|needs attention/i)).toBeNull();
  });

  it('reports a never-scanned project as not observed, not as a fault', () => {
    renderPulse(withGit());

    const panel = screen.getByRole('region', { name: 'Repository facts' });
    expect(within(panel).getByText(/no git scan recorded/i)).toBeTruthy();
  });
});

describe('Project Pulse', () => {
  const withProjects = () => {
    const value = input();
    value.projects = {
      state: 'ready',
      data: [{ id: 'project-1', name: 'LUWI Runtime', localPath: 'C:/work/luwi' }],
    };
    value.sessions = { state: 'ready', data: [session()] };
    return value;
  };

  it('draws a monogram tile and the project facts it actually holds', () => {
    renderPulse(withProjects());

    const panel = screen.getByRole('region', { name: 'Project Pulse' });
    expect(within(panel).getByText('LR')).toBeTruthy();
    expect(within(panel).getByText('LUWI Runtime')).toBeTruthy();
    expect(within(panel).getByText('C:/work/luwi')).toBeTruthy();
    expect(within(panel).getByText(/1 active · 1 agent/)).toBeTruthy();
  });

  it('invents no project status word and no lifecycle stage', () => {
    renderPulse(withProjects());

    const panel = screen.getByRole('region', { name: 'Project Pulse' });
    for (const invented of ['Ready', 'Needs Attention', 'Blocked', 'active dev', 'maintenance']) {
      expect(within(panel).queryByText(invented)).toBeNull();
    }
  });

  it('traces only the retained events that name this project', () => {
    const value = withProjects();
    value.activity = {
      state: 'ready',
      data: [
        activityEvent('2026-08-05T06:00:00.000Z', 'project-1'),
        activityEvent('2026-08-05T08:00:00.000Z', 'other-project'),
      ],
    };
    const { container } = renderPulse(value);

    const panel = screen.getByRole('region', { name: 'Project Pulse' });
    expect(panel.querySelectorAll('.retained-trace__bar')).toHaveLength(1);
    expect(container.querySelectorAll('.retained-trace__bar').length).toBeGreaterThan(1);
  });

  it('opens the project inspector from the row, keeping its action name', () => {
    const onOpenProject = vi.fn();
    renderPulse(withProjects(), { onOpenProject });

    fireEvent.click(screen.getByRole('button', { name: 'Inspect project LUWI Runtime' }));

    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  it('reports an unavailable session read per project rather than zero', () => {
    const value = withProjects();
    value.sessions = { state: 'unavailable' };
    renderPulse(value);

    // Worded differently from Active Work's own unavailable state on purpose:
    // two panels saying the identical sentence read as one duplicated message
    // rather than as two independent reports of the same failed read.
    const panel = screen.getByRole('region', { name: 'Project Pulse' });
    expect(within(panel).getByText('Active sessions unavailable')).toBeTruthy();
  });
});
