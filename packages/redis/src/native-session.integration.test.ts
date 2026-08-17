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

    const register = async (
      sessionId: string,
      native?: NativeRegistrationInput,
      presenceTtlMs = 15_000,
    ) =>
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
        presenceTtlMs,
        ...(native === undefined ? {} : { native }),
      });

    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
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

    /**
     * The key a link is written into is derived from the declared `linkId`,
     * while the record written into it comes from the payload. If the Function
     * only compares the payload against itself, those two can disagree and the
     * link key ends up holding a record that names a different link.
     */
    it('refuses a declaration whose declared link id differs from its payload', async () => {
      const current = nextCase();
      const declaredLinkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      const payloadLinkId = deriveNativeLinkId(current.bindingId, `${current.sessionId}-other`);

      await expect(
        register(current.sessionId, {
          bindingId: current.bindingId,
          linkId: declaredLinkId,
          linkedEventId: `event-linked-${current.sessionId}`,
          payload: {
            bindingId: current.bindingId,
            expectedVersion: 0,
            link: { id: payloadLinkId, sessionId: current.sessionId },
            binding: {
              id: current.bindingId,
              adapterId: current.adapterId,
              nativeSessionId: current.nativeSessionId,
              kind: 'main',
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });

      expect(await repository.getSession(current.sessionId)).toBeNull();
      // The refusal precedes XGROUP CREATE, so no inbox stream or group survives.
      expect(
        await commandClient.sendCommand(['EXISTS', keys.sessionInbox(current.sessionId)]),
      ).toBe(0);
      expect(await repository.getNativeBinding(current.bindingId)).toBeNull();
      expect(await repository.getNativeLink(declaredLinkId)).toBeNull();
      expect(await repository.getNativeLink(payloadLinkId)).toBeNull();
      expect(await repository.getSessionNativeBindingId(current.sessionId)).toBeNull();
    });

    /**
     * The stale case: an open link whose session already went terminal without
     * the close being written. The arriving declaration closes it and creates
     * its own in one transition, and the closing event carries the id the
     * caller declared for it.
     */
    it('closes a stale link and creates the new one in the same transition', async () => {
      const holder = nextCase();
      const staleLinkId = deriveNativeLinkId(holder.bindingId, holder.sessionId);
      await register(holder.sessionId, firstDeclaration(holder));
      // Terminal through the 5-key path, so the link is left open behind it.
      await repository.updateSessionStatus({
        sessionId: holder.sessionId,
        projectId: 'project-1',
        targetStatus: 'completed',
        workspaceId: 'local',
        eventId: `event-status-${holder.sessionId}`,
      });

      const arriving = `${holder.sessionId}-arriving`;
      const linkId = deriveNativeLinkId(holder.bindingId, arriving);
      const result = await register(arriving, {
        bindingId: holder.bindingId,
        linkId,
        staleLinkId,
        linkedEventId: `event-linked-${arriving}`,
        unlinkedEventId: `event-unlinked-${arriving}`,
        payload: {
          bindingId: holder.bindingId,
          expectedVersion: 1,
          expectedOpenLinkId: staleLinkId,
          staleLinkId,
          link: { id: linkId, sessionId: arriving },
        },
      });

      expect(result.status).toBe('created');
      if (result.status !== 'created') return;
      expect(result.native?.transition).toBe('linked');
      const binding = await repository.getNativeBinding(holder.bindingId);
      expect(binding?.openLinkId).toBe(linkId);
      expect(binding?.version).toBe(2);
      expect(binding?.linkCount).toBe(2);
      expect((await repository.getNativeLink(staleLinkId))?.unlinkedAt).toBeDefined();
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeUndefined();
      // Three events in order, and the unlinked one carries the declared id.
      expect(result.events?.map((entry) => entry.event.type)).toEqual([
        'session.registered',
        'session.native.unlinked',
        'session.native.linked',
      ]);
      expect(result.events?.map((entry) => entry.event.id)).toEqual([
        `event-session-${arriving}`,
        `event-unlinked-${arriving}`,
        `event-linked-${arriving}`,
      ]);
    });

    /**
     * The unlink proves the link is the one it means, but the link also has to
     * belong to the session being made terminal. Without that, closing one
     * session would close another session's open interval.
     */
    it('refuses a terminal unlink whose link belongs to another session', async () => {
      const holder = nextCase();
      const linkId = deriveNativeLinkId(holder.bindingId, holder.sessionId);
      await register(holder.sessionId, firstDeclaration(holder));
      const intruder = `${holder.sessionId}-intruder`;
      await register(intruder);

      const bindingBefore = await repository.getNativeBinding(holder.bindingId);
      const linkBefore = await repository.getNativeLink(linkId);
      const globalBefore = await commandClient.sendCommand(['XLEN', keys.globalEvents]);

      await expect(
        repository.closeSession({
          sessionId: intruder,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: `event-close-${intruder}`,
          native: {
            bindingId: holder.bindingId,
            linkId,
            expectedVersion: 1,
            expectedOpenLinkId: linkId,
            unlinkedEventId: `event-unlink-${intruder}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      expect(await repository.getSession(intruder)).toMatchObject({ status: 'starting' });
      expect(await repository.getNativeBinding(holder.bindingId)).toEqual(bindingBefore);
      expect(await repository.getNativeLink(linkId)).toEqual(linkBefore);
      expect(await commandClient.sendCommand(['XLEN', keys.globalEvents])).toBe(globalBefore);
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

    /**
     * The third terminal path, and the one the design calls easiest to miss: a
     * session can reach `completed` through the status endpoint without ever
     * calling close, and must not leave `openLinkId` behind when it does.
     */
    it('closes the link through session_status when the target is completed', async () => {
      const current = nextCase();
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      await register(current.sessionId, firstDeclaration(current));

      const result = await repository.updateSessionStatus({
        sessionId: current.sessionId,
        projectId: 'project-1',
        targetStatus: 'completed',
        workspaceId: 'local',
        eventId: `event-status-${current.sessionId}`,
        native: {
          bindingId: current.bindingId,
          linkId,
          expectedVersion: 1,
          expectedOpenLinkId: linkId,
          unlinkedEventId: `event-unlink-${current.sessionId}`,
        },
      });

      expect(result).toMatchObject({ status: 'updated', currentStatus: 'completed' });
      const closed = await repository.getNativeBinding(current.bindingId);
      expect(closed?.openLinkId).toBeUndefined();
      expect(closed?.version).toBe(2);
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeDefined();
      expect(await repository.getSessionNativeBindingId(current.sessionId)).toBe(current.bindingId);
    });

    /**
     * The sweeper's path, proven against Redis rather than against a stub: the
     * daemon-side adapter is unit-tested, but only this asserts that the 7-key
     * `session_disconnect` actually clears `openLinkId` and stamps `unlinkedAt`.
     */
    it('closes the link through session_disconnect when the heartbeat lapses', async () => {
      const current = nextCase();
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      // Short enough that the presence key is gone by the time the sweep runs;
      // a live presence key would return `reconciled` and write no unlink.
      await register(current.sessionId, firstDeclaration(current), 40);
      await delay(70);
      const expired = (await repository.findExpiredHeartbeatDeadlines(Date.now(), 10)).find(
        ({ sessionId }) => sessionId === current.sessionId,
      );
      expect(expired).toBeDefined();
      if (expired === undefined) return;

      const result = await repository.disconnectExpiredSession({
        ...expired,
        expectedDeadlineMs: expired.deadlineMs,
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: `event-disconnect-${current.sessionId}`,
        native: {
          bindingId: current.bindingId,
          linkId,
          expectedVersion: 1,
          expectedOpenLinkId: linkId,
          unlinkedEventId: `event-unlink-${current.sessionId}`,
        },
      });

      expect(result.status).toBe('disconnected');
      expect(await repository.getSession(current.sessionId)).toMatchObject({
        status: 'disconnected',
      });
      const closed = await repository.getNativeBinding(current.bindingId);
      expect(closed?.openLinkId).toBeUndefined();
      expect(closed?.version).toBe(2);
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeDefined();
      // The reverse index outlives a lapse for the same reason it outlives a
      // graceful close.
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
     * B0: the declaration surface for an already-registered session. The
     * session below registers with the unchanged 9-key shape — the state every
     * existing session is in — and declares afterwards through native_declare.
     */
    it('declares a binding for an already-registered session', async () => {
      const current = nextCase();
      await register(current.sessionId);
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);

      const result = await repository.declareNativeSession({
        sessionId: current.sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        native: firstDeclaration(current),
      });

      expect(result.status).toBe('declared');
      if (result.status !== 'declared') return;
      expect(result.native.transition).toBe('created');
      const binding = await repository.getNativeBinding(current.bindingId);
      expect(binding).toMatchObject({
        id: current.bindingId,
        kind: 'main',
        version: 1,
        linkCount: 1,
        openLinkId: linkId,
      });
      const link = await repository.getNativeLink(linkId);
      expect(link).toMatchObject({ bindingId: current.bindingId, sessionId: current.sessionId });
      expect(link?.unlinkedAt).toBeUndefined();
      expect(link?.linkedAt).toBe(binding?.firstLinkedAt);
      expect(await repository.getSessionNativeBindingId(current.sessionId)).toBe(current.bindingId);
      // Exactly one event: the link that came into being, and nothing else.
      expect(result.events.map((entry) => entry.event.type)).toEqual(['session.native.linked']);
      expect(result.events[0]?.event).toMatchObject({
        id: `event-linked-${current.sessionId}`,
        projectId: 'project-1',
        agentId: 'codex-sim',
        sessionId: current.sessionId,
      });
    });

    /**
     * D3's deepest defense: the service returns `unchanged` without calling
     * the Function, and if a stale observation reaches the Function anyway,
     * the CAS refuses it — so `version` cannot be incremented twice for one
     * identity either way.
     */
    it('refuses a repeated declaration through the Function without incrementing version', async () => {
      const current = nextCase();
      await register(current.sessionId);
      const declare = (native: NativeRegistrationInput) =>
        repository.declareNativeSession({
          sessionId: current.sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          native,
        });
      await declare(firstDeclaration(current));

      // As if a second caller still believed the binding was unclaimed.
      await expect(declare(firstDeclaration(current))).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
      });

      expect((await repository.getNativeBinding(current.bindingId))?.version).toBe(1);
      expect((await repository.getNativeBinding(current.bindingId))?.linkCount).toBe(1);
    });

    it('leaves no partial write behind a refused declaration', async () => {
      const current = nextCase();
      await register(current.sessionId);
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);
      const globalBefore = await commandClient.sendCommand(['XLEN', keys.globalEvents]);

      await expect(
        repository.declareNativeSession({
          sessionId: current.sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          native: {
            bindingId: current.bindingId,
            linkId,
            linkedEventId: `event-linked-${current.sessionId}`,
            payload: {
              bindingId: current.bindingId,
              expectedVersion: 9999,
              expectedOpenLinkId: 'nope',
              link: { id: linkId, sessionId: current.sessionId },
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      // No binding, no link, no reverse index, no event.
      expect(await repository.getNativeBinding(current.bindingId)).toBeNull();
      expect(await repository.getNativeLink(linkId)).toBeNull();
      expect(await repository.getSessionNativeBindingId(current.sessionId)).toBeNull();
      expect(await commandClient.sendCommand(['XLEN', keys.globalEvents])).toBe(globalBefore);
    });

    /**
     * A held identity cannot be taken by pretending it is free: a declaration
     * that does not name the exact open link it replaces loses the CAS. The
     * holder keeps its link, its session and its status.
     */
    it('refuses to take a held identity and leaves the live holder untouched', async () => {
      const holder = nextCase();
      const holderLinkId = deriveNativeLinkId(holder.bindingId, holder.sessionId);
      await register(holder.sessionId, firstDeclaration(holder));
      const arriving = `${holder.sessionId}-arriving`;
      await register(arriving);
      const arrivingLinkId = deriveNativeLinkId(holder.bindingId, arriving);
      const bindingBefore = await repository.getNativeBinding(holder.bindingId);

      await expect(
        repository.declareNativeSession({
          sessionId: arriving,
          projectId: 'project-1',
          workspaceId: 'local',
          native: {
            bindingId: holder.bindingId,
            linkId: arrivingLinkId,
            linkedEventId: `event-linked-${arriving}`,
            payload: {
              bindingId: holder.bindingId,
              expectedVersion: 1,
              link: { id: arrivingLinkId, sessionId: arriving },
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      expect(await repository.getNativeBinding(holder.bindingId)).toEqual(bindingBefore);
      expect((await repository.getNativeLink(holderLinkId))?.unlinkedAt).toBeUndefined();
      expect(await repository.getSession(holder.sessionId)).toMatchObject({ status: 'starting' });
      expect(await repository.getNativeLink(arrivingLinkId)).toBeNull();
      expect(await repository.getSessionNativeBindingId(arriving)).toBeNull();
    });

    it('refuses a declaration for a terminal session and writes nothing', async () => {
      const current = nextCase();
      await register(current.sessionId);
      await repository.closeSession({
        sessionId: current.sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: `event-close-${current.sessionId}`,
      });

      const result = await repository.declareNativeSession({
        sessionId: current.sessionId,
        projectId: 'project-1',
        workspaceId: 'local',
        native: firstDeclaration(current),
      });

      expect(result).toEqual({ status: 'terminal', currentStatus: 'completed' });
      expect(await repository.getNativeBinding(current.bindingId)).toBeNull();
      expect(await repository.getSessionNativeBindingId(current.sessionId)).toBeNull();
    });

    /**
     * The bound-session rule at the deepest layer: the link inside the payload
     * must name the session whose key was declared, so a declaration cannot be
     * redirected at another session no matter what the caller sends.
     */
    it('refuses a declaration whose payload names another session', async () => {
      const current = nextCase();
      await register(current.sessionId);
      const other = `${current.sessionId}-other`;
      const linkId = deriveNativeLinkId(current.bindingId, current.sessionId);

      await expect(
        repository.declareNativeSession({
          sessionId: current.sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          native: {
            bindingId: current.bindingId,
            linkId,
            linkedEventId: `event-linked-${current.sessionId}`,
            payload: {
              bindingId: current.bindingId,
              expectedVersion: 0,
              link: { id: linkId, sessionId: other },
              binding: {
                id: current.bindingId,
                adapterId: current.adapterId,
                nativeSessionId: current.nativeSessionId,
                kind: 'main',
              },
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });

      expect(await repository.getNativeBinding(current.bindingId)).toBeNull();
      expect(await repository.getNativeLink(linkId)).toBeNull();
    });

    /**
     * The stale case through the declaration surface: the previous holder went
     * terminal down the 5-key path, so its link was left open. The arriving
     * declaration closes it and opens its own in one transition, unlinked
     * before linked.
     */
    it('closes a stale link and opens the new one in one declaration', async () => {
      const holder = nextCase();
      const staleLinkId = deriveNativeLinkId(holder.bindingId, holder.sessionId);
      await register(holder.sessionId, firstDeclaration(holder));
      await repository.updateSessionStatus({
        sessionId: holder.sessionId,
        projectId: 'project-1',
        targetStatus: 'completed',
        workspaceId: 'local',
        eventId: `event-status-${holder.sessionId}`,
      });
      const arriving = `${holder.sessionId}-arriving`;
      await register(arriving);
      const linkId = deriveNativeLinkId(holder.bindingId, arriving);

      const result = await repository.declareNativeSession({
        sessionId: arriving,
        projectId: 'project-1',
        workspaceId: 'local',
        native: {
          bindingId: holder.bindingId,
          linkId,
          staleLinkId,
          linkedEventId: `event-linked-${arriving}`,
          unlinkedEventId: `event-unlinked-${arriving}`,
          payload: {
            bindingId: holder.bindingId,
            expectedVersion: 1,
            expectedOpenLinkId: staleLinkId,
            staleLinkId,
            link: { id: linkId, sessionId: arriving },
          },
        },
      });

      expect(result.status).toBe('declared');
      if (result.status !== 'declared') return;
      expect(result.native.transition).toBe('linked');
      expect(result.native.staleLink?.unlinkedAt).toBeDefined();
      const binding = await repository.getNativeBinding(holder.bindingId);
      expect(binding?.openLinkId).toBe(linkId);
      expect(binding?.version).toBe(2);
      expect(binding?.linkCount).toBe(2);
      expect((await repository.getNativeLink(staleLinkId))?.unlinkedAt).toBeDefined();
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeUndefined();
      expect(result.events.map((entry) => entry.event.type)).toEqual([
        'session.native.unlinked',
        'session.native.linked',
      ]);
      expect(result.events.map((entry) => entry.event.id)).toEqual([
        `event-unlinked-${arriving}`,
        `event-linked-${arriving}`,
      ]);
    });

    /**
     * B1's attribution read against real data. Two intervals on one binding —
     * one closed by the arriving session, one still open — and a point-in-time
     * lookup must land in exactly one of them, or in neither.
     */
    it('resolves which session held a binding at a given instant', async () => {
      const holder = nextCase();
      await register(holder.sessionId, firstDeclaration(holder));
      const staleLinkId = deriveNativeLinkId(holder.bindingId, holder.sessionId);

      const arriving = `${holder.sessionId}-successor`;
      await register(arriving);
      const linkId = deriveNativeLinkId(holder.bindingId, arriving);
      await repository.declareNativeSession({
        sessionId: arriving,
        projectId: 'project-1',
        workspaceId: 'local',
        native: {
          bindingId: holder.bindingId,
          linkId,
          staleLinkId,
          linkedEventId: `event-linked-${arriving}`,
          unlinkedEventId: `event-unlinked-${arriving}`,
          payload: {
            bindingId: holder.bindingId,
            expectedVersion: 1,
            expectedOpenLinkId: staleLinkId,
            staleLinkId,
            link: { id: linkId, sessionId: arriving },
          },
        },
      });

      const closed = await repository.getNativeLink(staleLinkId);
      const open = await repository.getNativeLink(linkId);
      const closedFrom = Date.parse(closed?.linkedAt ?? '');
      const closedTo = Date.parse(closed?.unlinkedAt ?? '');
      const openFrom = Date.parse(open?.linkedAt ?? '');

      // Inside the closed interval the first session held it.
      await expect(
        repository.findNativeLinkAt(holder.bindingId, closedFrom),
      ).resolves.toMatchObject({ sessionId: holder.sessionId });

      // The closing instant belongs to the next interval, never this one.
      const atClose = await repository.findNativeLinkAt(holder.bindingId, closedTo);
      expect(atClose?.sessionId).not.toBe(holder.sessionId);

      // Long after the handover the open link still answers.
      await expect(
        repository.findNativeLinkAt(holder.bindingId, openFrom + 86_400_000),
      ).resolves.toMatchObject({ sessionId: arriving });

      // Before the binding existed nothing can be attributed.
      await expect(
        repository.findNativeLinkAt(holder.bindingId, closedFrom - 1),
      ).resolves.toBeNull();
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
