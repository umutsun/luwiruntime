import { describe, expect, it } from 'vitest';

import {
  eventListQuerySchema,
  eventListResponseSchema,
  publicErrorResponseSchema,
  runtimeStateSchema,
} from './index.js';

const event = {
  id: 'event-1',
  version: 1,
  type: 'project.registered',
  occurredAt: '2026-07-28T12:00:00.000Z',
  workspaceId: 'local',
  projectId: 'project-1',
  payload: {},
};

describe('runtime API protocol', () => {
  it('validates every internal runtime state', () => {
    for (const state of ['starting', 'ready', 'degraded', 'recovering', 'draining', 'stopped']) {
      expect(runtimeStateSchema.parse(state)).toBe(state);
    }
  });

  it('coerces and bounds the event list limit', () => {
    expect(eventListQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(eventListQuerySchema.parse({ limit: '1000' })).toEqual({ limit: 1000 });
    expect(eventListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(eventListQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
  });

  it('validates recent events in stream order wrappers', () => {
    expect(
      eventListResponseSchema.parse({
        events: [{ streamId: '1722170000000-0', event }],
      }),
    ).toEqual({
      events: [{ streamId: '1722170000000-0', event }],
    });
  });

  it('validates bounded safe error details', () => {
    expect(
      publicErrorResponseSchema.parse({
        error: {
          code: 'PROJECT_ALREADY_REGISTERED',
          message: 'A project is already registered for this local path.',
          details: {
            existingProjectId: 'project-1',
            canonicalLocalPath: 'C:/workspace/luwi',
          },
        },
      }),
    ).toMatchObject({
      error: {
        code: 'PROJECT_ALREADY_REGISTERED',
      },
    });
  });
});
