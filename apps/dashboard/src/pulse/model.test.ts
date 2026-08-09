import { describe, expect, it } from 'vitest';

import { buildPulseSnapshot, labelSessionStatus, type PulseInput } from './model.js';

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

describe('Pulse snapshot mapping', () => {
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
});
