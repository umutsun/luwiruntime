import { describe, expect, it, vi } from 'vitest';

import {
  createPulseRefreshController,
  freshnessForResources,
  type PulseRefreshSnapshot,
} from './refresh-state.js';
import type { PulseResources } from '../pulse/model.js';

const resources = (): PulseResources => ({
  health: { state: 'unavailable' },
  projects: { state: 'ready', data: [{ id: 'p1', name: 'LUWI', localPath: 'C:/luwi' }] },
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
});

describe('Pulse refresh state', () => {
  it('classifies bootstrap resources as unavailable until at least one safe snapshot exists', () => {
    const unavailable = Object.fromEntries(
      Object.keys(resources()).map((key) => [key, { state: 'unavailable' }]),
    ) as PulseResources;

    expect(freshnessForResources(unavailable)).toBe('unavailable');
    expect(freshnessForResources(resources())).toBe('current');
  });

  it('publishes retained resources as refreshing before the authoritative load completes', async () => {
    let resolveLoad!: (value: Partial<PulseResources>) => void;
    const load = new Promise<Partial<PulseResources>>((resolve) => {
      resolveLoad = resolve;
    });
    const onChange = vi.fn();
    const controller = createPulseRefreshController({
      initial: resources(),
      load: async () => await load,
      onChange,
    });

    const refresh = controller.refresh(['projects']);

    const inFlight = onChange.mock.lastCall?.[0] as PulseRefreshSnapshot;
    expect(inFlight.freshness).toBe('refreshing');
    expect(inFlight.resources.projects).toEqual(resources().projects);
    resolveLoad({ projects: { state: 'ready', data: [] } });
    await refresh;
    expect((onChange.mock.lastCall?.[0] as PulseRefreshSnapshot).freshness).toBe('current');
  });

  it('preserves last successful data and marks it stale when refresh fails', async () => {
    const onChange = vi.fn();
    const controller = createPulseRefreshController({
      initial: resources(),
      load: async () => ({ projects: { state: 'unavailable' } }),
      onChange,
      now: () => new Date('2026-08-05T08:01:00.000Z'),
    });

    await controller.refresh(['projects']);

    const next = onChange.mock.lastCall?.[0] as PulseRefreshSnapshot;
    expect(next.resources.projects).toEqual(resources().projects);
    expect(next.staleResources).toEqual(['projects']);
    expect(next.freshness).toBe('stale');
  });

  it('does not let an obsolete response overwrite a newer resource generation', async () => {
    let resolveOld!: (value: Partial<PulseResources>) => void;
    const oldRequest = new Promise<Partial<PulseResources>>((resolve) => {
      resolveOld = resolve;
    });
    const onChange = vi.fn();
    const load = vi
      .fn()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce({ projects: { state: 'ready', data: [] } });
    const controller = createPulseRefreshController({
      initial: resources(),
      load,
      onChange,
      now: () => new Date('2026-08-05T08:02:00.000Z'),
    });

    const first = controller.refresh(['projects']);
    const second = controller.refresh(['projects']);
    await second;
    resolveOld({
      projects: {
        state: 'ready',
        data: [{ id: 'old', name: 'Obsolete', localPath: 'C:/old' }],
      },
    });
    await first;

    expect(onChange).toHaveBeenCalledTimes(3);
    const next = onChange.mock.lastCall?.[0] as PulseRefreshSnapshot;
    expect(next.resources.projects).toEqual({ state: 'ready', data: [] });
  });

  it('uses unavailable when no safe resource exists after refresh failure', async () => {
    const unavailable = Object.fromEntries(
      Object.keys(resources()).map((key) => [key, { state: 'unavailable' }]),
    ) as PulseResources;
    const onChange = vi.fn();
    const controller = createPulseRefreshController({
      initial: unavailable,
      load: async () => ({ health: { state: 'unavailable' } }),
      onChange,
    });

    await controller.refresh(['health']);

    expect((onChange.mock.lastCall?.[0] as PulseRefreshSnapshot).freshness).toBe('unavailable');
  });

  it('cancels an active request and suppresses changes after stop', async () => {
    let capturedSignal: AbortSignal | undefined;
    const onChange = vi.fn();
    const controller = createPulseRefreshController({
      initial: resources(),
      load: async (_keys, signal) => {
        capturedSignal = signal;
        return new Promise<Partial<PulseResources>>(() => undefined);
      },
      onChange,
    });

    void controller.refresh(['sessions']);
    controller.stop();
    expect(capturedSignal?.aborted).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    expect((onChange.mock.lastCall?.[0] as PulseRefreshSnapshot).freshness).toBe('refreshing');
  });
});
