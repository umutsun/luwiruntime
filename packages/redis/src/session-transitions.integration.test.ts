import { randomUUID } from 'node:crypto';

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
  'session transition Functions',
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
          name: 'Sessions',
          localPath: 'C:/workspace/luwi',
          canonicalPath: 'C:/workspace/luwi',
          identityPath: 'c:/workspace/luwi',
          pathIdentityHash: 'd'.repeat(64),
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

    it('accepts unseen opaque agents, multiple sessions, and creates only derived indexes', async () => {
      for (const suffix of ['1', '2']) {
        await expect(
          repository.registerSession({
            session: {
              id: `session-${suffix}`,
              agentId: 'codex-sim',
              projectId: 'project-1',
              status: 'starting',
              workingDirectory: 'C:/workspace/luwi',
              metadataJson: '{"source":"integration"}',
            },
            workspaceId: 'local',
            eventId: `event-session-${suffix}`,
            presenceTtlMs: 15_000,
          }),
        ).resolves.toMatchObject({
          status: 'created',
          session: { id: `session-${suffix}`, agentId: 'codex-sim' },
        });
      }

      await expect(
        commandClient.sendCommand(['SMEMBERS', keys.agentSessions('codex-sim')]),
      ).resolves.toEqual(expect.arrayContaining(['session-1', 'session-2']));
      await expect(
        commandClient.sendCommand(['SMEMBERS', keys.projectSessions('project-1')]),
      ).resolves.toEqual(expect.arrayContaining(['session-1', 'session-2']));
      await expect(
        commandClient.sendCommand(['EXISTS', `${namespace}:agent:codex-sim`]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['PTTL', keys.sessionPresence('session-1')]),
      ).resolves.toBeGreaterThan(0);
    });

    it('persists allowed status changes and emits nothing for unchanged or terminal requests', async () => {
      const globalBefore = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));
      const updated = await repository.updateSessionStatus({
        sessionId: 'session-1',
        projectId: 'project-1',
        targetStatus: 'idle',
        workspaceId: 'local',
        eventId: 'event-status-idle',
      });
      const unchanged = await repository.updateSessionStatus({
        sessionId: 'session-1',
        projectId: 'project-1',
        targetStatus: 'idle',
        workspaceId: 'local',
        eventId: 'event-status-same',
      });
      const completed = await repository.updateSessionStatus({
        sessionId: 'session-1',
        projectId: 'project-1',
        targetStatus: 'completed',
        workspaceId: 'local',
        eventId: 'event-status-completed',
      });
      const terminal = await repository.updateSessionStatus({
        sessionId: 'session-1',
        projectId: 'project-1',
        targetStatus: 'thinking',
        workspaceId: 'local',
        eventId: 'event-status-terminal',
      });

      expect(updated).toMatchObject({ status: 'updated', currentStatus: 'idle' });
      expect(unchanged).toEqual({ status: 'unchanged', currentStatus: 'idle' });
      expect(completed).toMatchObject({ status: 'updated', currentStatus: 'completed' });
      expect(terminal).toEqual({ status: 'terminal', currentStatus: 'completed' });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalBefore + 2,
      );
      await expect(
        commandClient.sendCommand(['EXISTS', keys.sessionPresence('session-1')]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['ZSCORE', keys.heartbeatDeadlines, 'session-1']),
      ).resolves.toBeNull();
    });

    it('returns validated online/offline views from Redis state', async () => {
      await expect(repository.getSession('session-1')).resolves.toMatchObject({
        id: 'session-1',
        status: 'completed',
        presence: 'offline',
      });
      await expect(repository.getSession('session-2')).resolves.toMatchObject({
        id: 'session-2',
        status: 'starting',
        presence: 'online',
      });
      await expect(repository.listSessions('project-1')).resolves.toHaveLength(2);
    });
  },
);
