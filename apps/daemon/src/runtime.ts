import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { RuntimeStateName } from '@luwi/protocol';
import {
  buildFunctionLibrary,
  claimSessionInbox,
  createBridgeSlotRepository,
  createDaemonOwnershipLease,
  createFunctionRegistry,
  createManagedRedisConnection,
  createLeaseRepository,
  createMessageRepository,
  createWakeIntentRepository,
  createWorkflowRepository,
  createControlPlaneRepository,
  createIntelligenceRepository,
  createRedisKeys,
  createRuntimeRepository,
  ensureRealtimeStreamGroup,
  readLatestRuntimeEvents,
  REALTIME_CONSUMER_GROUP,
  runMessageRetention,
  runStreamRetention,
  verifyOrLoadFunctionLibrary,
  type ManagedRedisConnection,
  type RedisFunctionRegistry,
  type RedisGateway,
  type RedisHealth,
  type NativeUnlinkInput,
  type RedisKeys,
  type RuntimeRepository,
} from '@luwi/redis';
import {
  createLeaseExpirySweeper,
  createMessageTimeoutSweeper,
  createNativeLinkRetentionSweeper,
  createPresenceSweeper,
  createRuntimeReadiness,
  NATIVE_DECLARATION_MAX_ATTEMPTS,
  type NativeLinkRetentionRepository,
  type PresenceSweeperRepository,
} from '@luwi/runtime';
import { createTranscriptReader, NodeTranscriptFileSystem } from '@luwi/adapters';

import { buildDaemon, type BuildDaemonOptions, type DaemonApp } from './app.js';
import { createBridgeSlotService } from './bridge-slot-service.js';
import {
  closeWithinDeadline,
  createBackgroundWorkTracker,
  waitForCompletion,
} from './background-work.js';
import {
  createDaemonRecoveryCoordinator,
  runDaemonRecoveryCycle,
  type DaemonRecoveryRunContext,
} from './daemon-ownership-recovery.js';
import type { DaemonConfig } from './config.js';
import { createCanonicalStore } from './canonical-store.js';
import { createConfigControlService } from './config-control-service.js';
import { clearStaleConfigFileLocks } from './config-file-engine.js';
import { createControlPlaneService } from './control-plane-service.js';
import { createLeaseService } from './lease-service.js';
import { createMessageService } from './message-service.js';
import { createIntelligenceService, type IntelligenceService } from './intelligence-service.js';
import { createGitObserver } from './git-observer.js';
import { createHostResourcesReader } from './host-resources.js';
import { createProjectService } from './project-service.js';
import { createRealtimeRelay } from './realtime-relay.js';
import { createSessionService, isVersionConflict } from './session-service.js';
import { createRedisWakeDispatchEvidence, createWakeIntentService } from './wake-intent-service.js';
import { createWorkflowService } from './workflow-service.js';
import {
  createTranscriptIngestService,
  createTranscriptIngestTick,
} from './transcript-ingest-service.js';
import {
  installGracefulShutdown,
  type GracefulShutdownController,
  type SignalSource,
} from './shutdown.js';
import { createWebSocketHub } from './websocket-hub.js';

/**
 * The open native link a lapsing session holds, if it holds one.
 *
 * Fail-closed: no reverse index means no binding and the unchanged path is
 * correct, but partial evidence is a fault rather than an absence, because
 * disconnecting anyway would abandon an open link.
 */
async function resolveExpiringNativeUnlink(
  repository: RuntimeRepository,
  sessionId: string,
): Promise<Omit<NativeUnlinkInput, 'unlinkedEventId'> | undefined> {
  const bindingId = await repository.getSessionNativeBindingId(sessionId);
  if (bindingId === null) return undefined;
  const binding = await repository.getNativeBinding(bindingId);
  const openLinkId = binding?.openLinkId;
  if (binding === null || openLinkId === undefined) {
    throw new Error('The native session binding for the lapsing session cannot be resolved.');
  }
  const link = await repository.getNativeLink(openLinkId);
  if (
    link === null ||
    link.id !== openLinkId ||
    link.bindingId !== bindingId ||
    link.sessionId !== sessionId ||
    link.unlinkedAt !== undefined
  ) {
    throw new Error('The native session link for the lapsing session cannot be resolved.');
  }
  return {
    bindingId,
    linkId: link.id,
    expectedVersion: binding.version,
    expectedOpenLinkId: openLinkId,
  };
}

/**
 * The presence sweeper's view of the runtime.
 *
 * It is built here rather than inline in `startDaemon` because this is the one
 * presence path that can make a session terminal with no caller to answer to,
 * and it is therefore the one worth exercising without a Redis stack behind it.
 */
