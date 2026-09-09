import { describe, expect, it, vi } from 'vitest';

import { createDaemonClient, type DaemonClient, type ResourceResult } from './client.js';
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
          wakeIntents: Array.from({ length: 101 }, (_, index) => ({
            id: `wake-${String(index)}`,
            messageId: `message-${String(index)}`,
            workflowId: `workflow-${String(index)}`,
            sourceSessionId: 'session-1',
            correlationId: `correlation-${String(index)}`,
            terminalState: 'responded',
            adapter: 'codex-queue-v1',
            state: index === 0 ? 'indeterminate' : 'dispatched',
            createdAt: timestamp,
            updatedAt: timestamp,
            reasonCode: index === 0 ? 'dispatcher_recovered' : 'queue_accepted',
          })),
        }),
      ],
      [
        '/api/v1/workflows?limit=101',
        ready({
          workflows: Array.from({ length: 101 }, (_, index) => ({
            id: `workflow-${String(index)}`,
            projectId: 'project-1',
            coordinatorSessionId: 'session-1',
            rootCorrelationId: `correlation-${String(index)}`,
            objective: 'Complete the durable workflow.',
            revision: 1,
            state: index === 0 ? 'active' : 'completed',
            ...(index === 0 ? { currentWakeIntentId: 'wake-0' } : {}),
            createdAt: timestamp,
            updatedAt: timestamp,
          })),
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
    expect(scope.bridgeSlots.state === 'ready' && scope.bridgeSlots.data.items.at(-1)?.id).toBe(
      '63'.padStart(64, '0'),
    );
    expect(
      scope.bridgeSlots.state === 'ready' &&
        scope.bridgeSlots.data.items.some((slot) => slot.id === '64'.padStart(64, '0')),
    ).toBe(false);
    expect(scope.wakeIntents).toMatchObject({
      state: 'ready',
      data: { truncated: true },
    });
    expect(scope.wakeIntents.state === 'ready' && scope.wakeIntents.data.items).toHaveLength(100);
    expect(scope.wakeIntents.state === 'ready' && scope.wakeIntents.data.items[0]?.state).toBe(
      'indeterminate',
    );
    expect(
      scope.wakeIntents.state === 'ready' &&
        scope.wakeIntents.data.items.some((intent) => intent.id === 'wake-100'),
    ).toBe(false);
    expect(scope.workflows).toMatchObject({
      state: 'ready',
      data: { truncated: true },
    });
    expect(scope.workflows.state === 'ready' && scope.workflows.data.items).toHaveLength(100);
    expect(scope.workflows.state === 'ready' && scope.workflows.data.items[0]?.revision).toBe(1);
    expect(
      scope.workflows.state === 'ready' &&
        scope.workflows.data.items.some((workflow) => workflow.id === 'workflow-100'),
    ).toBe(false);
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

  it('rejects private dispatcher and owner fields at every browser read boundary', async () => {
    const payloads = new Map<string, unknown>([
      [
        '/api/v1/bridge-slots?limit=101',
        {
          slots: [
            {
              id: 'a'.repeat(64),
              workspaceId: 'local',
              projectId: 'project-1',
              agentId: 'agent-1',
              provider: 'antigravity',
              executionProfile: 'workspace-write',
              state: 'active',
              revision: 1,
              expiresAt: timestamp,
              ownerToken: 'must-never-reach-the-browser',
            },
          ],
        },
      ],
      [
        '/api/v1/wake-intents?limit=101',
        {
          wakeIntents: [
            {
              id: 'wake-1',
              messageId: 'message-1',
              workflowId: 'workflow-1',
              sourceSessionId: 'session-1',
              correlationId: 'correlation-1',
              terminalState: 'responded',
              adapter: 'codex-queue-v1',
              state: 'claimed',
              createdAt: timestamp,
              updatedAt: timestamp,
              claimId: 'private-claim',
              target: {
                adapter: 'codex-queue-v1',
                nativeSessionId: 'private-native-session',
              },
            },
          ],
        },
      ],
      [
        '/api/v1/workflows?limit=101',
        {
          workflows: [
            {
              id: 'workflow-1',
              projectId: 'project-1',
              coordinatorSessionId: 'session-1',
              rootCorrelationId: 'correlation-1',
              objective: 'Complete the durable workflow.',
              revision: 1,
              state: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
              dispatcherInstanceId: 'private-dispatcher',
            },
          ],
        },
      ],
    ]);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(payloads.get(path)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const scope = await loadWakeScope(createDaemonClient(fetchImpl as typeof fetch));

    expect(scope).toEqual({
      bridgeSlots: { state: 'unavailable' },
      wakeIntents: { state: 'unavailable' },
      workflows: { state: 'unavailable' },
    });
    expect(JSON.stringify(scope)).not.toMatch(
      /must-never-reach-the-browser|private-claim|private-native-session|private-dispatcher/u,
    );
  });
});
