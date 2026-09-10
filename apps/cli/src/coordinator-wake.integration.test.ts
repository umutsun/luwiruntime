import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  WakeIntentClaimRequest,
  WakeIntentClaimResponse,
  WakeIntentCompleteRequest,
  WakeIntentCompleteResponse,
  WakeIntentDispatchingRequest,
  WakeIntentDispatchingResponse,
  WakeIntentRecoverRequest,
  WakeIntentRecoverResponse,
  WakeIntentView,
} from '@luwi/protocol';
// This integration-only fixture composes the daemon's Redis seams; production CLI code stays HTTP-only.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
  WAKE_CONSUMER_GROUP,
  type ManagedRedisConnection,
  type RedisFunctionRegistry,
  type RedisKeys,
} from '@luwi/redis';
import { ApplicationError } from '@luwi/runtime';
import { describe, expect, it } from 'vitest';

import type { DaemonConfig } from '../../daemon/src/config.js';
import {
  startDaemon,
  type RunningDaemon,
  type StartDaemonConnections,
} from '../../daemon/src/runtime.js';
import {
  createCoordinatorWakeDispatcher,
  type CoordinatorWakeClient,
  type WakeQueueChild,
  type WakeQueueSpawn,
} from './coordinator-wake.js';

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

type WakeFixture = {
  sourceSessionId: string;
  targetSessionId: string;
  correlationId: string;
  wakeIntentId: string;
  nativeSessionId: string;
};

type QueueCall = {
  command: string;
  arguments: readonly string[];
  options: Parameters<WakeQueueSpawn>[2];
};

function connections(): StartDaemonConnections {
  return {
    command: createManagedRedisConnection({ url: redisUrl ?? '' }),
    admin: createManagedRedisConnection({ url: redisUrl ?? '' }),
    relay: createManagedRedisConnection({ url: redisUrl ?? '' }),
    wake: createManagedRedisConnection({ url: redisUrl ?? '' }),
  };
}

