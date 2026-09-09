import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { BridgeSlotTransitionResponse } from '@luwi/protocol';
// This integration-only fixture composes the daemon's Redis seams; production CLI code stays HTTP-only.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
  type ManagedRedisConnection,
  type RedisFunctionRegistry,
  type RedisKeys,
} from '@luwi/redis';
import { ApplicationError, deriveBridgeSlotId } from '@luwi/runtime';
import { describe, expect, it } from 'vitest';

import type { DaemonConfig } from '../../daemon/src/config.js';
import {
  startDaemon,
  type RunningDaemon,
  type StartDaemonConnections,
} from '../../daemon/src/runtime.js';
import {
  createBridgeSlotOwner,
  type BridgeSlotClient,
  type BridgeSlotOwner,
} from './bridge-slot-owner.js';
import {
  createWakeSupervisor,
  type WakeCandidate,
  type WakeSupervisor,
  type WakeWorker,
  type WakeWorkerOutcome,
} from './wake-supervisor.js';

const redisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

type Harness = {
  runtime: RunningDaemon;
  admin: ManagedRedisConnection;
  keys: RedisKeys;
  registry: RedisFunctionRegistry;
  namespace: string;
  projectId: string;
  projectRoot: string;
  testRoot: string;
};

function connections(): StartDaemonConnections {
  return {
    command: createManagedRedisConnection({ url: redisUrl ?? '' }),
    admin: createManagedRedisConnection({ url: redisUrl ?? '' }),
    relay: createManagedRedisConnection({ url: redisUrl ?? '' }),
    wake: createManagedRedisConnection({ url: redisUrl ?? '' }),
  };
}

async function post<T>(runtime: RunningDaemon, path: string, payload: object): Promise<T> {
  const response = await runtime.app.inject({ method: 'POST', url: path, payload });
  if (response.statusCode >= 400) {
    const body = response.json<{ error?: { code?: string; message?: string } }>();
    throw new ApplicationError(
      body.error?.code ?? 'DAEMON_REQUEST_FAILED',
      body.error?.message ?? 'The daemon request failed.',
      response.statusCode,
    );
  }
  return response.json<T>();
}

function bridgeClient(runtime: RunningDaemon): BridgeSlotClient {
  return {
    acquire: (body) =>
      post<BridgeSlotTransitionResponse>(runtime, '/api/v1/bridge-slots/acquire', body),
    renew: (slotId, ownerToken) =>
      post<BridgeSlotTransitionResponse>(runtime, `/api/v1/bridge-slots/${slotId}/renew`, {
        ownerToken,
      }),
    release: (slotId, ownerToken) =>
      post<BridgeSlotTransitionResponse>(runtime, `/api/v1/bridge-slots/${slotId}/release`, {
        ownerToken,
      }),
  };
}

async function cleanup(harness: Harness): Promise<void> {
  await harness.runtime.shutdown.shutdown('SIGTERM');
  harness.runtime.shutdown.dispose();
  const client = createManagedRedisConnection({ url: redisUrl ?? '' });
  await client.connect();
  let cursor = '0';
  do {
    const reply = (await client.sendCommand([
      'SCAN',
      cursor,
      'MATCH',
      `${harness.namespace}:*`,
      'COUNT',
      '100',
    ])) as [string, string[]];
    cursor = reply[0];
    if (reply[1].length > 0) await client.sendCommand(['DEL', ...reply[1]]);
  } while (cursor !== '0');
  await client.sendCommand(['FUNCTION', 'DELETE', harness.registry.libraryName]).catch(() => 0);
  await client.quit();
  await rm(harness.testRoot, { recursive: true, force: true });
}

async function startHarness(): Promise<Harness> {
  if (redisUrl !== 'redis://127.0.0.1:6391') {
    throw new Error('Wake supervisor integration requires dedicated Redis port 6391.');
  }
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const namespace = `luwi:test:${runId}:v1`;
  const registry = createFunctionRegistry(runId);
  const keys = createRedisKeys(namespace);
  const testRoot = join(tmpdir(), `luwi-wake-supervisor-${runId}`);
  const projectRoot = join(testRoot, 'project');
  await mkdir(projectRoot, { recursive: true });
  const daemonConnections = connections();
  const config: DaemonConfig = {
    host: '127.0.0.1',
    port: 0,
    redisUrl,
    logLevel: 'silent',
    workspaceId: 'local',
    sessionPresenceTtlMs: 60_000,
    presenceSweepIntervalMs: 60_000,
    heartbeatEventIntervalMs: 60_000,
    consumerClaimIdleMs: 0,
    relayBlockMs: 10,
    messageTimeoutSweepIntervalMs: 60_000,
    messageTimeoutBatchSize: 10,
    wakeSweepIntervalMs: 60_000,
    wakeSweepBatchSize: 10,
    retentionIntervalMs: 60_000,
    drainTimeoutMs: 1_000,
    allowedOrigins: ['http://127.0.0.1:0'],
    luwiHome: join(testRoot, 'home'),
    nativeHome: join(testRoot, 'native-home'),
  };
  const runtime = await startDaemon({
    config,
    logger: false,
    runtimeInstanceId: `runtime-${runId}`,
    keys,
    functionRegistry: registry,
    connections: daemonConnections,
  });
  const response = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: `Wake supervisor ${runId}`, localPath: projectRoot },
  });
  expect(response.statusCode, response.body).toBe(201);
  const projectId = response.json<{ id: string }>().id;
  return {
    runtime,
    admin: daemonConnections.admin,
    keys,
    registry,
    namespace,
    projectId,
    projectRoot,
    testRoot,
  };
}

