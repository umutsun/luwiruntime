import type { RuntimeEvent } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { afterEach, describe, expect, it } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { DaemonConfig } from './config.js';

const config: DaemonConfig = {
  host: '127.0.0.1',
  port: 4782,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'workspace-1',
};

class FakeRedisGateway implements RedisGateway {
  closeCalls = 0;
  health: RedisHealth = {
    connected: true,
    status: 'connected',
    latencyMs: 2,
  };

  async connect(): Promise<boolean> {
    return this.health.connected;
  }

  async checkHealth(): Promise<RedisHealth> {
    return this.health;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe('LUWI daemon HTTP API', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports healthy Redis connectivity with HTTP 200', async () => {
    const redis = new FakeRedisGateway();
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
      startedAt: new Date('2026-07-28T08:00:00.000Z'),
      now: () => new Date('2026-07-28T08:00:02.500Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      runtimeState: 'ready',
      version: '0.1.0',
      uptimeMs: 2500,
      redis: {
        connected: true,
        status: 'connected',
        latencyMs: 2,
      },
      timestamp: '2026-07-28T08:00:02.500Z',
    });
  });

  it('reports unavailable Redis with HTTP 503 and no connection details', async () => {
    const redis = new FakeRedisGateway();
    redis.health = {
      connected: false,
      status: 'disconnected',
      error: {
        code: 'REDIS_UNAVAILABLE',
        message: 'Redis is unavailable',
      },
    };
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'degraded',
      startedAt: new Date('2026-07-28T08:00:00.000Z'),
      now: () => new Date('2026-07-28T08:00:02.500Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'degraded',
      runtimeState: 'degraded',
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
    });
    expect(response.body).not.toContain('redis://');
  });

  it('exposes versioned runtime information under /api/v1', async () => {
    const redis = new FakeRedisGateway();
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
      startedAt: new Date('2026-07-28T08:00:00.000Z'),
      now: () => new Date('2026-07-28T08:00:02.500Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/runtime',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
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
        connected: true,
        status: 'connected',
        latencyMs: 2,
      },
      endpoints: {
        health: '/health',
        runtime: '/api/v1/runtime',
      },
    });
    expect(response.body).not.toContain(config.redisUrl);
  });

  it('converts unexpected handler failures into a safe machine-readable error', async () => {
    const redis = new FakeRedisGateway();
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
    });
    app.get('/test/unexpected-error', async () => {
      throw new Error('secret connection details');
    });

    const response = await app.inject({
      method: 'GET',
      url: '/test/unexpected-error',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
      },
    });
    expect(response.body).not.toContain('secret connection details');
  });

  it('emits normalized lifecycle events and closes Redis gracefully', async () => {
    const redis = new FakeRedisGateway();
    const events: RuntimeEvent[] = [];
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
      startedAt: new Date('2026-07-28T08:00:00.000Z'),
      now: () => new Date('2026-07-28T08:00:02.500Z'),
      publishEvent: (event) => {
        events.push(event);
      },
    });

    await app.ready();
    await app.close();

    expect(events.map((event) => event.type)).toEqual(['runtime.started', 'runtime.stopping']);
    expect(redis.closeCalls).toBe(1);
    app = undefined;
  });
});
