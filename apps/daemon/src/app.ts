import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  agentDefinitionCollectionSchema,
  agentDefinitionCreateRequestSchema,
  agentDefinitionPatchRequestSchema,
  agentDefinitionSchema,
  agentDetectionRequestSchema,
  agentDetectionResponseSchema,
  capabilityAssignmentRequestSchema,
  capabilityBindingSchema,
  capabilityCollectionSchema,
  capabilityListQuerySchema,
  capabilityPackageCreateRequestSchema,
  capabilityPackagePatchRequestSchema,
  capabilityPackageSchema,
  capabilityProfileCollectionSchema,
  capabilityProfileCreateRequestSchema,
  capabilityProfilePatchRequestSchema,
  capabilityProfileSchema,
  capabilityScanResponseSchema,
  configDriftCollectionSchema,
  configOperationReceiptSchema,
  configPlanApplyRequestSchema,
  configPlanApprovalResponseSchema,
  configPlanCollectionSchema,
  configPlanCreateRequestSchema,
  configPlanSchema,
  configReconcileResponseSchema,
  configSnapshotCollectionSchema,
  configSnapshotSchema,
  contextFootprintSchema,
  contextSourceCollectionSchema,
  contextSourceListQuerySchema,
  contextContributionCollectionSchema,
  contextContributionObservationRequestSchema,
  contextContributionSchema,
  contextSummarySchema,
  controlPlaneAgentParamsSchema,
  controlPlaneCapabilityParamsSchema,
  controlPlaneEmptyRequestSchema,
  controlPlanePlanParamsSchema,
  controlPlaneProfileParamsSchema,
  controlPlaneProjectAgentParamsSchema,
  controlPlaneProjectBindingParamsSchema,
  controlPlaneProjectParamsSchema,
  controlPlaneSnapshotParamsSchema,
  effectiveAgentConfigurationSchema,
  eventListQuerySchema,
  eventListResponseSchema,
  heartbeatRequestSchema,
  inboxClaimRequestSchema,
  inboxClaimResponseSchema,
  knowledgeGraphResponseSchema,
  leaseAcquireRequestSchema,
  leaseAcquireResponseSchema,
  leaseCollectionSchema,
  leaseListQuerySchema,
  leaseReleaseRequestSchema,
  leaseRenewRequestSchema,
  lifecycleStopResponseSchema,
  workLeaseSchema,
  coordinatorClaimRequestSchema,
  coordinatorReleaseRequestSchema,
  coordinatorSchema,
  coordinatorViewSchema,
  messageCollectionResponseSchema,
  messageCreateRequestSchema,
  messageCreateResponseSchema,
  messageListQuerySchema,
  messageRespondRequestSchema,
  messageResponseSchema,
  messageTransitionRequestSchema,
  messageWaitQuerySchema,
  nativeConfigInspectRequestSchema,
  nativeConfigInspectionSchema,
  nativeDeclarationRequestSchema,
  nativeDeclarationResponseSchema,
  sessionNativeRefResponseSchema,
  type HealthResponse,
  projectCollectionResponseSchema,
  projectDiscoveryResponseSchema,
  projectRegistrationRequestSchema,
  projectUpdateRequestSchema,
  projectResponseSchema,
  projectAgentBindingCollectionSchema,
  projectAgentBindingCreateRequestSchema,
  projectAgentBindingPatchRequestSchema,
  projectAgentBindingSchema,
  type RuntimeEvent,
  type RuntimeInfoResponse,
  type RuntimeResourcesResponse,
  type RuntimeStateName,
  sessionCollectionResponseSchema,
  sessionRegistrationRequestSchema,
  sessionResponseSchema,
  sessionStatusRequestSchema,
  attributionCollectionSchema,
  gitObservationSchema,
  graphNeighborsQuerySchema,
  graphNeighborsResponseSchema,
  graphNodeKindSchema,
  graphNodeSchema,
  graphPathQuerySchema,
  graphPathResponseSchema,
  graphRebuildOperationSchema,
  graphSubgraphQuerySchema,
  graphSubgraphResponseSchema,
  graphSummarySchema,
  optimizationAcceptRequestSchema,
  optimizationAnalysisRequestSchema,
  optimizationAnalysisResponseSchema,
  optimizationCreatePlanRequestSchema,
  optimizationEvaluateRequestSchema,
  optimizationEvaluationSchema,
  optimizationFindingCollectionSchema,
  optimizationProposalCollectionSchema,
  optimizationProposalSchema,
  optimizationRejectRequestSchema,
  packageCollectionSchema,
  technologyCollectionSchema,
  usageCollectionSchema,
  usageIngestRequestSchema,
  usageListQuerySchema,
  usageRecordSchema,
  usageSummarySchema,
} from '@luwi/protocol';
import { RedisRepositoryError, type RedisGateway } from '@luwi/redis';
import {
  ApplicationError,
  createProjectDiscoveryService,
  createRuntimeLifecycleEvent,
  createRuntimeState,
  getRuntimeUptimeMs,
  toPublicError,
  type ProjectDiscoveryService,
  type RuntimeReadiness,
} from '@luwi/runtime';
import websocketPlugin from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import type { DaemonConfig } from './config.js';
import { defaultDashboardDistRoot, readDashboardAsset } from './dashboard-assets.js';
import type { ConfigControlService } from './config-control-service.js';
import type { ControlPlaneService } from './control-plane-service.js';
import {
  projectKnowledgeGraph,
  readGraphifyKnowledge,
  type KnowledgeDocument,
} from './graphify-knowledge.js';
import type { LeaseService } from './lease-service.js';
import type { CoordinatorService } from './coordinator-service.js';
import type { MessageService } from './message-service.js';
import type { IntelligenceService } from './intelligence-service.js';
import type { ProjectService } from './project-service.js';
import type { ProjectUnregisterService } from './project-unregister-service.js';
import type { SessionService } from './session-service.js';
import {
  type WebSocketHub,
  type WebSocketPeer,
  validateLocalHttpRequest,
  validateRealtimeUpgrade,
} from './websocket-hub.js';

export type DaemonApp = FastifyInstance;

