import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorMutations } from './coordinator-mutations.js';

const coordinator = {
  projectId: 'project-1',
  sessionId: 'session-a',
  agentId: 'agent-a',
  claimId: 'claim-1',
  claimedAt: '2026-09-16T10:00:00.000Z',
  version: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('coordinator mutations', () => {
  it('claims the role with the bounded JSON body and returns the holder', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(coordinator, 201));
    const mutations = createCoordinatorMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.claim('project-1', 'session-a');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/projects/project-1/coordinator');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'session-a' });
    expect(result).toEqual({ state: 'ok', httpStatus: 201, data: coordinator });
  });

  it('surfaces a live-holder conflict as the daemon public error code and message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'COORDINATOR_CONFLICT',
            message: 'Project project-1 is already coordinated by session session-b.',
          },
        },
        409,
      ),
    );
    const mutations = createCoordinatorMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.claim('project-1', 'session-a');

    expect(result).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'COORDINATOR_CONFLICT',
      message: 'Project project-1 is already coordinated by session session-b.',
    });
  });

  it('releases on a 204 with no body without trying to parse one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const mutations = createCoordinatorMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.release('project-1', 'session-a');

    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/projects/project-1/coordinator');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'session-a' });
    expect(result).toEqual({ state: 'ok', httpStatus: 204, data: null });
  });

  it('reports a holder-only release refusal with its code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'COORDINATOR_NOT_HELD_BY_SESSION',
            message: 'Only the holder can release.',
          },
        },
        409,
      ),
    );
    const mutations = createCoordinatorMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.release('project-1', 'session-a')).toMatchObject({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'COORDINATOR_NOT_HELD_BY_SESSION',
    });
  });

  it('refuses a blank project or session before any request', async () => {
    const fetchImpl = vi.fn();
    const mutations = createCoordinatorMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.claim('', 'session-a')).toMatchObject({
      state: 'failed',
      reason: 'http',
    });
    expect(await mutations.release('project-1', '  ')).toMatchObject({
      state: 'failed',
      reason: 'http',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a transport failure and an invalid claim body apart', async () => {
    const down = createCoordinatorMutations(
      vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    );
    expect(await down.claim('project-1', 'session-a')).toEqual({
      state: 'failed',
      reason: 'transport',
    });

    const garbage = createCoordinatorMutations(
      vi.fn().mockResolvedValue(jsonResponse({ nope: true }, 201)) as unknown as typeof fetch,
    );
    expect(await garbage.claim('project-1', 'session-a')).toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 201,
    });
  });
});
