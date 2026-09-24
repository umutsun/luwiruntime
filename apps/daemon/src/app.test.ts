import type { RuntimeEvent, RuntimeResourcesResponse } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { DaemonConfig } from './config.js';

const config: DaemonConfig = {
  host: '127.0.0.1',
  port: 80,
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

  it('authorizes lifecycle stop with an in-memory token and never returns it', async () => {
    const redis = new FakeRedisGateway();
    const requestStop = vi.fn(async () => undefined);
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
      lifecycle: {
        token: '6ccfd2c0-e424-4a21-91db-30dc72092a01',
        requestStop,
        schedule: (action) => action(),
      },
    });

    for (const token of [undefined, 'bad', '01a4d3e9-761e-4df8-824d-8f2182367512']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/runtime/stop',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { 'x-luwi-lifecycle-token': token }),
        },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.stringify(response.json())).not.toContain('6ccfd2c0');
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime/stop',
      headers: {
        'content-type': 'application/json',
        'x-luwi-lifecycle-token': '6ccfd2c0-e424-4a21-91db-30dc72092a01',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'stopping' });
    expect(JSON.stringify(response.json())).not.toContain('6ccfd2c0');
    expect(requestStop).toHaveBeenCalledTimes(1);
  });

  it('refuses lifecycle stop when this daemon was not CLI-managed', async () => {
    app = buildDaemon({ config, redis: new FakeRedisGateway(), logger: false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime/stop',
      headers: {
        'content-type': 'application/json',
        'x-luwi-lifecycle-token': '6ccfd2c0-e424-4a21-91db-30dc72092a01',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'DAEMON_LIFECYCLE_UNMANAGED' } });
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
      version: '0.2.0',
      uptimeMs: 2500,
      redis: {
        connected: true,
        status: 'connected',
        latencyMs: 2,
      },
      timestamp: '2026-07-28T08:00:02.500Z',
    });
  });

  it('rejects DNS-rebinding Hosts and hostile browser Origins for reads and mutations', async () => {
    const redis = new FakeRedisGateway();
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
    });
    app.post('/test/mutation', async () => ({ ok: true }));

    for (const request of [
      {
        method: 'GET' as const,
        url: '/api/v1/runtime',
        headers: {
          host: 'luwi.attacker.test:80',
          origin: 'http://luwi.attacker.test:80',
        },
      },
      {
        method: 'POST' as const,
        url: '/test/mutation',
        headers: {
          host: '127.0.0.1:80',
          origin: 'http://evil.test',
        },
      },
      // A state-changing request with no Origin is only tolerated when its
      // media type is one a browser cannot send cross-site without a preflight.
      {
        method: 'POST' as const,
        url: '/test/mutation',
        headers: {
          host: 'localhost:80',
          'content-type': 'text/plain',
        },
      },
      {
        method: 'POST' as const,
        url: '/test/mutation',
        headers: {
          host: 'localhost:80',
        },
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: 'REQUEST_ORIGIN_REJECTED',
          message: 'The local request origin was rejected.',
        },
      });
    }

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/runtime',
          headers: { host: 'localhost:80' },
          remoteAddress: '127.0.0.1',
        })
      ).statusCode,
    ).toBe(200);

    // The CLI and MCP shape: no Origin, JSON body. This must keep working, and
    // it is the only Origin-less shape that may.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/test/mutation',
          headers: { host: 'localhost:80', 'content-type': 'application/json' },
          payload: {},
          remoteAddress: '127.0.0.1',
        })
      ).statusCode,
    ).toBe(200);
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
      version: '0.2.0',
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
      version: '0.2.0',
      protocolVersion: 1,
      runtimeState: 'ready',
      runtimeInstanceId: 'runtime-1',
      workspaceId: 'workspace-1',
      startedAt: '2026-07-28T08:00:00.000Z',
      uptimeMs: 2500,
      host: '127.0.0.1',
      port: 80,
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

  it('serves the machine and footprint figures a wired reader measured', async () => {
    const resources: RuntimeResourcesResponse = {
      observedAt: '2026-07-28T08:00:02.500Z',
      host: {
        platform: 'win32',
        cpu: { model: 'Fake CPU', cores: 4, utilizationPercent: 12.5 },
        memory: { totalBytes: 8, freeBytes: 4 },
      },
      daemon: { pid: 1, rssBytes: 2, heapUsedBytes: 1 },
    };
    app = buildDaemon({
      config,
      redis: new FakeRedisGateway(),
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
      resources: async () => resources,
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime/resources' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(resources);
    expect(response.body).not.toContain(config.redisUrl);
  });

  it('has no resources route at all when no reader is wired', async () => {
    app = buildDaemon({
      config,
      redis: new FakeRedisGateway(),
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime/resources' });

    expect(response.statusCode).toBe(404);
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

  it("answers a malformed request body with a 400, not the server's 500", async () => {
    // Live 2026-09-24: a client sent a Content-Length that did not match its (UTF-8)
    // body; Fastify raised a 400-class FST_ERR and the daemon answered 500
    // INTERNAL_ERROR, which read as "the daemon is broken".
    const redis = new FakeRedisGateway();
    app = buildDaemon({
      config,
      redis,
      logger: false,
      runtimeInstanceId: 'runtime-1',
      runtimeState: () => 'ready',
    });
    app.post('/test/echo', async () => ({ ok: true }));

    const malformedJson = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"note": ',
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toMatchObject({ error: { code: 'REQUEST_MALFORMED' } });

    const lengthMismatch = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json', 'content-length': '40' },
      payload: '{"note":"ş"}',
    });
    expect(lengthMismatch.statusCode).toBe(400);
    expect(lengthMismatch.json()).toMatchObject({ error: { code: 'REQUEST_MALFORMED' } });
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
