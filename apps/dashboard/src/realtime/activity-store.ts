import type { DashboardEvent } from './schema.js';

export const DEFAULT_ACTIVITY_LIMIT = 200;
export const DEFAULT_DEDUPE_LIMIT = 512;

export type ActivityState = {
  events: DashboardEvent[];
  seenStreamIds: string[];
  following: boolean;
  pendingCount: number;
  maxEvents: number;
  maxSeenIds: number;
};

export type ActivityFilters = {
  projectId?: string;
  source?: string;
  eventType?: string;
  search?: string;
};

function compareIntegerText(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

export function compareStreamIds(left: string, right: string): number {
  const [leftMs = '0', leftSequence = '0'] = left.split('-');
  const [rightMs = '0', rightSequence = '0'] = right.split('-');
  return compareIntegerText(leftMs, rightMs) || compareIntegerText(leftSequence, rightSequence);
}

export function createActivityState(
  options: { maxEvents?: number; maxSeenIds?: number } = {},
): ActivityState {
  return {
    events: [],
    seenStreamIds: [],
    following: true,
    pendingCount: 0,
    maxEvents: options.maxEvents ?? DEFAULT_ACTIVITY_LIMIT,
    maxSeenIds: options.maxSeenIds ?? DEFAULT_DEDUPE_LIMIT,
  };
}

export function acceptActivityEvent(
  state: ActivityState,
  event: DashboardEvent,
): { state: ActivityState; accepted: boolean } {
  if (state.seenStreamIds.includes(event.streamId)) return { state, accepted: false };
  const events = [...state.events, event]
    .sort((left, right) => compareStreamIds(left.streamId, right.streamId))
    .slice(-state.maxEvents);
  const seenStreamIds = [...state.seenStreamIds, event.streamId].slice(-state.maxSeenIds);
  return {
    accepted: true,
    state: {
      ...state,
      events,
      seenStreamIds,
      pendingCount: state.following
        ? state.pendingCount
        : Math.min(state.maxEvents, state.pendingCount + 1),
    },
  };
}

export function setActivityFollowing(state: ActivityState, following: boolean): ActivityState {
  return { ...state, following };
}

export function resumeActivity(state: ActivityState): ActivityState {
  return { ...state, following: true, pendingCount: 0 };
}

export function activitySource(event: DashboardEvent): string {
  return event.agentId ?? event.sessionId ?? event.projectId ?? 'runtime';
}

export function filterActivityEvents(
  events: readonly DashboardEvent[],
  filters: ActivityFilters,
): DashboardEvent[] {
  const search = filters.search?.trim().toLowerCase();
  return events.filter((event) => {
    if (filters.projectId !== undefined && event.projectId !== filters.projectId) return false;
    if (filters.source !== undefined && activitySource(event) !== filters.source) return false;
    if (filters.eventType !== undefined && event.type !== filters.eventType) return false;
    if (search === undefined || search.length === 0) return true;
    return [
      event.type,
      event.streamId,
      event.projectId,
      event.agentId,
      event.sessionId,
      event.correlationId,
    ].some((value) => value?.toLowerCase().includes(search) === true);
  });
}