function candidate(harness: Harness): WakeCandidate {
  return {
    projectId: harness.projectId,
    agentId: 'codex',
    agentKind: 'codex',
    provider: 'codex',
    executionProfile: 'workspace-write',
    localPath: harness.projectRoot,
  };
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for supervisor convergence.');
    await delay(10);
  }
}

function workerFactory(
  client: BridgeSlotClient,
  ownerPrefix: string,
  counters: { acquisitions: number; children: string[] },
): (next: WakeCandidate) => WakeWorker {
  let workerSequence = 0;
  return (next) => {
    const ownerToken = `${ownerPrefix}-${++workerSequence}-${randomUUID()}`;
    let resolveWorker!: (outcome: WakeWorkerOutcome) => void;
    const running = new Promise<WakeWorkerOutcome>((resolve) => {
      resolveWorker = resolve;
    });
    let acquired = false;
    const owner = createBridgeSlotOwner({
      client,
      slot: next,
      ownerToken,
      onLost: () => resolveWorker('lost'),
    });
    return {
      async start() {
        counters.acquisitions += 1;
        if ((await owner.acquire()) === 'held') return 'held';
        acquired = true;
        counters.children.push(ownerToken);
        return running;
      },
      stop() {
        if (!acquired) return;
        void owner.release().finally(() => resolveWorker('stopped'));
      },
    };
  };
}

function supervisor(
  next: WakeCandidate,
  createWorker: (candidate: WakeCandidate) => WakeWorker,
): WakeSupervisor {
  return createWakeSupervisor({
    discover: async () => [next],
    createWorker,
    standbyMs: 25,
    rescanMs: 60_000,
    wait: async (milliseconds) => {
      await delay(milliseconds);
    },
  });
}

function ownerWithoutRenewal(
  client: BridgeSlotClient,
  next: WakeCandidate,
  ownerToken: string,
  errors: unknown[],
): BridgeSlotOwner {
  return createBridgeSlotOwner({
    client,
    slot: next,
    ownerToken,
    setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
    clearInterval: (() => undefined) as never,
    onLost: () => undefined,
    onError: (error) => errors.push(error),
  });
}

describe.skipIf(redisUrl === undefined || !sharedFunctionsAllowed)(
  'wake supervisor ownership integration',
  () => {
    it('converges two supervisors on one Redis slot owner and one child', async () => {
      const harness = await startHarness();
      const stats = { acquisitions: 0, children: [] as string[] };
      const next = candidate(harness);
      const client = bridgeClient(harness.runtime);
      const first = supervisor(next, workerFactory(client, 'supervisor-a', stats));
      const second = supervisor(next, workerFactory(client, 'supervisor-b', stats));
      try {
        await Promise.all([first.start(), second.start()]);
        await eventually(() => stats.acquisitions >= 2 && stats.children.length === 1);

        const slotId = deriveBridgeSlotId({
          workspaceId: 'local',
          projectId: harness.projectId,
          agentId: next.agentId,
        });
        const ownerToken = await harness.admin.sendCommand([
          'GET',
          harness.keys.bridgeSlotOwner(slotId),
        ]);
        expect(ownerToken).toBe(stats.children[0]);
        const response = await harness.runtime.app.inject({
          method: 'GET',
          url: '/api/v1/bridge-slots?limit=10',
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          slots: [expect.objectContaining({ id: slotId, state: 'active' })],
        });
        expect(response.body).not.toContain(String(ownerToken));
        expect(stats.children).toHaveLength(1);
      } finally {
        await Promise.allSettled([first.stop(), second.stop()]);
        await cleanup(harness);
      }
    });

    it('lets Redis TTL choose a replacement and rejects the expired owner token', async () => {
      const harness = await startHarness();
      try {
        const next = candidate(harness);
        const client = bridgeClient(harness.runtime);
        const staleErrors: unknown[] = [];
        const staleToken = `stale-${randomUUID()}`;
        const replacementToken = `replacement-${randomUUID()}`;
        const stale = ownerWithoutRenewal(client, next, staleToken, staleErrors);
        const replacement = ownerWithoutRenewal(client, next, replacementToken, []);
        await expect(stale.acquire()).resolves.toBe('acquired');
        const slotId = stale.declaration!.slotId;

        await eventually(
          async () =>
            (await harness.admin.sendCommand(['PTTL', harness.keys.bridgeSlotOwner(slotId)])) ===
            -2,
          17_000,
        );
        await expect(replacement.acquire()).resolves.toBe('acquired');
        await stale.release();

        expect(staleErrors).toEqual([expect.objectContaining({ code: 'BRIDGE_SLOT_NOT_OWNER' })]);
        await expect(
          harness.admin.sendCommand(['GET', harness.keys.bridgeSlotOwner(slotId)]),
        ).resolves.toBe(replacementToken);
        const response = await harness.runtime.app.inject({
          method: 'GET',
          url: `/api/v1/bridge-slots/${slotId}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ state: 'active', revision: 3 });
        await replacement.release();
      } finally {
        await cleanup(harness);
      }
    }, 25_000);
  },
);