export function createPresenceSweeperRepository(options: {
  repository: RuntimeRepository;
  workspaceId: string;
  createId: () => string;
}): PresenceSweeperRepository {
  const { repository, workspaceId, createId } = options;
  return {
    findExpiredHeartbeatDeadlines: (nowMs, limit) =>
      repository.findExpiredHeartbeatDeadlines(nowMs, limit),
    async disconnectExpiredSession(deadline) {
      const session = await repository.getSession(deadline.sessionId);
      if (session === null) {
        return 'unchanged';
      }
      /**
       * Both event ids are minted once and reused on every attempt, for the
       * same reason a declaration mints its ids before its loop: a retry that
       * minted new ones would append a second disconnect event for one lapse
       * if an earlier attempt had in fact succeeded unobserved.
       */
      const eventId = createId();
      const unlinkedEventId = createId();

      for (let attempt = 1; attempt <= NATIVE_DECLARATION_MAX_ATTEMPTS; attempt += 1) {
        /**
         * A lapsing session must not leave an open native link behind, so the
         * sweep resolves the binding and closes the link in the same
         * transition. Resolution is fail-closed: incomplete evidence throws
         * rather than quietly disconnecting and abandoning the link. It is
         * re-read on every attempt, because a conflict means the observation
         * the previous attempt rested on is no longer the one that won.
         */
        const native = await resolveExpiringNativeUnlink(repository, deadline.sessionId);
        try {
          const result = await repository.disconnectExpiredSession({
            ...deadline,
            expectedDeadlineMs: deadline.deadlineMs,
            projectId: session.projectId,
            workspaceId,
            eventId,
            ...(native === undefined ? {} : { native: { ...native, unlinkedEventId } }),
          });
          if (result.status === 'disconnected') {
            return 'disconnected';
          }
          return result.status === 'reconciled' ? 'reconciled' : 'unchanged';
        } catch (error) {
          if (!isVersionConflict(error)) throw error;
        }
      }

      /**
       * A conflict writes nothing, so the heartbeat deadline still names this
       * session and the next sweep sees it again. Reporting `unchanged` rather
       * than throwing is what keeps one contended session from aborting the
       * remaining candidates in the batch.
       */
      return 'unchanged';
    },
  };
}

/**
 * The seam between link retention and Redis.
 *
 * A refused trim is an outcome, not a failure: the compare-and-set lost to a
 * link or unlink that ran first, the Function wrote nothing, and the overshoot
 * is still there for the next sweep. Anything else is a real fault and escapes.
 */
export function createNativeLinkRetentionRepository(options: {
  repository: RuntimeRepository;
}): NativeLinkRetentionRepository {
  const { repository } = options;
  return {
    listBindingIds: (sessionIds) => repository.listSessionNativeBindingIds(sessionIds),
    async getRetentionState(bindingId) {
      const state = await repository.getNativeRetentionState(bindingId);
      if (state === null) {
        return null;
      }
      return {
        version: state.binding.version,
        ...(state.binding.openLinkId === undefined ? {} : { openLinkId: state.binding.openLinkId }),
        linkCount: state.linkCount,
      };
    },
    async listOldestLinks(bindingId, limit) {
      const links = await repository.listOldestNativeLinks(bindingId, limit);
      return links.map((link) => ({
        id: link.id,
        sessionId: link.sessionId,
        ...(link.unlinkedAt === undefined ? {} : { unlinkedAt: link.unlinkedAt }),
      }));
    },
    async trimLinks(input) {
      try {
        await repository.trimNativeLinks(input);
        return 'trimmed';
      } catch (error) {
        if (!isVersionConflict(error)) throw error;
        return 'conflict';
      }
    },
  };
}

export type StartDaemonConnections = {
  command: ManagedRedisConnection;
  admin: ManagedRedisConnection;
  relay: ManagedRedisConnection;
  wake: ManagedRedisConnection;
};

export type StartDaemonOptions = {
  config: DaemonConfig;
  lifecycleToken?: string;
  logger?: BuildDaemonOptions['logger'];
  signals?: SignalSource;
  runtimeInstanceId?: string;
  keys?: RedisKeys;
  functionRegistry?: RedisFunctionRegistry;
  connections?: StartDaemonConnections;
};

export type RunningDaemon = {
  app: DaemonApp;
  shutdown: GracefulShutdownController;
  runtimeInstanceId: string;
  runtimeState: () => RuntimeStateName;
};

const defaults = {
  ownerTtlMs: 15_000,
  ownerRenewIntervalMs: 5_000,
  sessionPresenceTtlMs: 15_000,
  presenceSweepIntervalMs: 1_000,
  heartbeatEventIntervalMs: 30_000,
  consumerClaimIdleMs: 30_000,
  relayBlockMs: 1_000,
  relayBatchSize: 100,
  websocketQueueLimit: 256,
  websocketSendTimeoutMs: 1_000,
  websocketMaxPayloadBytes: 65_536,
  websocketMaxBufferedBytes: 1_048_576,
  globalStreamMaxLength: 100_000,
  projectStreamMaxLength: 50_000,
  deadLetterStreamMaxLength: 10_000,
  retentionIntervalMs: 60_000,
  nativeLinkRetentionMax: 1_000,
  messageTimeoutSweepIntervalMs: 1_000,
  messageTimeoutBatchSize: 100,
  wakeSweepIntervalMs: 1_000,
  wakeSweepBatchSize: 100,
  messageMaxContentBytes: 32_768,
  messageMaxSubjectBytes: 512,
  messageMaxResponseBytes: 65_536,
  messageMaxEvidenceItems: 32,
  messageDefaultTimeoutMs: 120_000,
  messageMaxTimeoutMs: 86_400_000,
  inboxClaimLimit: 10,
  inboxBlockMs: 5_000,
  inboxMinIdleMs: 15_000,
  inboxMaxClaimLimit: 100,
  terminalMessageRetentionMs: 604_800_000,
  messageIdempotencyRetentionMs: 86_400_000,
  sessionInboxMaxLength: 10_000,
  drainTimeoutMs: 5_000,
  reconnectInitialMs: 250,
  reconnectMaxMs: 5_000,
  gitCommandTimeoutMs: 5_000,
  gitScanIntervalMs: 300_000,
  transcriptScanIntervalMs: 300_000,
  transcriptMaxFileBytes: 16_777_216,
  transcriptMaxFilesPerScan: 2_000,
  usageRetentionDays: 30,
  gitObservationRetentionCount: 100,
  graphGenerationRetentionCount: 2,
  optimizationMinimumBaselineSessions: 3,
  optimizationMinimumPostSessions: 3,
  optimizationMinimumObservationHours: 24,
  optimizationMaximumFindings: 100,
  optimizationMaximumProposals: 25,
  optimizationOversizedContextTokens: 8_000,
};

