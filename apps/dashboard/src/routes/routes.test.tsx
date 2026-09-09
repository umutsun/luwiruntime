// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPulseSnapshot, type PulseInput } from '../pulse/model.js';
import { AgentsView } from './agents-view.js';
import { SessionsView } from './sessions-view.js';
import { UsageView } from './usage-view.js';

afterEach(cleanup);

function baseInput(overrides: Partial<PulseInput> = {}): PulseInput {
  return {
    measuredLatencyMs: 5,
    snapshotAt: '2026-08-08T00:00:00.000Z',
    health: { state: 'unavailable' },
    projects: {
      state: 'ready',
      data: [{ id: 'p1', name: 'Alpha', localPath: 'C:/work/alpha' }],
    },
    sessions: { state: 'ready', data: [] },
    agents: { state: 'ready', data: [] },
    usage: { state: 'ready', data: [] },
    context: { state: 'unavailable' },
    activity: { state: 'unavailable' },
    findings: { state: 'unavailable' },
    ...overrides,
  };
}

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  agentId: 'a1',
  projectId: 'p1',
  status: 'thinking',
  presence: 'online' as const,
  startedAt: '2026-08-08T00:00:00.000Z',
  lastHeartbeatAt: '2026-08-08T00:00:00.000Z',
  ...over,
});

