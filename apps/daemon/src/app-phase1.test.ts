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

const project2: Project = {
  id: 'project-2',
  name: 'Second Project',
  localPath: 'C:/workspace/second',
  canonicalPath: 'C:/workspace/second',
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

const declaredBinding = {
  id: 'b'.repeat(64),
  adapterId: 'claude-code',
  nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
  kind: 'main' as const,
  openLinkId: 'l'.repeat(64),
  version: 1,
  linkCount: 1,
  trimmedLinkCount: 0,
  firstLinkedAt: '2026-08-17T00:00:00.000Z',
  lastLinkedAt: '2026-08-17T00:00:00.000Z',
};
const declaredLink = {
  id: 'l'.repeat(64),
  bindingId: 'b'.repeat(64),
  sessionId: 'session-1',
  linkedAt: '2026-08-17T00:00:00.000Z',
};

function services(overrides?: {
  projectRegister?: ProjectService['register'];
  projectUpdate?: ProjectService['update'];
  projectList?: ProjectService['list'];
  sessionRegister?: SessionService['register'];
  sessionDeclareNative?: SessionService['declareNative'];
}): { projects: ProjectService; sessions: SessionService } {
  return {
    projects: {
      register: overrides?.projectRegister ?? (async () => project),
      update: overrides?.projectUpdate ?? (async () => project),
      get: async (projectId) =>
        projectId === project.id ? project : projectId === project2.id ? project2 : null,
      list: overrides?.projectList ?? (async () => [project]),
    },
    sessions: {
      register: overrides?.sessionRegister ?? (async () => session),
      declareNative:
        overrides?.sessionDeclareNative ??
        (async () => ({ outcome: 'created', binding: declaredBinding, link: declaredLink })),
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

  it('discovers one directory level under a root, read-only, marking what is registered', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const seen: unknown[] = [];
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
      projectDiscovery: {
        createPlan: async (input) => {
          seen.push(input);
          const under = (name: string) => `${input.root}/${name}`;
          return {
            root: input.root,
            selected: [
              {
                directoryName: 'luwi',
                displayName: 'LUWI Runtime',
                localPath: under('luwi'),
                canonicalPath: under('luwi'),
                existingProjectId: 'project-1',
              },
              {
                directoryName: 'new-app',
                displayName: 'new-app',
                localPath: under('new-app'),
                canonicalPath: under('new-app'),
              },
            ],
            excluded: [],
            invalid: [
              {
                directoryName: 'link',
                displayName: 'link',
                localPath: under('link'),
                canonicalPath: '/elsewhere/link',
                reason: 'outside_root',
              },
            ],
          };
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/discover?root=C:/workspace',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      root: 'C:/workspace',
      candidates: [
        expect.objectContaining({ directoryName: 'luwi', existingProjectId: 'project-1' }),
        expect.objectContaining({ directoryName: 'new-app' }),
        expect.objectContaining({ directoryName: 'link', reason: 'outside_root' }),
      ],
      truncated: false,
    });
    // The runtime's discovery decides; the route only names the root and the registry.
    expect(seen[0]).toMatchObject({ root: 'C:/workspace', excludes: [], names: {} });
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/discover' })).statusCode).toBe(
      400,
    );
  });

  it('edits a project through PATCH and refuses a body that names the path or nothing at all', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const seen: unknown[] = [];
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...services({
          projectUpdate: async (projectId, body) => {
            seen.push([projectId, body]);
            return { ...project, name: 'Renamed' };
          },
        }),
        listEvents: async (): Promise<RealtimeEventMessage[]> => [],
      },
    });

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/project-1',
      payload: { name: 'Renamed', repositoryUrl: null },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ ...project, name: 'Renamed' });
    expect(seen).toEqual([['project-1', { name: 'Renamed', repositoryUrl: null }]]);

    // The path is identity: a body that names it is refused, not silently ignored.
    const pathChange = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/project-1',
      payload: { localPath: 'C:/elsewhere' },
    });
    expect(pathChange.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/project-1',
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(seen).toHaveLength(1);
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

  it('declares a native identity for exactly the session the path names', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const declareNative = vi.fn(
      async (): Promise<Awaited<ReturnType<SessionService['declareNative']>>> => ({
        outcome: 'created',
        binding: declaredBinding,
        link: declaredLink,
      }),
    );
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...services({ sessionDeclareNative: declareNative }),
        listEvents: async () => [],
      },
    });

    const declared = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/session-1/native',
      payload: {
        native: {
          adapterId: 'claude-code',
          nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
        },
      },
    });
    expect(declared.statusCode).toBe(200);
    expect(declared.json()).toEqual({
      outcome: 'created',
      binding: declaredBinding,
      link: declaredLink,
    });
    expect(declareNative).toHaveBeenCalledWith('session-1', {
      adapterId: 'claude-code',
      nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
    });
  });

  it('rejects a declaration that names a session in its body', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const declareNative = vi.fn(
      async (): Promise<Awaited<ReturnType<SessionService['declareNative']>>> => ({
        outcome: 'created',
        binding: declaredBinding,
        link: declaredLink,
      }),
    );
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...services({ sessionDeclareNative: declareNative }),
        listEvents: async () => [],
      },
    });

    // The body may carry the native reference and nothing else. A sessionId in
    // the body would be a declaration for someone else's session; the strict
    // schema refuses it before the service is ever consulted.
    const impersonating = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/session-1/native',
      payload: {
        native: {
          adapterId: 'claude-code',
          nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
        },
        sessionId: 'session-2',
      },
    });
    expect(impersonating.statusCode).toBe(400);
    expect(impersonating.json()).toMatchObject({ error: { code: 'REQUEST_VALIDATION_FAILED' } });
    expect(declareNative).not.toHaveBeenCalled();
  });

  it('maps a declaration refusal to its safe application error', async () => {
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
          sessionDeclareNative: async () => {
            throw new ApplicationError(
              'NATIVE_SESSION_CONFLICT',
              'Another live session already holds this native session reference.',
              409,
            );
          },
        }),
        listEvents: async () => [],
      },
    });

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/session-1/native',
      payload: {
        native: {
          adapterId: 'claude-code',
          nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
        },
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'NATIVE_SESSION_CONFLICT' } });
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

  it('serves a project knowledge graph, empty when there is no output, 404 for an unknown project', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      readKnowledgeGraph: async (localPath: string) =>
        localPath === project.canonicalPath
          ? {
              nodes: [{ id: 'a::b', sourceFile: 'src/a.ts', community: 0, communityName: 'a' }],
              links: [],
              builtAtCommit: 'c1',
              observedAt: '2026-09-15T00:00:00.000Z',
            }
          : null,
      services: {
        ...services(),
        listEvents: async () => [],
      },
    });

    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/knowledge-graph',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().summary.nodeCount).toBe(1);
    expect(ok.json().nodes[0].kind).toBe('god');

    const empty = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-2/knowledge-graph',
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().summary.nodeCount).toBe(0);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/does-not-exist/knowledge-graph',
    });
    expect(missing.statusCode).toBe(404);
  });
});