function setting(config: DaemonConfig, key: keyof typeof defaults): number {
  const configured = config[key];
  return typeof configured === 'number' ? configured : defaults[key];
}

class ConnectionHealthGateway implements RedisGateway {
  readonly #connection: ManagedRedisConnection;

  constructor(connection: ManagedRedisConnection) {
    this.#connection = connection;
  }

  async connect(): Promise<boolean> {
    return this.#connection.isReady;
  }

  async checkHealth(): Promise<RedisHealth> {
    if (!this.#connection.isReady) {
      return {
        connected: false,
        status: 'disconnected',
        error: { code: 'REDIS_UNAVAILABLE', message: 'Redis is unavailable' },
      };
    }
    const startedAt = Date.now();
    try {
      const reply = await this.#connection.sendCommand(['PING']);
      if (reply !== 'PONG') {
        throw new Error('Unexpected Redis PING response.');
      }
      return {
        connected: true,
        status: 'connected',
        latencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch {
      return {
        connected: false,
        status: 'disconnected',
        error: { code: 'REDIS_UNAVAILABLE', message: 'Redis is unavailable' },
      };
    }
  }

  async close(): Promise<void> {
    // The owned runtime closes its four connections in drain order.
  }
}

async function connect(connection: ManagedRedisConnection): Promise<void> {
  if (connection.isReady) {
    return;
  }
  if (connection.isOpen) {
    connection.disconnect();
  }
  await connection.connect();
}

async function closeConnection(connection: ManagedRedisConnection): Promise<void> {
  if (!connection.isOpen) {
    return;
  }
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
}

function abortConnection(connection: ManagedRedisConnection): void {
  if (connection.isOpen) {
    connection.disconnect();
  }
}

function pairsToRecord(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }
  const result: Record<string, unknown> = {};
  for (let index = 0; index < value.length; index += 2) {
    if (typeof value[index] === 'string') {
      result[value[index] as string] = value[index + 1];
    }
  }
  return result;
}

async function relayCaughtUp(
  client: ManagedRedisConnection,
  stream: string,
  group: string,
): Promise<boolean> {
  const pending = await client.sendCommand(['XPENDING', stream, group]);
  if (!Array.isArray(pending) || Number(pending[0]) !== 0) {
    return false;
  }
  const groups = await client.sendCommand(['XINFO', 'GROUPS', stream]);
  if (!Array.isArray(groups)) {
    return false;
  }
  const metadata = groups.map(pairsToRecord).find((candidate) => candidate.name === group);
  return metadata?.lag === 0;
}

export async function startDaemon(options: StartDaemonOptions): Promise<RunningDaemon> {
  const { config } = options;
  if (
    options.lifecycleToken !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      options.lifecycleToken,
    )
  ) {
    throw new Error('The daemon lifecycle token is invalid.');
  }
  const runtimeInstanceId = options.runtimeInstanceId ?? randomUUID();
  const keys = options.keys ?? createRedisKeys();
  const registry = options.functionRegistry ?? createFunctionRegistry();
  const library = buildFunctionLibrary(registry);
  let requestRecovery = (): void => undefined;
  const createConnection = (): ManagedRedisConnection =>
    createManagedRedisConnection({
      url: config.redisUrl,
      onError: () => requestRecovery(),
    });
  const connections =
    options.connections ??
    ({
      command: createConnection(),
      admin: createConnection(),
      relay: createConnection(),
      wake: createConnection(),
    } satisfies StartDaemonConnections);
  const readiness = createRuntimeReadiness('starting');
  const ownership = createDaemonOwnershipLease({
    client: connections.admin,
    key: keys.daemonOwner,
    runtimeInstanceId,
    ttlMs: setting(config, 'ownerTtlMs'),
    renewIntervalMs: setting(config, 'ownerRenewIntervalMs'),
    onLost: () => requestRecovery(),
  });
  let app: DaemonApp | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let messageTimeoutTimer: NodeJS.Timeout | undefined;
  let wakeSweepTimer: NodeJS.Timeout | undefined;
  let leaseExpiryTimer: NodeJS.Timeout | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  let gitScanTimer: NodeJS.Timeout | undefined;
  let transcriptScanTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let sweeping = false;
  let sweepingMessageTimeouts = false;
  let sweepingWakeIntents = false;
  let sweepingLeaseExpiry = false;
  let retaining = false;
  const backgroundWork = createBackgroundWorkTracker();
  const projectRefreshes = new Set<string>();
  let refreshProject = (projectId: string, reason: string): void => {
    void projectId;
    void reason;
  };

