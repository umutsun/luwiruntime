import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { DaemonClient, ResourceResult } from './client.js';
import { leaseResourcesForEvent, loadLeaseScope, remainingMs } from './lease-scope.js';

const timestamp = '2026-08-10T00:00:00.000Z';

function lease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lease-1',
    projectId: 'project-1',
    sessionId: 'session-a',
    agentId: 'codex-main',
    path: 'apps/daemon/src',
    matchPath: 'apps/daemon/src/',
    reason: 'rewriting the capability route',
    state: 'held',
    acquiredAt: timestamp,
    expiresAt: '2026-08-10T00:05:00.000Z',
    ...overrides,
  };
}

/** Runs the real protocol schema, so a drifted fixture fails here, not in a browser. */
function stubClient(
  leases: unknown[],
  truncated = false,
): { client: DaemonClient; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    client: {
      async get<T>(path: string, schema: z.ZodType<T>): Promise<ResourceResult<T>> {
        paths.push(path);
        return {
          state: 'ready',
          data: schema.parse({ leases, truncated }),
          httpStatus: 200,
          receivedAt: timestamp,
        };
      },
    },
  };
}

describe('loadLeaseScope', () => {
  it('reads the project scope, because leases have no global index', async () => {
    const { client, paths } = stubClient([lease()]);

    const result = await loadLeaseScope(client, 'project 1', ['leases']);

    expect(paths).toEqual(['/api/v1/leases?projectId=project%201&limit=100']);
    expect(result.leases).toMatchObject({
      state: 'ready',
      data: {
        truncated: false,
        items: [{ id: 'lease-1', path: 'apps/daemon/src', agentId: 'codex-main', state: 'held' }],
      },
    });
  });

  it('leaves a never-renewed lease without a renewal timestamp', async () => {
    const { client } = stubClient([lease()]);

    const result = await loadLeaseScope(client, 'project-1', ['leases']);
    const item = result.leases?.state === 'ready' ? result.leases.data.items[0] : undefined;

    expect(item === undefined ? true : 'renewedAt' in item).toBe(false);
  });

  it('carries the truncation the daemon reports', async () => {
    const { client } = stubClient([lease()], true);

    const result = await loadLeaseScope(client, 'project-1', ['leases']);

    expect(result.leases).toMatchObject({ data: { truncated: true } });
  });

  it('reports a failed read as unavailable rather than as an unlocked project', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'transport' }),
    } as unknown as DaemonClient;

    const result = await loadLeaseScope(client, 'project-1', ['leases']);

    expect(result.leases).toEqual({ state: 'unavailable' });
  });

  it('issues no request when the key is not asked for', async () => {
    const { client, paths } = stubClient([]);

    expect(await loadLeaseScope(client, 'project-1', [])).toEqual({});
    expect(paths).toEqual([]);
  });
});

describe('leaseResourcesForEvent', () => {
  it('refreshes on every lease transition, including a refusal', () => {
    for (const type of [
      'lease.acquired',
      'lease.renewed',
      'lease.released',
      'lease.expired',
      'lease.denied',
    ]) {
      expect(leaseResourcesForEvent(type)).toEqual(['leases']);
    }
  });

  it('refreshes on a runtime lifecycle event', () => {
    expect(leaseResourcesForEvent('runtime.started')).toEqual(['leases']);
  });

  it('ignores families that change no lease', () => {
    for (const type of ['message.requested', 'session.heartbeat', 'config.applied']) {
      expect(leaseResourcesForEvent(type)).toEqual([]);
    }
  });
});

describe('remainingMs', () => {
  const held = {
    id: 'lease-1',
    sessionId: 'session-a',
    agentId: 'codex-main',
    path: 'src',
    reason: 'x',
    state: 'held' as const,
    acquiredAt: timestamp,
    expiresAt: '2026-08-10T00:05:00.000Z',
  };

  it('reports the time left at the moment it is asked', () => {
    expect(remainingMs(held, Date.parse('2026-08-10T00:02:00.000Z'))).toBe(180_000);
  });

  it('clamps a passed expiry to zero rather than reporting negative time', () => {
    expect(remainingMs(held, Date.parse('2026-08-10T00:09:00.000Z'))).toBe(0);
  });

  /** An unparseable expiry is not zero time left; it is no measurement at all. */
  it('reports nothing when the expiry cannot be read', () => {
    expect(remainingMs({ ...held, expiresAt: 'not-a-time' }, 0)).toBeUndefined();
  });
});