async function injectJson<T>(
  runtime: RunningDaemon,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  expectedStatus = 200,
): Promise<T> {
  if (method === 'POST' && payload === undefined) throw new TypeError('POST payload is required.');
  const response =
    method === 'POST'
      ? await runtime.app.inject({ method, url, payload: payload! })
      : await runtime.app.inject({ method, url });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return response.json<T>();
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

function wakeClient(runtime: RunningDaemon, immediate = false): CoordinatorWakeClient {
  return {
    claim: (input: WakeIntentClaimRequest) =>
      post<WakeIntentClaimResponse>(runtime, '/api/v1/wake-intents/claim', {
        ...input,
        ...(immediate ? { blockMs: 0, minIdleMs: 0 } : {}),
      }),
    recover: (input: WakeIntentRecoverRequest) =>
      post<WakeIntentRecoverResponse>(runtime, '/api/v1/wake-intents/recover', {
        ...input,
        ...(immediate ? { minIdleMs: 0 } : {}),
      }),
    markDispatching: (intentId: string, input: WakeIntentDispatchingRequest) =>
      post<WakeIntentDispatchingResponse>(
        runtime,
        `/api/v1/wake-intents/${intentId}/dispatching`,
        input,
      ),
    complete: (intentId: string, input: WakeIntentCompleteRequest) =>
      post<WakeIntentCompleteResponse>(runtime, `/api/v1/wake-intents/${intentId}/complete`, input),
  };
}

function successfulQueue(calls: QueueCall[]): WakeQueueSpawn {
  return (command, arguments_, options) => {
    calls.push({ command, arguments: arguments_, options });
    let onSpawn: (() => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const child = {
      once(event: string, listener: unknown) {
        if (event === 'spawn') onSpawn = listener as () => void;
        if (event === 'error') onError = listener as (error: Error) => void;
        if (event === 'exit') {
          onExit = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
        }
        return child;
      },
    } as unknown as WakeQueueChild;
    queueMicrotask(() => {
      onSpawn?.();
      onExit?.(0, null);
      void onError;
    });
    return child;
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
    throw new Error('Wake recovery integration requires dedicated Redis port 6391.');
  }
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const namespace = `luwi:test:${runId}:v1`;
  const registry = createFunctionRegistry(runId);
  const keys = createRedisKeys(namespace);
  const testRoot = join(tmpdir(), `luwi-coordinator-wake-${runId}`);
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
  const project = await injectJson<{ id: string }>(
    runtime,
    'POST',
    '/api/v1/projects',
    { name: `Coordinator wake ${runId}`, localPath: projectRoot },
    201,
  );
  return {
    runtime,
    admin: daemonConnections.admin,
    keys,
    registry,
    namespace,
    projectId: project.id,
    projectRoot,
    testRoot,
  };
}

async function registerSession(harness: Harness, agentId: string): Promise<string> {
  return (
    await injectJson<{ id: string }>(
      harness.runtime,
      'POST',
      '/api/v1/sessions',
      {
        projectId: harness.projectId,
        agentId,
        workingDirectory: harness.projectRoot,
      },
      201,
    )
  ).id;
}

async function seedWake(harness: Harness): Promise<WakeFixture> {
  const sourceSessionId = await registerSession(harness, 'codex');
  const targetSessionId = await registerSession(harness, 'claude-code');
  const nativeSessionId = `native-${randomUUID()}`;
  await injectJson(harness.runtime, 'POST', `/api/v1/sessions/${sourceSessionId}/native`, {
    native: { adapterId: 'codex-native-v1', nativeSessionId },
    identityProvenance: {
      source: 'host_launcher',
      launcherInstanceId: `launcher-${randomUUID()}`,
    },
    hostWake: { adapter: 'codex-queue-v1', mcpSessionId: sourceSessionId },
  });
  const created = await injectJson<{
    message: { id: string; correlationId: string };
  }>(
    harness.runtime,
    'POST',
    '/api/v1/workflows',
    {
      objective: 'Prove coordinator wake recovery.',
      coordinatorSessionId: sourceSessionId,
      rootCorrelationId: randomUUID(),
      firstMessage: {
        targetAgentId: 'claude-code',
        kind: 'instruction',
        content: 'Return one durable response.',
      },
    },
    201,
  );
  await injectJson(harness.runtime, 'POST', `/api/v1/sessions/${targetSessionId}/inbox/claim`, {
    bridgeInstanceId: `bridge-${randomUUID()}`,
    limit: 1,
    blockMs: 0,
    minIdleMs: 0,
  });
  await injectJson(
    harness.runtime,
    'POST',
    `/api/v1/messages/${created.message.correlationId}/respond`,
    {
      responderSessionId: targetSessionId,
      response: {
        status: 'answered',
        answer: 'The durable response is ready.',
        evidence: [],
        verifiedAt: new Date().toISOString(),
      },
    },
  );
  return {
    sourceSessionId,
    targetSessionId,
    correlationId: created.message.correlationId,
    wakeIntentId: created.message.id,
    nativeSessionId,
  };
}

async function sourceInbox(harness: Harness, sourceSessionId: string): Promise<unknown> {
  return harness.admin.sendCommand([
    'XRANGE',
    harness.keys.sessionInbox(sourceSessionId),
    '-',
    '+',
  ]);
}

async function wake(harness: Harness, intentId: string): Promise<WakeIntentView> {
  const response = await injectJson<{ wakeIntents: WakeIntentView[] }>(
    harness.runtime,
    'GET',
    `/api/v1/wake-intents?projectId=${harness.projectId}&limit=20`,
  );
  const intent = response.wakeIntents.find((candidate) => candidate.id === intentId);
  expect(intent).toBeDefined();
  return intent!;
}

function dispatcher(harness: Harness, instanceId: string, calls: QueueCall[], attemptId: string) {
  return createCoordinatorWakeDispatcher({
    client: wakeClient(harness.runtime, true),
    dispatcherInstanceId: instanceId,
    resolveQueueExecutable: async () => '/trusted/codex',
    environment: {},
    spawn: successfulQueue(calls),
    randomUUID: () => attemptId,
    queueTimeoutMs: 1_000,
  });
}

describe.skipIf(redisUrl === undefined || !sharedFunctionsAllowed)(
  'coordinator wake recovery integration',
  () => {
    it('dispatches one preexisting response from the 0-0 group and leaves the source inbox untouched', async () => {
      const harness = await startHarness();
      try {
        const fixture = await seedWake(harness);
        const before = await sourceInbox(harness, fixture.sourceSessionId);
        await expect(
          harness.admin.sendCommand(['XINFO', 'GROUPS', harness.keys.wakeStream]),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: WAKE_CONSUMER_GROUP,
              'last-delivered-id': '0-0',
            }),
          ]),
        );
        const calls: QueueCall[] = [];
        const restarted = dispatcher(harness, 'dispatcher-restarted', calls, 'attempt-restarted');

        await expect(restarted.runOnce()).resolves.toMatchObject({
          state: 'dispatched',
          intentId: fixture.wakeIntentId,
          reasonCode: 'queue_accepted',
        });
        await expect(restarted.runOnce()).resolves.toMatchObject({ state: 'idle' });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          command: '/trusted/codex',
          arguments: [
            'queue',
            '--thread',
            fixture.nativeSessionId,
            '--message',
            expect.any(String),
          ],
          options: { shell: false, windowsHide: true, stdio: 'ignore' },
        });
        expect(JSON.stringify(calls)).not.toContain('The durable response is ready.');
        await expect(wake(harness, fixture.wakeIntentId)).resolves.toMatchObject({
          state: 'dispatched',
          reasonCode: 'queue_accepted',
        });
        expect(await sourceInbox(harness, fixture.sourceSessionId)).toEqual(before);
        expect(
          (
            (await harness.admin.sendCommand([
              'XPENDING',
              harness.keys.wakeStream,
              WAKE_CONSUMER_GROUP,
            ])) as unknown[]
          )[0],
        ).toBe(0);
      } finally {
        await cleanup(harness);
      }
    });

    it('reclaims a claimed crash window and dispatches exactly once under the new owner', async () => {
      const harness = await startHarness();
      try {
        const fixture = await seedWake(harness);
        const before = await sourceInbox(harness, fixture.sourceSessionId);
        const crashed = wakeClient(harness.runtime);
        const original = await crashed.claim({
          dispatcherInstanceId: 'dispatcher-crashed',
          limit: 1,
          blockMs: 0,
          minIdleMs: 0,
        });
        expect(original.items).toHaveLength(1);

        const calls: QueueCall[] = [];
        const replacement = dispatcher(
          harness,
          'dispatcher-replacement',
          calls,
          'attempt-reclaimed',
        );
        await expect(replacement.recover()).resolves.toMatchObject({
          state: 'dispatched',
          intentId: fixture.wakeIntentId,
          recoveredDispatching: 0,
        });
        await expect(replacement.runOnce()).resolves.toMatchObject({ state: 'idle' });

        expect(calls).toHaveLength(1);
        expect(await sourceInbox(harness, fixture.sourceSessionId)).toEqual(before);
        expect(
          (
            (await harness.admin.sendCommand([
              'XPENDING',
              harness.keys.wakeStream,
              WAKE_CONSUMER_GROUP,
            ])) as unknown[]
          )[0],
        ).toBe(0);
      } finally {
        await cleanup(harness);
      }
    });

    it('recovers dispatching as indeterminate and never replays the host command', async () => {
      const harness = await startHarness();
      try {
        const fixture = await seedWake(harness);
        const before = await sourceInbox(harness, fixture.sourceSessionId);
        const crashed = wakeClient(harness.runtime);
        const original = await crashed.claim({
          dispatcherInstanceId: 'dispatcher-before-crash',
          limit: 1,
          blockMs: 0,
          minIdleMs: 0,
        });
        const claim = original.items[0];
        expect(claim).toBeDefined();
        await crashed.markDispatching(fixture.wakeIntentId, {
          dispatcherInstanceId: 'dispatcher-before-crash',
          claimId: claim!.claimId,
          attemptId: 'attempt-before-crash',
        });

        const calls: QueueCall[] = [];
        const replacement = dispatcher(
          harness,
          'dispatcher-after-crash',
          calls,
          'attempt-after-crash',
        );
        await expect(replacement.recover()).resolves.toMatchObject({
          state: 'indeterminate',
          intentId: fixture.wakeIntentId,
          reasonCode: 'dispatcher_recovered',
          recoveredDispatching: 1,
        });
        await expect(replacement.runOnce()).resolves.toMatchObject({ state: 'idle' });

        expect(calls).toHaveLength(0);
        await expect(wake(harness, fixture.wakeIntentId)).resolves.toMatchObject({
          state: 'indeterminate',
          reasonCode: 'dispatcher_recovered',
        });
        expect(await sourceInbox(harness, fixture.sourceSessionId)).toEqual(before);
        expect(
          (
            (await harness.admin.sendCommand([
              'XPENDING',
              harness.keys.wakeStream,
              WAKE_CONSUMER_GROUP,
            ])) as unknown[]
          )[0],
        ).toBe(0);
      } finally {
        await cleanup(harness);
      }
    });

    it('falls back without spawning when native binding evidence becomes stale', async () => {
      const harness = await startHarness();
      try {
        const fixture = await seedWake(harness);
        const before = await sourceInbox(harness, fixture.sourceSessionId);
        await harness.admin.sendCommand([
          'DEL',
          harness.keys.sessionNativeBinding(fixture.sourceSessionId),
        ]);
        const calls: QueueCall[] = [];
        const current = dispatcher(harness, 'dispatcher-fallback', calls, 'attempt-fallback');

        await expect(current.runOnce()).resolves.toMatchObject({
          state: 'fallback_only',
          intentId: fixture.wakeIntentId,
          reasonCode: 'native_binding_stale',
        });

        expect(calls).toHaveLength(0);
        const publicIntent = await wake(harness, fixture.wakeIntentId);
        expect(publicIntent).toMatchObject({
          state: 'fallback_only',
          reasonCode: 'native_binding_stale',
        });
        expect(JSON.stringify(publicIntent)).not.toContain(fixture.nativeSessionId);
        expect(await sourceInbox(harness, fixture.sourceSessionId)).toEqual(before);
      } finally {
        await cleanup(harness);
      }
    });
  },
);
