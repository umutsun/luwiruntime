import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
  type ManagedRedisConnection,
} from '@luwi/redis';
import { afterAll, describe, expect, it } from 'vitest';

import type { DaemonConfig } from './config.js';
import { startDaemon, type RunningDaemon } from './runtime.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'owned daemon runtime integration',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const config: DaemonConfig = {
      host: '127.0.0.1',
      port: 48_782,
      redisUrl: testRedisUrl ?? '',
      logLevel: 'silent',
      workspaceId: 'local',
      sessionPresenceTtlMs: 5_000,
      presenceSweepIntervalMs: 50,
      heartbeatEventIntervalMs: 100,
      consumerClaimIdleMs: 0,
      relayBlockMs: 25,
      messageTimeoutSweepIntervalMs: 25,
      messageTimeoutBatchSize: 10,
      retentionIntervalMs: 60_000,
      drainTimeoutMs: 1_000,
      allowedOrigins: ['http://127.0.0.1:48782'],
    };
    let runtime: RunningDaemon | undefined;

    function connections(): {
      command: ManagedRedisConnection;
      admin: ManagedRedisConnection;
      relay: ManagedRedisConnection;
    } {
      return {
        command: createManagedRedisConnection({ url: testRedisUrl ?? '' }),
        admin: createManagedRedisConnection({ url: testRedisUrl ?? '' }),
        relay: createManagedRedisConnection({ url: testRedisUrl ?? '' }),
      };
    }

    afterAll(async () => {
      await runtime?.shutdown.shutdown('SIGTERM');
      runtime?.shutdown.dispose();
      const cleanup = createManagedRedisConnection({ url: testRedisUrl ?? '' });
      await cleanup.connect();
      let cursor = '0';
      do {
        const reply = (await cleanup.sendCommand([
          'SCAN',
          cursor,
          'MATCH',
          `${namespace}:*`,
          'COUNT',
          '100',
        ])) as [string, string[]];
        cursor = reply[0];
        if (reply[1].length > 0) {
          await cleanup.sendCommand(['DEL', ...reply[1]]);
        }
      } while (cursor !== '0');
      await cleanup.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]).catch(() => 0);
      await cleanup.quit();
    });

    it('boots in order, rejects a second owner, and serves projects, sessions, and messages', async () => {
      const firstConnections = connections();
      runtime = await startDaemon({
        config,
        logger: false,
        runtimeInstanceId: 'runtime-first',
        keys,
        functionRegistry: registry,
        connections: firstConnections,
      });
      expect(runtime.runtimeState()).toBe('ready');
      expect((await runtime.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      await expect(
        runtime.app.injectWS('/api/v1/realtime', {
          headers: {
            host: '127.0.0.1:48782',
            origin: 'http://evil.test',
          },
        }),
      ).rejects.toThrow('Unexpected server response: 403');
      await expect(
        runtime.app.injectWS('/api/v1/not-realtime', {
          headers: {
            host: '127.0.0.1:48782',
            origin: 'http://127.0.0.1:48782',
          },
        }),
      ).rejects.toThrow('Unexpected server response: 404');
      const nativeSocket = new WebSocket('ws://127.0.0.1:48782/api/v1/realtime');
      await new Promise<void>((resolve, reject) => {
        nativeSocket.addEventListener('open', () => resolve(), { once: true });
        nativeSocket.addEventListener('error', () => reject(new Error('Native WebSocket failed')), {
          once: true,
        });
      });
      nativeSocket.close();

      await expect(
        startDaemon({
          config,
          logger: false,
          runtimeInstanceId: 'runtime-second',
          keys,
          functionRegistry: registry,
          connections: connections(),
        }),
      ).rejects.toMatchObject({ code: 'DAEMON_ALREADY_RUNNING' });

      const projectResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: { name: 'LUWI Runtime', localPath: process.cwd() },
      });
      expect(projectResponse.statusCode).toBe(201);
      const project = projectResponse.json<{ id: string }>();
      const duplicate = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: { name: 'Duplicate', localPath: `${process.cwd()}/` },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.headers.location).toBe(`/api/v1/projects/${project.id}`);

      const sessionResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {
          projectId: project.id,
          agentId: 'codex-sim',
          workingDirectory: process.cwd(),
        },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const session = sessionResponse.json<{ id: string }>();
      expect(session.id).toBeTruthy();
      const targetResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {
          projectId: project.id,
          agentId: 'gemini-sim',
          workingDirectory: process.cwd(),
        },
      });
      expect(targetResponse.statusCode).toBe(201);
      const target = targetResponse.json<{ id: string }>();

      const requested = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/messages',
        headers: { 'idempotency-key': 'runtime-integration-request' },
        payload: {
          sourceSessionId: session.id,
          targetSessionId: target.id,
          kind: 'status_request',
          content: 'Report simulated status.',
          evidenceRequirements: ['session_state'],
          timeoutMs: 5_000,
        },
      });
      expect(requested.statusCode).toBe(202);
      const correlationId = requested.json<{ message: { correlationId: string } }>().message
        .correlationId;
      const claimed = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${target.id}/inbox/claim`,
        payload: {
          bridgeInstanceId: 'integration-bridge',
          limit: 10,
          blockMs: 0,
          minIdleMs: 0,
        },
      });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.json<{ items: Array<{ correlationId: string }> }>().items).toEqual([
        expect.objectContaining({ correlationId }),
      ]);
      for (const action of ['acknowledge', 'processing'] as const) {
        expect(
          (
            await runtime.app.inject({
              method: 'POST',
              url: `/api/v1/messages/${correlationId}/${action}`,
              payload: { responderSessionId: target.id },
            })
          ).statusCode,
        ).toBe(200);
      }
      const responded = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/messages/${correlationId}/respond`,
        payload: {
          responderSessionId: target.id,
          response: {
            status: 'answered',
            answer: 'Simulated integration status.',
            evidence: [
              {
                type: 'session_state',
                summary: 'Simulated daemon integration evidence.',
                metadata: { simulated: true },
              },
            ],
            verifiedAt: new Date().toISOString(),
          },
        },
      });
      expect(responded.statusCode).toBe(200);
      expect(
        (
          await runtime.app.inject({
            method: 'GET',
            url: `/api/v1/messages/${correlationId}/wait?waitMs=100`,
          })
        ).json(),
      ).toMatchObject({ state: 'responded', response: { status: 'answered' } });
      const idempotentRetry = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/messages',
        headers: { 'idempotency-key': 'runtime-integration-request' },
        payload: {
          sourceSessionId: session.id,
          targetSessionId: target.id,
          kind: 'status_request',
          content: 'Report simulated status.',
          evidenceRequirements: ['session_state'],
          timeoutMs: 5_000,
        },
      });
      expect(idempotentRetry.statusCode).toBe(200);
      expect(idempotentRetry.json()).toMatchObject({
        idempotent: true,
        message: { correlationId, state: 'responded' },
      });
      const responseInbox = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/inbox/claim`,
        payload: {
          bridgeInstanceId: 'integration-source',
          limit: 10,
          blockMs: 0,
          minIdleMs: 0,
        },
      });
      expect(responseInbox.json()).toMatchObject({
        items: [expect.objectContaining({ itemKind: 'response', correlationId })],
      });

      const timeoutRequest = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: {
          sourceSessionId: session.id,
          targetSessionId: target.id,
          kind: 'question',
          content: 'No response expected.',
          timeoutMs: 1,
        },
      });
      expect(timeoutRequest.statusCode).toBe(202);
      const timeoutCorrelation = timeoutRequest.json<{ message: { correlationId: string } }>()
        .message.correlationId;
      const timeoutDeadline = Date.now() + 1_000;
      let timeoutState = 'queued';
      while (timeoutState !== 'timed_out' && Date.now() < timeoutDeadline) {
        await delay(10);
        const timeoutProjection = await runtime.app.inject({
          method: 'GET',
          url: `/api/v1/messages/${timeoutCorrelation}`,
        });
        if (timeoutProjection.statusCode !== 200) {
          throw new Error(
            `Timeout projection failed: ${timeoutProjection.statusCode} ${timeoutProjection.body}`,
          );
        }
        timeoutState = timeoutProjection.json<{ state: string }>().state;
      }
      expect(timeoutState).toBe('timed_out');

      const socket = await runtime.app.injectWS('/api/v1/realtime', {
        headers: {
          host: '127.0.0.1:48782',
          origin: 'http://127.0.0.1:48782',
        },
      });
      const received = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket event timeout')), 2_000);
        socket.once('message', (data) => {
          clearTimeout(timeout);
          resolve(data.toString());
        });
      });
      const status = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/status`,
        payload: { status: 'tool_running' },
      });
      expect(status.statusCode).toBe(200);
      expect(JSON.parse(await received)).toMatchObject({
        event: {
          type: 'session.status.changed',
          sessionId: session.id,
        },
      });
      socket.terminate();

      const events = await runtime.app.inject({
        method: 'GET',
        url: '/api/v1/events?limit=100',
      });
      expect(events.statusCode).toBe(200);
      expect(events.json<{ events: unknown[] }>().events.length).toBeGreaterThanOrEqual(3);

      firstConnections.command.disconnect();
      const unavailableRead = await runtime.app.inject({
        method: 'GET',
        url: '/api/v1/projects',
      });
      expect(unavailableRead.statusCode).toBe(503);
      expect(unavailableRead.json()).toMatchObject({
        error: { code: 'RUNTIME_NOT_READY' },
      });
      const recoveryDeadline = Date.now() + 2_000;
      while (runtime.runtimeState() !== 'ready' && Date.now() < recoveryDeadline) {
        await delay(10);
      }
      expect(runtime.runtimeState()).toBe('ready');
      expect(
        (await runtime.app.inject({ method: 'GET', url: '/api/v1/projects' })).statusCode,
      ).toBe(200);

      await runtime.shutdown.shutdown('SIGTERM');
      runtime.shutdown.dispose();
      expect(runtime.runtimeState()).toBe('stopped');
      await delay(10);
    });
  },
);
