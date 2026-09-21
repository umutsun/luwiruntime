import { randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createRedisKeys,
  createRuntimeRepository,
  purgeTerminalSessionLeaves,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

/**
 * The retention sweep's per-session purge against a real server: it removes every
 * key and index membership a terminal session owned and nothing of a live session,
 * and is idempotent. Uses the SAME purgeTerminalSessionLeaves that project
 * unregister uses, so a green run here is the sweep's delete path proven directly.
 */
describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'terminal-session purge',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let command: RedisCommandClient;
    let runtime: RuntimeRepository;

    const projectId = 'project-1';

    const registerSession = (sessionId: string, agentId = 'codex') =>
      runtime.registerSession({
        session: {
          id: sessionId,
          agentId,
          projectId,
          status: 'starting',
          workingDirectory: `C:/workspace/${projectId}`,
          metadataJson: '{}',
        },
        workspaceId: 'local',
        eventId: randomUUID(),
        presenceTtlMs: 60_000,
      });
    const closeSession = (sessionId: string) =>
      runtime.closeSession({ sessionId, projectId, workspaceId: 'local', eventId: randomUUID() });

    const scanKeys = async (): Promise<string[]> => {
      const found: string[] = [];
      let cursor = '0';
      do {
        const reply = (await command.sendCommand([
          'SCAN',
          cursor,
          'MATCH',
          `${namespace}:*`,
          'COUNT',
          '200',
        ])) as [string, string[]];
        cursor = reply[0];
        found.push(...reply[1]);
      } while (cursor !== '0');
      return found;
    };

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      command = { sendCommand: (args) => client.sendCommand([...args]) };
      await command.sendCommand(['FUNCTION', 'LOAD', library.source]);
      runtime = createRuntimeRepository({ client: command, keys, functions: registry });
      await runtime.registerProject({
        project: {
          id: projectId,
          name: projectId,
          localPath: `C:/workspace/${projectId}`,
          canonicalPath: `C:/workspace/${projectId}`,
          identityPath: `c:/workspace/${projectId}`,
          pathIdentityHash: 'f'.repeat(64),
        },
        workspaceId: 'local',
        eventId: randomUUID(),
      });
    });

    afterAll(async () => {
      if (client?.isOpen) {
        const stale = await scanKeys();
        if (stale.length > 0) await command.sendCommand(['DEL', ...stale]);
        await command.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]);
        await client.quit();
      }
    });

    it('removes every leaf of a terminal session and nothing of a live one, idempotently', async () => {
      await registerSession('s-dead', 'codex');
      await registerSession('s-live', 'codex');
      await closeSession('s-dead');

      // Pre: the dead session's hash, inbox and index memberships all exist.
      expect(await command.sendCommand(['EXISTS', keys.session('s-dead')])).toBe(1);
      expect(await command.sendCommand(['EXISTS', keys.sessionInbox('s-dead')])).toBe(1);
      expect(
        await command.sendCommand(['SISMEMBER', keys.projectSessions(projectId), 's-dead']),
      ).toBe(1);

      await purgeTerminalSessionLeaves(command, keys, 's-dead', 'codex', projectId);

      // Zero residue for the dead session: no key anywhere still names it.
      const residue = (await scanKeys()).filter((key) => key.includes('s-dead'));
      expect(residue).toEqual([]);
      expect(await command.sendCommand(['EXISTS', keys.session('s-dead')])).toBe(0);
      expect(await command.sendCommand(['EXISTS', keys.sessionInbox('s-dead')])).toBe(0);
      expect(
        await command.sendCommand(['SISMEMBER', keys.projectSessions(projectId), 's-dead']),
      ).toBe(0);
      expect(await command.sendCommand(['ZSCORE', keys.heartbeatDeadlines, 's-dead'])).toBeNull();

      // The live session is untouched, including its shared agent index.
      expect(await command.sendCommand(['EXISTS', keys.session('s-live')])).toBe(1);
      expect(
        await command.sendCommand(['SISMEMBER', keys.projectSessions(projectId), 's-live']),
      ).toBe(1);
      expect(await command.sendCommand(['SISMEMBER', keys.agentSessions('codex'), 's-live'])).toBe(
        1,
      );

      // Idempotent: a second purge of the same id is a harmless no-op.
      await expect(
        purgeTerminalSessionLeaves(command, keys, 's-dead', 'codex', projectId),
      ).resolves.toBeUndefined();
      expect((await scanKeys()).filter((key) => key.includes('s-dead'))).toEqual([]);
    });
  },
);
