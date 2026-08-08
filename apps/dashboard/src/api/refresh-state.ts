import type { PulseResources } from '../pulse/model.js';
import type { PulseResourceKey } from './pulse.js';

export type PulseFreshness = 'current' | 'refreshing' | 'stale' | 'unavailable';

export function freshnessForResources(
  resources: PulseResources,
): Extract<PulseFreshness, 'current' | 'unavailable'> {
  return Object.values(resources).some((resource) => resource.state === 'ready')
    ? 'current'
    : 'unavailable';
}

export type PulseRefreshSnapshot = {
  resources: PulseResources;
  freshness: PulseFreshness;
  staleResources: PulseResourceKey[];
  lastSuccessAt: string;
};

type RefreshControllerOptions = {
  initial: PulseResources;
  load: (
    keys: readonly PulseResourceKey[],
    signal: AbortSignal,
  ) => Promise<Partial<PulseResources>>;
  onChange: (snapshot: PulseRefreshSnapshot) => void;
  now?: () => Date;
};

export function createPulseRefreshController(options: RefreshControllerOptions) {
  const now = options.now ?? (() => new Date());
  let resources = options.initial;
  const stale = new Set<PulseResourceKey>();
  let lastSuccessAt = now().toISOString();
  let generation = 0;
  let active: AbortController | undefined;
  let stopped = false;
  const hasSafeSnapshot = (): boolean => freshnessForResources(resources) === 'current';

  const refresh = async (keys: readonly PulseResourceKey[]): Promise<void> => {
    if (stopped || keys.length === 0) return;
    generation += 1;
    const currentGeneration = generation;
    active?.abort();
    active = new AbortController();
    const controller = active;
    options.onChange({
      resources,
      freshness: hasSafeSnapshot() ? 'refreshing' : 'unavailable',
      staleResources: [...stale],
      lastSuccessAt,
    });
    let result: Partial<PulseResources>;
    try {
      result = await options.load(keys, controller.signal);
    } catch {
      result = {};
    }
    if (stopped || currentGeneration !== generation || controller.signal.aborted) return;

    let succeeded = false;
    const next = { ...resources };
    for (const key of keys) {
      const update = result[key];
      if (update?.state === 'ready') {
        Object.assign(next, { [key]: update });
        stale.delete(key);
        succeeded = true;
      } else {
        stale.add(key);
      }
    }
    resources = next;
    if (succeeded) lastSuccessAt = now().toISOString();
    active = undefined;
    options.onChange({
      resources,
      freshness: stale.size === 0 ? 'current' : hasSafeSnapshot() ? 'stale' : 'unavailable',
      staleResources: [...stale],
      lastSuccessAt,
    });
  };

  return {
    refresh,
    stop(): void {
      stopped = true;
      generation += 1;
      active?.abort();
      active = undefined;
    },
  };
}
