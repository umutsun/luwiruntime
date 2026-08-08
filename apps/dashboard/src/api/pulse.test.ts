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
          version: '0.1.0',
          uptimeMs: 120_000,
          timestamp: '2026-08-05T08:00:00.000Z',
          redis: { connected: true, status: 'connected', latencyMs: 2 },
        }),
      ],
      [
        '/api/v1/projects',
        ready({ projects: [{ id: 'project-1', name: 'LUWI', localPath: 'C:/luwi' }] }),
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
        '/api/v1/events?limit=20',
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

    expect(get).toHaveBeenCalledTimes(8);
    expect(input.measuredLatencyMs).toBe(24);
    expect(input.projects).toEqual({
      state: 'ready',
      data: [{ id: 'project-1', name: 'LUWI', localPath: 'C:/luwi' }],
    });
    expect(input.sessions.state === 'ready' && input.sessions.data[0]?.presence).toBe('online');
    expect(input.usage.state === 'ready' && input.usage.data[0]?.source).toBe('agent-exact');
    expect(input.activity.state === 'ready' && input.activity.data[0]).toMatchObject({
      streamId: '1785918000000-0',
      type: 'future.adapter.observed',
      payload: { safe: true },
    });
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