  const hub = createWebSocketHub({
    maxQueueSize: setting(config, 'websocketQueueLimit'),
    maxBufferedBytes: setting(config, 'websocketMaxBufferedBytes'),
    sendTimeoutMs: setting(config, 'websocketSendTimeoutMs'),
  });
  const repository = createRuntimeRepository({
    client: connections.command,
    keys,
    functions: registry,
  });
  const messageRepository = createMessageRepository({
    client: connections.command,
    keys,
    functions: registry,
  });
  const workflowRepository = createWorkflowRepository({
    client: connections.command,
    keys,
    functions: registry,
    decisionReceiptRetentionMs: setting(config, 'terminalMessageRetentionMs'),
  });
  const wakeIntentRepository = createWakeIntentRepository({
    client: connections.command,
    keys,
    functions: registry,
  });
  const wakeClaimRepository = createWakeIntentRepository({
    client: connections.wake,
    keys,
    functions: registry,
  });
  const leaseRepository = createLeaseRepository({
    client: connections.command,
    keys,
    functions: registry,
  });
  const controlPlaneRepository = createControlPlaneRepository({
    client: connections.command,
    keys,
    functions: registry,
  });
  const intelligenceRepository = createIntelligenceRepository({
    client: connections.command,
    keys,
    functions: registry,
  });
  const canonicalStore = createCanonicalStore({
    globalRoot:
      config.luwiHome ??
      (process.env['NODE_ENV'] === 'test'
        ? join(tmpdir(), 'luwi-runtime-tests', runtimeInstanceId)
        : join(homedir(), '.luwi')),
  });
  const projectService = createProjectService({
    repository,
    workspaceId: config.workspaceId,
    onRegistered: (project) => refreshProject(project.id, 'project-registered'),
  });
  const sessionService = createSessionService({
    repository,
    workspaceId: config.workspaceId,
    presenceTtlMs: setting(config, 'sessionPresenceTtlMs'),
    heartbeatEventIntervalMs: setting(config, 'heartbeatEventIntervalMs'),
    onRegistered: (session) => refreshProject(session.projectId, 'session-started'),
    onClosed: (session) => refreshProject(session.projectId, 'session-closed'),
  });
  const messageService = createMessageService({
    repository: messageRepository,
    sessions: sessionService,
    workspaceId: config.workspaceId,
    runtimeState: () => readiness.state,
    idempotencyRetentionMs: setting(config, 'messageIdempotencyRetentionMs'),
    maxContentBytes: setting(config, 'messageMaxContentBytes'),
    maxSubjectBytes: setting(config, 'messageMaxSubjectBytes'),
    maxResponseBytes: setting(config, 'messageMaxResponseBytes'),
    maxEvidenceItems: setting(config, 'messageMaxEvidenceItems'),
    maxTimeoutMs: setting(config, 'messageMaxTimeoutMs'),
    claimInbox: (sessionId, request) =>
      claimSessionInbox({
        client: connections.command,
        keys,
        sessionId,
        bridgeInstanceId: request.bridgeInstanceId,
        limit: request.limit,
        minIdleMs: request.minIdleMs,
        getMessage: (messageId) => messageRepository.getMessageById(messageId),
        markDelivered: async (correlationId) => {
          await messageRepository.transitionMessage('delivered', {
            correlationId,
            responderSessionId: sessionId,
            workspaceId: config.workspaceId,
            eventId: randomUUID(),
          });
        },
        onInvalidEntry: ({ streamId, reason }) => {
          process.stderr.write(
            `${JSON.stringify({
              level: 'warn',
              code: 'INBOX_ENTRY_INVALID',
              sessionId,
              streamId,
              reason,
            })}\n`,
          );
        },
      }),
  });
  const workflowService = createWorkflowService({
    repository: workflowRepository,
    sessions: sessionService,
    workspaceId: config.workspaceId,
    messageTimeoutMs: setting(config, 'messageDefaultTimeoutMs'),
    maxContentBytes: setting(config, 'messageMaxContentBytes'),
    maxSubjectBytes: setting(config, 'messageMaxSubjectBytes'),
  });
  const wakeIntentService = createWakeIntentService({
    repository: wakeIntentRepository,
    claimRepository: wakeClaimRepository,
    evidence: createRedisWakeDispatchEvidence({
      repository,
      client: connections.command,
      keys,
    }),
  });
  const controlPlaneService = createControlPlaneService({
    repository: controlPlaneRepository,
    canonicalStore,
    projects: projectService,
    workspaceId: config.workspaceId,
    ...(config.nativeHome === undefined ? {} : { homeDirectory: config.nativeHome }),
    ...(config.capabilityRoots === undefined ? {} : { capabilityRoots: config.capabilityRoots }),
  });
  const intelligenceServiceReference: { current?: IntelligenceService } = {};
  const configControlService = createConfigControlService({
    repository: controlPlaneRepository,
    canonicalStore,
    controlPlane: controlPlaneService,
    projects: projectService,
    workspaceId: config.workspaceId,
    ...(config.nativeHome === undefined ? {} : { homeDirectory: config.nativeHome }),
    ...(config.configSnapshotRetentionCount === undefined
      ? {}
      : { snapshotRetentionCount: config.configSnapshotRetentionCount }),
    onReconciliationRequired: () => requestRecovery(),
    onApplied: async (_receipt, plan) => {
      if (plan.projectId !== undefined) refreshProject(plan.projectId, 'config-applied');
      const service = intelligenceServiceReference.current;
      if (service === undefined) {
        throw new Error('Intelligence service is not initialized.');
      }
      await service.recordConfigPlanApplied(plan.id);
    },
  });
  const intelligenceService = createIntelligenceService({
    repository: intelligenceRepository,
    projects: projectService,
    sessions: sessionService,
    controlPlane: controlPlaneService,
    configControl: configControlService,
    workspaceId: config.workspaceId,
    gitObserver: createGitObserver({
      timeoutMs: setting(config, 'gitCommandTimeoutMs'),
    }),
    optimizationMinimumBaselineSessions: setting(config, 'optimizationMinimumBaselineSessions'),
    optimizationMinimumPostSessions: setting(config, 'optimizationMinimumPostSessions'),
    optimizationMinimumObservationHours: setting(config, 'optimizationMinimumObservationHours'),
    optimizationMaximumFindings: setting(config, 'optimizationMaximumFindings'),
    optimizationMaximumProposals: setting(config, 'optimizationMaximumProposals'),
    oversizedContextTokens: setting(config, 'optimizationOversizedContextTokens'),
    readRebuildEvents: () =>
      readLatestRuntimeEvents({
        client: connections.command,
        stream: keys.globalEvents,
        deadLetterStream: keys.deadLetterEvents,
        deadLetterMaxLength: setting(config, 'deadLetterStreamMaxLength'),
        limit: setting(config, 'globalStreamMaxLength'),
      }),
    // The post-mutation reprojection rescans the project's TypeScript and
    // rewrites the active generation. Held inside the request it kept a
    // response open for minutes on a real repository; tracked here it is still
    // logged and still drained at shutdown, and the mutation answers at once.
    // Readiness leaves `ready` the moment shutdown begins, so this is the same
    // signal every background tick already gates on.
    projectionStopped: () => readiness.state !== 'ready',
    deferProjection: (run) => {
      const scheduled = backgroundWork.run(run, (error) =>
        app?.log.error({ err: error }, 'Operational graph projection failed'),
      );
      if (!scheduled) {
        app?.log.debug('Operational graph projection skipped during drain');
      }
    },
  });
  intelligenceServiceReference.current = intelligenceService;
  const ensureIntelligenceHealthy = async (): Promise<void> => {
    if ((await intelligenceRepository.getGraphProjectionHealth()) === 'healthy') return;
    // The operational-graph rebuild is minutes of Redis work on a real datastore,
    // and the projects, sessions, usage, capabilities, and messaging surfaces do
    // not depend on it. Awaiting it here gated the daemon's readiness on it, so a
    // first start against real data timed out and — interrupted mid-flight — logged
    // REDIS_UNAVAILABLE against a healthy Redis. Defer it to the background-work
    // tracker instead (still tracked, logged, and drained at shutdown) so a slow or
    // failing rebuild degrades only the graph view rather than preventing startup.
    const scheduled = backgroundWork.run(
      () => intelligenceService.rebuildGraph().then(() => undefined),
      (error) => app?.log.error({ err: error }, 'Startup operational-graph rebuild failed'),
    );
    if (!scheduled) {
      app?.log.debug('Startup operational-graph rebuild skipped during drain');
    }
  };
  refreshProject = (projectId, reason) => {
    if (projectRefreshes.has(projectId) || readiness.state !== 'ready') return;
    projectRefreshes.add(projectId);
    const scheduled = backgroundWork.run(
      async () => {
        try {
          await intelligenceService.scanGit(projectId);
        } catch (error) {
          app?.log.debug({ err: error, projectId, reason }, 'Git observation skipped');
        }
        try {
          await intelligenceService.scanPackages(projectId);
        } catch (error) {
          app?.log.debug({ err: error, projectId, reason }, 'Package observation skipped');
        } finally {
          projectRefreshes.delete(projectId);
        }
      },
      (error) => {
        projectRefreshes.delete(projectId);
        app?.log.error({ err: error, projectId, reason }, 'Repository refresh failed');
      },
    );
    if (!scheduled) projectRefreshes.delete(projectId);
  };
  const reconcileCanonicalControlPlane = async (): Promise<void> => {
    await projectService.reconcileCanonical(await canonicalStore.loadTrackedProjects());
    for (const project of await projectService.list()) {
      await canonicalStore.trackProject(project);
    }
    await controlPlaneService.reconcileCanonicalState();
    await configControlService.reconcile();
  };

