import { LEASE_MAX_ACTIVE_PER_PROJECT, type SessionView, type WorkLease } from '@luwi/protocol';
import type { LeaseRepository } from '@luwi/redis';
import { ApplicationError } from '@luwi/runtime';
import { describe, expect, it, vi } from 'vitest';

import { createLeaseService } from './lease-service.js';
import type { SessionService } from './session-service.js';

const session: SessionView = {
  id: 'session-a',
  agentId: 'codex-main',
  projectId: 'project-1',
  status: 'idle',
  workingDirectory: 'C:/workspace',
  startedAt: '2026-08-10T00:00:00.000Z',
  lastSeenAt: '2026-08-10T00:00:00.000Z',
  online: true,
  metadata: {},
};

const held: WorkLease = {
  id: 'lease-1',
  projectId: 'project-1',
  sessionId: 'session-a',
  agentId: 'codex-main',
  path: 'apps/daemon/src',
  matchPath: 'apps/daemon/src/',
  reason: 'rewriting the capability route',
  state: 'held',
  acquiredAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-08-10T00:05:00.000Z',
};

function build(
  repository: Partial<LeaseRepository>,
  sessionOverrides: Partial<SessionView> | null = {},
) {
  return createLeaseService({
    repository: repository as LeaseRepository,
    sessions: {
      get: vi
        .fn()
        .mockResolvedValue(sessionOverrides === null ? null : { ...session, ...sessionOverrides }),
    } as unknown as SessionService,
    workspaceId: 'local',
    now: () => new Date('2026-08-10T00:00:00.000Z'),
    createId: () => 'lease-1',
  });
}

const acquireInput = {
  projectId: 'project-1',
  sessionId: 'session-a',
  path: 'apps/daemon/src',
  reason: 'rewriting the capability route',
  durationMs: 300_000,
};

describe('createLeaseService acquire', () => {
  it('normalizes the path before it reaches Redis, so the match form is derived once', async () => {
    const acquireLease = vi.fn().mockResolvedValue({ status: 'granted', lease: held });
    const service = build({ acquireLease });

    await service.acquire({ ...acquireInput, path: './apps\\daemon//src/' });

    expect(acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ path: 'apps/daemon/src', matchPath: 'apps/daemon/src/' }),
        expiresMs: Date.parse('2026-08-10T00:05:00.000Z'),
      }),
    );
  });

  it('rejects an invalid path as a caller error rather than a runtime fault', async () => {
    const service = build({ acquireLease: vi.fn() });

    await expect(service.acquire({ ...acquireInput, path: '../outside' })).rejects.toMatchObject({
      code: 'LEASE_PATH_INVALID',
      statusCode: 400,
    });
  });

  it('returns the denial with its holder instead of throwing', async () => {
    const conflict = {
      leaseId: 'lease-other',
      sessionId: 'session-b',
      agentId: 'claude-main',
      path: 'apps/daemon',
      reason: 'refactoring routes',
      expiresAt: '2026-08-10T00:10:00.000Z',
    };
    const service = build({
      acquireLease: vi.fn().mockResolvedValue({ status: 'denied', conflict }),
    });

    await expect(service.acquire(acquireInput)).resolves.toEqual({ status: 'denied', conflict });
  });

  it('refuses a lease for a session that does not exist', async () => {
    const service = build({ acquireLease: vi.fn() }, null);

    await expect(service.acquire(acquireInput)).rejects.toMatchObject({
      code: 'LEASE_SESSION_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('refuses a lease in a project the session does not belong to', async () => {
    const service = build({ acquireLease: vi.fn() }, { projectId: 'project-2' });

    await expect(service.acquire(acquireInput)).rejects.toMatchObject({
      code: 'LEASE_SESSION_PROJECT_MISMATCH',
      statusCode: 409,
    });
  });

  it('refuses a completed session but allows a disconnected one to keep working', async () => {
    const completed = build({ acquireLease: vi.fn() }, { status: 'completed' });
    await expect(completed.acquire(acquireInput)).rejects.toMatchObject({
      code: 'LEASE_SESSION_NOT_ACTIVE',
    });

    const disconnected = build(
      { acquireLease: vi.fn().mockResolvedValue({ status: 'granted', lease: held }) },
      { status: 'disconnected' },
    );
    await expect(disconnected.acquire(acquireInput)).resolves.toMatchObject({ status: 'granted' });
  });

  it('reports the per-project bound as a caller conflict', async () => {
    const service = build({
      acquireLease: vi.fn().mockResolvedValue({ status: 'limit_reached' }),
    });

    await expect(service.acquire(acquireInput)).rejects.toMatchObject({
      code: 'LEASE_LIMIT_REACHED',
      statusCode: 409,
    });
  });

  it('retries a colliding identifier and gives up rather than looping', async () => {
    const acquireLease = vi.fn().mockResolvedValue({ status: 'id_conflict' });
    const service = build({ acquireLease });

    await expect(service.acquire(acquireInput)).rejects.toMatchObject({
      code: 'LEASE_ID_UNAVAILABLE',
      statusCode: 500,
    });
    expect(acquireLease).toHaveBeenCalledTimes(3);
  });
});

