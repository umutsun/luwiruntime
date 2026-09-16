import type { Coordinator, SessionView } from '@luwi/protocol';
import type { CoordinatorRepository } from '@luwi/redis';
import { ApplicationError } from '@luwi/runtime';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorService } from './coordinator-service.js';
import type { SessionService } from './session-service.js';

const claimant: SessionView = {
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

const heldBy: Coordinator = {
  projectId: 'project-1',
  sessionId: 'session-b',
  agentId: 'claude-main',
  claimId: 'claim-b',
  claimedAt: '2026-08-10T00:00:00.000Z',
  version: 4,
};

function build(options: {
  repository: Partial<CoordinatorRepository>;
  sessions?: Record<string, SessionView | null>;
}) {
  const sessions = options.sessions ?? { 'session-a': claimant };
  return createCoordinatorService({
    repository: options.repository as CoordinatorRepository,
    sessions: {
      get: vi.fn((id: string) => Promise.resolve(sessions[id] ?? null)),
    } as unknown as SessionService,
    workspaceId: 'local',
    now: () => new Date('2026-08-10T00:01:00.000Z'),
  });
}

const claimInput = { projectId: 'project-1', sessionId: 'session-a' };

describe('createCoordinatorService claim', () => {
  it('refuses a claim from an unregistered session', async () => {
    const service = build({ repository: {}, sessions: { 'session-a': null } });
    await expect(service.claim(claimInput)).rejects.toMatchObject({
      code: 'COORDINATOR_SESSION_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('refuses a session claiming another project', async () => {
    const service = build({
      repository: {},
      sessions: { 'session-a': { ...claimant, projectId: 'project-2' } },
    });
    await expect(service.claim(claimInput)).rejects.toMatchObject({
      code: 'COORDINATOR_SESSION_PROJECT_MISMATCH',
      statusCode: 409,
    });
  });

  it('refuses a terminal session', async () => {
    const service = build({
      repository: {},
      sessions: { 'session-a': { ...claimant, status: 'completed' } },
    });
    await expect(service.claim(claimInput)).rejects.toMatchObject({
      code: 'COORDINATOR_SESSION_NOT_ACTIVE',
      statusCode: 409,
    });
  });

  it('grants a vacant role with expectedVersion 0', async () => {
    const claimCoordinator = vi.fn().mockResolvedValue({ status: 'claimed', version: 1 });
    const service = build({
      repository: { getCoordinator: vi.fn().mockResolvedValue(null), claimCoordinator },
    });
    const result = await service.claim(claimInput);
    expect(result).toMatchObject({ sessionId: 'session-a', agentId: 'codex-main', version: 1 });
    // A fresh grant carries a claimId nonce and no expected incarnation.
    expect(claimCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 0,
        expectedClaimId: '',
        record: expect.objectContaining({ claimId: expect.any(String) }),
      }),
    );
  });

  it('is idempotent when the same session already holds the role', async () => {
    const own: Coordinator = { ...heldBy, sessionId: 'session-a', agentId: 'codex-main' };
    const claimCoordinator = vi.fn();
    const service = build({
      repository: { getCoordinator: vi.fn().mockResolvedValue(own), claimCoordinator },
    });
    expect(await service.claim(claimInput)).toEqual(own);
    expect(claimCoordinator).not.toHaveBeenCalled();
  });

  it('refuses when a live different session holds the role', async () => {
    const service = build({
      repository: { getCoordinator: vi.fn().mockResolvedValue(heldBy) },
      sessions: { 'session-a': claimant, 'session-b': { ...claimant, id: 'session-b' } },
    });
    await expect(service.claim(claimInput)).rejects.toMatchObject({
      code: 'COORDINATOR_CONFLICT',
      statusCode: 409,
    });
  });

  it('takes over from a terminal holder using its version', async () => {
    const claimCoordinator = vi.fn().mockResolvedValue({ status: 'claimed', version: 5 });
    const service = build({
      repository: { getCoordinator: vi.fn().mockResolvedValue(heldBy), claimCoordinator },
      sessions: {
        'session-a': claimant,
        'session-b': { ...claimant, id: 'session-b', status: 'disconnected' },
      },
    });
    const result = await service.claim(claimInput);
    expect(result.version).toBe(5);
    // A take-over CASes on the observed holder's version AND incarnation nonce.
    expect(claimCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 4, expectedClaimId: 'claim-b' }),
    );
  });

  it('re-reads and retries on a version_conflict, then succeeds', async () => {
    const getCoordinator = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const claimCoordinator = vi
      .fn()
      .mockResolvedValueOnce({ status: 'version_conflict' })
      .mockResolvedValueOnce({ status: 'claimed', version: 1 });
    const service = build({ repository: { getCoordinator, claimCoordinator } });
    expect((await service.claim(claimInput)).version).toBe(1);
    expect(claimCoordinator).toHaveBeenCalledTimes(2);
  });

  it('gives up as contended after the attempt budget of losing CAS races', async () => {
    const service = build({
      repository: {
        getCoordinator: vi.fn().mockResolvedValue(null),
        claimCoordinator: vi.fn().mockResolvedValue({ status: 'version_conflict' }),
      },
    });
    await expect(service.claim(claimInput)).rejects.toMatchObject({
      code: 'COORDINATOR_CONTENDED',
      statusCode: 409,
    });
  });
});

describe('createCoordinatorService release', () => {
  it('releases when the caller holds the role', async () => {
    const releaseCoordinator = vi.fn().mockResolvedValue({ status: 'released' });
    const service = build({ repository: { releaseCoordinator } });
    await expect(service.release(claimInput)).resolves.toBeUndefined();
  });

  it('is a 404 when there is no coordinator', async () => {
    const service = build({
      repository: { releaseCoordinator: vi.fn().mockResolvedValue({ status: 'not_found' }) },
    });
    await expect(service.release(claimInput)).rejects.toMatchObject({
      code: 'COORDINATOR_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('is a 409 when a different session holds the role', async () => {
    const service = build({
      repository: {
        releaseCoordinator: vi
          .fn()
          .mockResolvedValue({ status: 'not_holder', heldBySessionId: 'session-b' }),
      },
    });
    await expect(service.release(claimInput)).rejects.toBeInstanceOf(ApplicationError);
  });
});

describe('createCoordinatorService get', () => {
  it('reports no coordinator as not live', async () => {
    const service = build({
      repository: { getCoordinator: vi.fn().mockResolvedValue(null) },
    });
    expect(await service.get('project-1')).toEqual({ coordinator: null, live: false });
  });

  it('reports a live holder', async () => {
    const service = build({
      repository: { getCoordinator: vi.fn().mockResolvedValue(heldBy) },
      sessions: { 'session-b': { ...claimant, id: 'session-b' } },
    });
    expect(await service.get('project-1')).toEqual({ coordinator: heldBy, live: true });
  });

  it('reports a terminal holder as not live, so the role is takeable', async () => {
    const service = build({
      repository: { getCoordinator: vi.fn().mockResolvedValue(heldBy) },
      sessions: { 'session-b': { ...claimant, id: 'session-b', status: 'disconnected' } },
    });
    expect(await service.get('project-1')).toEqual({ coordinator: heldBy, live: false });
  });
});
