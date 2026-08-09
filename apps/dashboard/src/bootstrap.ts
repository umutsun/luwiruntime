import { buildPulseSnapshot, type PulseInput, type PulseResources } from './pulse/model.js';
import {
  acceptActivityEvent,
  createActivityState,
  type ActivityState,
} from './realtime/activity-store.js';
import { parseRoute } from './routing.js';

/**
 * The composition root's policies.
 *
 * These decide what the application loads and when. They live here rather than
 * in `main.tsx` because that module calls `createRoot` at import time, so
 * anything defined beside it can only be exercised by mounting the whole app —
 * which is why none of this was covered.
 *
 * `buildPulseSnapshot` is re-exported so the entry point has one import for the
 * snapshot pipeline.
 */
export { buildPulseSnapshot };

/** The project whose scoped evidence should be loaded, if any. */
export function selectedProjectOf(hash: string): string | undefined {
  const route = parseRoute(hash);
  return route.name === 'projects' ? route.projectId : undefined;
}

/**
 * Only these routes consume the extra global reads, so they load while one of
 * them is open and never otherwise. The graph summary is 56 Redis commands per
 * request (ADR 0013) and nothing caches it, which is exactly why the overview
 * must not pay for it.
 */
export function needsIntelligenceOf(hash: string): boolean {
  const route = parseRoute(hash);
  return route.name === 'context' || route.name === 'optimization' || route.name === 'graph';
}

/**
 * Whether a realtime event can change what the currently open project panels
 * show. An event for another project changes nothing that is rendered, so it
 * must not cost a request; an event carrying no project may still matter.
 */
export function affectsSelectedProject(
  selectedProjectId: string | undefined,
  eventProjectId: string | undefined,
): boolean {
  if (selectedProjectId === undefined) return false;
  return eventProjectId === undefined || eventProjectId === selectedProjectId;
}

export function resourcesOf(input: PulseInput): PulseResources {
  return {
    health: input.health,
    projects: input.projects,
    sessions: input.sessions,
    agents: input.agents,
    usage: input.usage,
    context: input.context,
    activity: input.activity,
    findings: input.findings,
  };
}

export function seedActivity(input: PulseInput): ActivityState {
  return input.activity.state === 'ready'
    ? input.activity.data.reduce(
        (state, event) => acceptActivityEvent(state, event).state,
        createActivityState(),
      )
    : createActivityState();
}
