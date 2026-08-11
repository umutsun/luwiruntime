import { randomUUID } from 'node:crypto';

import { deriveNativeBindingId, deriveNativeLinkId } from '@luwi/runtime';
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
  'native session binding Functions',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let repository: RuntimeRepository;
    let sequence = 0;

    /**
     * Each case gets its own native reference and session id. Sharing one would
     * make every case depend on the binding the previous case left behind,
     * which is exactly the coupling these tests exist to detect.
     */
    function nextCase(): {
      sessionId: string;
      bindingId: string;
      adapterId: string;
      nativeSessionId: string;
    } {
      sequence += 1;
      const adapterId = 'claude-code-native-v1';
      const nativeSessionId = `native-${String(sequence).padStart(8, '0')}`;
      return {
        sessionId: `session-${String(sequence)}`,
        bindingId: deriveNativeBindingId({ adapterId, nativeSessionId }),
        adapterId,
        nativeSessionId,
      };
    }

    function firstDeclaration(current: ReturnType<typeof nextCase>): NativeRegistrationInput {
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      return {
        bindingId: current.bindingId,
        linkId,
        linkedEventId: `event-linked-${current.sessionId}`,
        payload: {
          bindingId: current.bindingId,
          expectedVersion: 0,
          link: { id: linkId, sessionId: current.sessionId },
          binding: {
            id: current.bindingId,
            adapterId: current.adapterId,
            nativeSessionId: current.nativeSessionId,
            kind: 'main',
          },
        },
      };
    }

    const register = async (sessionId: string, native?: NativeRegistrationInput) =>
      repository.registerSession({
        session: {
          id: sessionId,
          agentId: 'codex-sim',
          projectId: 'project-1',
          status: 'starting',
          workingDirectory: 'C:/workspace/luwi',
          metadataJson: '{"source":"native-integration"}',
        },
        workspaceId: 'local',
        eventId: `event-session-${sessionId}`,
        presenceTtlMs: 15_000,
        ...(native === undefined ? {} : { native }),
      });

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
          name: 'Native',
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

    it('creates a binding and an open link inside the registration', async () => {
      const current = nextCase();

      const result = await register(current.sessionId, firstDeclaration(current));

      expect(result.status).toBe('created');
      if (result.status !== 'created') return;
      expect(result.native?.transition).toBe('created');
      expect(result.events?.map((entry) => entry.event.type)).toEqual([
        'session.registered',
        'session.native.linked',
      ]);
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      const binding = await repository.getNativeBinding(current.bindingId);
      expect(binding).toMatchObject({
        id: current.bindingId,
        kind: 'main',
        version: 1,
        linkCount: 1,
        trimmedLinkCount: 0,
        openLinkId: linkId,
      });
      const link = await repository.getNativeLink(linkId);
      expect(link).toMatchObject({ bindingId: current.bindingId, sessionId: current.sessionId });
      expect(link?.unlinkedAt).toBeUndefined();
      // Every timestamp comes from the same Redis transition clock.
      expect(link?.linkedAt).toBe(binding?.firstLinkedAt);
      expect(await repository.getSessionNativeBindingId(current.sessionId)).toBe(current.bindingId);
    });

    it('keeps the 9-key registration shape untouched', async () => {
      const current = nextCase();

      const result = await register(current.sessionId);

      expect(result.status).toBe('created');
      if (result.status !== 'created') return;
      expect(result.native).toBeUndefined();
      expect(result.events).toBeUndefined();
      expect(result.globalStreamId).toBeDefined();
    });

    it('refuses a second live declaration, writes nothing, and creates no session', async () => {
      const holder = nextCase();
      await register(holder.sessionId, firstDeclaration(holder));
      const before = await repository.getNativeBinding(holder.bindingId);
      const rejected = `${holder.sessionId}-second`;
      const rejectedLinkId = deriveNativeLinkId(holder.bindingId, rejected);

      await expect(
        register(rejected, {
          bindingId: holder.bindingId,
          linkId: rejectedLinkId,
          linkedEventId: 'event-linked-rejected',
          payload: {
            bindingId: holder.bindingId,
            expectedVersion: 0,
            link: { id: rejectedLinkId, sessionId: rejected },
            binding: {
              id: holder.bindingId,
              adapterId: holder.adapterId,
              nativeSessionId: holder.nativeSessionId,
              kind: 'main',
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      expect(await repository.getNativeBinding(holder.bindingId)).toEqual(before);
      expect(await repository.getSession(rejected)).toBeNull();
      // Validation runs before XGROUP CREATE, so no inbox stream survives.
      expect(await commandClient.sendCommand(['EXISTS', keys.sessionInbox(rejected)])).toBe(0);
      expect(await repository.getNativeLink(rejectedLinkId)).toBeNull();
    });

    it('closes the link through session_close, clears openLinkId, and keeps the reverse index', async () => {
      const current = nextCase();
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      await register(current.sessionId, firstDeclaration(current));

      const result = await repository.closeSession({
        sessionId: current.sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: `event-close-${current.sessionId}`,
        native: {
          bindingId: current.bindingId,
          linkId,
          expectedVersion: 1,
          expectedOpenLinkId: linkId,
          unlinkedEventId: `event-unlink-${current.sessionId}`,
        },
      });

      expect(result.status).toBe('completed');
      const closed = await repository.getNativeBinding(current.bindingId);
      expect(closed?.openLinkId).toBeUndefined();
      expect(closed?.version).toBe(2);
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeDefined();
      // The reverse index outlives the link's closure: a terminal session still
      // has to resolve to its binding for later transcript mapping.
      expect(await repository.getSessionNativeBindingId(current.sessionId)).toBe(current.bindingId);
    });

    it('refuses a second close, so unlinkedAt is written exactly once', async () => {
      const current = nextCase();
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      await register(current.sessionId, firstDeclaration(current));
      await repository.closeSession({
        sessionId: current.sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: `event-close-${current.sessionId}`,
        native: {
          bindingId: current.bindingId,
          linkId,
          expectedVersion: 1,
          expectedOpenLinkId: linkId,
          unlinkedEventId: `event-unlink-${current.sessionId}`,
        },
      });
      const firstUnlinkedAt = (await repository.getNativeLink(linkId))?.unlinkedAt;

      /**
       * The session guard short-circuits first: an already-completed session
       * reports `unchanged` and the native block is never reached. The interval
       * is therefore preserved by the session's own terminal state, before the
       * unlink's own single-write guard ever has to defend it.
       */
      const second = await repository.closeSession({
        sessionId: current.sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: `event-close-again-${current.sessionId}`,
        native: {
          bindingId: current.bindingId,
          linkId,
          expectedVersion: 2,
          expectedOpenLinkId: linkId,
          unlinkedEventId: `event-unlink-again-${current.sessionId}`,
        },
      });

      expect(second).toMatchObject({ status: 'unchanged' });
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBe(firstUnlinkedAt);
      expect((await repository.getNativeBinding(current.bindingId))?.version).toBe(2);
    });

    /**
     * The unlink's own guard, reached directly: a link that is already closed is
     * refused even when the session-level guard does not intervene.
     */
    it('refuses an unlink against an already-closed link', async () => {
      const current = nextCase();
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      await register(current.sessionId, firstDeclaration(current));
      await repository.closeSession({
        sessionId: current.sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: `event-close-${current.sessionId}`,
        native: {
          bindingId: current.bindingId,
          linkId,
          expectedVersion: 1,
          expectedOpenLinkId: linkId,
          unlinkedEventId: `event-unlink-${current.sessionId}`,
        },
      });
      const closedAt = (await repository.getNativeLink(linkId))?.unlinkedAt;

      // A different, still-open session pointed at the closed link.
      const other = nextCase();
      await register(other.sessionId, firstDeclaration(other));

      await expect(
        repository.closeSession({
          sessionId: other.sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: `event-close-${other.sessionId}`,
          native: {
            bindingId: current.bindingId,
            linkId,
            expectedVersion: 2,
            expectedOpenLinkId: linkId,
            unlinkedEventId: `event-unlink-cross-${other.sessionId}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBe(closedAt);
    });

    it('refuses an unlink whose link hash is missing, and creates no hash', async () => {
      const current = nextCase();
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      await register(current.sessionId, firstDeclaration(current));
      const absentLinkId = deriveNativeLinkId(current.bindingId, 'never-existed');

      await expect(
        repository.closeSession({
          sessionId: current.sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: `event-close-${current.sessionId}`,
          native: {
            bindingId: current.bindingId,
            linkId: absentLinkId,
            expectedVersion: 1,
            expectedOpenLinkId: linkId,
            unlinkedEventId: `event-unlink-${current.sessionId}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      // HSET would have created it; the validation is what stops a phantom link.
      expect(await repository.getNativeLink(absentLinkId)).toBeNull();
      expect((await repository.getNativeBinding(current.bindingId))?.openLinkId).toBe(linkId);
    });

    it('returns version_conflict and writes nothing when the expected version is stale', async () => {
      const current = nextCase();
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);

      await expect(
        register(current.sessionId, {
          bindingId: current.bindingId,
          linkId,
          linkedEventId: `event-linked-${current.sessionId}`,
          payload: {
            bindingId: current.bindingId,
            expectedVersion: 9999,
            expectedOpenLinkId: 'nope',
            link: { id: linkId, sessionId: current.sessionId },
          },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      expect(await repository.getNativeBinding(current.bindingId)).toBeNull();
      expect(await repository.getSession(current.sessionId)).toBeNull();
      expect(
        await commandClient.sendCommand(['EXISTS', keys.sessionInbox(current.sessionId)]),
      ).toBe(0);
    });

    /**
     * The boundary a single `stream_appendable` check passes and a real second
     * append fails: room for exactly one more entry, but two events to write.
     */
    it('aborts before any write when a stream cannot accept every event', async () => {
      const current = nextCase();
      await commandClient.sendCommand([
        'XADD',
        keys.globalEvents,
        '18446744073709551615-18446744073709551614',
        'f',
        'v',
      ]);

      await expect(register(current.sessionId, firstDeclaration(current))).rejects.toMatchObject({
        code: 'REDIS_STATE_INVALID',
      });

      expect(await repository.getSession(current.sessionId)).toBeNull();
      expect(await repository.getNativeBinding(current.bindingId)).toBeNull();
      expect(
        await repository.getNativeLink(deriveNativeLinkId(current.bindingId, current.sessionId)),
      ).toBeNull();
    });
  },
);