describe('createLeaseService renew and release', () => {
  it('renews for the holder and records when', async () => {
    const renewLease = vi.fn().mockResolvedValue({ status: 'updated', lease: held });
    const service = build({ getLease: vi.fn().mockResolvedValue(held), renewLease });

    await service.renew('lease-1', 'session-a', 600_000);

    expect(renewLease).toHaveBeenCalledWith(
      expect.objectContaining({
        holderSessionId: 'session-a',
        expiresMs: Date.parse('2026-08-10T00:10:00.000Z'),
        lease: expect.objectContaining({ renewedAt: '2026-08-10T00:00:00.000Z' }),
      }),
    );
  });

  it('names the holder rule when another session tries to renew', async () => {
    const service = build({
      getLease: vi.fn().mockResolvedValue(held),
      renewLease: vi.fn().mockResolvedValue({ status: 'not_holder', lease: held }),
    });

    await expect(service.renew('lease-1', 'session-b', 300_000)).rejects.toMatchObject({
      code: 'LEASE_NOT_HELD_BY_SESSION',
      statusCode: 409,
    });
  });

  it('reports a lease that is already gone as a state conflict, not as missing', async () => {
    const released = {
      ...held,
      state: 'released' as const,
      releasedAt: '2026-08-10T00:01:00.000Z',
    };
    const service = build({
      getLease: vi.fn().mockResolvedValue(released),
      releaseLease: vi.fn().mockResolvedValue({ status: 'state_conflict', lease: released }),
    });

    await expect(service.release('lease-1', 'session-a')).rejects.toMatchObject({
      code: 'LEASE_NOT_HELD',
      statusCode: 409,
    });
  });

  it('reports an unknown lease as not found', async () => {
    const service = build({ getLease: vi.fn().mockResolvedValue(null) });

    await expect(service.release('lease-x', 'session-a')).rejects.toMatchObject({
      code: 'LEASE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('marks the record released and stamps it', async () => {
    const releaseLease = vi.fn().mockResolvedValue({ status: 'updated', lease: held });
    const service = build({ getLease: vi.fn().mockResolvedValue(held), releaseLease });

    await service.release('lease-1', 'session-a');

    expect(releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          state: 'released',
          releasedAt: '2026-08-10T00:00:00.000Z',
        }),
      }),
    );
  });
});

