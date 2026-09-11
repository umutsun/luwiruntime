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

    it('updates a project in one Function with one event, clears with null, and reports a stranger', async () => {
      const registered = await repository.registerProject({
        project: {
          id: 'project-u1',
          name: 'Before',
          localPath: 'C:/workspace/update',
          canonicalPath: 'C:/workspace/update',
          identityPath: 'c:/workspace/update',
          // Its own hash: the tests below own 'a' to 'd'.
          pathIdentityHash: 'e'.repeat(64),
          repositoryUrl: 'https://example.test/before.git',
          defaultBranch: 'main',
        },
        workspaceId: 'local',
        eventId: 'event-u1',
      });
      expect(registered.status).toBe('created');
      const globalBefore = (await commandClient.sendCommand(['XLEN', keys.globalEvents])) as number;

      const updated = await repository.updateProject({
        projectId: 'project-u1',
        patch: { name: 'After', repositoryUrl: null },
        workspaceId: 'local',
        eventId: 'event-u2',
      });

      expect(updated).toMatchObject({
        status: 'updated',
        project: { id: 'project-u1', name: 'After', defaultBranch: 'main' },
        event: { id: 'event-u2', type: 'project.updated', projectId: 'project-u1' },
      });
      if (updated.status !== 'updated') throw new Error('Expected an update');
      expect(updated.project.repositoryUrl).toBeUndefined();
      expect(updated.event.payload).toMatchObject({ changed: ['name', 'repositoryUrl'] });
      await expect(
        commandClient.sendCommand(['HGET', keys.project('project-u1'), 'repositoryUrl']),
      ).resolves.toBeNull();
      await expect(
        commandClient.sendCommand(['HGET', keys.project('project-u1'), 'name']),
      ).resolves.toBe('After');
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalBefore + 1,
      );
      await expect(
        commandClient.sendCommand(['XLEN', keys.projectEvents('project-u1')]),
      ).resolves.toBe(2);

      await expect(
        repository.updateProject({
          projectId: 'project-none',
          patch: { name: 'x' },
          workspaceId: 'local',
          eventId: 'event-u3',
        }),
      ).resolves.toEqual({ status: 'not_found' });
      // An empty patch is refused before any write, so no event and no timestamp move.
      const updatedAt = await commandClient.sendCommand([
        'HGET',
        keys.project('project-u1'),
        'updatedAt',
      ]);
      await expect(
        repository.updateProject({
          projectId: 'project-u1',
          patch: {},
          workspaceId: 'local',
          eventId: 'event-u4',
        }),
      ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });
      await expect(
        commandClient.sendCommand(['XLEN', keys.projectEvents('project-u1')]),
      ).resolves.toBe(2);
      await expect(
        commandClient.sendCommand(['HGET', keys.project('project-u1'), 'updatedAt']),
      ).resolves.toBe(updatedAt);

      // A patch that matches what is stored writes nothing and emits nothing.
      await expect(
        repository.updateProject({
          projectId: 'project-u1',
          patch: { name: 'After', repositoryUrl: null },
          workspaceId: 'local',
          eventId: 'event-u5',
        }),
      ).resolves.toMatchObject({ status: 'unchanged', project: { name: 'After' } });
      await expect(
        commandClient.sendCommand(['XLEN', keys.projectEvents('project-u1')]),
      ).resolves.toBe(2);
    });

    it('refuses an update whose stream cannot take the event, or whose record is not a project, before any write', async () => {
      const registered = await repository.registerProject({
        project: {
          id: 'project-u2',
          name: 'Guarded',
          localPath: 'C:/workspace/guarded',
          canonicalPath: 'C:/workspace/guarded',
          identityPath: 'c:/workspace/guarded',
          pathIdentityHash: 'f'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-g1',
      });
      expect(registered.status).toBe('created');
      const globalBefore = await commandClient.sendCommand(['XLEN', keys.globalEvents]);
      const updatedAt = await commandClient.sendCommand([
        'HGET',
        keys.project('project-u2'),
        'updatedAt',
      ]);

      // The project Stream sits at its maximum id: no event can follow, so nothing may change.
      await commandClient.sendCommand([
        'XADD',
        keys.projectEvents('project-u2'),
        '18446744073709551615-18446744073709551615',
        'event',
        'seed',
      ]);
      await expect(
        repository.updateProject({
          projectId: 'project-u2',
          patch: { name: 'Blocked' },
          workspaceId: 'local',
          eventId: 'event-g2',
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await expect(
        commandClient.sendCommand(['HGET', keys.project('project-u2'), 'name']),
      ).resolves.toBe('Guarded');
      await expect(
        commandClient.sendCommand(['HGET', keys.project('project-u2'), 'updatedAt']),
      ).resolves.toBe(updatedAt);
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalBefore,
      );

      // A key of the wrong type, and a hash that is not a whole project, are refused the same way.
      await commandClient.sendCommand(['SET', keys.project('project-string'), 'not-a-hash']);
      await expect(
        repository.updateProject({
          projectId: 'project-string',
          patch: { name: 'x' },
          workspaceId: 'local',
          eventId: 'event-g3',
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await commandClient.sendCommand([
        'HSET',
        keys.project('project-partial'),
        'name',
        'only-a-name',
      ]);
      await expect(
        repository.updateProject({
          projectId: 'project-partial',
          patch: { name: 'x' },
          workspaceId: 'local',
          eventId: 'event-g4',
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      // A hash whose stored id is another project's is refused too: the event must name the key's project.
      await commandClient.sendCommand([
        'HSET',
        keys.project('project-alias'),
        'id',
        'project-u2',
        'name',
        'Alias',
        'localPath',
        'C:/a',
        'canonicalPath',
        'C:/a',
        'createdAt',
        '2026-09-11T10:00:00.000Z',
        'updatedAt',
        '2026-09-11T10:00:00.000Z',
      ]);
      await expect(
        repository.updateProject({
          projectId: 'project-alias',
          patch: { name: 'x' },
          workspaceId: 'local',
          eventId: 'event-g5',
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalBefore,
      );
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