  const transitionDegraded = (): void => {
    if (readiness.state === 'ready' || readiness.state === 'recovering') {
      readiness.transitionTo('degraded');
    }
  };

  const relay = createRealtimeRelay({
    client: connections.relay,
    stream: keys.globalEvents,
    group: REALTIME_CONSUMER_GROUP,
    consumer: `daemon-${runtimeInstanceId}`,
    deadLetterStream: keys.deadLetterEvents,
    claimIdleMs: setting(config, 'consumerClaimIdleMs'),
    blockMs: setting(config, 'relayBlockMs'),
    batchSize: setting(config, 'relayBatchSize'),
    deadLetterMaxLength: setting(config, 'deadLetterStreamMaxLength'),
    accept: (message) => hub.accept(message),
    onFailure: (error) => {
      app?.log.error({ err: error }, 'Realtime relay failed');
      requestRecovery();
    },
    now: () => new Date(),
  });

  const sweeper = createPresenceSweeper({
    now: Date.now,
    batchSize: setting(config, 'relayBatchSize'),
    repository: createPresenceSweeperRepository({
      repository,
      workspaceId: config.workspaceId,
      createId: randomUUID,
    }),
  });
  const leaseService = createLeaseService({
    repository: leaseRepository,
    sessions: sessionService,
    workspaceId: config.workspaceId,
  });
  const leaseExpirySweeper = createLeaseExpirySweeper({
    now: Date.now,
    batchSize: setting(config, 'messageTimeoutBatchSize'),
    repository: {
      findDueLeases: (nowMs, limit) => leaseService.findDueLeases(nowMs, limit),
      expireLease: (leaseId) => leaseService.expire(leaseId),
    },
  });
  const bridgeSlotService = createBridgeSlotService({
    repository: createBridgeSlotRepository({
      client: connections.command,
      keys,
      functions: registry,
    }),
    workspaceId: config.workspaceId,
  });
  // Rides the lease-expiry tick rather than owning a timer: the sweep is the
  // same shape (a passed deadline becomes an `expired` transition and event),
  // and one less timer is one less thing to clear on both teardown paths.
  const bridgeSlotExpirySweeper = createLeaseExpirySweeper({
    now: Date.now,
    batchSize: setting(config, 'messageTimeoutBatchSize'),
    repository: {
      findDueLeases: (_nowMs, limit) => bridgeSlotService.findDue(limit),
      expireLease: (slotId) => bridgeSlotService.expire(slotId),
    },
  });
  const nativeLinkRetentionSweeper = createNativeLinkRetentionSweeper({
    repository: createNativeLinkRetentionRepository({ repository }),
    retentionMax: setting(config, 'nativeLinkRetentionMax'),
  });
  // Reads the developer's native transcripts and attributes each request's
  // tokens to the session that held the native session at that instant. The
  // root follows nativeHome so a fixture run stays isolated from the real
  // ~/.claude tree.
  const transcriptIngestService = createTranscriptIngestService({
    reader: createTranscriptReader({
      fileSystem: new NodeTranscriptFileSystem(),
      maxFileBytes: setting(config, 'transcriptMaxFileBytes'),
      maxFilesPerScan: setting(config, 'transcriptMaxFilesPerScan'),
    }),
    repository: {
      getNativeBinding: (bindingId) => repository.getNativeBinding(bindingId),
      findNativeLinkAt: (bindingId, atMs) => repository.findNativeLinkAt(bindingId, atMs),
    },
    sessions: {
      get: async (sessionId) => {
        const session = await repository.getSession(sessionId);
        return session === null
          ? null
          : { id: session.id, projectId: session.projectId, agentId: session.agentId };
      },
    },
    projects: {
      list: async () =>
        (await projectService.list()).map((project) => ({
          id: project.id,
          canonicalPath: project.canonicalPath,
        })),
    },
    intelligence: {
      ingestUsage: async (input) => intelligenceService.ingestUsage(input),
      projectSessionFileChanges: (changes) =>
        intelligenceService.projectSessionFileChanges(changes),
    },
    transcriptRoot: join(config.nativeHome ?? homedir(), '.claude', 'projects'),
    adapterId: 'claude-code',
  });
  const transcriptIngestTick = createTranscriptIngestTick({
    runtimeState: () => readiness.state,
    schedule: (work, onError) => backgroundWork.run(work, onError),
    ingestOnce: () => transcriptIngestService.ingestOnce(),
    // Counters only — no session id, no native id, no content.
    onComplete: (summary) => app?.log.debug(summary, 'Transcript ingestion completed'),
    onError: (error) => app?.log.error({ err: error }, 'Transcript ingestion failed'),
  });
  const messageTimeoutSweeper = createMessageTimeoutSweeper({
    now: Date.now,
    batchSize: setting(config, 'messageTimeoutBatchSize'),
    repository: {
      findDueMessageDeadlines: (nowMs, limit) =>
        messageRepository.findDueMessageDeadlines(nowMs, limit),
      timeoutMessage: ({ messageId, deadlineMs }) =>
        messageService.timeoutMessage(messageId, deadlineMs),
    },
  });