export type BuildDaemonOptions = {
  config: DaemonConfig;
  redis: RedisGateway;
  /** `stream` lets a test read the lines the daemon would have logged. */
  logger?: boolean | { level: string; stream?: { write: (line: string) => void } };
  now?: () => Date;
  startedAt?: Date;
  runtimeInstanceId?: string;
  runtimeState?: () => RuntimeStateName;
  publishEvent?: (event: RuntimeEvent) => Promise<void> | void;
  readiness?: RuntimeReadiness;
  services?: {
    projects: ProjectService;
    sessions: SessionService;
    messages?: MessageService;
    leases?: LeaseService;
    coordinator?: CoordinatorService;
    /** Absent leaves the registry without a DELETE route (F3). */
    projectUnregister?: ProjectUnregisterService;
    controlPlane?: ControlPlaneService;
    configControl?: ConfigControlService;
    intelligence?: IntelligenceService;
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
  dashboardDistRoot?: string;
  /** What the machine has and what this runtime costs on it; no route without it. */
  resources?: () => Promise<RuntimeResourcesResponse>;
  /** Filesystem read of graphify's output; defaults to `readGraphifyKnowledge` so tests can stub it. */
  readKnowledgeGraph?: (localPath: string) => Promise<KnowledgeDocument | null>;
  /** One-level directory discovery for `GET /projects/discover`; defaults to the runtime's, so tests can stub it. */
  projectDiscovery?: ProjectDiscoveryService;
  lifecycle?: {
    token: string;
    requestStop: () => Promise<void>;
    schedule?: (action: () => void) => void;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function lifecycleTokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length > 128) return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

// The only source of REQUEST_VALIDATION_FAILED (ADR 0015): a ZodError anywhere else
// is an internal invariant violation and must surface as a server error.
function parseRequestInput<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const error = new ApplicationError(
    'REQUEST_VALIDATION_FAILED',
    'The request did not match the protocol.',
    400,
  );
  error.cause = result.error;
  throw error;
}

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

  const allowedOrigins = new Set(
    options.config.allowedOrigins ?? [
      `http://127.0.0.1:${options.config.port}`,
      `http://localhost:${options.config.port}`,
    ],
  );
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.upgrade?.toLowerCase() === 'websocket') {
      return;
    }
    const origin = request.headers.origin;
    const localPort = request.raw.socket.localPort;
    const expectedHosts =
      localPort === undefined
        ? new Set(['localhost:80'])
        : new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`]);
    const contentType = request.headers['content-type'];
    if (
      !validateLocalHttpRequest({
        host: request.headers.host,
        method: request.method,
        ...(typeof origin === 'string' ? { origin } : {}),
        ...(typeof contentType === 'string' ? { contentType } : {}),
        remoteAddress: request.raw.socket.remoteAddress,
        expectedHosts,
        allowedOrigins,
      })
    ) {
      return reply.code(403).send({
        error: {
          code: 'REQUEST_ORIGIN_REJECTED',
          message: 'The local request origin was rejected.',
        },
      });
    }
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

  const sendDashboardAsset = async (requestPath: string, reply: FastifyReply) => {
    const asset = await readDashboardAsset(
      options.dashboardDistRoot ?? defaultDashboardDistRoot,
      requestPath,
    );
    if (asset === null) {
      return reply.code(404).send({
        error: { code: 'DASHBOARD_ASSET_NOT_FOUND', message: 'The dashboard asset was not found.' },
      });
    }
    return reply
      .header('Cache-Control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-store')
      .type(asset.contentType)
      .send(asset.body);
  };

  app.get('/', async (_request, reply) => sendDashboardAsset('/', reply));
  app.get('/assets/:asset', async (request, reply) => {
    const { asset } = parseRequestInput(z.strictObject({ asset: z.string() }), request.params);
    return sendDashboardAsset(`/assets/${asset}`, reply);
  });

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

  const readResources = options.resources;
  if (readResources !== undefined) {
    app.get('/api/v1/runtime/resources', async () => readResources());
  }

  app.post('/api/v1/runtime/stop', async (request, reply) => {
    parseRequestInput(controlPlaneEmptyRequestSchema, request.body ?? {});
    const lifecycle = options.lifecycle;
    if (lifecycle === undefined) {
      throw new ApplicationError(
        'DAEMON_LIFECYCLE_UNMANAGED',
        'This daemon was not started by the LUWI lifecycle CLI.',
        403,
      );
    }
    if (!lifecycleTokenMatches(request.headers['x-luwi-lifecycle-token'], lifecycle.token)) {
      throw new ApplicationError(
        'DAEMON_LIFECYCLE_FORBIDDEN',
        'The daemon lifecycle ownership proof was rejected.',
        403,
      );
    }
    const requestStop = (): void => {
      void lifecycle.requestStop().catch((error: unknown) => {
        app.log.error({ err: error }, 'Lifecycle shutdown failed');
      });
    };
    if (lifecycle.schedule === undefined) {
      const timer = setTimeout(requestStop, 0);
      timer.unref();
    } else {
      lifecycle.schedule(requestStop);
    }
    return reply.code(202).send(lifecycleStopResponseSchema.parse({ status: 'stopping' }));
  });

  if (options.services !== undefined) {
    const services = options.services;
    const projectParamsSchema = z.strictObject({ projectId: z.string().min(1).max(128) });
    const sessionParamsSchema = z.strictObject({ sessionId: z.string().min(1).max(128) });
    const leaseParamsSchema = z.strictObject({ leaseId: z.string().min(1).max(128) });
    const messageParamsSchema = z.strictObject({
      correlationId: z.string().trim().min(1).max(128),
    });

    app.get('/api/v1/projects', async () =>
      projectCollectionResponseSchema.parse({
        projects: await withCurrentRead(() => services.projects.list()),
      }),
    );
    app.post('/api/v1/projects', async (request, reply) => {
      const body = parseRequestInput(projectRegistrationRequestSchema, request.body);
      const project = await withMutation(() => services.projects.register(body));
      return reply
        .code(201)
        .header('Location', `/api/v1/projects/${project.id}`)
        .send(projectResponseSchema.parse(project));
    });
    // One directory level under a root the loopback caller names, read-only —
    // the dashboard's "Scan a folder" and the CLI's `project discover` share
    // the runtime's discovery. Registration stays `POST /projects`, one per
    // candidate, so nothing here writes.
    const MAX_DISCOVERY_CANDIDATES = 500;
    const discoveryQuerySchema = z.strictObject({ root: z.string().trim().min(1).max(4096) });
    const projectDiscovery = options.projectDiscovery ?? createProjectDiscoveryService();
    app.get('/api/v1/projects/discover', async (request) => {
      const { root } = parseRequestInput(discoveryQuerySchema, request.query);
      const plan = await withCurrentRead(async () =>
        projectDiscovery.createPlan({
          root,
          excludes: [],
          names: {},
          existingProjects: await services.projects.list(),
        }),
      );
      const candidates = [...plan.selected, ...plan.invalid];
      return projectDiscoveryResponseSchema.parse({
        root: plan.root,
        candidates: candidates.slice(0, MAX_DISCOVERY_CANDIDATES),
        truncated: candidates.length > MAX_DISCOVERY_CANDIDATES,
      });
    });
    app.get('/api/v1/projects/:projectId', async (request) => {
      const { projectId } = parseRequestInput(projectParamsSchema, request.params);
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
      const body = parseRequestInput(sessionRegistrationRequestSchema, request.body);
      const session = await withMutation(() => services.sessions.register(body));
      return reply
        .code(201)
        .header('Location', `/api/v1/sessions/${session.id}`)
        .send(sessionResponseSchema.parse(session));
    });
    app.get('/api/v1/sessions/:sessionId', async (request) => {
      const { sessionId } = parseRequestInput(sessionParamsSchema, request.params);
      const session = await withCurrentRead(() => services.sessions.get(sessionId));
      if (session === null) {
        throw new ApplicationError('SESSION_NOT_FOUND', 'The session was not found.', 404);
      }
      return sessionResponseSchema.parse(session);
    });
    /**
     * B0 (ADR 0023): an already-registered, live session declares its native
     * identity. The body carries the same `native` block registration takes
     * and, by strict schema, nothing else — the declaration applies to the
     * session the path names and a body cannot redirect it.
     */
    app.post('/api/v1/sessions/:sessionId/native', async (request) => {
      const { sessionId } = parseRequestInput(sessionParamsSchema, request.params);
      const body = parseRequestInput(nativeDeclarationRequestSchema, request.body);
      return nativeDeclarationResponseSchema.parse(
        await withMutation(() => services.sessions.declareNative(sessionId, body.native)),
      );
    });
    // The native reference a session's binding holds, so a reader reviving a
    // dropped session can re-declare it from the daemon's truth even when the
    // session file never carried it (ADR 0034 revival native recovery).
    app.get('/api/v1/sessions/:sessionId/native', async (request) => {
      const { sessionId } = parseRequestInput(sessionParamsSchema, request.params);
      return sessionNativeRefResponseSchema.parse({
        native: await services.sessions.getNativeRef(sessionId),
      });
    });
    // Every live session heartbeats every few seconds and every bridge long-polls
    // its inbox; at info Fastify wrote two lines per request and the daemon log
    // grew by hundreds of megabytes a day. These two routes log at warn — a
    // failure still surfaces, a healthy poll does not.
    app.post('/api/v1/sessions/:sessionId/heartbeat', { logLevel: 'warn' }, async (request) => {
      const { sessionId } = parseRequestInput(sessionParamsSchema, request.params);
      const body = parseRequestInput(heartbeatRequestSchema, request.body ?? {});
      return withMutation(() => services.sessions.heartbeat(sessionId, body));
    });
    app.post('/api/v1/sessions/:sessionId/status', async (request) => {
      const { sessionId } = parseRequestInput(sessionParamsSchema, request.params);
      const body = parseRequestInput(sessionStatusRequestSchema, request.body);
      return sessionResponseSchema.parse(
        await withMutation(() => services.sessions.updateStatus(sessionId, body.status)),
      );
    });
    app.post('/api/v1/sessions/:sessionId/close', async (request) => {
      const { sessionId } = parseRequestInput(sessionParamsSchema, request.params);
      return sessionResponseSchema.parse(
        await withMutation(() => services.sessions.close(sessionId)),
      );
    });
    app.patch('/api/v1/projects/:projectId', async (request) => {
      const { projectId } = parseRequestInput(projectParamsSchema, request.params);
      const body = parseRequestInput(projectUpdateRequestSchema, request.body);
      const project = await withMutation(() => services.projects.update(projectId, body));
      return projectResponseSchema.parse(project);
    });
    // Unregister only (F3): the registry and the evidence LUWI collected go; the
    // project's files and its .luwi directory stay. Refused, with what blocks
    // it named, while anything live still points at the project.
    const projectUnregister = services.projectUnregister;
    if (projectUnregister !== undefined) {
      app.delete('/api/v1/projects/:projectId', async (request, reply) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        await withMutation(() => projectUnregister.remove(projectId));
        return reply.code(204).send();
      });
    }
    app.get('/api/v1/projects/:projectId/sessions', async (request) => {
      const { projectId } = parseRequestInput(projectParamsSchema, request.params);
      if ((await withCurrentRead(() => services.projects.get(projectId))) === null) {
        throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
      }
      return sessionCollectionResponseSchema.parse({
        sessions: await withCurrentRead(() => services.sessions.list(projectId)),
      });
    });
    // Read-only per-project graphify knowledge graph (docs/superpowers/plans/2026-09-15-per-project-
    // graphify-knowledge-graph.md). Needs only the project's canonicalPath, not the intelligence
    // service, so it lives here beside the other /api/v1/projects/:projectId/* reads rather than
    // inside the intelligence block.
    app.get('/api/v1/projects/:projectId/knowledge-graph', async (request) => {
      const { projectId } = parseRequestInput(projectParamsSchema, request.params);
      return withCurrentRead(async () => {
        const project = await services.projects.get(projectId);
        if (project === null) {
          throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
        }
        const read =
          options.readKnowledgeGraph ??
          ((localPath: string) => readGraphifyKnowledge({ localPath }));
        const document = await read(project.canonicalPath);
        return knowledgeGraphResponseSchema.parse(projectKnowledgeGraph(document));
      });
    });
    app.get('/api/v1/events', async (request) => {
      const { limit } = parseRequestInput(eventListQuerySchema, request.query);
      return eventListResponseSchema.parse({
        events: await withCurrentRead(() => services.listEvents(limit)),
      });
    });

    if (services.intelligence !== undefined) {
      const intelligence = services.intelligence;
      const intelligenceIdentifier = z
        .string()
        .trim()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
      const graphNodeParamsSchema = z.strictObject({
        nodeKind: graphNodeKindSchema,
        nodeId: intelligenceIdentifier,
      });
      const graphPathHttpQuerySchema = graphPathQuerySchema.extend({
        fromKind: graphNodeKindSchema,
        fromId: intelligenceIdentifier,
      });
      const contextQuerySchema = z.strictObject({
        projectId: intelligenceIdentifier,
        agentId: intelligenceIdentifier,
      });
      const contextContributionQuerySchema = z.strictObject({
        projectId: intelligenceIdentifier.optional(),
        agentId: intelligenceIdentifier.optional(),
        sessionId: intelligenceIdentifier.optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
      });
      const boundedProjectQuerySchema = z.strictObject({
        limit: z.coerce.number().int().min(1).max(1000).default(100),
      });
      const optimizationListQuerySchema = z.strictObject({
        projectId: intelligenceIdentifier.optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
      });
      const optimizationParamsSchema = z.strictObject({
        proposalId: intelligenceIdentifier,
      });
      const evaluationParamsSchema = z.strictObject({
        evaluationId: intelligenceIdentifier,
      });
      const usageIdempotencyKeySchema = z.string().trim().min(1).max(256);
      const rebuildParamsSchema = z.strictObject({
        operationId: intelligenceIdentifier,
      });

      app.post('/api/v1/usage', async (request, reply) => {
        const body = parseRequestInput(usageIngestRequestSchema, request.body);
        const idempotencyKey =
          request.headers['idempotency-key'] === undefined
            ? undefined
            : parseRequestInput(usageIdempotencyKeySchema, request.headers['idempotency-key']);
        const record = await withMutation(() =>
          intelligence.ingestUsage({
            ...body,
            ...(body.sourceEventId !== undefined || idempotencyKey === undefined
              ? {}
              : { sourceEventId: idempotencyKey }),
          }),
        );
        return reply
          .code(201)
          .header('Location', `/api/v1/usage/${record.id}`)
          .send(usageRecordSchema.parse(record));
      });
      app.get('/api/v1/usage', async (request) => {
        const query = parseRequestInput(usageListQuerySchema, request.query);
        const usage = await withCurrentRead(() =>
          intelligence.listUsage({ ...query, limit: query.limit + 1 }),
        );
        return usageCollectionSchema.parse({
          records: usage.records.slice(0, query.limit),
          truncated: usage.truncated || usage.records.length > query.limit,
          ...(usage.earliestAvailableAt === undefined
            ? {}
            : { earliestAvailableAt: usage.earliestAvailableAt }),
        });
      });
      app.get('/api/v1/usage/summary', async (request) => {
        const query = parseRequestInput(usageListQuerySchema, request.query);
        return usageSummarySchema.parse(
          await withCurrentRead(() => intelligence.summarizeUsage(query)),
        );
      });

      app.get('/api/v1/context/contributions', async (request) => {
        const query = parseRequestInput(contextContributionQuerySchema, request.query);
        const contributions = await withCurrentRead(() =>
          intelligence.listContextContributions({
            ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
            limit: query.limit + 1,
          }),
        );
        return contextContributionCollectionSchema.parse({
          contributions: contributions.slice(0, query.limit),
          truncated: contributions.length > query.limit,
        });
      });
      app.post('/api/v1/context/contributions', async (request, reply) => {
        const body = parseRequestInput(contextContributionObservationRequestSchema, request.body);
        const contribution = await withMutation(() =>
          intelligence.observeContextContribution(body),
        );
        return reply.code(201).send(contextContributionSchema.parse(contribution));
      });
      app.get('/api/v1/context/summary', async (request) => {
        const query = parseRequestInput(contextQuerySchema, request.query);
        return contextSummarySchema.parse(
          await withCurrentRead(() => intelligence.contextSummary(query.projectId, query.agentId)),
        );
      });
      app.post('/api/v1/context/analyze', async (request) => {
        const body = parseRequestInput(contextQuerySchema, request.body);
        return withMutation(() => intelligence.analyzeContext(body.projectId, body.agentId));
      });
      app.get(
        '/api/v1/projects/:projectId/agents/:agentId/context-intelligence',
        async (request) => {
          const { projectId, agentId } = parseRequestInput(
            controlPlaneProjectAgentParamsSchema,
            request.params,
          );
          return withCurrentRead(() => intelligence.getContextIntelligence(projectId, agentId));
        },
      );

      app.post('/api/v1/projects/:projectId/git/scan', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        return gitObservationSchema.parse(
          await withMutation(() => intelligence.scanGit(projectId)),
        );
      });
      app.get('/api/v1/projects/:projectId/git', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        return gitObservationSchema.parse(
          await withCurrentRead(() => intelligence.getGit(projectId)),
        );
      });
      app.get('/api/v1/projects/:projectId/git/commits', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        const { limit } = parseRequestInput(boundedProjectQuerySchema, request.query);
        const commits = await withCurrentRead(() =>
          intelligence.listGitCommits(projectId, limit + 1),
        );
        return {
          commits: commits.slice(0, limit),
          truncated: commits.length > limit,
        };
      });
      app.get('/api/v1/projects/:projectId/git/worktrees', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        return {
          worktrees: await withCurrentRead(() => intelligence.listGitWorktrees(projectId)),
        };
      });
      app.get('/api/v1/projects/:projectId/git/attributions', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        const { limit } = parseRequestInput(boundedProjectQuerySchema, request.query);
        const attributions = await withCurrentRead(() =>
          intelligence.listAttributions(projectId, limit + 1),
        );
        return attributionCollectionSchema.parse({
          attributions: attributions.slice(0, limit),
          truncated: attributions.length > limit,
        });
      });

      app.post('/api/v1/projects/:projectId/packages/scan', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        return withMutation(() => intelligence.scanPackages(projectId));
      });
      app.get('/api/v1/projects/:projectId/packages', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        const { limit } = parseRequestInput(boundedProjectQuerySchema, request.query);
        const packages = await withCurrentRead(() =>
          intelligence.listPackages(projectId, limit + 1),
        );
        return packageCollectionSchema.parse({
          packages: packages.slice(0, limit),
          truncated: packages.length > limit,
        });
      });
      app.get('/api/v1/projects/:projectId/technologies', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        const { limit } = parseRequestInput(boundedProjectQuerySchema, request.query);
        const technologies = await withCurrentRead(() =>
          intelligence.listTechnologies(projectId, limit + 1),
        );
        return technologyCollectionSchema.parse({
          technologies: technologies.slice(0, limit),
          truncated: technologies.length > limit,
        });
      });

      /**
       * The bounded global answer from ADR 0013. Set cardinality on the active
       * generation only: no traversal, no scan, and no rebuild.
       */
      app.get('/api/v1/graph/summary', async () => {
        return graphSummarySchema.parse(await withCurrentRead(() => intelligence.graphSummary()));
      });
      app.get('/api/v1/graph/path', async (request) => {
        const query = parseRequestInput(graphPathHttpQuerySchema, request.query);
        const { fromKind, fromId, ...pathQuery } = query;
        return graphPathResponseSchema.parse(
          await withCurrentRead(() => intelligence.graphPath(fromKind, fromId, pathQuery)),
        );
      });
      app.get('/api/v1/graph/subgraph', async (request) => {
        const query = parseRequestInput(graphSubgraphQuerySchema, request.query);
        return graphSubgraphResponseSchema.parse(
          await withCurrentRead(() => intelligence.graphSubgraph(query)),
        );
      });
      app.get('/api/v1/graph/nodes/:nodeKind/:nodeId', async (request) => {
        const { nodeKind, nodeId } = parseRequestInput(graphNodeParamsSchema, request.params);
        return graphNodeSchema.parse(
          await withCurrentRead(() => intelligence.getGraphNode(nodeKind, nodeId)),
        );
      });
      for (const direction of ['out', 'in'] as const) {
        app.get(`/api/v1/graph/nodes/:nodeKind/:nodeId/${direction}`, async (request) => {
          const { nodeKind, nodeId } = parseRequestInput(graphNodeParamsSchema, request.params);
          const query = parseRequestInput(graphNeighborsQuerySchema, request.query);
          return graphNeighborsResponseSchema.parse(
            await withCurrentRead(() =>
              intelligence.graphNeighbors(nodeKind, nodeId, direction, query),
            ),
          );
        });
      }
      app.post('/api/v1/graph/rebuild', async (_request, reply) => {
        const operation = await withMutation(() => intelligence.rebuildGraph());
        return reply
          .code(202)
          .header('Location', `/api/v1/graph/rebuild/${operation.id}`)
          .send(graphRebuildOperationSchema.parse(operation));
      });
      app.get('/api/v1/graph/rebuild/:operationId', async (request) => {
        const { operationId } = parseRequestInput(rebuildParamsSchema, request.params);
        return graphRebuildOperationSchema.parse(
          await withCurrentRead(() => intelligence.getGraphRebuild(operationId)),
        );
      });

      app.post('/api/v1/optimization/analyze', async (request) => {
        const body = parseRequestInput(optimizationAnalysisRequestSchema, request.body);
        return optimizationAnalysisResponseSchema.parse(
          await withMutation(() => intelligence.analyzeOptimization(body)),
        );
      });
      app.get('/api/v1/optimization/findings', async (request) => {
        const query = parseRequestInput(optimizationListQuerySchema, request.query);
        const findings = await withCurrentRead(() =>
          intelligence.listFindings(query.projectId, query.limit + 1),
        );
        return optimizationFindingCollectionSchema.parse({
          findings: findings.slice(0, query.limit),
          truncated: findings.length > query.limit,
        });
      });
      app.get('/api/v1/optimization/proposals', async (request) => {
        const query = parseRequestInput(optimizationListQuerySchema, request.query);
        const proposals = await withCurrentRead(() =>
          intelligence.listProposals(query.projectId, query.limit + 1),
        );
        return optimizationProposalCollectionSchema.parse({
          proposals: proposals.slice(0, query.limit),
          truncated: proposals.length > query.limit,
        });
      });
      app.get('/api/v1/optimization/proposals/:proposalId', async (request) => {
        const { proposalId } = parseRequestInput(optimizationParamsSchema, request.params);
        return optimizationProposalSchema.parse(
          await withCurrentRead(() => intelligence.getProposal(proposalId)),
        );
      });
      app.post('/api/v1/optimization/proposals/:proposalId/accept', async (request) => {
        const { proposalId } = parseRequestInput(optimizationParamsSchema, request.params);
        parseRequestInput(optimizationAcceptRequestSchema, request.body);
        return optimizationProposalSchema.parse(
          await withMutation(() => intelligence.acceptProposal(proposalId)),
        );
      });
      app.post('/api/v1/optimization/proposals/:proposalId/reject', async (request) => {
        const { proposalId } = parseRequestInput(optimizationParamsSchema, request.params);
        parseRequestInput(optimizationRejectRequestSchema, request.body ?? {});
        return optimizationProposalSchema.parse(
          await withMutation(() => intelligence.rejectProposal(proposalId)),
        );
      });
      app.post(
        '/api/v1/optimization/proposals/:proposalId/create-config-plan',
        async (request, reply) => {
          const { proposalId } = parseRequestInput(optimizationParamsSchema, request.params);
          const { actionIndex } = parseRequestInput(
            optimizationCreatePlanRequestSchema,
            request.body ?? {},
          );
          const result = await withMutation(() =>
            intelligence.createConfigPlan(proposalId, actionIndex),
          );
          return reply
            .code(201)
            .header('Location', `/api/v1/config/plans/${result.plan.id}`)
            .send(result);
        },
      );
      app.post('/api/v1/optimization/proposals/:proposalId/evaluate', async (request) => {
        const { proposalId } = parseRequestInput(optimizationParamsSchema, request.params);
        const body = parseRequestInput(optimizationEvaluateRequestSchema, request.body ?? {});
        return optimizationEvaluationSchema.parse(
          await withMutation(() =>
            intelligence.evaluateProposal(proposalId, {
              ...(body.minimumPostSessions === undefined
                ? {}
                : { minimumPostSessions: body.minimumPostSessions }),
              ...(body.minimumObservationHours === undefined
                ? {}
                : { minimumObservationHours: body.minimumObservationHours }),
            }),
          ),
        );
      });
      app.get('/api/v1/optimization/evaluations/:evaluationId', async (request) => {
        const { evaluationId } = parseRequestInput(evaluationParamsSchema, request.params);
        return optimizationEvaluationSchema.parse(
          await withCurrentRead(() => intelligence.getEvaluation(evaluationId)),
        );
      });
    }

    if (services.messages !== undefined) {
      const messages = services.messages;
      app.post('/api/v1/messages', async (request, reply) => {
        const rawBody = isRecord(request.body) ? request.body : {};
        if (
          (typeof rawBody.content === 'string' &&
            utf8Bytes(rawBody.content) > (options.config.messageMaxContentBytes ?? 32_768)) ||
          (typeof rawBody.subject === 'string' &&
            utf8Bytes(rawBody.subject) > (options.config.messageMaxSubjectBytes ?? 512)) ||
          (Array.isArray(rawBody.evidenceRequirements) &&
            rawBody.evidenceRequirements.length > (options.config.messageMaxEvidenceItems ?? 32))
        ) {
          throw new ApplicationError(
            'MESSAGE_CONTENT_TOO_LARGE',
            'The message content, subject, or evidence requirements exceed configured limits.',
            413,
          );
        }
        const timeoutMs =
          rawBody.timeoutMs === undefined
            ? (options.config.messageDefaultTimeoutMs ?? 120_000)
            : rawBody.timeoutMs;
        if (
          typeof timeoutMs === 'number' &&
          (timeoutMs < 1 || timeoutMs > (options.config.messageMaxTimeoutMs ?? 86_400_000))
        ) {
          throw new ApplicationError(
            'MESSAGE_TIMEOUT_INVALID',
            'The message timeout is outside the configured range.',
            400,
          );
        }
        const body = messageCreateRequestSchema.parse({ ...rawBody, timeoutMs });
        const idempotencyHeader = request.headers['idempotency-key'];
        if (idempotencyHeader !== undefined && typeof idempotencyHeader !== 'string') {
          throw new ApplicationError(
            'IDEMPOTENCY_KEY_INVALID',
            'Idempotency-Key must be a single header value.',
            400,
          );
        }
        const result = await withMutation(() => messages.ask(body, idempotencyHeader));
        return reply
          .code(result.idempotent ? 200 : 202)
          .header('Location', `/api/v1/messages/${result.message.correlationId}`)
          .send(messageCreateResponseSchema.parse(result));
      });
      app.get('/api/v1/messages', async (request) => {
        const query = parseRequestInput(messageListQuerySchema, request.query);
        return messageCollectionResponseSchema.parse(
          await withCurrentRead(() => messages.list(query)),
        );
      });
      app.get('/api/v1/messages/:correlationId', async (request) => {
        const { correlationId } = parseRequestInput(messageParamsSchema, request.params);
        return messageResponseSchema.parse(
          await withCurrentRead(() => messages.get(correlationId)),
        );
      });
      app.get('/api/v1/messages/:correlationId/wait', async (request) => {
        const { correlationId } = parseRequestInput(messageParamsSchema, request.params);
        const { waitMs } = parseRequestInput(messageWaitQuerySchema, request.query);
        return messageResponseSchema.parse(
          await withCurrentRead(() => messages.wait(correlationId, waitMs)),
        );
      });
      app.post('/api/v1/messages/:correlationId/acknowledge', async (request) => {
        const { correlationId } = parseRequestInput(messageParamsSchema, request.params);
        const body = parseRequestInput(messageTransitionRequestSchema, request.body);
        return messageResponseSchema.parse(
          await withMutation(() => messages.acknowledge(correlationId, body)),
        );
      });
      app.post('/api/v1/messages/:correlationId/processing', async (request) => {
        const { correlationId } = parseRequestInput(messageParamsSchema, request.params);
        const body = parseRequestInput(messageTransitionRequestSchema, request.body);
        return messageResponseSchema.parse(
          await withMutation(() => messages.processing(correlationId, body)),
        );
      });
      for (const action of ['respond', 'reject', 'fail'] as const) {
        app.post(`/api/v1/messages/:correlationId/${action}`, async (request) => {
          const { correlationId } = parseRequestInput(messageParamsSchema, request.params);
          const rawBody = isRecord(request.body) ? request.body : {};
          const rawResponseJson =
            rawBody.response === undefined ? undefined : JSON.stringify(rawBody.response);
          if (
            rawResponseJson !== undefined &&
            utf8Bytes(rawResponseJson) > (options.config.messageMaxResponseBytes ?? 65_536)
          ) {
            throw new ApplicationError(
              'MESSAGE_RESPONSE_TOO_LARGE',
              'The message response exceeds the configured size limit.',
              413,
            );
          }
          const body = parseRequestInput(messageRespondRequestSchema, request.body);
          if (body.response.evidence.length > (options.config.messageMaxEvidenceItems ?? 32)) {
            throw new ApplicationError(
              'MESSAGE_RESPONSE_TOO_LARGE',
              'The message response exceeds the configured evidence limit.',
              413,
            );
          }
          const validStatus =
            action === 'respond'
              ? body.response.status === 'answered' || body.response.status === 'partially_answered'
              : body.response.status === (action === 'reject' ? 'rejected' : 'failed');
          if (!validStatus) {
            throw new ApplicationError(
              'MESSAGE_TRANSITION_INVALID',
              'The response status does not match the requested terminal transition.',
              409,
            );
          }
          return messageResponseSchema.parse(
            await withMutation(() =>
              messages[action](correlationId, body.responderSessionId, body.response),
            ),
          );
        });
      }
      app.post('/api/v1/sessions/:sessionId/inbox/claim', { logLevel: 'warn' }, async (request) => {
        const { sessionId } = parseRequestInput(sessionParamsSchema, request.params);
        const rawBody = isRecord(request.body) ? request.body : {};
        const body = inboxClaimRequestSchema.parse({
          ...rawBody,
          limit: rawBody.limit ?? options.config.inboxClaimLimit ?? 10,
          blockMs: rawBody.blockMs ?? options.config.inboxBlockMs ?? 5_000,
          minIdleMs: rawBody.minIdleMs ?? options.config.inboxMinIdleMs ?? 15_000,
        });
        if (body.limit > (options.config.inboxMaxClaimLimit ?? 100)) {
          throw new ApplicationError(
            'INBOX_CONSUMER_INVALID',
            'The inbox claim limit exceeds the configured maximum.',
            400,
          );
        }
        return inboxClaimResponseSchema.parse(
          await withMutation(() => messages.claimInbox(sessionId, body)),
        );
      });
    }

    if (services.leases !== undefined) {
      const leases = services.leases;

      /**
       * A denial is a 200, not a 409.
       *
       * The runtime answered the question it was asked — who holds this path —
       * and the answer is a body the caller reads, not a fault. Returning an
       * error status would make a working collision check look like a broken
       * request to every generic HTTP client between here and the agent.
       */
      app.post('/api/v1/leases', async (request, reply) => {
        const body = parseRequestInput(leaseAcquireRequestSchema, request.body);
        const result = await withMutation(() => leases.acquire(body));
        if (result.status === 'denied') {
          return reply.code(200).send(leaseAcquireResponseSchema.parse(result));
        }
        return reply
          .code(201)
          .header('Location', `/api/v1/leases/${result.lease.id}`)
          .send(leaseAcquireResponseSchema.parse(result));
      });

      app.post('/api/v1/leases/:leaseId/renew', async (request) => {
        const { leaseId } = parseRequestInput(leaseParamsSchema, request.params);
        const body = parseRequestInput(leaseRenewRequestSchema, request.body);
        return workLeaseSchema.parse(
          await withMutation(() => leases.renew(leaseId, body.sessionId, body.durationMs)),
        );
      });

      app.post('/api/v1/leases/:leaseId/release', async (request) => {
        const { leaseId } = parseRequestInput(leaseParamsSchema, request.params);
        const body = parseRequestInput(leaseReleaseRequestSchema, request.body);
        return workLeaseSchema.parse(
          await withMutation(() => leases.release(leaseId, body.sessionId)),
        );
      });

      app.get('/api/v1/leases', async (request) => {
        const query = parseRequestInput(leaseListQuerySchema, request.query);
        const found = await withCurrentRead(() =>
          leases.list({
            ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
            ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
            limit: query.limit + 1,
          }),
        );
        return leaseCollectionSchema.parse({
          leases: found.slice(0, query.limit),
          truncated: found.length > query.limit,
        });
      });

      app.get('/api/v1/leases/:leaseId', async (request) => {
        const { leaseId } = parseRequestInput(leaseParamsSchema, request.params);
        return workLeaseSchema.parse(await withCurrentRead(() => leases.get(leaseId)));
      });
    }

    if (services.coordinator !== undefined) {
      const coordinator = services.coordinator;

      /**
       * The per-project coordinator role (ADR 0035). Claim is single-holder: a
       * live holder refuses with 409 COORDINATOR_CONFLICT naming it, a terminal
       * holder is taken over, and the same session re-claiming is idempotent.
       */
      app.post('/api/v1/projects/:projectId/coordinator', async (request, reply) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        const body = parseRequestInput(coordinatorClaimRequestSchema, request.body);
        const claimed = await withMutation(() =>
          coordinator.claim({ projectId, sessionId: body.sessionId }),
        );
        return reply
          .code(201)
          .header('Location', `/api/v1/projects/${projectId}/coordinator`)
          .send(coordinatorSchema.parse(claimed));
      });

      // Holder-only: the body names the session so a coordinator another session
      // can evict is not a single holder.
      app.delete('/api/v1/projects/:projectId/coordinator', async (request, reply) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        const body = parseRequestInput(coordinatorReleaseRequestSchema, request.body);
        await withMutation(() => coordinator.release({ projectId, sessionId: body.sessionId }));
        return reply.code(204).send();
      });

      app.get('/api/v1/projects/:projectId/coordinator', async (request) => {
        const { projectId } = parseRequestInput(projectParamsSchema, request.params);
        return coordinatorViewSchema.parse(await withCurrentRead(() => coordinator.get(projectId)));
      });
    }

    if (services.controlPlane !== undefined) {
      const control = services.controlPlane;

      /*
       * A definition's `detectedVersion` was never written by anything, so the
       * column it fed always read "Undetected". The list now carries the version
       * of the detected installation for the definition's adapter — from a
       * cached detection, since detecting spawns the vendors' executables — and
       * a detection that fails leaves every version absent rather than the list.
       */
      app.get('/api/v1/agents', async () => {
        const [agents, installations] = await withCurrentRead(() =>
          Promise.all([control.listAgents(), control.detectAgentsCached().catch(() => [])]),
        );
        const versions = new Map(
          installations.flatMap((installation) =>
            installation.detectedVersion === undefined
              ? []
              : [[installation.adapterId, installation.detectedVersion] as const],
          ),
        );
        return agentDefinitionCollectionSchema.parse({
          agents: agents.map((agent) => {
            const detectedVersion = agent.detectedVersion ?? versions.get(agent.adapterId);
            return detectedVersion === undefined ? agent : { ...agent, detectedVersion };
          }),
        });
      });
      app.post('/api/v1/agents', async (request, reply) => {
        const body = parseRequestInput(agentDefinitionCreateRequestSchema, request.body);
        const agent = await withMutation(() => control.createAgent(body));
        return reply
          .code(201)
          .header('Location', `/api/v1/agents/${agent.id}`)
          .send(agentDefinitionSchema.parse(agent));
      });
      app.post('/api/v1/agents/detect', async (request) => {
        const body = parseRequestInput(agentDetectionRequestSchema, request.body ?? {});
        return agentDetectionResponseSchema.parse({
          installations: await withCurrentRead(() => control.detectAgents(body.projectId)),
        });
      });
      app.get('/api/v1/agents/:agentId', async (request) => {
        const { agentId } = parseRequestInput(controlPlaneAgentParamsSchema, request.params);
        return agentDefinitionSchema.parse(await withCurrentRead(() => control.getAgent(agentId)));
      });
      app.patch('/api/v1/agents/:agentId', async (request) => {
        const { agentId } = parseRequestInput(controlPlaneAgentParamsSchema, request.params);
        const body = parseRequestInput(agentDefinitionPatchRequestSchema, request.body);
        return agentDefinitionSchema.parse(
          await withMutation(() => control.updateAgent(agentId, body)),
        );
      });

      app.get('/api/v1/projects/:projectId/agents', async (request) => {
        const { projectId } = parseRequestInput(controlPlaneProjectParamsSchema, request.params);
        return projectAgentBindingCollectionSchema.parse({
          bindings: await withCurrentRead(() => control.listProjectAgentBindings(projectId)),
        });
      });
      app.post('/api/v1/projects/:projectId/agents', async (request, reply) => {
        const { projectId } = parseRequestInput(controlPlaneProjectParamsSchema, request.params);
        const body = parseRequestInput(projectAgentBindingCreateRequestSchema, request.body);
        const binding = await withMutation(() => control.bindProjectAgent(projectId, body));
        return reply
          .code(201)
          .header('Location', `/api/v1/projects/${projectId}/agents/${binding.id}`)
          .send(projectAgentBindingSchema.parse(binding));
      });
      app.get('/api/v1/projects/:projectId/agents/:bindingId', async (request) => {
        const { projectId, bindingId } = parseRequestInput(
          controlPlaneProjectBindingParamsSchema,
          request.params,
        );
        return projectAgentBindingSchema.parse(
          await withCurrentRead(() => control.getProjectAgentBinding(projectId, bindingId)),
        );
      });
      app.patch('/api/v1/projects/:projectId/agents/:bindingId', async (request) => {
        const { projectId, bindingId } = parseRequestInput(
          controlPlaneProjectBindingParamsSchema,
          request.params,
        );
        const body = parseRequestInput(projectAgentBindingPatchRequestSchema, request.body);
        return projectAgentBindingSchema.parse(
          await withMutation(() => control.updateProjectAgentBinding(projectId, bindingId, body)),
        );
      });
      app.delete('/api/v1/projects/:projectId/agents/:bindingId', async (request) => {
        const { projectId, bindingId } = parseRequestInput(
          controlPlaneProjectBindingParamsSchema,
          request.params,
        );
        return projectAgentBindingSchema.parse(
          await withMutation(() => control.unbindProjectAgent(projectId, bindingId)),
        );
      });

      /**
       * `listCapabilities` applies the page limit itself, unlike the collection
       * reads that slice here, so asking it for exactly the limit leaves a full
       * page and a cut one indistinguishable. One more than the page is
       * requested for the same reason every other bounded read over-fetches by
       * one: without it the response asserts a completeness it cannot know.
       */
      app.get('/api/v1/capabilities', async (request) => {
        const query = parseRequestInput(capabilityListQuerySchema, request.query);
        const capabilities = await withCurrentRead(() =>
          control.listCapabilities({ ...query, limit: query.limit + 1 }),
        );
        return capabilityCollectionSchema.parse({
          capabilities: capabilities.slice(0, query.limit),
          truncated: capabilities.length > query.limit,
        });
      });
      app.post('/api/v1/capabilities/scan', async (request) => {
        parseRequestInput(controlPlaneEmptyRequestSchema, request.body ?? {});
        return capabilityScanResponseSchema.parse(
          await withMutation(() => control.scanCapabilities()),
        );
      });
      app.post('/api/v1/capabilities', async (request, reply) => {
        const body = parseRequestInput(capabilityPackageCreateRequestSchema, request.body);
        const capability = await withMutation(() => control.createCapability(body));
        return reply
          .code(201)
          .header('Location', `/api/v1/capabilities/${capability.id}`)
          .send(capabilityPackageSchema.parse(capability));
      });
      app.get('/api/v1/capabilities/:capabilityId', async (request) => {
        const { capabilityId } = parseRequestInput(
          controlPlaneCapabilityParamsSchema,
          request.params,
        );
        return capabilityPackageSchema.parse(
          await withCurrentRead(() => control.getCapability(capabilityId)),
        );
      });
      app.patch('/api/v1/capabilities/:capabilityId', async (request) => {
        const { capabilityId } = parseRequestInput(
          controlPlaneCapabilityParamsSchema,
          request.params,
        );
        const body = parseRequestInput(capabilityPackagePatchRequestSchema, request.body);
        return capabilityPackageSchema.parse(
          await withMutation(() => control.updateCapability(capabilityId, body)),
        );
      });
      app.post('/api/v1/capabilities/:capabilityId/assign', async (request) => {
        const { capabilityId } = parseRequestInput(
          controlPlaneCapabilityParamsSchema,
          request.params,
        );
        const body = parseRequestInput(capabilityAssignmentRequestSchema, request.body);
        return capabilityBindingSchema.parse(
          await withMutation(() => control.assignCapability(capabilityId, body)),
        );
      });
      app.post('/api/v1/capabilities/:capabilityId/unassign', async (request) => {
        const { capabilityId } = parseRequestInput(
          controlPlaneCapabilityParamsSchema,
          request.params,
        );
        const body = parseRequestInput(capabilityAssignmentRequestSchema, request.body);
        return capabilityBindingSchema.parse(
          await withMutation(() => control.unassignCapability(capabilityId, body)),
        );
      });

      app.get('/api/v1/profiles', async () =>
        capabilityProfileCollectionSchema.parse({
          profiles: await withCurrentRead(() => control.listProfiles()),
        }),
      );
      app.post('/api/v1/profiles', async (request, reply) => {
        const body = parseRequestInput(capabilityProfileCreateRequestSchema, request.body);
        const profile = await withMutation(() => control.createProfile(body));
        return reply
          .code(201)
          .header('Location', `/api/v1/profiles/${profile.id}`)
          .send(capabilityProfileSchema.parse(profile));
      });
      app.get('/api/v1/profiles/:profileId', async (request) => {
        const { profileId } = parseRequestInput(controlPlaneProfileParamsSchema, request.params);
        return capabilityProfileSchema.parse(
          await withCurrentRead(() => control.getProfile(profileId)),
        );
      });
      app.patch('/api/v1/profiles/:profileId', async (request) => {
        const { profileId } = parseRequestInput(controlPlaneProfileParamsSchema, request.params);
        const body = parseRequestInput(capabilityProfilePatchRequestSchema, request.body);
        return capabilityProfileSchema.parse(
          await withMutation(() => control.updateProfile(profileId, body)),
        );
      });

      app.get('/api/v1/projects/:projectId/agents/:agentId/effective-config', async (request) => {
        const { projectId, agentId } = parseRequestInput(
          controlPlaneProjectAgentParamsSchema,
          request.params,
        );
        return effectiveAgentConfigurationSchema.parse(
          await withCurrentRead(() => control.getEffectiveConfiguration(projectId, agentId)),
        );
      });

      app.get('/api/v1/context/sources', async (request) => {
        const query = parseRequestInput(contextSourceListQuerySchema, request.query);
        const sources = await withCurrentRead(() => control.listContextSources());
        return contextSourceCollectionSchema.parse({
          sources: sources
            .filter(
              (source) =>
                (query.projectId === undefined || source.projectId === query.projectId) &&
                (query.agentId === undefined || source.agentId === query.agentId),
            )
            .slice(0, query.limit),
          truncated: sources.length > query.limit,
        });
      });
      app.post('/api/v1/context/scan', async (request) => {
        const body = parseRequestInput(nativeConfigInspectRequestSchema, request.body);
        const result = await withMutation(() => control.scanContext(body.agentId, body.projectId));
        return contextSourceCollectionSchema.parse({
          sources: result.sources,
          truncated: false,
        });
      });
      app.get('/api/v1/projects/:projectId/agents/:agentId/context-footprint', async (request) => {
        const { projectId, agentId } = parseRequestInput(
          controlPlaneProjectAgentParamsSchema,
          request.params,
        );
        return contextFootprintSchema.parse(
          await withCurrentRead(() => control.getContextFootprint(projectId, agentId)),
        );
      });
    }

    if (services.configControl !== undefined) {
      const configControl = services.configControl;

      app.post('/api/v1/config/inspect', async (request) => {
        const body = parseRequestInput(nativeConfigInspectRequestSchema, request.body);
        return nativeConfigInspectionSchema.parse(
          await withMutation(() => configControl.inspect(body.agentId, body.projectId)),
        );
      });
      app.post('/api/v1/config/import-plan', async (request, reply) => {
        const body = parseRequestInput(configPlanCreateRequestSchema, request.body);
        const plan = await withMutation(() => configControl.createImportPlan(body));
        return reply
          .code(201)
          .header('Location', `/api/v1/config/plans/${plan.id}`)
          .send(configPlanSchema.parse(plan));
      });
      app.post('/api/v1/config/render-plan', async (request, reply) => {
        const body = parseRequestInput(configPlanCreateRequestSchema, request.body);
        const plan = await withMutation(() => configControl.createRenderPlan(body));
        return reply
          .code(201)
          .header('Location', `/api/v1/config/plans/${plan.id}`)
          .send(configPlanSchema.parse(plan));
      });
      app.get('/api/v1/config/plans', async () =>
        configPlanCollectionSchema.parse({
          plans: await withCurrentRead(() => configControl.listPlans()),
        }),
      );
      app.get('/api/v1/config/plans/:planId', async (request) => {
        const { planId } = parseRequestInput(controlPlanePlanParamsSchema, request.params);
        return configPlanSchema.parse(await withCurrentRead(() => configControl.getPlan(planId)));
      });
      app.post('/api/v1/config/plans/:planId/approve', async (request) => {
        const { planId } = parseRequestInput(controlPlanePlanParamsSchema, request.params);
        parseRequestInput(controlPlaneEmptyRequestSchema, request.body ?? {});
        return configPlanApprovalResponseSchema.parse(
          await withMutation(() => configControl.approvePlan(planId)),
        );
      });
      app.post('/api/v1/config/plans/:planId/apply', async (request) => {
        const { planId } = parseRequestInput(controlPlanePlanParamsSchema, request.params);
        const body = parseRequestInput(configPlanApplyRequestSchema, request.body);
        return configOperationReceiptSchema.parse(
          await withMutation(() => configControl.applyPlan(planId, body.approvalToken)),
        );
      });
      app.get('/api/v1/config/snapshots', async () =>
        configSnapshotCollectionSchema.parse({
          snapshots: await withCurrentRead(() => configControl.listSnapshots()),
        }),
      );
      app.get('/api/v1/config/snapshots/:snapshotId', async (request) => {
        const { snapshotId } = parseRequestInput(controlPlaneSnapshotParamsSchema, request.params);
        return configSnapshotSchema.parse(
          await withCurrentRead(() => configControl.getSnapshot(snapshotId)),
        );
      });
      app.post('/api/v1/config/snapshots/:snapshotId/rollback-plan', async (request, reply) => {
        const { snapshotId } = parseRequestInput(controlPlaneSnapshotParamsSchema, request.params);
        parseRequestInput(controlPlaneEmptyRequestSchema, request.body ?? {});
        const plan = await withMutation(() => configControl.createRollbackPlan(snapshotId));
        return reply
          .code(201)
          .header('Location', `/api/v1/config/plans/${plan.id}`)
          .send(configPlanSchema.parse(plan));
      });
      app.get('/api/v1/config/drift', async () =>
        configDriftCollectionSchema.parse({
          drifts: await withCurrentRead(() => configControl.listDrift()),
        }),
      );
      app.post('/api/v1/config/drift/scan', async (request) => {
        parseRequestInput(controlPlaneEmptyRequestSchema, request.body ?? {});
        return configDriftCollectionSchema.parse({
          drifts: await withMutation(() => configControl.scanDrift()),
        });
      });
      app.post('/api/v1/config/reconcile', async (request) => {
        parseRequestInput(controlPlaneEmptyRequestSchema, request.body ?? {});
        return configReconcileResponseSchema.parse({
          operations: await withMutation(() => configControl.reconcile()),
        });
      });
    }
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
