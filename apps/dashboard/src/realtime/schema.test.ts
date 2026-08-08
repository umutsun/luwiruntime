import { describe, expect, it } from 'vitest';

import { parseDashboardEvent } from './schema.js';

const message = (type = 'session.heartbeat') => ({
  streamId: '1785918000000-0',
  event: {
    id: 'event-1',
    version: 1,
    type,
    occurredAt: '2026-08-05T08:00:00.000Z',
    workspaceId: 'local',
    projectId: 'project-1',
    sessionId: 'session-1',
    payload: { status: 'renewed' },
  },
});

describe('dashboard realtime envelope', () => {
  it('parses the canonical stream identity and normalized event fields', () => {
    expect(parseDashboardEvent(message())).toEqual({
      ok: true,
      event: {
        streamId: '1785918000000-0',
        id: 'event-1',
        version: 1,
        type: 'session.heartbeat',
        occurredAt: '2026-08-05T08:00:00.000Z',
        workspaceId: 'local',
        projectId: 'project-1',
        sessionId: 'session-1',
        payload: { status: 'renewed' },
      },
    });
  });

  it('accepts a structurally valid future event type for safe display', () => {
    const result = parseDashboardEvent(message('future.adapter.observed'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.type).toBe('future.adapter.observed');
  });

  it.each([
    { ...message(), streamId: 'latest' },
    { ...message(), event: { ...message().event, version: 2 } },
    { ...message(), event: { ...message().event, occurredAt: 'not-a-date' } },
    { ...message(), event: { ...message().event, type: '<script>' } },
  ])('rejects malformed messages without preserving their payload', (value) => {
    expect(parseDashboardEvent(value)).toEqual({ ok: false, reason: 'invalid-envelope' });
  });
});
