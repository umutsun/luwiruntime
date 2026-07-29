import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createRedisKeys,
  createRuntimeRepository,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'session heartbeat and presence Functions',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let repository: RuntimeRepository;

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      repository = createRuntimeRepository({ client: commandClient, keys, functions: registry });
      await repository.registerProject({
        project: {
          id: 'project-1',
          name: 'Presence',
          localPath: 'C:/workspace/luwi',
          canonicalPath: 'C:/workspace/luwi',
          identityPath: 'c:/workspace/luwi',
          pathIdentityHash: 'e'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-project',
      });
    });

    afterAll(async () => {
      if (client?.isOpen) {
        let cursor = '0';
        do {
          const reply = (await commandClient.sendCommand([
            'SCAN',
            cursor,
            'MATCH',
            `${namespace}:*`,
            'COUNT',
            '100',
          ])) as [string, string[]];
          cursor = reply[0];
          if (reply[1].length > 0) {
            await commandClient.sendCommand(['DEL', ...reply[1]]);
          }
        } while (cursor !== '0');
        await commandClient.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]);
        await client.quit();
      }
    });

    async function register(sessionId: string, ttl = 15_000): Promise<void> {
      await repository.registerSession({
        session: {
          id: sessionId,
          agentId: 'codex-sim',
          projectId: 'project-1',
          status: 'starting',
          workingDirectory: 'C:/workspace/luwi',
          metadataJson: '{"source":"integration"}',
        },
        workspaceId: 'local',
        eventId: `event-${sessionId}`,
        presenceTtlMs: ttl,
      });
    }

    it('uses Redis time and samples heartbeat events while renewing every heartbeat', async () => {
      await register('session-heartbeat');
      const first = await repository.heartbeatSession({
        sessionId: 'session-heartbeat',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-heartbeat-1',
        presenceTtlMs: 15_000,
        eventIntervalMs: 30_000,
      });
      const second = await repository.heartbeatSession({
        sessionId: 'session-heartbeat',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-heartbeat-2',
        presenceTtlMs: 15_000,
        eventIntervalMs: 30_000,
      });
      const metadataChange = await repository.heartbeatSession({
        sessionId: 'session-heartbeat',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-heartbeat-3',
        presenceTtlMs: 15_000,
        eventIntervalMs: 30_000,
        metadataJson: '{"branchHead":"abc"}',
      });

      expect(first).toMatchObject({ status: 'renewed', eventEmitted: true });
      expect(second).toMatchObject({ status: 'renewed', eventEmitted: false });
      expect(metadataChange).toMatchObject({ status: 'renewed', eventEmitted: true });
      await expect(repository.getSession('session-heartbeat')).resolves.toMatchObject({
        id: 'session-heartbeat',
        presence: 'online',
      });
      if (first.status !== 'renewed') {
        throw new Error('Expected a renewed heartbeat');
      }
      expect(Math.abs(Date.parse(first.lastHeartbeatAt) - Date.now())).toBeLessThan(5_000);
      await expect(
        commandClient.sendCommand(['PTTL', keys.sessionPresence('session-heartbeat')]),
      ).resolves.toBeGreaterThan(10_000);
    });

    it('closes gracefully exactly once and rejects later heartbeats as terminal', async () => {
      await register('session-close');
      const closed = await repository.closeSession({
        sessionId: 'session-close',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-close',
      });
      const repeated = await repository.closeSession({
        sessionId: 'session-close',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-close-repeat',
      });
      const heartbeat = await repository.heartbeatSession({
        sessionId: 'session-close',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-heartbeat-terminal',
        presenceTtlMs: 15_000,
        eventIntervalMs: 30_000,
      });

      expect(closed).toMatchObject({ status: 'completed' });
      expect(repeated).toEqual({ status: 'unchanged', currentStatus: 'completed' });
      expect(heartbeat).toEqual({ status: 'terminal', currentStatus: 'completed' });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.sessionPresence('session-close')]),
      ).resolves.toBe(0);
    });

    it('disconnects expired sessions and reconciles heartbeat races', async () => {
      await register('session-expired', 40);
      await delay(70);
      const candidates = await repository.findExpiredHeartbeatDeadlines(Date.now(), 10);
      const expired = candidates.find(({ sessionId }) => sessionId === 'session-expired');
      expect(expired).toBeDefined();
      if (expired === undefined) {
        throw new Error('Expected an expired deadline');
      }
      await expect(
        repository.disconnectExpiredSession({
          ...expired,
          expectedDeadlineMs: expired.deadlineMs,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: 'event-disconnected',
        }),
      ).resolves.toMatchObject({ status: 'disconnected' });

      await register('session-race');
      const score = Number(
        await commandClient.sendCommand(['ZSCORE', keys.heartbeatDeadlines, 'session-race']),
      );
      await expect(
        repository.disconnectExpiredSession({
          sessionId: 'session-race',
          projectId: 'project-1',
          expectedDeadlineMs: score,
          workspaceId: 'local',
          eventId: 'event-reconcile',
        }),
      ).resolves.toMatchObject({ status: 'reconciled' });
      await expect(repository.getSession('session-race')).resolves.toMatchObject({
        status: 'starting',
        presence: 'online',
      });
    });
  },
);
