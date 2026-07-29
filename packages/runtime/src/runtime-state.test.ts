import { describe, expect, it } from 'vitest';

import {
  ApplicationError,
  createRuntimeState,
  getRuntimeUptimeMs,
  toPublicError,
} from './index.js';

describe('runtime state', () => {
  it('creates stable versioned runtime identity', () => {
    expect(
      createRuntimeState({
        workspaceId: 'workspace-1',
        startedAt: new Date('2026-07-28T08:00:00.000Z'),
      }),
    ).toEqual({
      version: '0.1.0',
      protocolVersion: 1,
      workspaceId: 'workspace-1',
      startedAt: '2026-07-28T08:00:00.000Z',
    });
  });

  it('reports non-negative monotonic uptime from injected timestamps', () => {
    const state = createRuntimeState({
      workspaceId: 'workspace-1',
      startedAt: new Date('2026-07-28T08:00:00.000Z'),
    });

    expect(getRuntimeUptimeMs(state, new Date('2026-07-28T08:00:02.500Z'))).toBe(2500);
    expect(getRuntimeUptimeMs(state, new Date('2026-07-28T07:59:59.000Z'))).toBe(0);
  });
});

describe('application errors', () => {
  it('converts typed errors into safe public responses', () => {
    const error = new ApplicationError('REDIS_UNAVAILABLE', 'Redis is unavailable', 503, {
      retryable: true,
    });

    expect(toPublicError(error)).toEqual({
      statusCode: 503,
      body: {
        error: {
          code: 'REDIS_UNAVAILABLE',
          message: 'Redis is unavailable',
          details: {
            retryable: true,
          },
        },
      },
    });
  });

  it('does not expose unknown error details', () => {
    expect(toPublicError(new Error('secret connection string'))).toEqual({
      statusCode: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred',
        },
      },
    });
  });
});
