import { randomUUID } from 'node:crypto';

import { deriveNativeBindingId, deriveNativeLinkId, selectMessageTarget } from '@luwi/runtime';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createRedisKeys,
  createRuntimeRepository,
  type NativeRegistrationInput,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'starting-session reap Function',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let repository: RuntimeRepository;

    const register = async (sessionId: string, native?: NativeRegistrationInput) =>
      repository.registerSession({
        session: {
          id: sessionId,
          agentId: 'codex-sim',
          projectId: 'project-1',
          status: 'starting',
          workingDirectory: 'C:/workspace/luwi',
          metadataJson: '{"source":"reap-integration"}',
        },
        workspaceId: 'local',
        eventId: `event-session-${sessionId}`,
        // A normal, live presence TTL: the reaper must override a session that is
        // still heartbeating, which is exactly what session_disconnect refuses to.
        presenceTtlMs: 15_000,
        ...(native === undefined ? {} : { native }),
      });

    const declarationFor = (
      sessionId: string,
    ): { native: NativeRegistrationInput; bindingId: string; linkId: string } => {
      const adapterId = 'claude-code-native-v1';
      const nativeSessionId = `native-${sessionId}`;
      const bindingId = deriveNativeBindingId({ adapterId, nativeSessionId });
      const linkId = deriveNativeLinkId(bindingId, sessionId);
      return {
        bindingId,
        linkId,
        native: {
          bindingId,
          linkId,
          linkedEventId: `event-linked-${sessionId}`,
          payload: {
            bindingId,
            expectedVersion: 0,
            link: { id: linkId, sessionId },
            binding: { id: bindingId, adapterId, nativeSessionId, kind: 'main' },
          },
        },
      };
    };

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
          name: 'Reap',
          localPath: 'C:/workspace/luwi',
          canonicalPath: 'C:/workspace/luwi',
          identityPath: 'c:/workspace/luwi',
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

    it('reaps a live-heartbeating starting session and closes its open native link', async () => {
      const sessionId = 'reap-native';
      const { native, bindingId, linkId } = declarationFor(sessionId);
      await register(sessionId, native);

      // Presence is live and the deadline is armed: session_disconnect would
      // reconcile here and write no unlink. The reaper must proceed anyway.
      expect(
        Number(await commandClient.sendCommand(['PTTL', keys.sessionPresence(sessionId)])),
      ).toBeGreaterThan(0);
      expect(
        await commandClient.sendCommand(['ZSCORE', keys.heartbeatDeadlines, sessionId]),
      ).not.toBeNull();

      const result = await repository.reapStartingSession({
        sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: `event-reap-${sessionId}`,
        native: {
          bindingId,
          linkId,
          expectedVersion: 1,
          expectedOpenLinkId: linkId,
          unlinkedEventId: `event-unlink-${sessionId}`,
        },
      });

      expect(result.status).toBe('disconnected');
      expect(await repository.getSession(sessionId)).toMatchObject({
        status: 'disconnected',
        presence: 'offline',
      });
      const binding = await repository.getNativeBinding(bindingId);
      expect(binding?.openLinkId).toBeUndefined();
      expect(binding?.version).toBe(2);
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeDefined();
      // Presence key gone and deadline removed: no ghost left in either index.
      expect(await commandClient.sendCommand(['EXISTS', keys.sessionPresence(sessionId)])).toBe(0);
      expect(
        await commandClient.sendCommand(['ZSCORE', keys.heartbeatDeadlines, sessionId]),
      ).toBeNull();
      // The reverse index outlives the lapse, as it does for a graceful close.
      expect(await repository.getSessionNativeBindingId(sessionId)).toBe(bindingId);
    });

    it('does not let a heartbeat after the reap revive the session to a routable status', async () => {
      const sessionId = 'reap-heartbeat';
      await register(sessionId);

      await expect(
        repository.reapStartingSession({
          sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: `event-reap-${sessionId}`,
        }),
      ).resolves.toMatchObject({ status: 'disconnected' });

      // The still-alive attach process keeps heartbeating. It must not flip the
      // session back to a live status or re-arm its presence/deadline.
      await expect(
        repository.heartbeatSession({
          sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: `event-heartbeat-${sessionId}`,
          presenceTtlMs: 15_000,
          eventIntervalMs: 30_000,
        }),
      ).resolves.toEqual({ status: 'terminal', currentStatus: 'disconnected' });

      const reaped = await repository.getSession(sessionId);
      expect(reaped).toMatchObject({ status: 'disconnected', presence: 'offline' });
      expect(await commandClient.sendCommand(['EXISTS', keys.sessionPresence(sessionId)])).toBe(0);
      expect(
        await commandClient.sendCommand(['ZSCORE', keys.heartbeatDeadlines, sessionId]),
      ).toBeNull();

      // And it is excluded from routing: a message aimed at it finds it unavailable.
      const source = await repository.getSession('reap-native');
      if (source === null || reaped === null) throw new Error('sessions missing');
      expect(
        selectMessageTarget({
          sourceSession: source,
          sessions: [reaped],
          targetSessionId: reaped.id,
        }),
      ).toEqual({ status: 'unavailable', selector: reaped.id });
    });

    it('refuses to reap a session that already left starting, writing nothing', async () => {
      const sessionId = 'reap-guard';
      await register(sessionId);
      await repository.updateSessionStatus({
        sessionId,
        projectId: 'project-1',
        targetStatus: 'idle',
        workspaceId: 'local',
        eventId: `event-idle-${sessionId}`,
      });
      const globalBefore = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));

      await expect(
        repository.reapStartingSession({
          sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: `event-reap-${sessionId}`,
        }),
      ).resolves.toEqual({ status: 'unchanged' });

      expect(await repository.getSession(sessionId)).toMatchObject({
        status: 'idle',
        presence: 'online',
      });
      expect(await commandClient.sendCommand(['XLEN', keys.globalEvents])).toBe(globalBefore);
    });

    it('finds starting sessions past the grace window and ignores fresh or non-starting ones', async () => {
      const starting = 'reap-finder-start';
      const idle = 'reap-finder-idle';
      await register(starting);
      await register(idle);
      await repository.updateSessionStatus({
        sessionId: idle,
        projectId: 'project-1',
        targetStatus: 'idle',
        workspaceId: 'local',
        eventId: `event-idle-${idle}`,
      });

      // A grace window wider than the session's age excludes it — a legitimate
      // startup in progress is never a candidate.
      const withinGrace = await repository.findStartingSessionsPastGrace(Date.now(), 3_600_000, 50);
      expect(withinGrace.map((candidate) => candidate.sessionId)).not.toContain(starting);

      // With no grace, the starting session qualifies but the idle one never does.
      const pastGrace = await repository.findStartingSessionsPastGrace(Date.now(), 0, 50);
      const ids = pastGrace.map((candidate) => candidate.sessionId);
      expect(ids).toContain(starting);
      expect(ids).not.toContain(idle);
      for (const candidate of pastGrace) {
        expect(candidate.projectId).toBe('project-1');
      }
    });
  },
);
