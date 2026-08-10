import type { Project, WorkLease } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { ApplicationError, createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { LeaseService } from './lease-service.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const timestamp = '2026-08-10T00:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  localPath: 'C:/fixture',
  canonicalPath: 'C:/fixture',
  createdAt: timestamp,
  updatedAt: timestamp,
};

const lease: WorkLease = {
  id: 'lease-1',
  projectId: 'project-1',
  sessionId: 'session-a',
  agentId: 'codex-main',
  path: 'apps/daemon/src',
  matchPath: 'apps/daemon/src/',
  reason: 'rewriting the capability route',
  state: 'held',
  acquiredAt: timestamp,
  expiresAt: '2026-08-10T00:05:00.000Z',
};

class HealthyRedis implements RedisGateway {
  async connect(): Promise<boolean> {
    return true;
  }
  async checkHealth(): Promise<RedisHealth> {
    return { connected: true, status: 'connected', latencyMs: 1 };
  }
  async close(): Promise<void> {}
}

function daemon(leases: Partial<LeaseService>): DaemonApp {
  const readiness = createRuntimeReadiness('recovering');
  readiness.transitionTo('ready');
  return buildDaemon({
    config: {
      host: '127.0.0.1',
      port: 80,
      redisUrl: 'redis://127.0.0.1:6379',
      logLevel: 'silent',
      workspaceId: 'local',
    },
    redis: new HealthyRedis(),
    logger: false,
    readiness,
    runtimeState: () => readiness.state,
    services: {
      projects: {
        register: async () => project,
        get: async () => project,
        list: async () => [project],
      } as ProjectService,
      sessions: { list: async () => [] } as unknown as SessionService,
      leases: leases as LeaseService,
      listEvents: async () => [],
    },
  });
}

describe('work lease routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('creates a lease with its location header', async () => {
    const acquire = vi.fn().mockResolvedValue({ status: 'granted', lease });
    app = daemon({ acquire });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leases',
      payload: {
        projectId: 'project-1',
        sessionId: 'session-a',
        path: 'apps/daemon/src',
        reason: 'rewriting the capability route',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe('/api/v1/leases/lease-1');
    expect(response.json()).toMatchObject({ status: 'granted', lease: { id: 'lease-1' } });
    // The default duration comes from the protocol, not from each caller.
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 300_000 }));
  });

  /**
   * A denial is the runtime answering correctly, so it is a 200 with a body.
   * An error status would make a working collision check look like a broken
   * request to every generic client between here and the agent.
   */
  it('returns a refusal as a successful answer carrying its holder', async () => {
    app = daemon({
      acquire: vi.fn().mockResolvedValue({
        status: 'denied',
        conflict: {
          leaseId: 'lease-other',
          sessionId: 'session-b',
          agentId: 'claude-main',
          path: 'apps/daemon',
          reason: 'refactoring routes',
          expiresAt: '2026-08-10T00:10:00.000Z',
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leases',
      payload: {
        projectId: 'project-1',
        sessionId: 'session-b',
        path: 'apps/daemon/src/app.ts',
        reason: 'adding lease routes',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.json()).toMatchObject({
      status: 'denied',
      conflict: { leaseId: 'lease-other', sessionId: 'session-b' },
    });
  });

  it('rejects an acquire with no reason before it reaches the service', async () => {
    const acquire = vi.fn();
    app = daemon({ acquire });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leases',
      payload: { projectId: 'project-1', sessionId: 'session-a', path: 'src' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_VALIDATION_FAILED' } });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('renews and releases through the holding session', async () => {
    const renew = vi.fn().mockResolvedValue({ ...lease, renewedAt: timestamp });
    const release = vi
      .fn()
      .mockResolvedValue({ ...lease, state: 'released', releasedAt: timestamp });
    app = daemon({ renew, release });

    const renewed = await app.inject({
      method: 'POST',
      url: '/api/v1/leases/lease-1/renew',
      payload: { sessionId: 'session-a', durationMs: 600_000 },
    });
    expect(renewed.statusCode).toBe(200);
    expect(renew).toHaveBeenCalledWith('lease-1', 'session-a', 600_000);

    const released = await app.inject({
      method: 'POST',
      url: '/api/v1/leases/lease-1/release',
      payload: { sessionId: 'session-a' },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ state: 'released' });
  });

  it('surfaces the holder rule as a conflict rather than as a server error', async () => {
    app = daemon({
      release: vi
        .fn()
        .mockRejectedValue(
          new ApplicationError(
            'LEASE_NOT_HELD_BY_SESSION',
            'Only the holding session can release this lease.',
            409,
          ),
        ),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leases/lease-1/release',
      payload: { sessionId: 'session-b' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'LEASE_NOT_HELD_BY_SESSION' } });
  });

  it('lists a scope and discloses truncation from an over-read', async () => {
    const many = Array.from({ length: 3 }, (_unused, index) => ({
      ...lease,
      id: `lease-${String(index)}`,
    }));
    const list = vi.fn().mockResolvedValue(many);
    app = daemon({ list });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/leases?projectId=project-1&limit=2',
    });

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({ projectId: 'project-1', limit: 3 });
    expect(response.json().leases).toHaveLength(2);
    expect(response.json().truncated).toBe(true);
  });

  it('does not claim truncation when the scope fitted inside the page', async () => {
    app = daemon({ list: vi.fn().mockResolvedValue([lease]) });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/leases?sessionId=session-a&limit=10',
    });

    expect(response.json().truncated).toBe(false);
  });

  it('reads one lease by id', async () => {
    app = daemon({ get: vi.fn().mockResolvedValue(lease) });

    const response = await app.inject({ method: 'GET', url: '/api/v1/leases/lease-1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'lease-1', path: 'apps/daemon/src' });
  });

  it('serves no lease route at all when the service is absent', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    app = buildDaemon({
      config: {
        host: '127.0.0.1',
        port: 80,
        redisUrl: 'redis://127.0.0.1:6379',
        logLevel: 'silent',
        workspaceId: 'local',
      },
      redis: new HealthyRedis(),
      logger: false,
      readiness,
      runtimeState: () => readiness.state,
      services: {
        projects: {
          register: async () => project,
          get: async () => project,
          list: async () => [project],
        } as ProjectService,
        sessions: { list: async () => [] } as unknown as SessionService,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/leases?projectId=project-1' });

    expect(response.statusCode).toBe(404);
  });

  it('refuses every lease mutation while the runtime is draining', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    readiness.beginDraining();
    const acquire = vi.fn();
    app = buildDaemon({
      config: {
        host: '127.0.0.1',
        port: 80,
        redisUrl: 'redis://127.0.0.1:6379',
        logLevel: 'silent',
        workspaceId: 'local',
      },
      redis: new HealthyRedis(),
      logger: false,
      readiness,
      runtimeState: () => readiness.state,
      services: {
        projects: {
          register: async () => project,
          get: async () => project,
          list: async () => [project],
        } as ProjectService,
        sessions: { list: async () => [] } as unknown as SessionService,
        leases: { acquire } as unknown as LeaseService,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leases',
      payload: {
        projectId: 'project-1',
        sessionId: 'session-a',
        path: 'src',
        reason: 'anything',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'RUNTIME_NOT_READY' } });
    expect(acquire).not.toHaveBeenCalled();
  });
});