  const canRecover = (): boolean => readiness.state !== 'draining' && readiness.state !== 'stopped';

  const runRecovery = async ({ hasPendingRequest }: DaemonRecoveryRunContext): Promise<void> => {
    transitionDegraded();
    // A BLOCKing wake claim must never hold recovery behind its own socket.
    abortConnection(connections.wake);
    let backoff = setting(config, 'reconnectInitialMs');
    while (canRecover()) {
      try {
        if (readiness.state === 'degraded') {
          readiness.transitionTo('recovering');
        }
        await connect(connections.command);
        await connect(connections.admin);
        await connect(connections.relay);
        await runDaemonRecoveryCycle({
          ownership,
          canRecover,
          hasPendingRequest,
          recoverRuntimeState: async () => {
            await verifyOrLoadFunctionLibrary(connections.admin, library, ownership);
            await connect(connections.wake);
            await wakeClaimRepository.createGroupAtZero();
            await ensureRealtimeStreamGroup(
              connections.admin,
              keys.globalEvents,
              REALTIME_CONSUMER_GROUP,
            );
            await relay.recoverPending();
            await reconcileCanonicalControlPlane();
            await ensureIntelligenceHealthy();
          },
          onReacquired: () => {
            app?.log.info(
              { runtimeInstanceId },
              'Daemon ownership reacquired after an expired owner key',
            );
          },
          onContended: () => {
            void shutdownRuntime();
          },
          onReady: () => {
            relay.start();
            readiness.transitionTo('ready');
          },
        });
        return;
      } catch (error) {
        transitionDegraded();
        app?.log.error({ err: error, retryInMs: backoff }, 'Runtime recovery failed');
        await delay(backoff);
        backoff = Math.min(backoff * 2, setting(config, 'reconnectMaxMs'));
      }
    }
  };

  const recoveryCoordinator = createDaemonRecoveryCoordinator({
    canRecover,
    onError: (error) => {
      app?.log.error(
        { err: error, runtimeInstanceId },
        'Runtime recovery coordinator failed unexpectedly',
      );
      void shutdownRuntime();
    },
    runRecovery,
  });
  requestRecovery = recoveryCoordinator.request;

