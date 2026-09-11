import { describe, expect, it, vi } from 'vitest';

import { createProjectMutations } from './project-mutations.js';

const project = {
  id: 'project-1',
  name: 'Alpha',
  localPath: 'C:/work/alpha',
  canonicalPath: 'C:/work/alpha',
  repositoryUrl: 'https://example.test/alpha.git',
  defaultBranch: 'main',
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('project mutations', () => {
  it('registers a project with the bounded JSON body the daemon expects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(project, 201));
    const mutations = createProjectMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.register({
      name: ' Alpha ',
      localPath: 'C:/work/alpha',
      repositoryUrl: 'https://example.test/alpha.git',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/projects');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Alpha',
      localPath: 'C:/work/alpha',
      repositoryUrl: 'https://example.test/alpha.git',
    });
    expect(result).toEqual({ state: 'ok', httpStatus: 201, data: project });
  });

  it('patches only the fields given, sending null to clear one', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...project, repositoryUrl: undefined }));
    const mutations = createProjectMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.update('project-1', { name: 'Beta', repositoryUrl: null });

    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/projects/project-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Beta', repositoryUrl: null });
    expect(result.state).toBe('ok');
  });

  it('refuses an empty patch and a blank name before any request', async () => {
    const fetchImpl = vi.fn();
    const mutations = createProjectMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.update('project-1', {})).toMatchObject({
      state: 'failed',
      reason: 'input',
    });
    expect(await mutations.register({ name: '   ', localPath: 'C:/x' })).toMatchObject({
      state: 'failed',
      reason: 'input',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces the daemon public error code and message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'PROJECT_ALREADY_REGISTERED',
            message: 'A project is already registered for this local path.',
          },
        },
        409,
      ),
    );
    const mutations = createProjectMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.register({ name: 'Alpha', localPath: 'C:/work/alpha' });

    expect(result).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'PROJECT_ALREADY_REGISTERED',
      message: 'A project is already registered for this local path.',
    });
  });

  it('reports a transport failure and an invalid body apart', async () => {
    const down = createProjectMutations(
      vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    );
    expect(await down.register({ name: 'Alpha', localPath: 'C:/x' })).toEqual({
      state: 'failed',
      reason: 'transport',
    });

    const garbage = createProjectMutations(
      vi.fn().mockResolvedValue(jsonResponse({ nope: true }, 201)) as unknown as typeof fetch,
    );
    expect(await garbage.register({ name: 'Alpha', localPath: 'C:/x' })).toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 201,
    });
  });
});
