import { acceptActivityEvent, type ActivityState } from './activity-store.js';
import { resourcesForEvent, type PulseResourceKey } from './invalidation.js';
import type { DashboardEvent } from './schema.js';

export type RealtimeEventResult = {
  state: ActivityState;
  accepted: boolean;
  invalidations: PulseResourceKey[];
};

export function routeRealtimeEvent(
  state: ActivityState,
  event: DashboardEvent,
): RealtimeEventResult {
  const activity = acceptActivityEvent(state, event);
  return {
    ...activity,
    invalidations: activity.accepted ? resourcesForEvent(event.type) : [],
  };
}
