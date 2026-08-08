import { describe, expect, it } from 'vitest';

import {
  acceptActivityEvent,
  createActivityState,
  filterActivityEvents,
  resumeActivity,
  setActivityFollowing,
  type ActivityState,
} from './activity-store.js';
import type { DashboardEvent } from './schema.js';

const event = (sequence: number, overrides: Partial<DashboardEvent> = {}): DashboardEvent => ({
  streamId: `${sequence}-0`,
  id: `event-${sequence}`,
  version: 1,
  type: 'session.heartbeat',
  occurredAt: '2026-08-05T08:00:00.000Z',
  workspaceId: 'local',
  projectId: 'project-1',
  sessionId: 'session-1',
  payload: {},
  ...overrides,
});

function add(state: ActivityState, value: DashboardEvent): ActivityState {
  return acceptActivityEvent(state, value).state;
}

describe('bounded activity state', () => {
  it('deduplicates canonical stream IDs including reconnect delivery', () => {
    let state = createActivityState({ maxEvents: 3, maxSeenIds: 5 });
    state = add(state, event(1));
    const duplicate = acceptActivityEvent(state, event(1, { id: 'event-redelivered' }));

    expect(duplicate.accepted).toBe(false);
    expect(duplicate.state.events.map(({ id }) => id)).toEqual(['event-1']);
  });

  it('bounds visible rows and deduplication storage independently', () => {
    let state = createActivityState({ maxEvents: 2, maxSeenIds: 3 });
    for (const sequence of [1, 2, 3, 4]) state = add(state, event(sequence));

    expect(state.events.map(({ streamId }) => streamId)).toEqual(['3-0', '4-0']);
    expect(state.seenStreamIds).toEqual(['2-0', '3-0', '4-0']);
  });

  it('orders an accepted out-of-order event by Redis stream identity', () => {
    let state = createActivityState({ maxEvents: 4, maxSeenIds: 8 });
    for (const sequence of [10, 12, 11]) state = add(state, event(sequence));
    expect(state.events.map(({ streamId }) => streamId)).toEqual(['10-0', '11-0', '12-0']);
  });

  it('keeps receiving while visual following is paused and clears the bounded count on resume', () => {
    let state = setActivityFollowing(createActivityState(), false);
    state = add(state, event(1));
    state = add(state, event(2));

    expect(state.following).toBe(false);
    expect(state.pendingCount).toBe(2);
    expect(resumeActivity(state)).toMatchObject({ following: true, pendingCount: 0 });
  });

  it('filters bounded local activity by project, source, type, and safe text search', () => {
    let state = createActivityState();
    state = add(state, event(1, { agentId: 'agent-a', type: 'usage.reported' }));
    state = add(
      state,
      event(2, {
        projectId: 'project-2',
        type: 'project.updated',
      }),
    );

    expect(filterActivityEvents(state.events, { projectId: 'project-1' })).toHaveLength(1);
    expect(filterActivityEvents(state.events, { source: 'agent-a' })).toHaveLength(1);
    expect(filterActivityEvents(state.events, { eventType: 'project.updated' })).toHaveLength(1);
    expect(filterActivityEvents(state.events, { search: 'usage.reported' })).toHaveLength(1);
  });
});
