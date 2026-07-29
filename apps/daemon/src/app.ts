import { randomUUID } from 'node:crypto';

import {
  eventListQuerySchema,
  eventListResponseSchema,
  heartbeatRequestSchema,
  type HealthResponse,
  projectCollectionResponseSchema,
  projectRegistrationRequestSchema,
  projectResponseSchema,
  type RuntimeEvent,
  type RuntimeInfoResponse,
  type RuntimeStateName,
  sessionCollectionResponseSchema,
  sessionRegistrationRequestSchema,
  sessionResponseSchema,
  sessionStatusRequestSchema,
} from '@luwi/protocol';
import { RedisRepositoryError, type RedisGateway } from '@luwi/redis';
import {
  ApplicationError,
  createRuntimeLifecycleEvent,
  createRuntimeState,
  getRuntimeUptimeMs,
  toPublicError,
  type RuntimeReadiness,
} from '@luwi/runtime';
import websocketPlugin from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';

import type { DaemonConfig } from './config.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';
import { type WebSocketHub, type WebSocketPeer, validateRealtimeUpgrade } from './websocket-hub.js';

export type DaemonApp = FastifyInstance;

export type BuildDaemonOptions = {
  config: DaemonConfig;
  redis: RedisGateway;
  logger?: boolean | { level: string };
  now?: () => Date;
  startedAt?: Date;
  runtimeInstanceId?: string;
  runtimeState?: () => RuntimeStateName;
  publishEvent?: (event: RuntimeEvent) => Promise<void> | void;
  readiness?: RuntimeReadiness;
  services?: {
    projects: ProjectService;
    sessions: SessionService;
    listEvents: (limit: number) => Promise<unknown[]>;
  };
  websocket?: {
    hub: WebSocketHub;
    maxPayloadBytes: number;
    expectedHosts: ReadonlySet<string>;
    allowedOrigins: ReadonlySet<string>;
  };
  closeRedisOnClose?: boolean;
  onRedisUnavailable?: (error: RedisRepositoryError) => void;
};

