import { randomUUID } from 'node:crypto';

import type { BridgeSlotAcquireRequest, BridgeSlotView } from '@luwi/protocol';
import { deriveBridgeSlotId, deriveNativeBindingId, deriveNativeLinkId } from '@luwi/runtime';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as redis from './index.js';

const url = process.env.LUWI_TEST_REDIS_URL;
describe.skipIf(url === undefined || process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS !== 'true')(
  'bridge slot atomic fencing',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = redis.createRedisKeys(namespace);
    const functions = redis.createFunctionRegistry(runId);
    let client: RedisClientType;
    let repository: redis.RuntimeRepository;
    const commandClient: redis.RedisCommandClient = {
      sendCommand: (args) => client.sendCommand([...args]),
    };
    let sequence = 0;
    const request = (): BridgeSlotAcquireRequest & { eventId: string; expiredEventId: string } => ({
      workspaceId: 'local',
      projectId: 'project-1',
      agentId: `agent-${++sequence}`,
      provider: 'codex',
      executionProfile: 'workspace-write',
      ownerToken: randomUUID(),
      eventId: randomUUID(),
      expiredEventId: randomUUID(),
    });
    const slotKeys = (input: BridgeSlotAcquireRequest) => {
      const id = deriveBridgeSlotId(input);
      return [
        keys.bridgeSlot(id),
        keys.bridgeSlotOwner(id),
        keys.bridgeSlotsIndex,
        keys.bridgeSlotDeadlines,
        keys.globalEvents,
        keys.projectEvents(input.projectId),
      ];
    };
    const call = async (
      operation: string,
      input: ReturnType<typeof request>,
      extra: Record<string, unknown> = {},
      overrideKeys?: string[],
    ) => {
      const declaredKeys = overrideKeys ?? slotKeys(input);
      const result = await commandClient.sendCommand([
        'FCALL',
        `luwi_bridge_slot_${operation}_v1_${runId}`,
        String(declaredKeys.length),
        ...declaredKeys,
        JSON.stringify({ ...input, slotId: deriveBridgeSlotId(input), ttlMs: 15000, ...extra }),
      ]);
      return JSON.parse(result as string) as {
        status: string;
        code?: string;
        slot: BridgeSlotView;
      };
    };
    const owner = (input: ReturnType<typeof request>) => ({
      slotId: deriveBridgeSlotId(input),
      ownerToken: input.ownerToken,
      provider: input.provider,
      executionProfile: input.executionProfile,
    });
    const registration = (input: ReturnType<typeof request>, sessionId = randomUUID()) => ({
      session: {
        id: sessionId,
        projectId: input.projectId,
        agentId: input.agentId,
        status: 'starting' as const,
        workingDirectory: 'C:/fixture',
        metadataJson: '{"source":"test"}',
      },
      workspaceId: input.workspaceId,
      eventId: randomUUID(),
      presenceTtlMs: 15000,
      bridgeOwner: owner(input),
      bridgeAttachedEventId: randomUUID(),
    });
    const events = async () => {
      const rows = await client.xRange(keys.globalEvents, '-', '+');
      return rows.map(
        (row) =>
          JSON.parse(row.message.event!) as {
            type: string;
            payload: { slot?: BridgeSlotView };
            id: string;
          },
      );
    };
    const slotEvents = async (id: string) =>
      (await events()).filter((event) => event.payload.slot?.id === id);
    const expireOwner = async (input: ReturnType<typeof request>) => {
      const id = deriveBridgeSlotId(input);
      const slot = JSON.parse((await client.hGet(keys.bridgeSlot(id), 'json'))!) as BridgeSlotView;
      slot.expiresAt = '2020-01-01T00:00:00.000Z';
      await client.hSet(keys.bridgeSlot(id), 'json', JSON.stringify(slot));
      await client.zAdd(keys.bridgeSlotDeadlines, { score: Date.parse(slot.expiresAt), value: id });
      await client.del(keys.bridgeSlotOwner(id));
      return slot;
    };
    const expectNoSession = async (id: string) => {
      expect(
        await client.exists([
          keys.session(id),
          keys.sessionPresence(id),
          keys.sessionInbox(id),
          keys.sessionNativeBinding(id),
        ]),
      ).toBe(0);
    };
    beforeAll(async () => {
      if (url !== 'redis://127.0.0.1:6391')
        throw new Error('Bridge fixture requires dedicated port 6391.');
      client = createClient({ url });
      client.on('error', () => undefined);
      await client.connect();
      await client.sendCommand(['FUNCTION', 'LOAD', redis.buildFunctionLibrary(functions).source]);
      repository = redis.createRuntimeRepository({ client: commandClient, keys, functions });
      await repository.registerProject({
        project: {
          id: 'project-1',
          name: 'Fixture',
          localPath: 'C:/fixture',
          canonicalPath: 'C:/fixture',
          identityPath: 'c:/fixture',
          pathIdentityHash: 'f'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'project-event',
      });
    });
    afterAll(async () => {
      if (!client?.isOpen) return;
      let cursor = '0';
      do {
        const result = await client.scan(cursor, { MATCH: `${namespace}:*`, COUNT: 100 });
        cursor = result.cursor;
        if (result.keys.length) await client.del(result.keys);
      } while (cursor !== '0');
      await client.sendCommand(['FUNCTION', 'DELETE', functions.libraryName]);
      await client.quit();
    });

    it('grants exactly one concurrent owner and returns only public state', async () => {
      const input = request();
      const contender = { ...input, ownerToken: randomUUID(), eventId: randomUUID() };
      const results = await Promise.all([call('acquire', input), call('acquire', contender)]);
      expect(results.map((result) => result.status).sort()).toEqual(['acquired', 'held']);
      expect(await client.pTTL(keys.bridgeSlot(deriveBridgeSlotId(input)))).toBe(-1);
      expect(await client.pTTL(keys.bridgeSlotOwner(deriveBridgeSlotId(input)))).toBeGreaterThan(
        14000,
      );
      expect(JSON.stringify(results)).not.toContain(input.ownerToken);
      expect(JSON.stringify(await events())).not.toContain(input.ownerToken);
    });
    it('retries acquire without adding an event or advancing revision', async () => {
      const input = request();
      const first = await call('acquire', input);
      expect(await call('acquire', input)).toMatchObject({
        status: 'acquired',
        slot: { revision: first.slot.revision },
      });
      expect(await slotEvents(deriveBridgeSlotId(input))).toHaveLength(1);
    });
    it('retains monotonic revisions and emits exactly one expired event during reacquire', async () => {
      const input = request();
      await call('acquire', input);
      await expireOwner(input);
      const winner = { ...input, ownerToken: randomUUID(), eventId: randomUUID() };
      expect(await call('acquire', winner)).toMatchObject({
        status: 'acquired',
        slot: { revision: 3 },
      });
      await call('acquire', winner);
      expect((await slotEvents(deriveBridgeSlotId(input))).map((event) => event.type)).toEqual([
        'bridge.slot.acquired',
        'bridge.slot.expired',
        'bridge.slot.acquired',
      ]);
      for (const operation of ['renew', 'release', 'attach']) {
        expect(
          await call(
            operation,
            input,
            { sessionId: 'stale-session' },
            operation === 'attach'
              ? [...slotKeys(input), keys.session('stale-session')]
              : undefined,
          ),
        ).toMatchObject({ status: 'not_owner' });
      }
      expect(await client.get(keys.bridgeSlotOwner(deriveBridgeSlotId(input)))).toBe(
        winner.ownerToken,
      );
    });
    it('a renewal defeats an expiry candidate without advancing semantic revision', async () => {
      const input = request();
      const acquired = await call('acquire', input);
      const renewed = await call('renew', input);
      expect(renewed).toMatchObject({ status: 'renewed', slot: { revision: 1 } });
      expect(
        await call('expire', input, {
          expectedRevision: 1,
          expectedExpiresAt: acquired.slot.expiresAt,
        }),
      ).toMatchObject({ status: 'unchanged' });
      expect(await slotEvents(deriveBridgeSlotId(input))).toHaveLength(1);
    });
    it('expires an owner exactly once using expected revision and expiry', async () => {
      const input = request();
      await call('acquire', input);
      const slot = await expireOwner(input);
      const extra = {
        expectedRevision: slot.revision,
        expectedExpiresAt: slot.expiresAt,
        eventId: randomUUID(),
      };
      expect(await call('expire', input, extra)).toMatchObject({
        status: 'expired',
        slot: { state: 'expired', revision: 2 },
      });
      expect(await call('expire', input, extra)).toMatchObject({ status: 'unchanged' });
      expect(
        (await slotEvents(slot.id)).filter((event) => event.type === 'bridge.slot.expired'),
      ).toHaveLength(1);
      expect(await client.zScore(keys.bridgeSlotDeadlines, slot.id)).toBeNull();
    });
    it('release clears the owner/deadline/attachment while preserving discoverability', async () => {
      const input = request();
      await call('acquire', input);
      await repository.registerSession(registration(input));
      expect(await call('release', input)).toMatchObject({
        status: 'released',
        slot: { state: 'standby', revision: 3 },
      });
      const slot = JSON.parse(
        (await client.hGet(keys.bridgeSlot(deriveBridgeSlotId(input)), 'json'))!,
      ) as BridgeSlotView;
      expect(slot.sessionId).toBeUndefined();
      expect(await client.get(keys.bridgeSlotOwner(slot.id))).toBeNull();
      expect(await client.zScore(keys.bridgeSlotDeadlines, slot.id)).toBeNull();
      expect(await client.sIsMember(keys.bridgeSlotsIndex, slot.id)).toBe(1);
      expect(await call('release', input)).toMatchObject({ status: 'not_owner' });
    });
    it('rejects stale-token registration before creating any session or inbox state', async () => {
      const input = request();
      await call('acquire', input);
      const reg = registration({ ...input, ownerToken: randomUUID() });
      const count = (await events()).length;
      expect(await repository.registerSession(reg)).toEqual({ status: 'bridge_slot_not_owner' });
      await expectNoSession(reg.session.id);
      expect(await events()).toHaveLength(count);
    });
    it.each(['bridge', 'bridgeSlotId', 'provider', 'executionProfile'])(
      'rejects reserved %s metadata with or without an owner',
      async (field) => {
        const input = request();
        await call('acquire', input);
        const reg = registration(input);
        reg.session.metadataJson = JSON.stringify({ [field]: 'injected' });
        const count = (await events()).length;
        expect(await repository.registerSession(reg)).toEqual({
          status: 'reserved_metadata_rejected',
        });
        const plain = {
          session: reg.session,
          workspaceId: reg.workspaceId,
          eventId: reg.eventId,
          presenceTtlMs: reg.presenceTtlMs,
        };
        expect(await repository.registerSession(plain)).toEqual({
          status: 'reserved_metadata_rejected',
        });
        await expectNoSession(reg.session.id);
        expect(await events()).toHaveLength(count);
      },
    );
    it('registers and attaches atomically, preserves stable reply retries, and permits rotation', async () => {
      const input = request();
      await call('acquire', input);
      const reg = registration(input);
      const first = await repository.registerSession(reg);
      expect(first).toMatchObject({
        status: 'created',
        session: {
          metadata: {
            source: 'test',
            bridge: 'native-headless',
            bridgeSlotId: deriveBridgeSlotId(input),
            provider: 'codex',
            executionProfile: 'workspace-write',
          },
        },
        events: expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({ type: 'bridge.slot.attached' }),
          }),
        ]),
      });
      expect(await repository.registerSession(reg)).toEqual(first);
      expect(
        (await slotEvents(deriveBridgeSlotId(input))).filter(
          (event) => event.type === 'bridge.slot.attached',
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(first)).not.toContain(input.ownerToken);
      const rotated = registration(input);
      expect(await repository.registerSession(rotated)).toMatchObject({ status: 'created' });
      const slot = JSON.parse(
        (await client.hGet(keys.bridgeSlot(deriveBridgeSlotId(input)), 'json'))!,
      ) as BridgeSlotView;
      expect(slot).toMatchObject({ sessionId: rotated.session.id, revision: 3 });
      await client.del(keys.bridgeSlotOwner(slot.id));
      expect(await repository.registerSession(reg)).toEqual(first);
      expect(JSON.parse((await client.hGet(keys.bridgeSlot(slot.id), 'json'))!)).toEqual(slot);
    });
    it('supports bridged native registration and exactly-once retry', async () => {
      const input = request();
      await call('acquire', input);
      const reg = registration(input);
      const ref = { adapterId: 'codex-native-v1', nativeSessionId: randomUUID() };
      const bindingId = deriveNativeBindingId(ref);
      const linkId = deriveNativeLinkId(bindingId, reg.session.id);
      const native: redis.NativeRegistrationInput = {
        bindingId,
        linkId,
        linkedEventId: randomUUID(),
        payload: {
          bindingId,
          expectedVersion: 0,
          link: { id: linkId, sessionId: reg.session.id },
          binding: { id: bindingId, ...ref, kind: 'main' },
        },
      };
      const first = await repository.registerSession({ ...reg, native });
      expect(first).toMatchObject({ status: 'created', native: { transition: 'created' } });
      expect(await repository.registerSession({ ...reg, native })).toEqual(first);
      expect(await repository.getSessionNativeBindingId(reg.session.id)).toBe(bindingId);
    });
    it('attach validates session identity and changes revision/events only on a new attachment', async () => {
      const input = request();
      await call('acquire', input);
      const reg = registration(input);
      await repository.registerSession(reg);
      const attachKeys = [...slotKeys(input), keys.session(reg.session.id)];
      expect(await call('attach', input, { sessionId: reg.session.id }, attachKeys)).toMatchObject({
        status: 'unchanged',
        slot: { revision: 2 },
      });
      const other = registration({ ...input, agentId: 'other-agent' });
      const plain = {
        session: other.session,
        workspaceId: other.workspaceId,
        eventId: other.eventId,
        presenceTtlMs: other.presenceTtlMs,
      };
      await repository.registerSession(plain);
      expect(
        await call('attach', input, { sessionId: other.session.id }, [
          ...slotKeys(input),
          keys.session(other.session.id),
        ]),
      ).toMatchObject({ status: 'error', code: 'REDIS_STATE_INVALID' });
      expect(await slotEvents(deriveBridgeSlotId(input))).toHaveLength(2);
    });
    it('heartbeat preserves bridge metadata and rejects every reserved caller key without writes', async () => {
      const input = request();
      await call('acquire', input);
      const reg = registration(input);
      await repository.registerSession(reg);
      const heartbeat = {
        sessionId: reg.session.id,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        eventId: randomUUID(),
        presenceTtlMs: 15000,
        eventIntervalMs: 0,
        metadataJson: '{"progress":"working"}',
      };
      expect(await repository.heartbeatSession(heartbeat)).toMatchObject({ status: 'renewed' });
      expect((await repository.getSession(reg.session.id))?.metadata).toEqual({
        progress: 'working',
        bridge: 'native-headless',
        bridgeSlotId: deriveBridgeSlotId(input),
        provider: input.provider,
        executionProfile: input.executionProfile,
      });
      const before = await client.hGetAll(keys.session(reg.session.id));
      const count = (await events()).length;
      for (const field of ['bridge', 'bridgeSlotId', 'provider', 'executionProfile']) {
        expect(
          await repository.heartbeatSession({
            ...heartbeat,
            metadataJson: JSON.stringify({ [field]: 'injected' }),
          }),
        ).toEqual({ status: 'reserved_metadata_rejected' });
      }
      expect(await client.hGetAll(keys.session(reg.session.id))).toEqual(before);
      expect(await events()).toHaveLength(count);
    });
    it.each([0, 1, 2, 3, 4, 5])(
      'preflights corrupt slot key %s before any mutation',
      async (index) => {
        const input = request();
        const declared = slotKeys(input);
        const corrupt = `${namespace}:corrupt:${randomUUID()}`;
        await client.set(corrupt, 'corrupt');
        if (index === 1) {
          await client.del(corrupt);
          await client.hSet(corrupt, 'bad', 'type');
        }
        declared[index] = corrupt;
        const count = (await events()).length;
        expect(await call('acquire', input, {}, declared)).toMatchObject({
          status: 'error',
          code: 'REDIS_STATE_INVALID',
        });
        expect(await client.exists(slotKeys(input).slice(0, 2))).toBe(0);
        expect(await events()).toHaveLength(count);
      },
    );
    it('preflights all required append capacity during expired reacquire and bridged registration', async () => {
      const input = request();
      await call('acquire', input);
      const expired = await expireOwner(input);
      const exhausted = `${namespace}:exhausted:${randomUUID()}`;
      await client.xAdd(exhausted, '18446744073709551615-18446744073709551614', {
        fixture: 'capacity-one',
      });
      const declared = slotKeys(input);
      declared[5] = exhausted;
      expect(
        await call('acquire', { ...input, ownerToken: randomUUID() }, {}, declared),
      ).toMatchObject({ status: 'error', code: 'REDIS_STATE_INVALID' });
      expect(JSON.parse((await client.hGet(keys.bridgeSlot(expired.id), 'json'))!)).toEqual(
        expired,
      );
      expect(await client.get(keys.bridgeSlotOwner(expired.id))).toBeNull();
      const next = request();
      await call('acquire', next);
      const reg = registration(next);
      const guarded = redis.createRuntimeRepository({
        client: {
          sendCommand: (args) =>
            commandClient.sendCommand(
              args.map((arg) => (arg === keys.projectEvents(next.projectId) ? exhausted : arg)),
            ),
        },
        keys,
        functions,
      });
      const before = await client.hGetAll(keys.bridgeSlot(deriveBridgeSlotId(next)));
      await expect(guarded.registerSession(reg)).rejects.toMatchObject({
        code: 'REDIS_STATE_INVALID',
      });
      await expectNoSession(reg.session.id);
      expect(await client.hGetAll(keys.bridgeSlot(deriveBridgeSlotId(next)))).toEqual(before);
    });

    it.each([0, 14999, 15001, -1, 1.5, '15000'])(
      'rejects a non-protocol slot TTL %s without writes',
      async (ttlMs) => {
        const input = request();
        expect(await call('acquire', input, { ttlMs })).toMatchObject({
          status: 'error',
          code: 'REDIS_ARGUMENT_INVALID',
        });
        expect(await client.exists(slotKeys(input).slice(0, 2))).toBe(0);
      },
    );

    it.each(['revision', 'expiry', 'identity', 'ownerTTL', 'projectionTTL', 'ownerDeadline'])(
      'rejects corrupt %s slot evidence before renew, release, attach, or registration',
      async (corruption) => {
        const input = request();
        const acquired = await call('acquire', input);
        const id = deriveBridgeSlotId(input);
        if (corruption === 'ownerTTL') await client.persist(keys.bridgeSlotOwner(id));
        else if (corruption === 'projectionTTL') await client.pExpire(keys.bridgeSlot(id), 60000);
        else if (corruption === 'ownerDeadline')
          await client.pExpire(keys.bridgeSlotOwner(id), 5000);
        else {
          const slot = { ...acquired.slot };
          if (corruption === 'revision') slot.revision = Number.MAX_SAFE_INTEGER;
          if (corruption === 'expiry') slot.expiresAt = '2099-01-01T00:00:00.000Z';
          if (corruption === 'identity') slot.projectId = 'wrong-project';
          await client.hSet(keys.bridgeSlot(id), 'json', JSON.stringify(slot));
        }
        const reg = registration(input);
        const before = await client.hGetAll(keys.bridgeSlot(id));
        const count = (await events()).length;
        for (const operation of ['renew', 'release', 'attach']) {
          expect(
            await call(
              operation,
              input,
              { sessionId: reg.session.id },
              operation === 'attach'
                ? [...slotKeys(input), keys.session(reg.session.id)]
                : undefined,
            ),
          ).toMatchObject({ status: 'error', code: 'REDIS_STATE_INVALID' });
        }
        await expect(repository.registerSession(reg)).rejects.toMatchObject({
          code: 'REDIS_STATE_INVALID',
        });
        await expectNoSession(reg.session.id);
        expect(await client.hGetAll(keys.bridgeSlot(id))).toEqual(before);
        expect(await events()).toHaveLength(count);
      },
    );

    it.each(['[]', '{"large":"' + 'x'.repeat(16400) + '"}'])(
      'rejects invalid session metadata before bridge attachment',
      async (metadataJson) => {
        const input = request();
        await call('acquire', input);
        const reg = registration(input);
        reg.session.metadataJson = metadataJson;
        const count = (await events()).length;
        await expect(repository.registerSession(reg)).rejects.toMatchObject({
          code: 'REDIS_ARGUMENT_INVALID',
        });
        await expectNoSession(reg.session.id);
        expect(await events()).toHaveLength(count);
      },
    );

    it('rejects an overflowing presence TTL before registration or heartbeat mutations', async () => {
      const input = request();
      await call('acquire', input);
      const reg = registration(input);
      await expect(
        repository.registerSession({ ...reg, presenceTtlMs: 1e30 }),
      ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });
      await expectNoSession(reg.session.id);
      await repository.registerSession(reg);
      const before = await client.hGetAll(keys.session(reg.session.id));
      await expect(
        repository.heartbeatSession({
          sessionId: reg.session.id,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          eventId: randomUUID(),
          presenceTtlMs: 1e30,
          eventIntervalMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });
      expect(await client.hGetAll(keys.session(reg.session.id))).toEqual(before);
    });

    it('preflights four events for bridged native rotation before closing a stale link', async () => {
      const input = request();
      await call('acquire', input);
      const original = registration(input);
      const ref = { adapterId: 'codex-native-v1', nativeSessionId: randomUUID() };
      const bindingId = deriveNativeBindingId(ref);
      const linkId = deriveNativeLinkId(bindingId, original.session.id);
      await repository.registerSession({
        ...original,
        native: {
          bindingId,
          linkId,
          linkedEventId: randomUUID(),
          payload: {
            bindingId,
            expectedVersion: 0,
            link: { id: linkId, sessionId: original.session.id },
            binding: { id: bindingId, ...ref, kind: 'main' },
          },
        },
      });
      const reg = registration(input);
      const nextLinkId = deriveNativeLinkId(bindingId, reg.session.id);
      const native: redis.NativeRegistrationInput = {
        bindingId,
        linkId: nextLinkId,
        staleLinkId: linkId,
        linkedEventId: randomUUID(),
        unlinkedEventId: randomUUID(),
        payload: {
          bindingId,
          expectedVersion: 1,
          expectedOpenLinkId: linkId,
          staleLinkId: linkId,
          link: { id: nextLinkId, sessionId: reg.session.id },
        },
      };
      const stream = `${namespace}:capacity-three:${randomUUID()}`;
      await client.xAdd(stream, '18446744073709551615-18446744073709551612', {
        fixture: 'capacity-three',
      });
      const guarded = redis.createRuntimeRepository({
        client: {
          sendCommand: (args) =>
            commandClient.sendCommand(
              args.map((arg) => (arg === keys.projectEvents(input.projectId) ? stream : arg)),
            ),
        },
        keys,
        functions,
      });
      const slotBefore = await client.hGetAll(keys.bridgeSlot(deriveBridgeSlotId(input)));
      const bindingBefore = await client.hGetAll(keys.nativeSessionBinding(bindingId));
      await expect(guarded.registerSession({ ...reg, native })).rejects.toMatchObject({
        code: 'REDIS_STATE_INVALID',
      });
      await expectNoSession(reg.session.id);
      expect(await client.hGetAll(keys.nativeSessionBinding(bindingId))).toEqual(bindingBefore);
      expect(await client.hGetAll(keys.bridgeSlot(deriveBridgeSlotId(input)))).toEqual(slotBefore);
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeUndefined();
      expect(await client.exists(keys.nativeSessionLink(nextLinkId))).toBe(0);
      expect(await repository.registerSession({ ...reg, native })).toMatchObject({
        status: 'created',
        events: expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({ type: 'bridge.slot.attached' }),
          }),
        ]),
      });
      expect((await repository.getNativeLink(linkId))?.unlinkedAt).toBeDefined();
    });

    it('fences every bridge key to the declared namespace and tuple', async () => {
      const input = request();
      const wrongKeys = [
        `${namespace}:wrong:slot`,
        `${namespace}:wrong:owner`,
        `${namespace}:wrong:index`,
        `${namespace}:wrong:deadlines`,
        `${namespace}:wrong:global`,
        `${namespace}:wrong:project`,
      ];
      expect(await call('acquire', input, {}, wrongKeys)).toMatchObject({
        status: 'error',
        code: 'REDIS_STATE_INVALID',
      });
      expect(await client.exists(wrongKeys)).toBe(0);
    });

    it('never permits an owner token to become a public event identifier', async () => {
      const input = request();
      expect(await call('acquire', { ...input, eventId: input.ownerToken })).toMatchObject({
        status: 'error',
        code: 'REDIS_ARGUMENT_INVALID',
      });
      expect(await call('acquire', { ...input, expiredEventId: input.ownerToken })).toMatchObject({
        status: 'error',
        code: 'REDIS_ARGUMENT_INVALID',
      });
      await call('acquire', input);

      for (const collision of ['registration', 'attachment', 'native'] as const) {
        const reg = registration(input);
        if (collision === 'registration') reg.eventId = input.ownerToken;
        if (collision === 'attachment') reg.bridgeAttachedEventId = input.ownerToken;
        if (collision === 'native') {
          const ref = { adapterId: 'codex-native-v1', nativeSessionId: randomUUID() };
          const bindingId = deriveNativeBindingId(ref);
          const linkId = deriveNativeLinkId(bindingId, reg.session.id);
          await expect(
            repository.registerSession({
              ...reg,
              native: {
                bindingId,
                linkId,
                linkedEventId: input.ownerToken,
                payload: {
                  bindingId,
                  expectedVersion: 0,
                  link: { id: linkId, sessionId: reg.session.id },
                  binding: { id: bindingId, ...ref, kind: 'main' },
                },
              },
            }),
          ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });
        } else {
          await expect(repository.registerSession(reg)).rejects.toMatchObject({
            code: 'REDIS_ARGUMENT_INVALID',
          });
        }
        await expectNoSession(reg.session.id);
      }
      expect(JSON.stringify(await events())).not.toContain(input.ownerToken);
    });

    it('does not let a different provider or profile expire a retained slot', async () => {
      const input = request();
      await call('acquire', input);
      const slot = await expireOwner(input);
      const expected = {
        expectedRevision: slot.revision,
        expectedExpiresAt: slot.expiresAt,
        eventId: randomUUID(),
      };
      expect(await call('expire', { ...input, provider: 'claude-code' }, expected)).toMatchObject({
        status: 'unchanged',
      });
      expect(
        await call('expire', { ...input, executionProfile: 'read-only' }, expected),
      ).toMatchObject({ status: 'unchanged' });
      expect(JSON.parse((await client.hGet(keys.bridgeSlot(slot.id), 'json'))!)).toEqual(slot);
    });

    it.each([
      ['plain', '18446744073709551615-18446744073709551614'],
      ['native', '18446744073709551615-18446744073709551612'],
    ] as const)(
      'rejects aliased global/project Streams before any %s registration writes',
      async (variant, nearMaximumId) => {
        const caseNamespace = `${namespace}:alias:${randomUUID()}`;
        const caseKeys = redis.createRedisKeys(caseNamespace);
        const baseRepository = redis.createRuntimeRepository({
          client: commandClient,
          keys: caseKeys,
          functions,
        });
        await baseRepository.registerProject({
          project: {
            id: 'project-alias',
            name: 'Alias fixture',
            localPath: 'C:/fixture',
            canonicalPath: 'C:/fixture',
            identityPath: 'c:/fixture',
            pathIdentityHash: 'e'.repeat(64),
          },
          workspaceId: 'local',
          eventId: randomUUID(),
        });
        await client.del(caseKeys.globalEvents);
        await client.xAdd(caseKeys.globalEvents, nearMaximumId, { fixture: 'near-capacity' });
        const aliased = redis.createRuntimeRepository({
          client: {
            sendCommand: (args) =>
              commandClient.sendCommand(
                args.map((argument) =>
                  argument === caseKeys.projectEvents('project-alias')
                    ? caseKeys.globalEvents
                    : argument,
                ),
              ),
          },
          keys: caseKeys,
          functions,
        });
        const sessionId = randomUUID();
        const registrationInput: redis.RegisterSessionInput = {
          session: {
            id: sessionId,
            projectId: 'project-alias',
            agentId: 'codex',
            status: 'starting',
            workingDirectory: 'C:/fixture',
            metadataJson: '{}',
          },
          workspaceId: 'local',
          eventId: randomUUID(),
          presenceTtlMs: 15_000,
        };
        if (variant === 'native') {
          const ref = { adapterId: 'codex-native-v1', nativeSessionId: randomUUID() };
          const bindingId = deriveNativeBindingId(ref);
          const linkId = deriveNativeLinkId(bindingId, sessionId);
          registrationInput.native = {
            bindingId,
            linkId,
            linkedEventId: randomUUID(),
            payload: {
              bindingId,
              expectedVersion: 0,
              link: { id: linkId, sessionId },
              binding: { id: bindingId, ...ref, kind: 'main' },
            },
          };
        }
        await expect(aliased.registerSession(registrationInput)).rejects.toMatchObject({
          code: 'REDIS_STATE_INVALID',
        });
        expect(
          await client.exists([
            caseKeys.session(sessionId),
            caseKeys.sessionPresence(sessionId),
            caseKeys.sessionInbox(sessionId),
          ]),
        ).toBe(0);
      },
    );
  },
);
