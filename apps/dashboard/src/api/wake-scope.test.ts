import { describe, expect, it, vi } from 'vitest';

import type { DaemonClient, ResourceResult } from './client.js';
import { loadWakeScope } from './wake-scope.js';

const ready = <T>(data: T): ResourceResult<T> => ({
  state: 'ready',
  data,
  httpStatus: 200,
  receivedAt: '2026-09-10T00:00:00.000Z',
});

const timestamp = '2026-09-10T00:00:00.000Z';

describe('wake scope loader', () => {
  it('loads three independent, bounded read-only collections', async () => {
    const responses = new Map<string, ResourceResult<unknown>>([
      [
        '/api/v1/bridge-slots?limit=101',
        ready({
          slots: Array.from({ length: 101 }, (_, index) => ({
            id: index.toString(16).padStart(64, '0'),
            workspaceId: 'local',
            projectId: 'project-1',
            agentId: 'agent-1',
            provider: 'antigravity',
            executionProfile: 'workspace-write',
            state: 'active',
            revision: 1,
            expiresAt: timestamp,
          })),
        }),
      ],
      [
        '/api/v1/wake-intents?limit=101',
        ready({
          wakeIntents: [
            {
              id: 'wake-1',
              messageId: 'message-1',
              workflowId: 'workflow-1',
              sourceSessionId: 'session-1',
              correlationId: 'correlation-1',
              terminalState: 'responded',
              adapter: 'codex-queue-v1',
              state: 'indeterminate',
              createdAt: timestamp,
              updatedAt: timestamp,
              reasonCode: 'dispatcher_recovered',
            },
          ],
        }),
      ],
      [
        '/api/v1/workflows?limit=101',
        ready({
          workflows: [
            {
              id: 'workflow-1',
              projectId: 'project-1',
              coordinatorSessionId: 'session-1',
              rootCorrelationId: 'correlation-1',
              objective: 'Complete the durable workflow.',
              revision: 1,
              state: 'active',
              currentWakeIntentId: 'wake-1',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        }),
      ],
    ]);
    const get = vi.fn(async (path: string) => responses.get(path) ?? { state: 'unavailable' });

    const scope = await loadWakeScope({ get } as unknown as DaemonClient);

    expect(get).toHaveBeenCalledTimes(3);
    expect(scope.bridgeSlots).toMatchObject({
      state: 'ready',
      data: { truncated: true },
    });
    expect(scope.bridgeSlots.state === 'ready' && scope.bridgeSlots.data.items).toHaveLength(100);
    expect(scope.wakeIntents).toMatchObject({
      state: 'ready',
      data: { truncated: false, items: [{ state: 'indeterminate' }] },
    });
    expect(scope.workflows).toMatchObject({
      state: 'ready',
      data: { truncated: false, items: [{ revision: 1 }] },
    });
  });

  it('keeps each unavailable read independent', async () => {
    const get = vi.fn(async (path: string) =>
      path.includes('wake-intents')
        ? ready({ wakeIntents: [] })
        : ({ state: 'unavailable' } as const),
    );

    const scope = await loadWakeScope({ get } as unknown as DaemonClient);

    expect(scope.bridgeSlots).toEqual({ state: 'unavailable' });
    expect(scope.wakeIntents).toEqual({
      state: 'ready',
      data: { items: [], truncated: false },
    });
    expect(scope.workflows).toEqual({ state: 'unavailable' });
  });
});
