export const PULSE_RESOURCE_KEYS = [
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
] as const;

export type PulseResourceKey = (typeof PULSE_RESOURCE_KEYS)[number];

export function resourcesForEvent(eventType: string): PulseResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...PULSE_RESOURCE_KEYS];
  // A binding change moves the flow roles (ADR 0036) as well as the agent view.
  if (eventType.startsWith('project.agent.')) return ['agents', 'bindings'];
  if (eventType.startsWith('agent.definition.')) return ['agents'];
  if (eventType.startsWith('project.')) return ['projects', 'git'];
  if (eventType.startsWith('git.')) return ['git'];
  // A coordinator claim/release is the only event that moves the role record; a
  // session heartbeat does not, so session.* stays sessions-only (the realtime
  // schema does not decode coordinator.* yet, so this is ready, not yet live).
  if (eventType.startsWith('coordinator.')) return ['coordinator'];
  if (eventType.startsWith('session.')) return ['sessions'];
  if (eventType.startsWith('usage.')) return ['usage'];
  if (eventType.startsWith('context.')) return ['context'];
  if (
    eventType.startsWith('optimization.finding.') ||
    eventType.startsWith('optimization.analysis.')
  ) {
    return ['findings'];
  }
  return [];
}

export type InvalidationCoordinator = {
  invalidate(resources: readonly PulseResourceKey[]): void;
  invalidateAll(): void;
  stop(): void;
};

export type LiveRefreshCoordinator = {
  observe(state: 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'unavailable'): void;
};

export type RefreshRequestRouter = {
  request(): void;
  attach(refresh: () => void): () => void;
};

export function createRefreshRequestRouter(fallback: () => void): RefreshRequestRouter {
  let attached: (() => void) | undefined;
  return {
    request() {
      (attached ?? fallback)();
    },
    attach(refresh) {
      attached = refresh;
      return () => {
        if (attached === refresh) attached = undefined;
      };
    },
  };
}

export function createLiveRefreshCoordinator(options: {
  invalidateAll: () => void;
}): LiveRefreshCoordinator {
  let previous: 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'unavailable' | undefined;
  return {
    observe(state) {
      if (state === 'live' && previous !== 'live') options.invalidateAll();
      previous = state;
    },
  };
}

export function createInvalidationCoordinator(options: {
  refresh: (resources: PulseResourceKey[]) => Promise<void>;
  coalesceMs?: number;
  onError?: () => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): InvalidationCoordinator {
  const coalesceMs = options.coalesceMs ?? 250;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const pending = new Set<PulseResourceKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;

  const schedule = () => {
    if (stopped || running || timer !== undefined || pending.size === 0) return;
    timer = setTimer(() => {
      timer = undefined;
      void flush();
    }, coalesceMs);
  };

  const flush = async () => {
    if (stopped || running || pending.size === 0) return;
    running = true;
    const resources = PULSE_RESOURCE_KEYS.filter((resource) => pending.delete(resource));
    try {
      await options.refresh(resources);
    } catch {
      options.onError?.();
    } finally {
      running = false;
      schedule();
    }
  };

  return {
    invalidate(resources) {
      if (stopped) return;
      for (const resource of resources) pending.add(resource);
      schedule();
    },
    invalidateAll() {
      this.invalidate(PULSE_RESOURCE_KEYS);
    },
    stop() {
      stopped = true;
      pending.clear();
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
