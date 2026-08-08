// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

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
  });

  it('labels an unrecognised status as Unknown rather than dropping the row', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        sessions: { state: 'ready', data: [session('s1', { status: 'invented_status' })] },
      }),
    );
    render(<SessionsView snapshot={snapshot} />);

    expect(screen.getByText('s1')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
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
    expect(screen.getByText('Unavailable')).toBeTruthy();
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