  const shutdownRuntime = async (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      if (readiness.state !== 'draining' && readiness.state !== 'stopped') {
        readiness.beginDraining();
      }
      const drainTimeoutMs = setting(config, 'drainTimeoutMs');
      const deadline = Date.now() + drainTimeoutMs;
      backgroundWork.stop();
      sweeper.stop();
      messageTimeoutSweeper.stop();
      leaseExpirySweeper.stop();
      bridgeSlotExpirySweeper.stop();
      nativeLinkRetentionSweeper.stop();
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
      }
      if (messageTimeoutTimer !== undefined) {
        clearInterval(messageTimeoutTimer);
      }
      if (wakeSweepTimer !== undefined) {
        clearInterval(wakeSweepTimer);
      }
      if (leaseExpiryTimer !== undefined) {
        clearInterval(leaseExpiryTimer);
      }
      if (retentionTimer !== undefined) {
        clearInterval(retentionTimer);
      }
      if (gitScanTimer !== undefined) {
        clearInterval(gitScanTimer);
      }
      if (transcriptScanTimer !== undefined) {
        clearInterval(transcriptScanTimer);
      }
      // Wake claims use a dedicated BLOCKing connection. Abort and close it
      // before waiting for mutation drain so a long claim cannot deadlock
      // cooperative shutdown.
      abortConnection(connections.wake);
      await closeConnection(connections.wake);
      const inFlightDrained = await readiness.waitForInFlight(Math.max(0, deadline - Date.now()));
      const backgroundDrained = await backgroundWork.waitForIdle(
        Math.max(0, deadline - Date.now()),
      );
      while (Date.now() < deadline) {
        try {
          if (await relayCaughtUp(connections.admin, keys.globalEvents, REALTIME_CONSUMER_GROUP)) {
            break;
          }
        } catch {
          break;
        }
        await delay(20);
      }
      const relayStopping = relay.stop();
      if (!(await waitForCompletion(relayStopping, Math.max(0, deadline - Date.now())))) {
        abortConnection(connections.relay);
        await waitForCompletion(relayStopping, 100);
      }
      hub.closeAll();
      if (!inFlightDrained || !backgroundDrained) {
        abortConnection(connections.command);
      }
      if (!backgroundDrained) {
        abortConnection(connections.admin);
      }
      if (app !== undefined) {
        await closeWithinDeadline(
          () => app?.close() ?? Promise.resolve(),
          () => {
            abortConnection(connections.command);
            app?.server.closeAllConnections();
          },
          Math.max(0, deadline - Date.now()),
        );
      }
      await closeConnection(connections.relay);
      await closeConnection(connections.command);
      await ownership.release().catch(() => false);
      await closeConnection(connections.admin);
      if (readiness.state === 'draining') {
        readiness.transitionTo('stopped');
      }
    })();
    return shutdownPromise;
  };

  try {
    await connect(connections.command);
    await connect(connections.admin);
    await ownership.acquire();
    readiness.transitionTo('recovering');
    await verifyOrLoadFunctionLibrary(connections.admin, library, ownership);
    await connect(connections.wake);
    await wakeClaimRepository.createGroupAtZero();
    await ensureRealtimeStreamGroup(connections.admin, keys.globalEvents, REALTIME_CONSUMER_GROUP);
    await connect(connections.relay);
    await clearStaleConfigFileLocks(canonicalStore.globalRoot);
    await reconcileCanonicalControlPlane();
    await ensureIntelligenceHealthy();

    const hostResources = createHostResourcesReader({
      diskPath: canonicalStore.globalRoot,
      redis: connections.admin,
    });
    app = buildDaemon({
      config,
      redis: new ConnectionHealthGateway(connections.command),
      resources: () => hostResources.read(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      runtimeInstanceId,
      runtimeState: () => readiness.state,
      readiness,
      onRedisUnavailable: () => requestRecovery(),
      ...(options.lifecycleToken === undefined
        ? {}
        : {
            lifecycle: {
              token: options.lifecycleToken,
              requestStop: shutdownRuntime,
            },
          }),
      services: {
        projects: projectService,
        sessions: sessionService,
        messages: messageService,
        leases: leaseService,
        bridgeSlots: bridgeSlotService,
        wakeIntents: wakeIntentService,
        workflows: workflowService,
        controlPlane: controlPlaneService,
        configControl: configControlService,
        intelligence: intelligenceService,
        listEvents: (limit) =>
          readLatestRuntimeEvents({
            client: connections.command,
            stream: keys.globalEvents,
            deadLetterStream: keys.deadLetterEvents,
            deadLetterMaxLength: setting(config, 'deadLetterStreamMaxLength'),
            limit,
          }),
      },
      websocket: {
        hub,
        maxPayloadBytes: setting(config, 'websocketMaxPayloadBytes'),
        expectedHosts: new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]),
        allowedOrigins: new Set(
          config.allowedOrigins ?? [
            `http://127.0.0.1:${config.port}`,
            `http://localhost:${config.port}`,
          ],
        ),
      },
      closeRedisOnClose: false,
    });
    await app.ready();
    await relay.recoverPending();
    relay.start();

    sweepTimer = setInterval(
      () => {
        if (sweeping || readiness.state !== 'ready') {
          return;
        }
        sweeping = true;
        const scheduled = backgroundWork.run(
          async () => {
            try {
              await sweeper.sweepOnce();
            } finally {
              sweeping = false;
            }
          },
          (error) => app?.log.error({ err: error }, 'Presence sweep failed'),
        );
        if (!scheduled) {
          sweeping = false;
        }
      },
      setting(config, 'presenceSweepIntervalMs'),
    );
    sweepTimer.unref?.();

    messageTimeoutTimer = setInterval(
      () => {
        if (sweepingMessageTimeouts || readiness.state !== 'ready') {
          return;
        }
        sweepingMessageTimeouts = true;
        const scheduled = backgroundWork.run(
          async () => {
            try {
              await messageTimeoutSweeper.sweepOnce();
            } finally {
              sweepingMessageTimeouts = false;
            }
          },
          (error) => app?.log.error({ err: error }, 'Message timeout sweep failed'),
        );
        if (!scheduled) {
          sweepingMessageTimeouts = false;
        }
      },
      setting(config, 'messageTimeoutSweepIntervalMs'),
    );
    messageTimeoutTimer.unref?.();

    wakeSweepTimer = setInterval(
      () => {
        if (sweepingWakeIntents || readiness.state !== 'ready') {
          return;
        }
        sweepingWakeIntents = true;
        const scheduled = backgroundWork.run(
          async () => {
            try {
              await wakeIntentService.sweep(setting(config, 'wakeSweepBatchSize'));
            } finally {
              sweepingWakeIntents = false;
            }
          },
          (error) => app?.log.error({ err: error }, 'Wake intent sweep failed'),
        );
        if (!scheduled) {
          sweepingWakeIntents = false;
        }
      },
      setting(config, 'wakeSweepIntervalMs'),
    );
    wakeSweepTimer.unref?.();

    leaseExpiryTimer = setInterval(
      () => {
        if (sweepingLeaseExpiry || readiness.state !== 'ready') {
          return;
        }
        sweepingLeaseExpiry = true;
        const scheduled = backgroundWork.run(
          async () => {
            try {
              await leaseExpirySweeper.sweepOnce();
              await bridgeSlotExpirySweeper.sweepOnce();
            } finally {
              sweepingLeaseExpiry = false;
            }
          },
          (error) => app?.log.error({ err: error }, 'Lease expiry sweep failed'),
        );
        if (!scheduled) {
          sweepingLeaseExpiry = false;
        }
      },
      setting(config, 'messageTimeoutSweepIntervalMs'),
    );
    leaseExpiryTimer.unref?.();

    retentionTimer = setInterval(
      () => {
        if (retaining || readiness.state !== 'ready') {
          return;
        }
        retaining = true;
        const scheduled = backgroundWork.run(
          async () => {
            try {
              await runStreamRetention({
                client: connections.admin,
                globalStream: keys.globalEvents,
                projectStream: keys.projectEvents,
                deadLetterStream: keys.deadLetterEvents,
                projectsIndex: keys.projectsIndex,
                consumerGroup: REALTIME_CONSUMER_GROUP,
                globalMaxLength: setting(config, 'globalStreamMaxLength'),
                projectMaxLength: setting(config, 'projectStreamMaxLength'),
                deadLetterMaxLength: setting(config, 'deadLetterStreamMaxLength'),
                relayHealthy: relay.healthy,
              });
              const sessions = await repository.listSessions();
              await runMessageRetention({
                client: connections.admin,
                keys,
                nowMs: Date.now(),
                terminalProjectionRetentionMs: setting(config, 'terminalMessageRetentionMs'),
                maxInboxLength: setting(config, 'sessionInboxMaxLength'),
                batchSize: setting(config, 'messageTimeoutBatchSize'),
                sessionIds: sessions.map(({ id }) => id),
              });
              // Rides the existing retention interval and the session list it
              // already read: a timer of its own would be a second thing to
              // clear on shutdown for no gain.
              await nativeLinkRetentionSweeper.sweepOnce(sessions.map(({ id }) => id));
              await intelligenceRepository.runRetention({
                now: new Date(),
                usageRetentionDays: setting(config, 'usageRetentionDays'),
                gitObservationRetentionCount: setting(config, 'gitObservationRetentionCount'),
                graphGenerationRetentionCount: setting(config, 'graphGenerationRetentionCount'),
              });
            } finally {
              retaining = false;
            }
          },
          (error) => app?.log.error({ err: error }, 'Runtime retention failed'),
        );
        if (!scheduled) {
          retaining = false;
        }
      },
      setting(config, 'retentionIntervalMs'),
    );
    retentionTimer.unref?.();

    gitScanTimer = setInterval(
      () => {
        if (readiness.state !== 'ready') return;
        const scheduled = backgroundWork.run(
          async () => {
            for (const project of await projectService.list()) {
              refreshProject(project.id, 'periodic');
            }
          },
          (error) => app?.log.error({ err: error }, 'Periodic repository scan failed'),
        );
        if (!scheduled) {
          app?.log.debug('Periodic repository scan skipped during drain');
        }
      },
      setting(config, 'gitScanIntervalMs'),
    );
    gitScanTimer.unref?.();

    transcriptScanTimer = setInterval(
      transcriptIngestTick,
      setting(config, 'transcriptScanIntervalMs'),
    );
    transcriptScanTimer.unref?.();

    readiness.transitionTo('ready');
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    backgroundWork.stop();
    sweeper.stop();
    messageTimeoutSweeper.stop();
    leaseExpirySweeper.stop();
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
    }
    if (messageTimeoutTimer !== undefined) {
      clearInterval(messageTimeoutTimer);
    }
    if (wakeSweepTimer !== undefined) {
      clearInterval(wakeSweepTimer);
    }
    if (leaseExpiryTimer !== undefined) {
      clearInterval(leaseExpiryTimer);
    }
    if (retentionTimer !== undefined) {
      clearInterval(retentionTimer);
    }
    if (gitScanTimer !== undefined) {
      clearInterval(gitScanTimer);
    }
    if (transcriptScanTimer !== undefined) {
      clearInterval(transcriptScanTimer);
    }
    await backgroundWork.waitForIdle(setting(config, 'drainTimeoutMs'));
    await relay.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await ownership.release().catch(() => false);
    await Promise.all([
      closeConnection(connections.wake),
      closeConnection(connections.relay),
      closeConnection(connections.command),
      closeConnection(connections.admin),
    ]);
    if (readiness.state === 'starting' || readiness.state === 'recovering') {
      readiness.transitionTo('stopped');
    }
    throw error;
  }

  const shutdown = installGracefulShutdown(app, options.signals, shutdownRuntime);
  app.log.info(
    {
      host: config.host,
      port: app.server.address(),
      runtimeInstanceId,
    },
    'LUWI Runtime daemon started',
  );

  return {
    app,
    shutdown,
    runtimeInstanceId,
    runtimeState: () => readiness.state,
  };
}
