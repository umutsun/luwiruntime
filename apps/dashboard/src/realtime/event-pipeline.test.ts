import { describe, expect, it } from 'vitest';

import { createActivityState } from './activity-store.js';
import { routeRealtimeEvent } from './event-pipeline.js';
import type { DashboardEvent } from './schema.js';

const event: DashboardEvent = {
  streamId: '42-0',
  id: 'event-42',
  version: 1,
  type: 'session.heartbeat',
  occurredAt: '2026-08-05T08:00:00.000Z',
  workspaceId: 'local',
  sessionId: 'session-1',
  payload: {},
};

describe('realtime event pipeline', () => {
  it('does not repeat projection invalidation for a duplicate stream ID', () => {
    const first = routeRealtimeEvent(createActivityState(), event);
    const duplicate = routeRealtimeEvent(first.state, event);

    expect(first.invalidations).toEqual(['sessions']);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.invalidations).toEqual([]);
    expect(duplicate.state.events).toHaveLength(1);
  });

  it('keeps an unknown valid event in Activity without refreshing unrelated queries', () => {
    const result = routeRealtimeEvent(createActivityState(), {
      ...event,
      streamId: '43-0',
      type: 'future.runtime.signal',
    });

    expect(result.accepted).toBe(true);
    expect(result.invalidations).toEqual([]);
    expect(result.state.events[0]?.type).toBe('future.runtime.signal');
  });
});
