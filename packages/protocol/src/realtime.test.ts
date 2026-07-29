import { describe, expect, it } from 'vitest';

import { realtimeEventMessageSchema } from './index.js';

describe('realtime protocol', () => {
  it('validates the exact persisted event and global stream identity', () => {
    const message = {
      streamId: '1722170000000-0',
      event: {
        id: 'event-1',
        version: 1,
        type: 'session.registered',
        occurredAt: '2026-07-28T12:00:00.000Z',
        workspaceId: 'local',
        projectId: 'project-1',
        agentId: 'codex-sim',
        sessionId: 'session-1',
        payload: {},
      },
    };

    expect(realtimeEventMessageSchema.parse(message)).toEqual(message);
  });

  it('rejects invented or malformed stream IDs', () => {
    expect(() =>
      realtimeEventMessageSchema.parse({
        streamId: 'latest',
        event: {
          id: 'event-1',
          version: 1,
          type: 'runtime.started',
          occurredAt: '2026-07-28T12:00:00.000Z',
          workspaceId: 'local',
          payload: {},
        },
      }),
    ).toThrow();
  });
});
