import type { Coordinator, Project } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { ApplicationError, createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { CoordinatorService } from './coordinator-service.js';
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

const coordinator: Coordinator = {
  projectId: 'project-1',
  sessionId: 'session-a',
  agentId: 'codex-main',
  claimId: 'claim-a',
  claimedAt: timestamp,
  version: 1,
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

function daemon(coordinatorService: Partial<CoordinatorService> | undefined): DaemonApp {
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
      ...(coordinatorService === undefined
        ? {}
        : { coordinator: coordinatorService as CoordinatorService }),
      listEvents: async () => [],
    },
  });
}

describe('coordinator routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('claims the role with a 201 and its location header', async () => {
    const claim = vi.fn().mockResolvedValue(coordinator);
    app = daemon({ claim });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-1/coordinator',
      payload: { sessionId: 'session-a' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe('/api/v1/projects/project-1/coordinator');
    expect(response.json()).toMatchObject({ sessionId: 'session-a', version: 1 });
    expect(claim).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-a' });
  });

  it('surfaces a live holder as a 409 conflict', async () => {
    app = daemon({
      claim: vi
        .fn()
        .mockRejectedValue(
          new ApplicationError('COORDINATOR_CONFLICT', 'Already coordinated by session-b.', 409),
        ),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-1/coordinator',
      payload: { sessionId: 'session-a' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'COORDINATOR_CONFLICT' } });
  });

  it('rejects a claim with no session before it reaches the service', async () => {
    const claim = vi.fn();
    app = daemon({ claim });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-1/coordinator',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });

  it('releases the role with a 204', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    app = daemon({ release });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/project-1/coordinator',
      payload: { sessionId: 'session-a' },
    });

    expect(response.statusCode).toBe(204);
    expect(release).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-a' });
  });

  it('surfaces the holder-only rule as a conflict', async () => {
    app = daemon({
      release: vi
        .fn()
        .mockRejectedValue(
          new ApplicationError(
            'COORDINATOR_NOT_HELD_BY_SESSION',
            'Only the coordinating session can release the role.',
            409,
          ),
        ),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/project-1/coordinator',
      payload: { sessionId: 'session-b' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'COORDINATOR_NOT_HELD_BY_SESSION' } });
  });

  it('reads the coordinator view', async () => {
    app = daemon({ get: vi.fn().mockResolvedValue({ coordinator, live: true }) });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/coordinator',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ coordinator, live: true });
  });

  it('serves no coordinator route when the service is absent', async () => {
    app = daemon(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/coordinator',
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a claim while the runtime is draining', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    readiness.beginDraining();
    const claim = vi.fn();
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
        coordinator: { claim } as unknown as CoordinatorService,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-1/coordinator',
      payload: { sessionId: 'session-a' },
    });

    expect(response.statusCode).toBe(503);
    expect(claim).not.toHaveBeenCalled();
  });
});
