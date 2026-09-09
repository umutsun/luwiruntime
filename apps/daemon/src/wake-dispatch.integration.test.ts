import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
  WAKE_CONSUMER_GROUP,
  type ManagedRedisConnection,
  type RedisFunctionRegistry,
  type RedisKeys,
} from '@luwi/redis';
import { describe, expect, it } from 'vitest';

import type { DaemonConfig } from './config.js';
import { startDaemon, type RunningDaemon, type StartDaemonConnections } from './runtime.js';

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

async function json<T>(
  runtime: RunningDaemon,
  method: 'GET' | 'POST',
  url: string,
  payload: object | undefined,
  expectedStatus: number,
): Promise<T> {
  if (method === 'POST' && payload === undefined) throw new TypeError('POST payload is required.');
  const response =
    method === 'POST'
      ? await runtime.app.inject({ method, url, payload: payload! })
      : await runtime.app.inject({ method, url });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return response.json<T>();
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
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const namespace = `luwi:test:${runId}:v1`;
  const registry = createFunctionRegistry(runId);
  const keys = createRedisKeys(namespace);
  const testRoot = join(tmpdir(), `luwi-wake-daemon-${runId}`);
  const projectRoot = join(testRoot, 'project');
  await mkdir(projectRoot, { recursive: true });
  const daemonConnections = connections();
  const config: DaemonConfig = {
    host: '127.0.0.1',
    port: 0,
    redisUrl: redisUrl ?? '',
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
  const project = await json<{ id: string }>(
    runtime,
    'POST',
    '/api/v1/projects',
    { name: `Wake fixture ${runId}`, localPath: projectRoot },
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
  const session = await json<{ id: string }>(
    harness.runtime,
    'POST',
    '/api/v1/sessions',
    {
      projectId: harness.projectId,
      agentId,
      workingDirectory: harness.projectRoot,
    },
    201,
  );
  return session.id;
}

async function createWakeableWorkflow(harness: Harness): Promise<{
  sourceSessionId: string;
  targetSessionId: string;
  correlationId: string;
  wakeIntentId: string;
  nativeSessionId: string;
}> {
  const sourceSessionId = await registerSession(harness, 'codex');
  const targetSessionId = await registerSession(harness, 'claude-code');
  const nativeSessionId = `native-${randomUUID()}`;
  await json(
    harness.runtime,
    'POST',
    `/api/v1/sessions/${sourceSessionId}/native`,
    {
      native: { adapterId: 'codex-native-v1', nativeSessionId },
      identityProvenance: {
        source: 'host_launcher',
        launcherInstanceId: `launcher-${randomUUID()}`,
      },
      hostWake: { adapter: 'codex-queue-v1', mcpSessionId: sourceSessionId },
    },
    200,
  );
  const created = await json<{
    workflow: { id: string };
    message: { id: string; correlationId: string };
  }>(
    harness.runtime,
    'POST',
    '/api/v1/workflows',
    {
      objective: 'Prove durable wake recovery without a realtime observer.',
      coordinatorSessionId: sourceSessionId,
      rootCorrelationId: randomUUID(),
      firstMessage: {
        targetAgentId: 'claude-code',
        kind: 'instruction',
        content: 'Return deterministic recovery evidence.',
      },
    },
    201,
  );
  await json(
    harness.runtime,
    'POST',
    `/api/v1/sessions/${targetSessionId}/inbox/claim`,
    { bridgeInstanceId: `bridge-${randomUUID()}`, limit: 1, blockMs: 0, minIdleMs: 0 },
    200,
  );
  return {
    sourceSessionId,
    targetSessionId,
    correlationId: created.message.correlationId,
    wakeIntentId: created.message.id,
    nativeSessionId,
  };
}

async function respond(harness: Harness, targetSessionId: string, correlationId: string) {
  await json(
    harness.runtime,
    'POST',
    `/api/v1/messages/${correlationId}/respond`,
    {
      responderSessionId: targetSessionId,
      response: {
        status: 'answered',
        answer: 'Recovery evidence is ready.',
        evidence: [],
        verifiedAt: new Date().toISOString(),
      },
    },
    200,
  );
}

describe.skipIf(redisUrl === undefined || !sharedFunctionsAllowed)(
  'daemon wake dispatch recovery integration',
  () => {
    it('starts the durable group at 0-0 and retains wake plus source response after WebSocket disconnect', async () => {
      if (redisUrl !== 'redis://127.0.0.1:6391') {
        throw new Error('Wake recovery integration requires dedicated Redis port 6391.');
      }
      const harness = await startHarness();
      try {
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

        const fixture = await createWakeableWorkflow(harness);
        const socket = await harness.runtime.app.injectWS('/api/v1/realtime', {
          headers: { host: '127.0.0.1:0', origin: 'http://127.0.0.1:0' },
        });
        socket.terminate();

        await respond(harness, fixture.targetSessionId, fixture.correlationId);

        const wake = await json<{ wakeIntents: Array<{ id: string; state: string }> }>(
          harness.runtime,
          'GET',
          `/api/v1/wake-intents?projectId=${harness.projectId}&limit=10`,
          undefined,
          200,
        );
        expect(wake.wakeIntents).toEqual([
          expect.objectContaining({ id: fixture.wakeIntentId, state: 'pending' }),
        ]);
        expect(JSON.stringify(wake)).not.toContain(fixture.nativeSessionId);
        await expect(
          harness.admin.sendCommand(['XLEN', harness.keys.sessionInbox(fixture.sourceSessionId)]),
        ).resolves.toBe(1);
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
      } finally {
        await cleanup(harness);
      }
    });
  },
);
