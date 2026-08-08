import type { Project, RealtimeEventMessage, SessionView } from '@luwi/protocol';
import { RedisRepositoryError, type RedisGateway, type RedisHealth } from '@luwi/redis';
import { ApplicationError, createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { DaemonConfig } from './config.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const config: DaemonConfig = {
  host: '127.0.0.1',
  port: 80,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'local',
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

const project: Project = {
  id: 'project-1',
  name: 'LUWI Runtime',
  localPath: 'C:/workspace/luwi',
  canonicalPath: 'C:/workspace/luwi',
  createdAt: '2026-07-28T12:00:00.000Z',
  updatedAt: '2026-07-28T12:00:00.000Z',
};

const session: SessionView = {
  id: 'session-1',
  agentId: 'codex-sim',
  projectId: 'project-1',
  status: 'starting',
  workingDirectory: 'C:/workspace/luwi',
  startedAt: '2026-07-28T12:00:00.000Z',
  lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
  metadata: {},
  presence: 'online',
};

function services(overrides?: {
  projectRegister?: ProjectService['register'];
  projectList?: ProjectService['list'];
  sessionRegister?: SessionService['register'];
}): { projects: ProjectService; sessions: SessionService } {
  return {
    projects: {
      register: overrides?.projectRegister ?? (async () => project),
      get: async (projectId) => (projectId === project.id ? project : null),
      list: overrides?.projectList ?? (async () => [project]),
    },
    sessions: {
      register: overrides?.sessionRegister ?? (async () => session),
      get: async (sessionId) => (sessionId === session.id ? session : null),
      list: async (projectId) =>
        projectId === undefined || projectId === project.id ? [session] : [],
      heartbeat: async () => ({ status: 'renewed', eventEmitted: false }),
      updateStatus: async () => ({ ...session, status: 'idle' }),
      close: async () => ({ ...session, status: 'completed', presence: 'offline' }),
    },
  };
}

describe('Phase 1 HTTP routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('serves validated project and session resources', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...services(),
        listEvents: async (): Promise<RealtimeEventMessage[]> => [],
      },
    });

    const registeredProject = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'LUWI Runtime', localPath: '.' },
    });
    expect(registeredProject.statusCode).toBe(201);
    expect(registeredProject.headers.location).toBe('/api/v1/projects/project-1');
    expect(registeredProject.json()).toEqual(project);

    const registeredSession = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: {
        projectId: 'project-1',
        agentId: 'codex-sim',
        workingDirectory: '.',
      },
    });
    expect(registeredSession.statusCode).toBe(201);
    expect(registeredSession.json()).toEqual(session);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects' })).json()).toEqual({
      projects: [project],
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/projects/project-1/sessions' })).json(),
    ).toEqual({ sessions: [session] });
  });

  it('returns approved duplicate-path conflict details and Location header', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...services({
          projectRegister: async () => {
            throw new ApplicationError(
              'PROJECT_ALREADY_REGISTERED',
              'A project is already registered for this local path.',
              409,
              {
                existingProjectId: 'project-existing',
                canonicalLocalPath: 'C:/workspace/luwi',
              },
            );
          },
        }),
        listEvents: async () => [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'LUWI', localPath: '.' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers.location).toBe('/api/v1/projects/project-existing');
    expect(response.json()).toMatchObject({
      error: {
        code: 'PROJECT_ALREADY_REGISTERED',
        details: { existingProjectId: 'project-existing' },
      },
    });
  });

  it('rejects invalid protocol input and mutations while not ready', async () => {
    const readiness = createRuntimeReadiness('recovering');
    const register = vi.fn(async () => session);
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...services({ sessionRegister: register }),
        listEvents: async () => [],
      },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: {
        projectId: 'project-1',
        agentId: '../invalid',
        workingDirectory: '.',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'REQUEST_VALIDATION_FAILED' } });

    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: {
        projectId: 'project-1',
        agentId: 'codex-sim',
        workingDirectory: '.',
      },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: { code: 'RUNTIME_NOT_READY' } });
    expect(register).not.toHaveBeenCalled();
    const unavailableRead = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(unavailableRead.statusCode).toBe(503);
    expect(unavailableRead.json()).toMatchObject({ error: { code: 'RUNTIME_NOT_READY' } });
  });

  it('returns event history in ascending Stream order after query validation', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const listEvents = vi.fn(async (): Promise<RealtimeEventMessage[]> => []);
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: { ...services(), listEvents },
    });

    expect((await app.inject({ method: 'GET', url: '/api/v1/events?limit=25' })).json()).toEqual({
      events: [],
    });
    expect(listEvents).toHaveBeenCalledWith(25);
    expect((await app.inject({ method: 'GET', url: '/api/v1/events?limit=0' })).statusCode).toBe(
      400,
    );
  });

  it('degrades and returns safe 503 errors when Redis fails during reads or mutations', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const onRedisUnavailable = vi.fn();
    const unavailable = () =>
      new RedisRepositoryError('REDIS_UNAVAILABLE', 'Redis is unavailable.');
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      onRedisUnavailable,
      services: {
        ...services({
          projectRegister: async () => {
            throw unavailable();
          },
          projectList: async () => {
            throw unavailable();
          },
        }),
        listEvents: async () => {
          throw unavailable();
        },
      },
    });

    const mutation = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'LUWI', localPath: '.' },
    });
    const projectionRead = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    const historyRead = await app.inject({ method: 'GET', url: '/api/v1/events' });

    for (const response of [mutation, projectionRead, historyRead]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: 'RUNTIME_NOT_READY',
          message: 'The runtime is not ready because Redis is unavailable.',
        },
      });
    }
    expect(onRedisUnavailable).toHaveBeenCalledTimes(3);
  });
});
