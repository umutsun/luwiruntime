import { describe, expect, it } from 'vitest';

import { createRuntimeLifecycleEvent } from './index.js';

const eventDependencies = {
  createId: () => 'event-1',
  now: () => new Date('2026-07-28T08:00:00.000Z'),
};

describe('runtime lifecycle events', () => {
  it('creates a normalized runtime.started event', () => {
    expect(
      createRuntimeLifecycleEvent(
        'started',
        {
          workspaceId: 'workspace-1',
        },
        eventDependencies,
      ),
    ).toMatchObject({
      id: 'event-1',
      version: 1,
      type: 'runtime.started',
      occurredAt: '2026-07-28T08:00:00.000Z',
      workspaceId: 'workspace-1',
      payload: {
        runtimeVersion: '0.1.0',
      },
    });
  });

  it('creates a normalized runtime.stopping event', () => {
    expect(
      createRuntimeLifecycleEvent(
        'stopping',
        {
          workspaceId: 'workspace-1',
        },
        eventDependencies,
      ).type,
    ).toBe('runtime.stopping');
  });
});
