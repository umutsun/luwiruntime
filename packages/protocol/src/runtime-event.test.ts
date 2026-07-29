import { describe, expect, it } from 'vitest';

import { createRuntimeEvent, parseRuntimeEvent, runtimeEventSchema } from './index.js';

describe('runtime event envelope', () => {
  it('creates a versioned event with centrally supplied identity and time', () => {
    const event = createRuntimeEvent(
      {
        type: 'runtime.started',
        workspaceId: 'workspace-1',
        payload: { host: '127.0.0.1' },
      },
      {
        createId: () => 'event-1',
        now: () => new Date('2026-07-28T08:00:00.000Z'),
      },
    );

    expect(event).toEqual({
      id: 'event-1',
      version: 1,
      type: 'runtime.started',
      occurredAt: '2026-07-28T08:00:00.000Z',
      workspaceId: 'workspace-1',
      payload: { host: '127.0.0.1' },
    });
  });

  it('rejects unsupported event versions', () => {
    const result = runtimeEventSchema.safeParse({
      id: 'event-1',
      version: 2,
      type: 'runtime.started',
      occurredAt: '2026-07-28T08:00:00.000Z',
      workspaceId: 'workspace-1',
      payload: {},
    });

    expect(result.success).toBe(false);
  });

  it('rejects timestamps that are not UTC ISO 8601 values', () => {
    expect(() =>
      parseRuntimeEvent({
        id: 'event-1',
        version: 1,
        type: 'runtime.started',
        occurredAt: '2026-07-28 08:00:00',
        workspaceId: 'workspace-1',
        payload: {},
      }),
    ).toThrow();
  });

  it('rejects speculative event types outside the initial protocol', () => {
    expect(() =>
      parseRuntimeEvent({
        id: 'event-1',
        version: 1,
        type: 'agent.teleported',
        occurredAt: '2026-07-28T08:00:00.000Z',
        workspaceId: 'workspace-1',
        payload: {},
      }),
    ).toThrow();
  });

  it('accepts the dedicated graceful completion event', () => {
    expect(
      parseRuntimeEvent({
        id: 'event-1',
        version: 1,
        type: 'session.completed',
        occurredAt: '2026-07-28T08:00:00.000Z',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        agentId: 'codex-sim',
        sessionId: 'session-1',
        payload: {},
      }).type,
    ).toBe('session.completed');
  });
});