describe('createLeaseService list and expire', () => {
  it('requires a scope, because leases are indexed by project and by session only', async () => {
    const service = build({});

    await expect(service.list({ limit: 10 })).rejects.toBeInstanceOf(ApplicationError);
    await expect(service.list({ limit: 10 })).rejects.toMatchObject({
      code: 'LEASE_SCOPE_REQUIRED',
      statusCode: 400,
    });
  });

  it('prefers the session index when both scopes are given', async () => {
    const listSessionLeases = vi.fn().mockResolvedValue([held]);
    const listProjectLeases = vi.fn().mockResolvedValue([]);
    const service = build({ listSessionLeases, listProjectLeases });

    await service.list({ projectId: 'project-1', sessionId: 'session-a', limit: 10 });

    expect(listSessionLeases).toHaveBeenCalledWith('session-a', 10);
    expect(listProjectLeases).not.toHaveBeenCalled();
  });

  it('leaves a lease that is no longer held alone rather than expiring it twice', async () => {
    const expireLease = vi.fn();
    const service = build({
      getLease: vi.fn().mockResolvedValue({ ...held, state: 'expired' }),
      expireLease,
    });

    expect(await service.expire('lease-1')).toBe('unchanged');
    expect(expireLease).not.toHaveBeenCalled();
  });

  it('expires a held lease and reports it', async () => {
    const service = build({
      getLease: vi.fn().mockResolvedValue(held),
      expireLease: vi.fn().mockResolvedValue({ status: 'updated', lease: held }),
    });

    expect(await service.expire('lease-1')).toBe('expired');
  });
});

describe('createLeaseService releaseForSession', () => {
  const heldTwo: WorkLease = {
    ...held,
    id: 'lease-2',
    path: 'apps/dashboard/src',
    matchPath: 'apps/dashboard/src/',
  };
  const byId = (leases: WorkLease[]) => {
    const map = new Map(leases.map((lease) => [lease.id, lease]));
    return vi.fn().mockImplementation((id: string) => Promise.resolve(map.get(id) ?? null));
  };

  it('expires every lease a terminating session held, so a rotation orphans none', async () => {
    const expireLease = vi.fn().mockResolvedValue({ status: 'updated', lease: held });
    const listSessionLeases = vi.fn().mockResolvedValue([held, heldTwo]);
    const service = build({ listSessionLeases, getLease: byId([held, heldTwo]), expireLease });

    expect(await service.releaseForSession('session-a')).toBe(2);
    expect(listSessionLeases).toHaveBeenCalledWith('session-a', LEASE_MAX_ACTIVE_PER_PROJECT);
    expect(expireLease).toHaveBeenCalledTimes(2);
    expect(expireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ id: 'lease-1', state: 'expired' }),
        event: expect.objectContaining({ type: 'lease.expired' }),
      }),
    );
  });

  it('is a no-op for a session that holds no leases', async () => {
    const expireLease = vi.fn();
    const service = build({ listSessionLeases: vi.fn().mockResolvedValue([]), expireLease });

    expect(await service.releaseForSession('session-a')).toBe(0);
    expect(expireLease).not.toHaveBeenCalled();
  });

  it('keeps releasing the rest when one lease fails, best-effort', async () => {
    const expireLease = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis blip'))
      .mockResolvedValueOnce({ status: 'updated', lease: heldTwo });
    const service = build({
      listSessionLeases: vi.fn().mockResolvedValue([held, heldTwo]),
      getLease: byId([held, heldTwo]),
      expireLease,
    });

    expect(await service.releaseForSession('session-a')).toBe(1);
    expect(expireLease).toHaveBeenCalledTimes(2);
  });

  it('skips a lease already gone between the list and the release, counting only real expiries', async () => {
    const expireLease = vi.fn().mockResolvedValue({ status: 'updated', lease: held });
    const service = build({
      listSessionLeases: vi.fn().mockResolvedValue([held, heldTwo]),
      // The second lease was released by its holder between the SMEMBERS and the
      // re-read, so it is no longer 'held' and must not be expired a second time.
      getLease: byId([held, { ...heldTwo, state: 'released' }]),
      expireLease,
    });

    expect(await service.releaseForSession('session-a')).toBe(1);
    expect(expireLease).toHaveBeenCalledTimes(1);
  });
});
