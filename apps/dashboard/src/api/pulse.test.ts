import { describe, expect, it, vi } from 'vitest';

import type { DaemonClient, ResourceResult } from './client.js';
import { loadPulseInput, loadPulseResources } from './pulse.js';

const ready = <T>(data: T): ResourceResult<T> => ({
  state: 'ready',
  data,
  httpStatus: 200,
  receivedAt: '2026-08-05T08:00:00.000Z',
});

describe('loadPulseInput', () => {
  it('loads independent read-only resources and maps them into Pulse input', async () => {
    const responses = new Map<string, ResourceResult<unknown>>([
      [
        '/health',
        ready({
          status: 'ok',
          runtimeState: 'ready',
          version: '0.2.0',
          uptimeMs: 120_000,
          timestamp: '2026-08-05T08:00:00.000Z',
          redis: { connected: true, status: 'connected', latencyMs: 2 },
        }),
      ],
      [
        '/api/v1/projects',
        ready({
          projects: [
            {
              id: 'project-1',
              name: 'LUWI',
              localPath: 'C:/luwi',
              repositoryUrl: 'https://github.com/umutsun/luwi.git',
              defaultBranch: 'main',
            },
          ],
        }),
      ],
      [
        '/api/v1/sessions',
        ready({
          sessions: [
            {
              id: 'session-1',
              agentId: 'codex',
              projectId: 'project-1',
              status: 'thinking',
              presence: 'online',
              workingDirectory: 'C:/luwi',
              startedAt: '2026-08-05T07:00:00.000Z',
              lastHeartbeatAt: '2026-08-05T08:00:00.000Z',
              metadata: {},
            },
          ],
        }),
      ],
      ['/api/v1/agents', ready({ agents: [{ id: 'codex' }] })],
      [
        '/api/v1/usage/summary?limit=1000',
        ready({
          recordCount: 1,
          sources: [{ source: 'agent-exact', recordCount: 1, totalTokens: 50 }],
        }),
      ],
      [
        '/api/v1/context/contributions?limit=1000',
        ready({
          contributions: [
            { assigned: true, effective: true, loaded: 'unknown', invoked: 'unknown' },
          ],
          truncated: false,
        }),
      ],
      [
        '/api/v1/events?limit=200',
        ready({
          events: [
            {
              streamId: '1785918000000-0',
              event: {
                id: 'event-1',
                version: 1,
                type: 'future.adapter.observed',
                occurredAt: '2026-08-05T08:00:00.000Z',
                workspaceId: 'local',
                projectId: 'project-1',
                payload: { safe: true },
              },
            },
          ],
        }),
      ],
      ['/api/v1/optimization/findings?limit=100', ready({ findings: [], truncated: false })],
    ]);
    const get = vi.fn(async (path: string) => responses.get(path) ?? { state: 'unavailable' });

    const input = await loadPulseInput({ get } as unknown as DaemonClient, {
      now: () => new Date('2026-08-05T08:00:00.000Z'),
      nowMs: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(124),
    });

    // 9 base reads + one git fan-out + one coordinator fan-out for the 1 project.
    expect(get).toHaveBeenCalledTimes(11);
    expect(input.measuredLatencyMs).toBe(24);
    expect(input.projects).toEqual({
      state: 'ready',
      data: [
        {
          id: 'project-1',
          name: 'LUWI',
          localPath: 'C:/luwi',
          repositoryUrl: 'https://github.com/umutsun/luwi.git',
          defaultBranch: 'main',
        },
      ],
    });
    expect(input.sessions.state === 'ready' && input.sessions.data[0]?.presence).toBe('online');
    expect(input.usage.state === 'ready' && input.usage.data[0]?.source).toBe('agent-exact');
    expect(input.activity.state === 'ready' && input.activity.data[0]).toMatchObject({
      streamId: '1785918000000-0',
      type: 'future.adapter.observed',
      payload: { safe: true },
    });
  });

  it('fetches runtime info and per-project git facts after the project list', async () => {
    const responses = new Map<string, ResourceResult<unknown>>([
      [
        '/api/v1/runtime',
        ready({
          version: '0.2.0',
          protocolVersion: 1,
          runtimeState: 'ready',
          runtimeInstanceId: 'r1',
          workspaceId: 'local',
          startedAt: '2026-08-05T08:00:00.000Z',
          uptimeMs: 1000,
          host: '127.0.0.1',
          port: 4782,
          redis: { connected: true, status: 'connected', latencyMs: 1 },
          endpoints: { health: '/health', runtime: '/api/v1/runtime' },
        }),
      ],
      ['/api/v1/projects', ready({ projects: [{ id: 'p1', name: 'LUWI', localPath: 'C:/luwi' }] })],
      [
        '/api/v1/projects/p1/git',
        ready({
          id: 'g1',
          projectId: 'p1',
          repositoryRoot: 'C:/luwi',
          branch: 'main',
          headSha: 'abc123def4567890abc123def4567890abc123de',
          clean: false,
          stagedCount: 0,
          unstagedCount: 1,
          untrackedCount: 3,
          branches: ['main'],
          tags: ['v1'],
          worktrees: [],
          recentCommits: [
            {
              sha: 'a'.repeat(40),
              parentShas: [],
              committedAt: '2026-08-05T07:00:00.000Z',
              changedPaths: [],
              trailers: {},
              merge: false,
            },
            {
              sha: 'b'.repeat(40),
              parentShas: [],
              committedAt: '2026-08-05T06:00:00.000Z',
              changedPaths: [],
              trailers: {},
              merge: false,
            },
          ],
          observedAt: '2026-08-05T08:00:00.000Z',
          metadata: {},
        }),
      ],
      [
        '/api/v1/projects/p1/coordinator',
        ready({
          coordinator: {
            projectId: 'p1',
            sessionId: 'session-a',
            agentId: 'agent-a',
            claimId: 'claim-1',
            claimedAt: '2026-08-05T07:30:00.000Z',
            version: 1,
          },
          live: true,
        }),
      ],
    ]);
    const get = vi.fn(async (path: string) => responses.get(path) ?? { state: 'unavailable' });

    const input = await loadPulseInput({ get } as unknown as DaemonClient, {
      now: () => new Date('2026-08-05T08:00:00.000Z'),
      nowMs: () => 10,
    });

    expect(input.runtime).toMatchObject({
      state: 'ready',
      data: { workspaceId: 'local', runtimeState: 'ready', port: 4782 },
    });
    expect(input.coordinator).toMatchObject({
      state: 'ready',
      data: {
        truncated: false,
        entries: [
          {
            projectId: 'p1',
            coordinator: { state: 'ready', data: { sessionId: 'session-a', live: true } },
          },
        ],
      },
    });
    expect(input.git).toMatchObject({
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
                untrackedCount: 3,
                clean: false,
                tagCount: 1,
                recentCommitCount: 2,
              },
            },
          },
        ],
      },
    });
  });

  it('reports a 404 git read as not-observed, never as a fault', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/projects')
        return ready({ projects: [{ id: 'p1', name: 'LUWI', localPath: 'C:/luwi' }] });
      if (path === '/api/v1/projects/p1/git')
        return { state: 'unavailable', httpStatus: 404 } as const;
      return { state: 'unavailable' } as const;
    });

    const input = await loadPulseInput({ get } as unknown as DaemonClient, {
      now: () => new Date('2026-08-05T08:00:00.000Z'),
      nowMs: () => 10,
    });

    expect(input.git).toMatchObject({
      state: 'ready',
      data: { entries: [{ projectId: 'p1', git: { state: 'not-observed' } }] },
    });
  });

  it('carries the session-reported task summary through, and omits it when absent', async () => {
    // `taskSummary` is on `agentSessionSchema`, so it is observed evidence the
    // session itself supplied — not a task the runtime assigned. Dropping it
    // would have left the Active Work row inventing a title it already had.
    const get = vi.fn(async (path: string) =>
      path === '/api/v1/sessions'
        ? ready({
            sessions: [
              {
                id: 'session-1',
                agentId: 'a1',
                projectId: 'project-1',
                status: 'thinking',
                presence: 'online',
                taskSummary: 'Rebuild the retention sweep',
                branch: 'main',
                workingDirectory: 'C:/luwi',
                startedAt: '2026-08-05T07:00:00.000Z',
                lastHeartbeatAt: '2026-08-05T08:00:00.000Z',
                metadata: {},
              },
              {
                id: 'session-2',
                agentId: 'a1',
                projectId: 'project-1',
                status: 'idle',
                presence: 'online',
                workingDirectory: 'C:/luwi',
                startedAt: '2026-08-05T07:00:00.000Z',
                lastHeartbeatAt: '2026-08-05T08:00:00.000Z',
                metadata: {},
              },
            ],
          })
        : ({ state: 'unavailable' } as const),
    );

    const result = await loadPulseResources({ get } as unknown as DaemonClient, ['sessions']);

    const sessions = result.sessions?.state === 'ready' ? result.sessions.data : [];
    expect(sessions[0]).toMatchObject({ taskSummary: 'Rebuild the retention sweep' });
    expect(sessions[1]).not.toHaveProperty('taskSummary');
  });

  it('carries the contribution session id through so context can be attributed', async () => {
    const get = vi.fn(async () =>
      ready({
        contributions: [
          {
            sessionId: 'session-1',
            assigned: true,
            effective: true,
            loaded: true,
            invoked: false,
          },
          { assigned: true, effective: true, loaded: 'unknown', invoked: 'unknown' },
        ],
        truncated: false,
      }),
    );

    const result = await loadPulseResources({ get } as unknown as DaemonClient, ['context']);

    const contributions = result.context?.state === 'ready' ? result.context.data : [];
    expect(contributions[0]).toMatchObject({ sessionId: 'session-1' });
    expect(contributions[1]).not.toHaveProperty('sessionId');
  });

  it('keeps each failed resource unavailable without discarding successful resources', async () => {
    const get = vi.fn(async (path: string) =>
      path === '/api/v1/projects'
        ? ready({ projects: [] })
        : ({ state: 'unavailable', reason: 'transport' } as const),
    );

    const input = await loadPulseInput({ get } as unknown as DaemonClient, {
      now: () => new Date('2026-08-05T08:00:00.000Z'),
      nowMs: () => 10,
    });

    expect(input.projects).toEqual({ state: 'ready', data: [] });
    expect(input.health).toEqual({ state: 'unavailable' });
    expect(input.activity).toEqual({ state: 'unavailable' });
  });

  it('loads only selected resources for realtime invalidation', async () => {
    const get = vi.fn(async () => ready({ sessions: [] }));
    const controller = new AbortController();

    const result = await loadPulseResources({ get } as unknown as DaemonClient, ['sessions'], {
      signal: controller.signal,
    });

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(result).toEqual({ sessions: { state: 'ready', data: [] } });
  });
});
