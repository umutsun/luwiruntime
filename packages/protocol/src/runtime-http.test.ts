import { describe, expect, it } from 'vitest';

import {
  healthResponseSchema,
  lifecycleStopResponseSchema,
  runtimeInfoResponseSchema,
  type HealthResponse,
  type RuntimeInfoResponse,
} from './index.js';

describe('runtime HTTP response schemas', () => {
  it('accepts only the strict lifecycle stopping response', () => {
    expect(lifecycleStopResponseSchema.parse({ status: 'stopping' })).toEqual({
      status: 'stopping',
    });
    expect(() =>
      lifecycleStopResponseSchema.parse({ status: 'stopping', token: 'must-not-leak' }),
    ).toThrow();
  });

  it('validates a healthy response with Redis latency', () => {
    const response: HealthResponse = {
      status: 'ok',
      runtimeState: 'ready',
      version: '0.1.0',
      uptimeMs: 2500,
      redis: {
        connected: true,
        status: 'connected',
        latencyMs: 3,
      },
      timestamp: '2026-07-28T08:00:02.500Z',
    };

    expect(healthResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects an ok daemon status when Redis is disconnected', () => {
    expect(() =>
      healthResponseSchema.parse({
        status: 'ok',
        runtimeState: 'ready',
        version: '0.1.0',
        uptimeMs: 2500,
        redis: {
          connected: false,
          status: 'disconnected',
          error: {
            code: 'REDIS_UNAVAILABLE',
            message: 'Redis is unavailable',
          },
        },
        timestamp: '2026-07-28T08:00:02.500Z',
      }),
    ).toThrow();
  });

  it('allows a degraded runtime while Redis remains connected', () => {
    expect(
      healthResponseSchema.parse({
        status: 'degraded',
        runtimeState: 'recovering',
        version: '0.1.0',
        uptimeMs: 2500,
        redis: {
          connected: true,
          status: 'connected',
          latencyMs: 3,
        },
        timestamp: '2026-07-28T08:00:02.500Z',
      }),
    ).toMatchObject({
      status: 'degraded',
      runtimeState: 'recovering',
      redis: {
        connected: true,
      },
    });
  });

  it('validates versioned runtime information without exposing a Redis URL', () => {
    const response: RuntimeInfoResponse = {
      version: '0.1.0',
      protocolVersion: 1,
      runtimeState: 'ready',
      runtimeInstanceId: 'runtime-1',
      workspaceId: 'workspace-1',
      startedAt: '2026-07-28T08:00:00.000Z',
      uptimeMs: 2500,
      host: '127.0.0.1',
      port: 4782,
      redis: {
        connected: false,
        status: 'disconnected',
        error: {
          code: 'REDIS_UNAVAILABLE',
          message: 'Redis is unavailable',
        },
      },
      endpoints: {
        health: '/health',
        runtime: '/api/v1/runtime',
      },
    };

    expect(runtimeInfoResponseSchema.parse(response)).toEqual(response);
    expect(response).not.toHaveProperty('redisUrl');
  });
});
