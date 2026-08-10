import { randomUUID } from 'node:crypto';

import { createRuntimeEvent, normalizeLeasePath, type WorkLease } from '@luwi/protocol';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createLeaseRepository,
  createRedisKeys,
  createRuntimeRepository,
  type LeaseRepository,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

/**
 * The lease Functions, against a real server.
 *
 * The claim these tests exist to check is atomicity: two overlapping acquires
 * must produce exactly one grant, and a conflict must leave no half-written
 * record behind. Neither can be shown with a stubbed client.
 */
describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'work lease Functions',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let runtimeRepository: RuntimeRepository;
    let leases: LeaseRepository;

    const at = (offsetMs: number) => new Date(1_800_000_000_000 + offsetMs).toISOString();
    const nowMs = 1_800_000_000_000;

    const lease = (overrides: Partial<WorkLease> & { path: string; id: string }): WorkLease => {
      const normalized = normalizeLeasePath(overrides.path);
      return {
        projectId: 'project-1',
        sessionId: 'session-a',
        agentId: 'codex-sim',
        reason: 'editing the capability route',
        state: 'held',
        acquiredAt: at(0),
        expiresAt: at(300_000),
        ...overrides,
        path: normalized.path,
        matchPath: normalized.matchPath,
      };
    };

    const event = (
      type:
        'lease.acquired' | 'lease.denied' | 'lease.renewed' | 'lease.released' | 'lease.expired',
    ) =>
      createRuntimeEvent({
        type,
        workspaceId: 'local',
        projectId: 'project-1',
        payload: {},
      });

    const acquire = (record: WorkLease, expiresMs = nowMs + 300_000) =>
      leases.acquireLease({
        lease: record,
        grantedEvent: event('lease.acquired'),
        deniedEvent: event('lease.denied'),
        nowMs,
        expiresMs,
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
      leases = createLeaseRepository({ client: commandClient, keys, functions: registry });
      await runtimeRepository.registerProject({
        project: {
          id: 'project-1',
          name: 'Leases',
          localPath: 'C:/workspace/leases',
          canonicalPath: 'C:/workspace/leases',
          identityPath: 'c:/workspace/leases',
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

    it('grants a lease over a free path and indexes it for the sweep', async () => {
      const result = await acquire(lease({ id: 'lease-free', path: 'apps/daemon/src' }));

      expect(result.status).toBe('granted');
      expect(await leases.getLease('lease-free')).toMatchObject({
        path: 'apps/daemon/src',
        state: 'held',
      });
      expect(await leases.findDueLeaseDeadlines(nowMs + 400_000, 10)).toContain('lease-free');
    });

    it('refuses an overlapping path and names the holder', async () => {
      await acquire(lease({ id: 'lease-parent', path: 'packages/redis' }));

      const denied = await acquire(
        lease({
          id: 'lease-child',
          path: 'packages/redis/src/lease-repository.ts',
          sessionId: 'session-b',
          agentId: 'claude-sim',
        }),
      );

      expect(denied.status).toBe('denied');
      expect(denied.status === 'denied' ? denied.conflict : undefined).toMatchObject({
        leaseId: 'lease-parent',
        sessionId: 'session-a',
        path: 'packages/redis',
      });
      // The refusal wrote nothing: a denied acquire must not leave a record.
      expect(await leases.getLease('lease-child')).toBeNull();
    });

    it('grants a sibling whose name merely starts with the same characters', async () => {
      await acquire(lease({ id: 'lease-app', path: 'apps/dashboard/src/app' }));

      const sibling = await acquire(
        lease({ id: 'lease-appendix', path: 'apps/dashboard/src/appendix' }),
      );

      expect(sibling.status).toBe('granted');
    });

    it('lets exactly one of two overlapping acquires win when they are issued together', async () => {
      const [first, second] = await Promise.all([
        acquire(lease({ id: 'race-a', path: 'packages/runtime/src' })),
        acquire(
          lease({
            id: 'race-b',
            path: 'packages/runtime/src/iris',
            sessionId: 'session-b',
            agentId: 'claude-sim',
          }),
        ),
      ]);

      const granted = [first, second].filter((result) => result.status === 'granted');
      const denied = [first, second].filter((result) => result.status === 'denied');
      expect(granted).toHaveLength(1);
      expect(denied).toHaveLength(1);
    });

    it('ignores an expired holder rather than refusing on its behalf', async () => {
      await leases.acquireLease({
        lease: lease({ id: 'lease-stale', path: 'docs/legacy' }),
        grantedEvent: event('lease.acquired'),
        deniedEvent: event('lease.denied'),
        nowMs,
        expiresMs: nowMs + 1_000,
      });

      const later = await leases.acquireLease({
        lease: lease({ id: 'lease-fresh', path: 'docs/legacy', sessionId: 'session-b' }),
        grantedEvent: event('lease.acquired'),
        deniedEvent: event('lease.denied'),
        nowMs: nowMs + 60_000,
        expiresMs: nowMs + 360_000,
      });

      expect(later.status).toBe('granted');
    });

    it('renews only for the holder and extends the sweep deadline', async () => {
      const held = lease({ id: 'lease-renew', path: 'apps/cli' });
      await acquire(held);

      const stranger = await leases.renewLease({
        lease: { ...held, expiresAt: at(900_000) },
        event: event('lease.renewed'),
        holderSessionId: 'session-b',
        expiresMs: nowMs + 900_000,
      });
      expect(stranger.status).toBe('not_holder');

      const holder = await leases.renewLease({
        lease: { ...held, expiresAt: at(900_000), renewedAt: at(1_000) },
        event: event('lease.renewed'),
        holderSessionId: 'session-a',
        expiresMs: nowMs + 900_000,
      });
      expect(holder.status).toBe('updated');
      expect(await leases.getLease('lease-renew')).toMatchObject({ expiresAt: at(900_000) });
      expect(await leases.findDueLeaseDeadlines(nowMs + 400_000, 10)).not.toContain('lease-renew');
    });

    it('releases for the holder, frees the path, and leaves the record readable', async () => {
      const held = lease({ id: 'lease-release', path: 'apps/mcp-server' });
      await acquire(held);

      const released = await leases.releaseLease({
        lease: { ...held, state: 'released', releasedAt: at(60_000) },
        event: event('lease.released'),
        holderSessionId: 'session-a',
      });

      expect(released.status).toBe('updated');
      expect(await leases.getLease('lease-release')).toMatchObject({ state: 'released' });
      expect(await leases.findDueLeaseDeadlines(nowMs + 400_000, 10)).not.toContain(
        'lease-release',
      );
      const reacquired = await acquire(
        lease({ id: 'lease-reacquired', path: 'apps/mcp-server', sessionId: 'session-b' }),
      );
      expect(reacquired.status).toBe('granted');
    });

    it('refuses to release a lease that is already gone', async () => {
      const held = lease({ id: 'lease-twice', path: 'scripts' });
      await acquire(held);
      const gone = { ...held, state: 'released' as const, releasedAt: at(10_000) };
      await leases.releaseLease({
        lease: gone,
        event: event('lease.released'),
        holderSessionId: 'session-a',
      });

      const again = await leases.releaseLease({
        lease: gone,
        event: event('lease.released'),
        holderSessionId: 'session-a',
      });

      expect(again.status).toBe('state_conflict');
    });

    it('expires without a holder, because expiry is the runtime\u2019s own transition', async () => {
      const held = lease({ id: 'lease-expire', path: 'temp' });
      await acquire(held);

      const expired = await leases.expireLease({
        lease: { ...held, state: 'expired' },
        event: event('lease.expired'),
      });

      expect(expired.status).toBe('updated');
      expect(await leases.getLease('lease-expire')).toMatchObject({ state: 'expired' });
      expect(await leases.findDueLeaseDeadlines(nowMs + 400_000, 20)).not.toContain('lease-expire');
    });

    it('reports a missing lease rather than inventing one', async () => {
      const absent = await leases.releaseLease({
        lease: lease({ id: 'lease-absent', path: 'nowhere' }),
        event: event('lease.released'),
        holderSessionId: 'session-a',
      });

      expect(absent.status).toBe('not_found');
    });

    it('lists a session\u2019s held leases and drops them from the index once released', async () => {
      await acquire(
        lease({ id: 'lease-listed', path: 'packages/adapters', sessionId: 'session-c' }),
      );

      const before = await leases.listSessionLeases('session-c', 10);
      expect(before.map((entry) => entry.id)).toContain('lease-listed');

      await leases.releaseLease({
        lease: {
          ...lease({ id: 'lease-listed', path: 'packages/adapters', sessionId: 'session-c' }),
          state: 'released',
          releasedAt: at(5_000),
        },
        event: event('lease.released'),
        holderSessionId: 'session-c',
      });

      const after = await leases.listSessionLeases('session-c', 10);
      expect(after.map((entry) => entry.id)).not.toContain('lease-listed');
    });
  },
);
