import { randomUUID } from 'node:crypto';

import { deriveNativeBindingId, deriveNativeLinkId } from '@luwi/runtime';
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
  'native session link retention',
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

    /** 2026-08-01T00:00:00.000Z, so every seeded score is a stable known value. */
    const baseMs = Date.UTC(2026, 7, 1);

    type SeededLink = { id: string; sessionId: string; linkedAtMs: number; linkedAt: string };
    type SeededBinding = {
      bindingId: string;
      closed: SeededLink[];
      open?: SeededLink;
    };

    /**
     * Writes exactly the fields `native_apply` and `native_unlink` write, without
     * paying a full registration per link. The last case in this file registers
     * and closes for real and trims that link, which is what keeps this helper
     * honest against the transition path.
     */
    async function seedBinding(config: {
      closedLinks: number;
      openLink?: boolean;
      version?: number;
      trimmedLinkCount?: number;
    }): Promise<SeededBinding> {
      sequence += 1;
      const bindingId = `binding-${String(sequence).padStart(4, '0')}`;
      const version = config.version ?? 1;
      const linkCount = config.closedLinks + (config.openLink === true ? 1 : 0);

      const makeLink = (index: number): SeededLink => {
        const linkedAtMs = baseMs + index * 1_000;
        return {
          id: `${bindingId}-link-${String(index).padStart(5, '0')}`,
          sessionId: `${bindingId}-session-${String(index).padStart(5, '0')}`,
          linkedAtMs,
          linkedAt: new Date(linkedAtMs).toISOString(),
        };
      };

      // The open link is seeded oldest on purpose: retention must skip it by
      // record state, not by position.
      const open = config.openLink === true ? makeLink(0) : undefined;
      const closed = Array.from({ length: config.closedLinks }, (_, index) => makeLink(index + 1));

      await commandClient.sendCommand([
        'HSET',
        keys.nativeSessionBinding(bindingId),
        'id',
        bindingId,
        'adapterId',
        'claude-code-native-v1',
        'nativeSessionId',
        `native-${bindingId}`,
        'kind',
        'main',
        'version',
        String(version),
        'linkCount',
        String(linkCount),
        'trimmedLinkCount',
        String(config.trimmedLinkCount ?? 0),
        'firstLinkedAt',
        new Date(baseMs).toISOString(),
        'lastLinkedAt',
        new Date(baseMs + linkCount * 1_000).toISOString(),
        ...(open === undefined ? [] : ['openLinkId', open.id]),
      ]);

      const all = open === undefined ? closed : [open, ...closed];
      await Promise.all(
        all.map(async (link) => {
          await commandClient.sendCommand([
            'HSET',
            keys.nativeSessionLink(link.id),
            'id',
            link.id,
            'bindingId',
            bindingId,
            'sessionId',
            link.sessionId,
            'linkedAt',
            link.linkedAt,
            ...(link === open ? [] : ['unlinkedAt', new Date(link.linkedAtMs + 500).toISOString()]),
          ]);
          await commandClient.sendCommand([
            'SET',
            keys.sessionNativeBinding(link.sessionId),
            bindingId,
          ]);
        }),
      );
      await commandClient.sendCommand([
        'ZADD',
        keys.nativeSessionLinks(bindingId),
        ...all.flatMap((link) => [String(link.linkedAtMs), link.id]),
      ]);

      return open === undefined ? { bindingId, closed } : { bindingId, closed, open };
    }

    /**
     * A raw FCALL, so a case can declare keys and a payload that disagree. The
     * repository can never produce that disagreement, which is exactly why the
     * Function has to refuse it on its own.
     */
    async function callTrim(input: {
      bindingId: string;
      expectedVersion: number | string;
      declared: { id: string; sessionId: string }[];
      keyPairs?: { linkKey: string; reverseKey: string }[];
      bindingKey?: string;
      linksKey?: string;
      declaredBindingId?: string;
    }): Promise<Record<string, unknown>> {
      const pairs =
        input.keyPairs ??
        input.declared.map((link) => ({
          linkKey: keys.nativeSessionLink(link.id),
          reverseKey: keys.sessionNativeBinding(link.sessionId),
        }));
      const commandKeys = [
        input.bindingKey ?? keys.nativeSessionBinding(input.bindingId),
        input.linksKey ?? keys.nativeSessionLinks(input.bindingId),
        ...pairs.flatMap((pair) => [pair.linkKey, pair.reverseKey]),
      ];
      const reply = await commandClient.sendCommand([
        'FCALL',
        registry.functions.nativeLinkTrim,
        String(commandKeys.length),
        ...commandKeys,
        String(input.expectedVersion),
        JSON.stringify({
          bindingId: input.declaredBindingId ?? input.bindingId,
          links: input.declared,
        }),
      ]);
      return JSON.parse(String(reply)) as Record<string, unknown>;
    }

    async function snapshot(
      bindingId: string,
      links: readonly { id: string; sessionId: string }[],
    ): Promise<unknown> {
      return {
        binding: await commandClient.sendCommand(['HGETALL', keys.nativeSessionBinding(bindingId)]),
        linkCount: await commandClient.sendCommand(['ZCARD', keys.nativeSessionLinks(bindingId)]),
        links: await Promise.all(
          links.map((link) =>
            commandClient.sendCommand(['HGETALL', keys.nativeSessionLink(link.id)]),
          ),
        ),
        reverse: await Promise.all(
          links.map((link) =>
            commandClient.sendCommand(['GET', keys.sessionNativeBinding(link.sessionId)]),
          ),
        ),
      };
    }

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
          name: 'Retention',
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
            '500',
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

    describe('native_link_trim', () => {
      it('trims the oldest closed link when the binding is one over the bound', async () => {
        const seeded = await seedBinding({ closedLinks: 1001 });
        const oldest = seeded.closed[0];
        if (oldest === undefined) throw new Error('Expected a seeded link');

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: oldest.id, sessionId: oldest.sessionId }],
        });

        expect(result).toMatchObject({ status: 'trimmed', trimmed: 1 });
        expect(
          await commandClient.sendCommand(['ZCARD', keys.nativeSessionLinks(seeded.bindingId)]),
        ).toBe(1000);
        expect(await repository.getNativeLink(oldest.id)).toBeNull();
        const survivor = seeded.closed[1];
        if (survivor === undefined) throw new Error('Expected a surviving link');
        expect(await repository.getNativeLink(survivor.id)).not.toBeNull();
      });

      it('refuses to trim the open link, even when it is the oldest', async () => {
        const seeded = await seedBinding({ closedLinks: 2, openLink: true });
        const open = seeded.open;
        if (open === undefined) throw new Error('Expected an open link');
        const before = await snapshot(seeded.bindingId, [open]);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: open.id, sessionId: open.sessionId }],
        });

        expect(result).toEqual({ status: 'error', code: 'VERSION_CONFLICT' });
        expect(await snapshot(seeded.bindingId, [open])).toEqual(before);
      });

      it('removes the link hash, the zset member and the reverse index together', async () => {
        const seeded = await seedBinding({ closedLinks: 3 });
        const target = seeded.closed[0];
        if (target === undefined) throw new Error('Expected a seeded link');

        await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: target.id, sessionId: target.sessionId }],
        });

        expect(await commandClient.sendCommand(['EXISTS', keys.nativeSessionLink(target.id)])).toBe(
          0,
        );
        expect(
          await commandClient.sendCommand([
            'ZSCORE',
            keys.nativeSessionLinks(seeded.bindingId),
            target.id,
          ]),
        ).toBeNull();
        expect(await repository.getSessionNativeBindingId(target.sessionId)).toBeNull();
      });

      it('increments trimmedLinkCount by the removed count and version exactly once', async () => {
        const seeded = await seedBinding({ closedLinks: 5, version: 7, trimmedLinkCount: 4 });
        const targets = seeded.closed.slice(0, 3);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 7,
          declared: targets.map((link) => ({ id: link.id, sessionId: link.sessionId })),
        });

        expect(result).toMatchObject({ status: 'trimmed', trimmed: 3 });
        const binding = await repository.getNativeBinding(seeded.bindingId);
        expect(binding?.trimmedLinkCount).toBe(7);
        expect(binding?.version).toBe(8);
        // linkCount records links ever created and must survive the cut.
        expect(binding?.linkCount).toBe(5);
      });

      it('sets oldestRetainedLinkedAt from the oldest link that remains', async () => {
        const seeded = await seedBinding({ closedLinks: 4 });
        const targets = seeded.closed.slice(0, 2);
        const survivor = seeded.closed[2];
        if (survivor === undefined) throw new Error('Expected a surviving link');

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: targets.map((link) => ({ id: link.id, sessionId: link.sessionId })),
        });

        expect(result).toMatchObject({ oldestRetainedLinkedAt: survivor.linkedAt });
        expect((await repository.getNativeBinding(seeded.bindingId))?.oldestRetainedLinkedAt).toBe(
          survivor.linkedAt,
        );
      });

      it('clears oldestRetainedLinkedAt when the last link is trimmed', async () => {
        const seeded = await seedBinding({ closedLinks: 1 });
        const target = seeded.closed[0];
        if (target === undefined) throw new Error('Expected a seeded link');

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: target.id, sessionId: target.sessionId }],
        });

        expect(result).not.toHaveProperty('oldestRetainedLinkedAt');
        expect(
          await commandClient.sendCommand([
            'HEXISTS',
            keys.nativeSessionBinding(seeded.bindingId),
            'oldestRetainedLinkedAt',
          ]),
        ).toBe(0);
      });

      it('refuses a stale expectedVersion and writes nothing', async () => {
        const seeded = await seedBinding({ closedLinks: 2, version: 4 });
        const target = seeded.closed[0];
        if (target === undefined) throw new Error('Expected a seeded link');
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 3,
          declared: [{ id: target.id, sessionId: target.sessionId }],
        });

        expect(result).toEqual({ status: 'error', code: 'VERSION_CONFLICT' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });

      it('refuses a link that carries no unlinkedAt and writes nothing', async () => {
        const seeded = await seedBinding({ closedLinks: 2 });
        const target = seeded.closed[0];
        if (target === undefined) throw new Error('Expected a seeded link');
        await commandClient.sendCommand(['HDEL', keys.nativeSessionLink(target.id), 'unlinkedAt']);
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: target.id, sessionId: target.sessionId }],
        });

        expect(result).toEqual({ status: 'error', code: 'VERSION_CONFLICT' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });

      it('refuses a link that belongs to another binding and writes nothing', async () => {
        const owner = await seedBinding({ closedLinks: 2 });
        const foreign = await seedBinding({ closedLinks: 2 });
        const target = foreign.closed[0];
        if (target === undefined) throw new Error('Expected a seeded link');
        const before = await snapshot(foreign.bindingId, foreign.closed);

        // Declared under `owner`, but keyed at a link `foreign` holds.
        const result = await callTrim({
          bindingId: owner.bindingId,
          expectedVersion: 1,
          declared: [{ id: target.id, sessionId: target.sessionId }],
        });

        expect(result).toEqual({ status: 'error', code: 'VERSION_CONFLICT' });
        expect(await snapshot(foreign.bindingId, foreign.closed)).toEqual(before);
      });

      it('refuses a link whose stored sessionId differs from the declaration', async () => {
        const seeded = await seedBinding({ closedLinks: 2 });
        const target = seeded.closed[0];
        const other = seeded.closed[1];
        if (target === undefined || other === undefined) throw new Error('Expected two links');
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: target.id, sessionId: other.sessionId }],
        });

        expect(result).toEqual({ status: 'error', code: 'VERSION_CONFLICT' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });

      it('refuses a declared link id that does not match the key it was given', async () => {
        const seeded = await seedBinding({ closedLinks: 2 });
        const target = seeded.closed[0];
        const other = seeded.closed[1];
        if (target === undefined || other === undefined) throw new Error('Expected two links');
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: target.id, sessionId: target.sessionId }],
          keyPairs: [
            {
              linkKey: keys.nativeSessionLink(other.id),
              reverseKey: keys.sessionNativeBinding(target.sessionId),
            },
          ],
        });

        expect(result).toEqual({ status: 'error', code: 'VERSION_CONFLICT' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });

      it('refuses a reverse index key that names another binding', async () => {
        const seeded = await seedBinding({ closedLinks: 2 });
        const foreign = await seedBinding({ closedLinks: 1 });
        const target = seeded.closed[0];
        const foreignLink = foreign.closed[0];
        if (target === undefined || foreignLink === undefined) {
          throw new Error('Expected seeded links');
        }
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [{ id: target.id, sessionId: target.sessionId }],
          keyPairs: [
            {
              linkKey: keys.nativeSessionLink(target.id),
              reverseKey: keys.sessionNativeBinding(foreignLink.sessionId),
            },
          ],
        });

        expect(result).toEqual({ status: 'error', code: 'VERSION_CONFLICT' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
        expect(await repository.getSessionNativeBindingId(foreignLink.sessionId)).toBe(
          foreign.bindingId,
        );
      });

      it('refuses the same link declared twice and writes nothing', async () => {
        const seeded = await seedBinding({ closedLinks: 2 });
        const target = seeded.closed[0];
        if (target === undefined) throw new Error('Expected a seeded link');
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [
            { id: target.id, sessionId: target.sessionId },
            { id: target.id, sessionId: target.sessionId },
          ],
        });

        expect(result).toEqual({ status: 'error', code: 'REDIS_ARGUMENT_INVALID' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });

      /**
       * D2: a trim that removes nothing is not a mutation, so it must not move
       * `version` — doing so would invalidate every concurrent observation for
       * no state change.
       */
      it('refuses an empty trim and leaves the binding untouched', async () => {
        const seeded = await seedBinding({ closedLinks: 2 });
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: [],
        });

        expect(result).toEqual({ status: 'error', code: 'REDIS_ARGUMENT_INVALID' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });

      it('refuses more than 32 links in one call and writes nothing', async () => {
        const seeded = await seedBinding({ closedLinks: 40 });
        const before = await snapshot(seeded.bindingId, seeded.closed);

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: seeded.closed
            .slice(0, 33)
            .map((link) => ({ id: link.id, sessionId: link.sessionId })),
        });

        expect(result).toEqual({ status: 'error', code: 'REDIS_ARGUMENT_INVALID' });
        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });

      it('trims exactly 32 links in one call', async () => {
        const seeded = await seedBinding({ closedLinks: 40 });

        const result = await callTrim({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          declared: seeded.closed
            .slice(0, 32)
            .map((link) => ({ id: link.id, sessionId: link.sessionId })),
        });

        expect(result).toMatchObject({ status: 'trimmed', trimmed: 32 });
        expect(
          await commandClient.sendCommand(['ZCARD', keys.nativeSessionLinks(seeded.bindingId)]),
        ).toBe(8);
      });

      /**
       * The seeding helper above writes what this transition writes. This case
       * is what proves that claim rather than assuming it.
       */
      it('trims a link the real registration and close path produced', async () => {
        const adapterId = 'claude-code-native-v1';
        const nativeSessionId = 'native-real-path';
        const bindingId = deriveNativeBindingId({ adapterId, nativeSessionId });
        const sessionId = 'session-real-path';
        const linkId = deriveNativeLinkId(bindingId, sessionId);

        await repository.registerSession({
          session: {
            id: sessionId,
            agentId: 'codex-sim',
            projectId: 'project-1',
            status: 'starting',
            workingDirectory: 'C:/workspace/luwi',
            metadataJson: '{"source":"retention-integration"}',
          },
          workspaceId: 'local',
          eventId: `event-session-${sessionId}`,
          presenceTtlMs: 15_000,
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
        });
        await repository.closeSession({
          sessionId,
          projectId: 'project-1',
          workspaceId: 'local',
          eventId: `event-close-${sessionId}`,
          native: {
            bindingId,
            linkId,
            expectedVersion: 1,
            expectedOpenLinkId: linkId,
            unlinkedEventId: `event-unlink-${sessionId}`,
          },
        });

        const result = await callTrim({
          bindingId,
          expectedVersion: 2,
          declared: [{ id: linkId, sessionId }],
        });

        expect(result).toMatchObject({ status: 'trimmed', trimmed: 1 });
        expect(await repository.getNativeLink(linkId)).toBeNull();
        expect(await repository.getSessionNativeBindingId(sessionId)).toBeNull();
        const binding = await repository.getNativeBinding(bindingId);
        expect(binding?.trimmedLinkCount).toBe(1);
        expect(binding?.version).toBe(3);
        expect(binding?.oldestRetainedLinkedAt).toBeUndefined();
      });
    });

    describe('retention reads', () => {
      it('resolves the distinct binding ids a session list names', async () => {
        const first = await seedBinding({ closedLinks: 2 });
        const second = await seedBinding({ closedLinks: 1 });
        const sessionIds = [
          ...first.closed.map((link) => link.sessionId),
          ...second.closed.map((link) => link.sessionId),
          'session-with-no-binding',
        ];

        const bindingIds = await repository.listSessionNativeBindingIds(sessionIds);

        expect(bindingIds).toEqual([first.bindingId, second.bindingId]);
      });

      it('resolves nothing without issuing a command for an empty session list', async () => {
        expect(await repository.listSessionNativeBindingIds([])).toEqual([]);
      });

      it('reports the binding together with its link count', async () => {
        const seeded = await seedBinding({ closedLinks: 3, openLink: true, version: 5 });

        const state = await repository.getNativeRetentionState(seeded.bindingId);

        expect(state?.linkCount).toBe(4);
        expect(state?.binding.version).toBe(5);
        expect(state?.binding.openLinkId).toBe(seeded.open?.id);
      });

      it('reports nothing for a binding that does not exist', async () => {
        expect(await repository.getNativeRetentionState('binding-absent')).toBeNull();
      });

      it('lists the oldest links first, bounded by the limit', async () => {
        const seeded = await seedBinding({ closedLinks: 4, openLink: true });

        const oldest = await repository.listOldestNativeLinks(seeded.bindingId, 3);

        expect(oldest.map((link) => link.id)).toEqual([
          seeded.open?.id,
          seeded.closed[0]?.id,
          seeded.closed[1]?.id,
        ]);
        expect(oldest[0]?.unlinkedAt).toBeUndefined();
        expect(oldest[1]?.unlinkedAt).toBeDefined();
      });

      it('trims through the repository and reports the new metadata', async () => {
        const seeded = await seedBinding({ closedLinks: 3 });
        const targets = seeded.closed.slice(0, 2);
        const survivor = seeded.closed[2];
        if (survivor === undefined) throw new Error('Expected a surviving link');

        const result = await repository.trimNativeLinks({
          bindingId: seeded.bindingId,
          expectedVersion: 1,
          links: targets.map((link) => ({ id: link.id, sessionId: link.sessionId })),
        });

        expect(result).toEqual({
          trimmedCount: 2,
          version: 2,
          trimmedLinkCount: 2,
          oldestRetainedLinkedAt: survivor.linkedAt,
        });
      });

      it('throws VERSION_CONFLICT from the repository on a stale version', async () => {
        const seeded = await seedBinding({ closedLinks: 2, version: 3 });
        const target = seeded.closed[0];
        if (target === undefined) throw new Error('Expected a seeded link');
        const before = await snapshot(seeded.bindingId, seeded.closed);

        await expect(
          repository.trimNativeLinks({
            bindingId: seeded.bindingId,
            expectedVersion: 2,
            links: [{ id: target.id, sessionId: target.sessionId }],
          }),
        ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

        expect(await snapshot(seeded.bindingId, seeded.closed)).toEqual(before);
      });
    });
  },
);
