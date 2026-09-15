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
  if (route.name === 'projects') return route.projectId;
  // The overview's detail drawer reads the same scoped evidence; a focus alone does not.
  return route.name === 'pulse' && route.detail !== undefined ? route.projectId : undefined;
}

/** The agent whose pair-scoped evidence should be loaded, if any. */
export function selectedAgentOf(hash: string): string | undefined {
  const route = parseRoute(hash);
  if (route.name === 'projects') return route.agentId;
  return route.name === 'pulse' ? route.detail?.agentId : undefined;
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
 * The message list is its own scope, loaded by two routes.
 *
 * `#/messages` renders the full table, and the overview enriches its stream with
 * each exchange's response — so both read the same bounded list (up to 101
 * records). Every other route stays off it, and its refresh domain is kept apart
 * from the intelligence scope so a `message.*` event never re-reads the graph
 * summary.
 */
export function needsMessagesOf(hash: string): boolean {
  const name = parseRoute(hash).name;
  return name === 'messages' || name === 'pulse';
}

/**
 * The catalogue reads, on the same rule.
 *
 * `#/capabilities` is the only route that renders either collection, and both
 * are whole-runtime inventories rather than project-scoped reads, so nothing
 * else should pay for them.
 */
export function needsCapabilityCatalogOf(hash: string): boolean {
  return parseRoute(hash).name === 'capabilities';
}

/** The config chain reads, on the same rule. */
export function needsConfigOf(hash: string): boolean {
  return parseRoute(hash).name === 'config';
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
    runtime: input.runtime ?? { state: 'unavailable' },
    git: input.git ?? { state: 'unavailable' },
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
