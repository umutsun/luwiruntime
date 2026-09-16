import { randomUUID } from 'node:crypto';

import { createRuntimeEvent, type Coordinator, type RuntimeEvent } from '@luwi/protocol';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createCoordinatorRepository,
  createFunctionRegistry,
  createRedisKeys,
  createRuntimeRepository,
  type CoordinatorRepository,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

/**
 * The coordinator Functions (ADR 0035), against a real server.
 *
 * The claim these tests exist to check is the compare-and-set: two claims on a
 * vacant role must produce exactly one grant, a stale expectedVersion must lose,
 * and a refusal must leave the role exactly as it was. None can be shown with a
 * stubbed client.
 */
describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'coordinator Functions',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let runtimeRepository: RuntimeRepository;
    let coordinators: CoordinatorRepository;

    let claimCounter = 0;
    const record = (sessionId: string, claimId?: string): Omit<Coordinator, 'version'> => ({
      projectId: 'project-1',
      sessionId,
      agentId: 'codex-sim',
      // A fresh nonce per claim unless the test pins one, mirroring the daemon.
      claimId: claimId ?? `claim-${(claimCounter += 1).toString()}`,
      claimedAt: '2026-08-10T00:00:00.000Z',
    });

    const event = (type: 'coordinator.claimed' | 'coordinator.released'): RuntimeEvent =>
      createRuntimeEvent({ type, workspaceId: 'local', projectId: 'project-1', payload: {} });

    const claim = (sessionId: string, expectedVersion: number, expectedClaimId = '') =>
      coordinators.claimCoordinator({
        record: record(sessionId),
        expectedVersion,
        expectedClaimId,
        event: event('coordinator.claimed'),
      });

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      runtimeRepository = createRuntimeRepository({
        client: commandClient,
        keys,
        functions: registry,
      });
      coordinators = createCoordinatorRepository({
        client: commandClient,
        keys,
        functions: registry,
      });
      await runtimeRepository.registerProject({
        project: {
          id: 'project-1',
          name: 'Coordinator',
          localPath: 'C:/workspace/coordinator',
          canonicalPath: 'C:/workspace/coordinator',
          identityPath: 'c:/workspace/coordinator',
          pathIdentityHash: 'f'.repeat(64),
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

    it('grants a vacant role at version 1 and stores it', async () => {
      const result = await claim('session-a', 0);

      expect(result).toEqual({ status: 'claimed', version: 1 });
      expect(await coordinators.getCoordinator('project-1')).toMatchObject({
        sessionId: 'session-a',
        version: 1,
      });
    });

    it('refuses a fresh grant when the role is already held', async () => {
      // The role from the previous test is still held at version 1.
      const conflict = await claim('session-z', 0);
      expect(conflict).toEqual({ status: 'version_conflict' });
      // The refusal changed nothing.
      expect(await coordinators.getCoordinator('project-1')).toMatchObject({
        sessionId: 'session-a',
        version: 1,
      });
    });

    it('takes over from a terminal holder with the matching version and incarnation', async () => {
      const held = await coordinators.getCoordinator('project-1');
      const result = await claim('session-b', held?.version ?? 0, held?.claimId ?? '');

      expect(result).toEqual({ status: 'claimed', version: (held?.version ?? 0) + 1 });
      expect(await coordinators.getCoordinator('project-1')).toMatchObject({
        sessionId: 'session-b',
      });
    });

    it('refuses a takeover carrying a stale version', async () => {
      const stale = await claim('session-c', 1, 'stale-incarnation');
      expect(stale).toEqual({ status: 'version_conflict' });
    });

    it('lets exactly one of two vacant-role claims win when issued together', async () => {
      await coordinators.releaseCoordinator({
        projectId: 'project-1',
        sessionId: 'session-b',
        event: event('coordinator.released'),
      });

      const [first, second] = await Promise.all([claim('race-a', 0), claim('race-b', 0)]);
      const claimed = [first, second].filter((r) => r.status === 'claimed');
      const conflicts = [first, second].filter((r) => r.status === 'version_conflict');
      expect(claimed).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
    });

    it('releases only for the holder and frees the role', async () => {
      const held = await coordinators.getCoordinator('project-1');
      const holder = held?.sessionId ?? '';

      const stranger = await coordinators.releaseCoordinator({
        projectId: 'project-1',
        sessionId: 'someone-else',
        event: event('coordinator.released'),
      });
      expect(stranger).toEqual({ status: 'not_holder', heldBySessionId: holder });

      const released = await coordinators.releaseCoordinator({
        projectId: 'project-1',
        sessionId: holder,
        event: event('coordinator.released'),
      });
      expect(released).toEqual({ status: 'released' });
      expect(await coordinators.getCoordinator('project-1')).toBeNull();

      // Now vacant, a fresh grant succeeds at version 1 again.
      expect(await claim('session-after', 0)).toEqual({ status: 'claimed', version: 1 });
    });

    it('reports a missing coordinator on release rather than inventing one', async () => {
      const absent = await coordinators.releaseCoordinator({
        projectId: 'project-nowhere',
        sessionId: 'session-a',
        event: event('coordinator.released'),
      });
      expect(absent).toEqual({ status: 'not_found' });
    });

    // The regression both reviews confirmed. Kept last: it leaves its own holder.
    it('refuses a stale take-over whose version coincides with a newer holder (ABA guard)', async () => {
      // Free the role, then reproduce the exact ABA: a take-over decided against
      // a dead incarnation at v1 must not evict a newer, live holder that
      // coincidentally also sits at v1 after a release reset the version.
      const current = await coordinators.getCoordinator('project-1');
      if (current !== null) {
        await coordinators.releaseCoordinator({
          projectId: 'project-1',
          sessionId: current.sessionId,
          event: event('coordinator.released'),
        });
      }

      const a = await coordinators.claimCoordinator({
        record: record('aba-a', 'incarnation-X'),
        expectedVersion: 0,
        expectedClaimId: '',
        event: event('coordinator.claimed'),
      });
      expect(a).toEqual({ status: 'claimed', version: 1 });

      await coordinators.releaseCoordinator({
        projectId: 'project-1',
        sessionId: 'aba-a',
        event: event('coordinator.released'),
      });

      // Fresh grant restarts version at 1 — the ABA precondition.
      const b = await coordinators.claimCoordinator({
        record: record('aba-b', 'incarnation-Y'),
        expectedVersion: 0,
        expectedClaimId: '',
        event: event('coordinator.claimed'),
      });
      expect(b).toEqual({ status: 'claimed', version: 1 });

      // Stale take-over: version 1 matches, but incarnation X is gone.
      const stale = await coordinators.claimCoordinator({
        record: record('aba-c'),
        expectedVersion: 1,
        expectedClaimId: 'incarnation-X',
        event: event('coordinator.claimed'),
      });
      expect(stale).toEqual({ status: 'version_conflict' });

      // The live holder B is untouched — no split-brain.
      expect(await coordinators.getCoordinator('project-1')).toMatchObject({
        sessionId: 'aba-b',
        claimId: 'incarnation-Y',
      });
    });
  },
);