describe('SessionsView', () => {
  it('lists every session, not only the active subset', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: {
          state: 'ready',
          data: [
            session('s-active'),
            session('s-done', { status: 'completed', presence: 'offline' }),
          ],
        },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    expect(screen.getByText('s-active')).toBeTruthy();
    expect(screen.getByText('s-done')).toBeTruthy();
    expect(
      screen.getByRole('table', { name: 'Observed sessions' }).closest('.session-registry'),
    ).toBeTruthy();
  });

  it('labels an unrecognised status as Unknown rather than dropping the row', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: { state: 'ready', data: [session('s1', { status: 'invented_status' })] },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    expect(screen.getByText('s1')).toBeTruthy();
    // Scoped to the row: 'Unknown' is also a status filter option.
    expect(within(screen.getByRole('row', { name: /s1/ })).getByText('Unknown')).toBeTruthy();
  });

  it('resolves the project name and marks an unresolvable one', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: {
          state: 'ready',
          data: [session('s1'), session('s2', { projectId: 'gone' })],
        },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /s2/ })).getByText('Unavailable')).toBeTruthy();
  });

  it('keeps empty and unavailable distinct', () => {
    const { unmount } = render(<SessionsView snapshot={buildPulseSnapshot(baseInput())} />);
    expect(screen.getByText(/no sessions/i)).toBeTruthy();
    unmount();

    render(
      <SessionsView
        snapshot={buildPulseSnapshot(baseInput({ sessions: { state: 'unavailable' } }))}
      />,
    );
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText(/no sessions/i)).toBeNull();
  });

  it('filters by status without discarding the total count', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: {
          state: 'ready',
          data: [
            session('s-active'),
            session('s-done', { status: 'completed', presence: 'offline' }),
          ],
        },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'completed' } });

    expect(screen.queryByText('s-active')).toBeNull();
    expect(screen.getByText('s-done')).toBeTruthy();
    expect(screen.getByText('1 of 2 shown')).toBeTruthy();
  });

  it('filters by presence', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: {
          state: 'ready',
          data: [session('s-on'), session('s-off', { presence: 'offline' })],
        },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    fireEvent.change(screen.getByLabelText('Presence'), { target: { value: 'offline' } });

    expect(screen.queryByText('s-on')).toBeNull();
    expect(screen.getByText('s-off')).toBeTruthy();
  });

  it('reports a filter that matches nothing instead of looking empty', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({ sessions: { state: 'ready', data: [session('s1')] } }),
    );
    render(<SessionsView snapshot={snapshot} />);

    fireEvent.change(screen.getByLabelText('Presence'), { target: { value: 'offline' } });

    expect(screen.getByText(/no sessions match/i)).toBeTruthy();
  });

  it('sorts newest first by default and toggles on the started header', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: {
          state: 'ready',
          data: [
            session('s-old', { startedAt: '2026-08-07T00:00:00.000Z' }),
            session('s-new', { startedAt: '2026-08-08T06:00:00.000Z' }),
          ],
        },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    const bodyRows = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');
    expect(bodyRows()[0]).toContain('s-new');

    fireEvent.click(screen.getByRole('button', { name: /sort by started/i }));

    expect(bodyRows()[0]).toContain('s-old');
  });

  it('opens the session inspector from a row', () => {
    const onOpenSession = vi.fn();
    const snapshot = buildPulseSnapshot(
      baseInput({ sessions: { state: 'ready', data: [session('s1')] } }),
    );
    render(<SessionsView snapshot={snapshot} onOpenSession={onOpenSession} />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect session s1' }));

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession.mock.calls[0]?.[0]).toMatchObject({ id: 's1' });
  });

  it('offers Ask only for an online target with another online session in the same project', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: {
          state: 'ready',
          data: [
            session('source'),
            session('target', { agentId: 'a2' }),
            session('offline', { agentId: 'a3', presence: 'offline' }),
            session('foreign', { agentId: 'a4', projectId: 'other-project' }),
          ],
        },
      }),
    );
    render(
      <SessionsView
        snapshot={snapshot}
        messageMutations={{ ask: vi.fn() }}
        onMessageCreated={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Ask session target' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask session offline' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask session target' }));
    const sourceSelect = screen.getByLabelText('Source session');
    expect(within(sourceSelect).getByRole('option', { name: /source/i })).toBeTruthy();
    expect(within(sourceSelect).queryByRole('option', { name: /offline|foreign/i })).toBeNull();
  });

  it('renders no Ask action when mutation capability is absent', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({ sessions: { state: 'ready', data: [session('source'), session('target')] } }),
    );
    render(<SessionsView snapshot={snapshot} />);

    expect(screen.queryByRole('button', { name: /ask session/i })).toBeNull();
  });

  it('shows a relative start time and keeps the absolute value accessible', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: {
          state: 'ready',
          data: [session('s1', { startedAt: '2026-08-08T10:00:00.000Z' })],
        },
      }),
    );
    render(<SessionsView snapshot={snapshot} now={() => new Date('2026-08-08T12:00:00.000Z')} />);

    const started = screen.getByText('2h ago');
    expect(started.closest('time')?.getAttribute('dateTime')).toBe('2026-08-08T10:00:00.000Z');
  });

  it('shows public bridge provider, execution profile, and computed slot health per session', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: { state: 'ready', data: [session('s-bridged'), session('s-inbox')] },
        bridgeSlots: {
          state: 'ready',
          data: {
            truncated: false,
            items: [
              {
                id: 'a'.repeat(64),
                workspaceId: 'local',
                projectId: 'p1',
                agentId: 'a1',
                provider: 'antigravity',
                executionProfile: 'workspace-write',
                state: 'active',
                revision: 1,
                sessionId: 's-bridged',
                expiresAt: '2026-08-08T00:00:10.000Z',
              },
            ],
          },
        },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    const bridged = screen.getByRole('row', { name: /s-bridged/ });
    expect(within(bridged).getByText('antigravity · workspace-write')).toBeTruthy();
    expect(within(bridged).getByText('Active')).toBeTruthy();
    const inbox = screen.getByRole('row', { name: /s-inbox/ });
    expect(within(inbox).getByText('No bridge observed')).toBeTruthy();
  });

  it('does not call a missing session bridge negative when the slot read was truncated', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: { state: 'ready', data: [session('s-unknown')] },
        bridgeSlots: { state: 'ready', data: { truncated: true, items: [] } },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    const row = screen.getByRole('row', { name: /s-unknown/ });
    expect(within(row).getByText('Bridge evidence incomplete')).toBeTruthy();
    expect(within(row).queryByText('No bridge observed')).toBeNull();
  });
});

const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'other',
  displayName: `Agent ${id}`,
  adapterId: 'adapter-x',
  enabled: true,
  detectedVersion: '1.2.3',
  updatedAt: '2026-08-08T00:00:00.000Z',
  ...over,
});

