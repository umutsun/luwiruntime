import { describe, expect, it, vi } from 'vitest';

import { createGoalMutations } from './goal-mutations.js';

const goal = {
  id: 'goal-1',
  projectId: 'project-1',
  title: 'Add localized dates',
  objective: 'Localize the admin dates',
  acceptanceCriteria: [],
  createdBy: { kind: 'operator' },
  budget: {
    maxTasks: 12,
    maxReworksPerTask: 1,
    maxReplans: 2,
    maxWallClockMs: 14_400_000,
    minConfidence: 0.6,
  },
  state: 'proposed',
  planVersion: 0,
  taskIds: [],
  usage: { tasks: 0, reworks: 0, replans: 0, judgments: 0, invalidJudgments: 0 },
  version: 1,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('goal mutations', () => {
  it('creates a goal with the request body and returns the created goal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(goal, 201));
    const mutations = createGoalMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.create('project-1', {
      title: 'Add localized dates',
      objective: 'Localize the admin dates',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/projects/project-1/goals');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'Add localized dates',
      objective: 'Localize the admin dates',
    });
    expect(result).toEqual({ state: 'ok', httpStatus: 201, data: goal });
  });

  it('encodes the project id and forwards acceptance criteria', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(goal, 201));
    const mutations = createGoalMutations(fetchImpl as unknown as typeof fetch);

    await mutations.create('a/b', {
      title: 'T',
      objective: 'O',
      acceptanceCriteria: ['one', 'two'],
    });

    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/projects/a%2Fb/goals');
    expect(JSON.parse(init.body as string).acceptanceCriteria).toEqual(['one', 'two']);
  });

  it('surfaces a daemon validation error as its public code and message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: 'REQUEST_VALIDATION_FAILED', message: 'objective is required.' } },
          400,
        ),
      );
    const mutations = createGoalMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.create('project-1', { title: 'T', objective: '' })).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 400,
      code: 'REQUEST_VALIDATION_FAILED',
      message: 'objective is required.',
    });
  });

  it('refuses a blank project before any request', async () => {
    const fetchImpl = vi.fn();
    const mutations = createGoalMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.create('  ', { title: 'T', objective: 'O' })).toMatchObject({
      state: 'failed',
      reason: 'http',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a transport failure and an invalid body apart', async () => {
    const down = createGoalMutations(
      vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    );
    expect(await down.create('project-1', { title: 'T', objective: 'O' })).toEqual({
      state: 'failed',
      reason: 'transport',
    });

    const garbage = createGoalMutations(
      vi.fn().mockResolvedValue(jsonResponse({ nope: true }, 201)) as unknown as typeof fetch,
    );
    expect(await garbage.create('project-1', { title: 'T', objective: 'O' })).toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 201,
    });
  });
});