export function buildDaemon(options: BuildDaemonOptions): DaemonApp {
  const now = options.now ?? (() => new Date());
  const runtimeState = createRuntimeState({
    workspaceId: options.config.workspaceId,
    startedAt: options.startedAt ?? now(),
  });
  const runtimeInstanceId = options.runtimeInstanceId ?? randomUUID();
  const getRuntimeState = options.runtimeState ?? (() => 'ready' as const);
  const app = Fastify({
    logger: options.logger ?? { level: options.config.logLevel },
  });
  if (options.websocket !== undefined) {
    const websocket = options.websocket;
    void app.register(websocketPlugin, {
      options: {
        maxPayload: websocket.maxPayloadBytes,
      },
    });
  }
  const publishEvent =
    options.publishEvent ??
    ((event: RuntimeEvent) => {
      app.log.info(
        {
          eventType: event.type,
          eventId: event.id,
          workspaceId: event.workspaceId,
        },
        'Runtime lifecycle event',
      );
    });

  app.setErrorHandler((error, request, reply) => {
    app.log.error(
      {
        err: error,
        requestId: request.id,
      },
      'Request failed',
    );
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'The request did not match the protocol.',
        },
      });
    }
    if (error instanceof RedisRepositoryError && error.code === 'REDIS_UNAVAILABLE') {
      options.onRedisUnavailable?.(error);
      return reply.code(503).send({
        error: {
          code: 'RUNTIME_NOT_READY',
          message: 'The runtime is not ready because Redis is unavailable.',
        },
      });
    }
    const publicError = toPublicError(error);
    const existingProjectId = publicError.body.error.details?.existingProjectId;
    if (
      publicError.body.error.code === 'PROJECT_ALREADY_REGISTERED' &&
      typeof existingProjectId === 'string'
    ) {
      reply.header('Location', `/api/v1/projects/${existingProjectId}`);
    }
    return reply.code(publicError.statusCode).send(publicError.body);
  });

  const withMutation = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const slot = options.readiness?.tryAcquireMutation() ?? null;
    if (slot === null) {
      throw new ApplicationError(
        'RUNTIME_NOT_READY',
        'The runtime is not ready to accept mutations.',
        503,
      );
    }
    try {
      return await operation();
    } finally {
      slot.release();
    }
  };
  const withCurrentRead = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    if (getRuntimeState() !== 'ready') {
      throw new ApplicationError(
        'RUNTIME_NOT_READY',
        'The runtime is not ready to serve current Redis state.',
        503,
      );
    }
    return operation();
  };

  app.get('/health', async (_request, reply) => {
    const checkedAt = now();
    const redis = await options.redis.checkHealth();
    const currentRuntimeState = getRuntimeState();
    const response: HealthResponse =
      redis.connected && currentRuntimeState === 'ready'
        ? {
            status: 'ok',
            runtimeState: currentRuntimeState,
            version: runtimeState.version,
            uptimeMs: getRuntimeUptimeMs(runtimeState, checkedAt),
            redis,
            timestamp: checkedAt.toISOString(),
          }
        : {
            status: 'degraded',
            runtimeState: currentRuntimeState,
            version: runtimeState.version,
            uptimeMs: getRuntimeUptimeMs(runtimeState, checkedAt),
            redis,
            timestamp: checkedAt.toISOString(),
          };

    return reply
      .code(redis.connected && currentRuntimeState === 'ready' ? 200 : 503)
      .send(response);
  });

  app.get('/api/v1/runtime', async () => {
    const checkedAt = now();
    const redis = await options.redis.checkHealth();
    const response: RuntimeInfoResponse = {
      ...runtimeState,
      runtimeState: getRuntimeState(),
      runtimeInstanceId,
      uptimeMs: getRuntimeUptimeMs(runtimeState, checkedAt),
      host: options.config.host,
      port: options.config.port,
      redis,
      endpoints: {
        health: '/health',
        runtime: '/api/v1/runtime',
      },
    };

    return response;
  });

  if (options.services !== undefined) {
    const services = options.services;
    const projectParamsSchema = z.strictObject({ projectId: z.string().min(1).max(128) });
    const sessionParamsSchema = z.strictObject({ sessionId: z.string().min(1).max(128) });

    app.get('/api/v1/projects', async () =>
      projectCollectionResponseSchema.parse({
        projects: await withCurrentRead(() => services.projects.list()),
      }),
    );
    app.post('/api/v1/projects', async (request, reply) => {
      const body = projectRegistrationRequestSchema.parse(request.body);
      const project = await withMutation(() => services.projects.register(body));
      return reply
        .code(201)
        .header('Location', `/api/v1/projects/${project.id}`)
        .send(projectResponseSchema.parse(project));
    });
    app.get('/api/v1/projects/:projectId', async (request) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const project = await withCurrentRead(() => services.projects.get(projectId));
      if (project === null) {
        throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
      }
      return projectResponseSchema.parse(project);
    });

    app.get('/api/v1/sessions', async () =>
      sessionCollectionResponseSchema.parse({
        sessions: await withCurrentRead(() => services.sessions.list()),
      }),
    );
    app.post('/api/v1/sessions', async (request, reply) => {
      const body = sessionRegistrationRequestSchema.parse(request.body);
      const session = await withMutation(() => services.sessions.register(body));
      return reply
        .code(201)
        .header('Location', `/api/v1/sessions/${session.id}`)
        .send(sessionResponseSchema.parse(session));
    });
    app.get('/api/v1/sessions/:sessionId', async (request) => {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const session = await withCurrentRead(() => services.sessions.get(sessionId));
      if (session === null) {
        throw new ApplicationError('SESSION_NOT_FOUND', 'The session was not found.', 404);
      }
      return sessionResponseSchema.parse(session);
    });
    app.post('/api/v1/sessions/:sessionId/heartbeat', async (request) => {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = heartbeatRequestSchema.parse(request.body ?? {});
      return withMutation(() => services.sessions.heartbeat(sessionId, body));
    });
    app.post('/api/v1/sessions/:sessionId/status', async (request) => {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = sessionStatusRequestSchema.parse(request.body);
      return sessionResponseSchema.parse(
        await withMutation(() => services.sessions.updateStatus(sessionId, body.status)),
      );
    });
    app.post('/api/v1/sessions/:sessionId/close', async (request) => {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      return sessionResponseSchema.parse(
        await withMutation(() => services.sessions.close(sessionId)),
      );
    });
    app.get('/api/v1/projects/:projectId/sessions', async (request) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      if ((await withCurrentRead(() => services.projects.get(projectId))) === null) {
        throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
      }
      return sessionCollectionResponseSchema.parse({
        sessions: await withCurrentRead(() => services.sessions.list(projectId)),
      });
    });
    app.get('/api/v1/events', async (request) => {
      const { limit } = eventListQuerySchema.parse(request.query);
      return eventListResponseSchema.parse({
        events: await withCurrentRead(() => services.listEvents(limit)),
      });
    });
  }

  if (options.websocket !== undefined) {
    const websocket = options.websocket;
    void app.register(async (realtimeRoutes) => {
      realtimeRoutes.get(
        '/api/v1/realtime',
        {
          websocket: true,
          preValidation: async (request, reply) => {
            const origin = request.headers.origin;
            const allowed = validateRealtimeUpgrade({
              host: request.headers.host,
              ...(typeof origin === 'string' ? { origin } : {}),
              remoteAddress: (request.raw.socket as { remoteAddress?: string } | undefined)
                ?.remoteAddress,
              expectedHosts: websocket.expectedHosts,
              allowedOrigins: websocket.allowedOrigins,
            });
            if (!allowed) {
              await reply.code(403).send({
                error: {
                  code: 'REALTIME_ORIGIN_REJECTED',
                  message: 'The realtime connection origin was rejected.',
                },
              });
            }
          },
        },
        (socket) => {
          websocket.hub.add(socket as unknown as WebSocketPeer);
        },
      );
    });
  }

  app.addHook('onReady', async () => {
    await publishEvent(
      createRuntimeLifecycleEvent('started', {
        workspaceId: runtimeState.workspaceId,
      }),
    );
  });

  app.addHook('onClose', async () => {
    try {
      options.websocket?.hub.closeAll();
      await publishEvent(
        createRuntimeLifecycleEvent('stopping', {
          workspaceId: runtimeState.workspaceId,
        }),
      );
    } finally {
      if (options.closeRedisOnClose !== false) {
        await options.redis.close();
      }
    }
  });

  return app;
}