describe('AgentsView', () => {
  it('lists definitions with their adapter and enabled state', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({ agents: { state: 'ready', data: [agent('a1')] } }),
    );
    render(<AgentsView snapshot={snapshot} />);

    const row = screen.getByRole('row', { name: /Agent a1/ });
    expect(within(row).getByText('adapter-x')).toBeTruthy();
    expect(within(row).getByText('Enabled')).toBeTruthy();
    expect(within(row).getByText('1.2.3')).toBeTruthy();
  });

  it('renders the agent kind verbatim without a vendor label map', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({ agents: { state: 'ready', data: [agent('a1', { kind: 'some-future-kind' })] } }),
    );
    render(<AgentsView snapshot={snapshot} />);

    expect(screen.getByText('some-future-kind')).toBeTruthy();
  });

  it('marks an undetected version instead of leaving the cell blank', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        agents: { state: 'ready', data: [agent('a1', { detectedVersion: undefined })] },
      }),
    );
    render(<AgentsView snapshot={snapshot} />);

    expect(screen.getByText('Undetected')).toBeTruthy();
  });

  it('counts sessions observed for each agent', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        agents: { state: 'ready', data: [agent('a1'), agent('a2')] },
        sessions: {
          state: 'ready',
          data: [session('s1', { agentId: 'a1' }), session('s2', { agentId: 'a1' })],
        },
      }),
    );
    render(<AgentsView snapshot={snapshot} />);

    expect(within(screen.getByRole('row', { name: /Agent a1/ })).getByText('2')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /Agent a2/ })).getByText('0')).toBeTruthy();
  });

  it('lists the models sessions reported, and the agent ids no definition covers', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        agents: { state: 'ready', data: [agent('a1'), agent('a2')] },
        sessions: {
          state: 'ready',
          data: [
            session('s1', { agentId: 'a1', metadata: { model: 'model-b' } }),
            session('s2', { agentId: 'a1', metadata: { model: 'model-a' } }),
            session('s3', { agentId: 'a1' }),
            session('s4', { agentId: 'a2' }),
            session('s5', { agentId: 'hooked', metadata: { model: 'model-c' } }),
          ],
        },
      }),
    );
    render(<AgentsView snapshot={snapshot} />);

    // Distinct, sorted, and only what sessions said — a session with no model
    // adds nothing, and an agent whose sessions said nothing gets a dash.
    expect(
      within(screen.getByRole('row', { name: /Agent a1/ })).getByText('model-a, model-b'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('row', { name: /Agent a2/ })).getByLabelText('No model reported'),
    ).toBeTruthy();

    // The hook-attached id is seen, counted and shown with its models, but no
    // definition is invented for it.
    const unregistered = screen.getByRole('region', { name: /without a definition/i });
    const row = within(unregistered).getByRole('row', { name: /hooked/ });
    expect(within(row).getByText('1')).toBeTruthy();
    expect(within(row).getByText('model-c')).toBeTruthy();
    expect(screen.queryByRole('row', { name: /Agent hooked/ })).toBeNull();
  });

  it('omits the unregistered panel when every session id has a definition', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        agents: { state: 'ready', data: [agent('a1')] },
        sessions: { state: 'ready', data: [session('s1', { agentId: 'a1' })] },
      }),
    );
    render(<AgentsView snapshot={snapshot} />);

    expect(screen.queryByRole('region', { name: /without a definition/i })).toBeNull();
  });

  it('keeps empty and unavailable distinct', () => {
    const { unmount } = render(<AgentsView snapshot={buildPulseSnapshot(baseInput())} />);
    expect(screen.getByText(/no agent definitions/i)).toBeTruthy();
    unmount();

    render(
      <AgentsView snapshot={buildPulseSnapshot(baseInput({ agents: { state: 'unavailable' } }))} />,
    );
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });
});

describe('UsageView', () => {
  const usage = (over: Record<string, unknown> = {}) => ({
    state: 'ready' as const,
    data: [
      { source: 'agent-exact' as const, recordCount: 10, totalTokens: 5000 },
      { source: 'unavailable' as const, recordCount: 3 },
      ...((over['extra'] as never[]) ?? []),
    ],
  });

  it('keeps each source on its own row with its label', () => {
    render(<UsageView snapshot={buildPulseSnapshot(baseInput({ usage: usage() }))} />);

    expect(screen.getByText('Exact')).toBeTruthy();
    // The source label and the missing-token label are worded differently on
    // purpose: a source that reported nothing is not the same fact as a token
    // value that was never observed.
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByText('Not reported')).toBeTruthy();
  });

  it('renders an absent token total as not reported, never as zero', () => {
    render(<UsageView snapshot={buildPulseSnapshot(baseInput({ usage: usage() }))} />);

    const row = screen.getByRole('row', { name: /Unavailable/ });
    expect(within(row).queryByText('0')).toBeNull();
    expect(within(row).getByText('Not reported')).toBeTruthy();
  });

  it('states that unavailable records are excluded from any total', () => {
    render(<UsageView snapshot={buildPulseSnapshot(baseInput({ usage: usage() }))} />);

    expect(screen.getByText(/excluded/i)).toBeTruthy();
  });

  it('keeps empty and unavailable distinct', () => {
    const { unmount } = render(<UsageView snapshot={buildPulseSnapshot(baseInput())} />);
    expect(screen.getByText(/no usage observations/i)).toBeTruthy();
    unmount();

    render(
      <UsageView snapshot={buildPulseSnapshot(baseInput({ usage: { state: 'unavailable' } }))} />,
    );
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });
});
