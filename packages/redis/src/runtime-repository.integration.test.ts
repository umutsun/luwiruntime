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
  'project Function integration',
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
      commandClient = {
        sendCommand: (arguments_) => client.sendCommand([...arguments_]),
      };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      repository = createRuntimeRepository({
        client: commandClient,
        keys,
        functions: registry,
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

    it('registers once and returns an atomic duplicate conflict without a second event', async () => {
      const input = {
        project: {
          id: 'project-1',
          name: 'LUWI Runtime',
          localPath: 'C:/workspace/luwi',
          canonicalPath: 'C:/workspace/luwi',
          identityPath: 'c:/workspace/luwi',
          pathIdentityHash: 'a'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-1',
      };

      const created = await repository.registerProject(input);
      const duplicate = await repository.registerProject({
        ...input,
        project: { ...input.project, id: 'project-2' },
        eventId: 'event-2',
      });

      expect(created).toMatchObject({
        status: 'created',
        event: {
          id: 'event-1',
          type: 'project.registered',
        },
      });
      expect(duplicate).toEqual({
        status: 'conflict',
        reason: 'duplicate',
        existingProjectId: 'project-1',
        canonicalPath: 'C:/workspace/luwi',
      });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(1);
      await expect(
        commandClient.sendCommand(['XLEN', keys.projectEvents('project-1')]),
      ).resolves.toBe(1);
      await expect(
        commandClient.sendCommand(['HGET', keys.project('project-1'), 'identityPath']),
      ).resolves.toBe('c:/workspace/luwi');

      if (created.status !== 'created') {
        throw new Error('Expected project creation');
      }
      expect(created.globalStreamId).toMatch(/^\d+-\d+$/);
      expect(created.projectStreamId).toMatch(/^\d+-\d+$/);
      expect(created.event.id).toBe('event-1');
    });

    it('distinguishes a path-hash collision from a duplicate', async () => {
      const result = await repository.registerProject({
        project: {
          id: 'project-collision',
          name: 'Other',
          localPath: 'C:/workspace/other',
          canonicalPath: 'C:/workspace/other',
          identityPath: 'c:/workspace/other',
          pathIdentityHash: 'a'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-collision',
      });

      expect(result).toEqual({
        status: 'conflict',
        reason: 'hash_collision',
      });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.project('project-collision')]),
      ).resolves.toBe(0);
    });

    it('serializes concurrent registrations so exactly one project wins', async () => {
      const base = {
        name: 'Concurrent',
        localPath: 'C:/workspace/concurrent',
        canonicalPath: 'C:/workspace/concurrent',
        identityPath: 'c:/workspace/concurrent',
        pathIdentityHash: 'b'.repeat(64),
      };
      const results = await Promise.all([
        repository.registerProject({
          project: { ...base, id: 'project-concurrent-1' },
          workspaceId: 'local',
          eventId: 'event-concurrent-1',
        }),
        repository.registerProject({
          project: { ...base, id: 'project-concurrent-2' },
          workspaceId: 'local',
          eventId: 'event-concurrent-2',
        }),
      ]);

      expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);
    });

    it('preflights key types and leaves no partial state or event', async () => {
      const projectId = 'project-wrong-type';
      await commandClient.sendCommand(['SET', keys.project(projectId), 'not-a-hash']);
      const before = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));

      await expect(
        repository.registerProject({
          project: {
            id: projectId,
            name: 'Wrong type',
            localPath: 'C:/workspace/wrong',
            canonicalPath: 'C:/workspace/wrong',
            identityPath: 'c:/workspace/wrong',
            pathIdentityHash: 'c'.repeat(64),
          },
          workspaceId: 'local',
          eventId: 'event-wrong-type',
        }),
      ).rejects.toMatchObject({
        code: 'REDIS_STATE_INVALID',
      });

      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(before);
      await expect(
        commandClient.sendCommand(['EXISTS', keys.projectPathIndex('c'.repeat(64))]),
      ).resolves.toBe(0);
    });

    it('rejects a non-appendable project Stream before any projection or global event write', async () => {
      const projectId = 'project-max-stream';
      const pathHash = 'd'.repeat(64);
      await commandClient.sendCommand([
        'XADD',
        keys.projectEvents(projectId),
        '18446744073709551615-18446744073709551615',
        'event',
        'seed',
      ]);
      const globalLength = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));

      await expect(
        repository.registerProject({
          project: {
            id: projectId,
            name: 'Max Stream',
            localPath: 'C:/workspace/max-stream',
            canonicalPath: 'C:/workspace/max-stream',
            identityPath: 'c:/workspace/max-stream',
            pathIdentityHash: pathHash,
          },
          workspaceId: 'local',
          eventId: 'event-max-stream',
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });

      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalLength,
      );
      await expect(commandClient.sendCommand(['EXISTS', keys.project(projectId)])).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['EXISTS', keys.projectPathIndex(pathHash)]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['SISMEMBER', keys.projectsIndex, projectId]),
      ).resolves.toBe(0);
    });
  },
);
