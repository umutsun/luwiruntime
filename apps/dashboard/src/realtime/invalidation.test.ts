import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInvalidationCoordinator,
  createRefreshRequestRouter,
  resourcesForEvent,
  type PulseResourceKey,
} from './invalidation.js';
import * as invalidationModule from './invalidation.js';
import { createPulseRefreshController, type PulseRefreshSnapshot } from '../api/refresh-state.js';
import type { PulseResources } from '../pulse/model.js';

afterEach(() => vi.useRealTimers());

describe('realtime snapshot invalidation', () => {
  it('routes manual retry through the attached canonical refresh and restores the fallback', () => {
    const fallback = vi.fn();
    const firstRefresh = vi.fn();
    const secondRefresh = vi.fn();
    const router = createRefreshRequestRouter(fallback);

    router.request();
    const detachFirst = router.attach(firstRefresh);
    router.request();
    const detachSecond = router.attach(secondRefresh);
    detachFirst();
    router.request();
    detachSecond();
    router.request();

    expect(fallback).toHaveBeenCalledTimes(2);
    expect(firstRefresh).toHaveBeenCalledOnce();
    expect(secondRefresh).toHaveBeenCalledOnce();
  });

  it('refreshes every resource once on the first live edge and coalesces an immediate event', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const invalidation = createInvalidationCoordinator({ refresh, coalesceMs: 250 });
    const createLiveRefreshCoordinator = Reflect.get(
      invalidationModule,
      'createLiveRefreshCoordinator',
    ) as
      | ((options: { invalidateAll: () => void }) => {
          observe: (state: string) => void;
        })
      | undefined;

    expect(createLiveRefreshCoordinator).toBeTypeOf('function');
    const liveRefresh = createLiveRefreshCoordinator?.({
      invalidateAll: () => invalidation.invalidateAll(),
    });
    liveRefresh?.observe('connecting');
    liveRefresh?.observe('live');
    invalidation.invalidate(['sessions']);
    await vi.advanceTimersByTimeAsync(250);

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith([
      'health',
      'projects',
      'sessions',
      'agents',
      'usage',
      'context',
      'activity',
      'findings',
      'runtime',
      'git',
      'coordinator',
      'bindings',
    ]);
  });

  it('ignores duplicate live notifications and refreshes once after a reconnect edge', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const invalidation = createInvalidationCoordinator({ refresh, coalesceMs: 250 });
    const createLiveRefreshCoordinator = Reflect.get(
      invalidationModule,
      'createLiveRefreshCoordinator',
    ) as
      | ((options: { invalidateAll: () => void }) => {
          observe: (state: string) => void;
        })
      | undefined;
    expect(createLiveRefreshCoordinator).toBeTypeOf('function');
    const liveRefresh = createLiveRefreshCoordinator?.({
      invalidateAll: () => invalidation.invalidateAll(),
    });

    liveRefresh?.observe('live');
    liveRefresh?.observe('live');
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledOnce();

    liveRefresh?.observe('reconnecting');
    liveRefresh?.observe('live');
    liveRefresh?.observe('live');
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('makes a mutation and refreshed event snapshot visible after the first live edge', async () => {
    vi.useFakeTimers();
    const initial: PulseResources = {
      health: { state: 'unavailable' },
      projects: { state: 'ready', data: [] },
      sessions: { state: 'ready', data: [] },
      agents: { state: 'ready', data: [] },
      usage: { state: 'ready', data: [] },
      context: { state: 'ready', data: [] },
      activity: { state: 'ready', data: [] },
      findings: { state: 'ready', data: [] },
      runtime: { state: 'unavailable' },
      git: { state: 'unavailable' },
      coordinator: { state: 'unavailable' },
      bindings: { state: 'unavailable' },
    };
    const onChange = vi.fn();
    const refreshController = createPulseRefreshController({
      initial,
      load: async () => ({
        projects: {
          state: 'ready',
          data: [{ id: 'p1', name: 'Added before live', localPath: 'C:/luwi' }],
        },
        activity: {
          state: 'ready',
          data: [
            {
              streamId: '1-0',
              id: 'event-1',
              version: 1,
              type: 'project.registered',
              occurredAt: '2026-08-05T08:00:00.000Z',
              workspaceId: 'local',
              projectId: 'p1',
              payload: {},
            },
          ],
        },
      }),
      onChange,
    });
    const invalidation = createInvalidationCoordinator({
      refresh: (keys) => refreshController.refresh(keys),
      coalesceMs: 250,
    });
    const liveRefresh = invalidationModule.createLiveRefreshCoordinator({
      invalidateAll: () => invalidation.invalidateAll(),
    });

    liveRefresh.observe('connecting');
    liveRefresh.observe('live');
    await vi.advanceTimersByTimeAsync(250);

    const snapshot = onChange.mock.lastCall?.[0] as PulseRefreshSnapshot;
    expect(snapshot.resources.projects).toEqual({
      state: 'ready',
      data: [{ id: 'p1', name: 'Added before live', localPath: 'C:/luwi' }],
    });
    expect(snapshot.resources.activity).toEqual({
      state: 'ready',
      data: [expect.objectContaining({ streamId: '1-0', type: 'project.registered' })],
    });
  });
  it.each<[string, PulseResourceKey[]]>([
    // A project mutation also moves its repository read: registration and
    // path changes are exactly when the per-project Git facts go stale.
    ['project.registered', ['projects', 'git']],
    ['session.heartbeat', ['sessions']],
    ['agent.definition.updated', ['agents']],
    ['project.agent.bound', ['agents', 'bindings']],
    ['project.agent.updated', ['agents', 'bindings']],
    ['usage.reported', ['usage']],
    ['context.capability.loaded', ['context']],
    ['optimization.finding.detected', ['findings']],
    ['message.responded', []],
    ['future.adapter.observed', []],
  ])('maps %s only to authoritative affected resources', (eventType, expected) => {
    expect(resourcesForEvent(eventType)).toEqual(expected);
  });

  it('coalesces burst invalidations into one bounded resource refresh', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const coordinator = createInvalidationCoordinator({ refresh, coalesceMs: 250 });

    coordinator.invalidate(['sessions']);
    coordinator.invalidate(['sessions', 'usage']);
    await vi.advanceTimersByTimeAsync(249);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(['sessions', 'usage']);
  });

  it('runs one trailing coalesced batch when events arrive during refresh', async () => {
    vi.useFakeTimers();
    let resolveFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const refresh = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const coordinator = createInvalidationCoordinator({ refresh, coalesceMs: 250 });

    coordinator.invalidate(['projects']);
    await vi.advanceTimersByTimeAsync(250);
    coordinator.invalidate(['sessions']);
    coordinator.invalidate(['usage']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(['sessions', 'usage']);
  });

  it('drops pending work after stop', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const coordinator = createInvalidationCoordinator({ refresh, coalesceMs: 250 });
    coordinator.invalidate(['health']);
    coordinator.stop();
    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
  });
});
