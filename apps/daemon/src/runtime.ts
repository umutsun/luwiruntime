import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { RuntimeStateName } from '@luwi/protocol';
import {
  buildFunctionLibrary,
  createDaemonOwnershipLease,
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
  createRuntimeRepository,
  ensureRealtimeStreamGroup,
  readLatestRuntimeEvents,
  REALTIME_CONSUMER_GROUP,
  runStreamRetention,
  verifyOrLoadFunctionLibrary,
  type ManagedRedisConnection,
  type RedisFunctionRegistry,
  type RedisGateway,
  type RedisHealth,
  type RedisKeys,
} from '@luwi/redis';
import { createPresenceSweeper, createRuntimeReadiness } from '@luwi/runtime';

import { buildDaemon, type BuildDaemonOptions, type DaemonApp } from './app.js';
import {
  closeWithinDeadline,
  createBackgroundWorkTracker,
  waitForCompletion,
} from './background-work.js';
import type { DaemonConfig } from './config.js';
import { createProjectService } from './project-service.js';
import { createRealtimeRelay } from './realtime-relay.js';
import { createSessionService } from './session-service.js';
import {
  installGracefulShutdown,
  type GracefulShutdownController,
  type SignalSource,
} from './shutdown.js';
import { createWebSocketHub } from './websocket-hub.js';

export type StartDaemonConnections = {
  command: ManagedRedisConnection;
  admin: ManagedRedisConnection;
  relay: ManagedRedisConnection;
};

export type StartDaemonOptions = {
  config: DaemonConfig;
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
  drainTimeoutMs: 5_000,
  reconnectInitialMs: 250,
  reconnectMaxMs: 5_000,
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
    // The owned runtime closes its three connections in drain order.
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
  let retentionTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let recoveryPromise: Promise<void> | undefined;
  let sweeping = false;
  let retaining = false;
  const backgroundWork = createBackgroundWorkTracker();

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
  const projectService = createProjectService({
    repository,
    workspaceId: config.workspaceId,
  });
  const sessionService = createSessionService({
    repository,
    workspaceId: config.workspaceId,
    presenceTtlMs: setting(config, 'sessionPresenceTtlMs'),
    heartbeatEventIntervalMs: setting(config, 'heartbeatEventIntervalMs'),
  });

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
    repository: {
      findExpiredHeartbeatDeadlines: (nowMs, limit) =>
        repository.findExpiredHeartbeatDeadlines(nowMs, limit),
      disconnectExpiredSession: async (deadline) => {
        const session = await repository.getSession(deadline.sessionId);
        if (session === null) {
          return 'unchanged';
        }
        const result = await repository.disconnectExpiredSession({
          ...deadline,
          expectedDeadlineMs: deadline.deadlineMs,
          projectId: session.projectId,
          workspaceId: config.workspaceId,
          eventId: randomUUID(),
        });
        if (result.status === 'disconnected') {
          return 'disconnected';
        }
        return result.status === 'reconciled' ? 'reconciled' : 'unchanged';
      },
    },
  });

  const runRecovery = async (): Promise<void> => {
    transitionDegraded();
    let backoff = setting(config, 'reconnectInitialMs');
    while (readiness.state !== 'draining' && readiness.state !== 'stopped') {
      try {
        if (readiness.state === 'degraded') {
          readiness.transitionTo('recovering');
        }
        await connect(connections.command);
        await connect(connections.admin);
        await connect(connections.relay);
        if (!(await ownership.ownsLease())) {
          void shutdownRuntime();
          return;
        }
        await verifyOrLoadFunctionLibrary(connections.admin, library, ownership);
        await ensureRealtimeStreamGroup(
          connections.admin,
          keys.globalEvents,
          REALTIME_CONSUMER_GROUP,
        );
        await relay.recoverPending();
        relay.start();
        readiness.transitionTo('ready');
        return;
      } catch (error) {
        transitionDegraded();
        app?.log.error({ err: error, retryInMs: backoff }, 'Runtime recovery failed');
        await delay(backoff);
        backoff = Math.min(backoff * 2, setting(config, 'reconnectMaxMs'));
      }
    }
  };

  requestRecovery = () => {
    if (
      readiness.state === 'draining' ||
      readiness.state === 'stopped' ||
      recoveryPromise !== undefined
    ) {
      return;
    }
    recoveryPromise = runRecovery().finally(() => {
      recoveryPromise = undefined;
    });
  };

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
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
      }
      if (retentionTimer !== undefined) {
        clearInterval(retentionTimer);
      }
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
    await ensureRealtimeStreamGroup(connections.admin, keys.globalEvents, REALTIME_CONSUMER_GROUP);
    await connect(connections.relay);

    app = buildDaemon({
      config,
      redis: new ConnectionHealthGateway(connections.command),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      runtimeInstanceId,
      runtimeState: () => readiness.state,
      readiness,
      onRedisUnavailable: () => requestRecovery(),
      services: {
        projects: projectService,
        sessions: sessionService,
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
            } finally {
              retaining = false;
            }
          },
          (error) => app?.log.error({ err: error }, 'Stream retention failed'),
        );
        if (!scheduled) {
          retaining = false;
        }
      },
      setting(config, 'retentionIntervalMs'),
    );
    retentionTimer.unref?.();

    readiness.transitionTo('ready');
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    backgroundWork.stop();
    sweeper.stop();
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
    }
    if (retentionTimer !== undefined) {
      clearInterval(retentionTimer);
    }
    await backgroundWork.waitForIdle(setting(config, 'drainTimeoutMs'));
    await relay.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await ownership.release().catch(() => false);
    await Promise.all([
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
