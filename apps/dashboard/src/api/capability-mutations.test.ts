import { describe, expect, it, vi } from 'vitest';

import { createCapabilityMutations } from './capability-mutations.js';

const timestamp = '2026-09-17T10:00:00.000Z';

const capability = {
  id: 'cap-1',
  kind: 'skill',
  name: 'release-notes',
  scope: 'project',
  projectId: 'project-1',
  source: 'luwi-project',
  checksum: 'a'.repeat(64),
  compatibleAgentKinds: [],
  requiredCapabilityIds: [],
  requiredMcpIds: [],
  enabled: false,
  manifest: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};

const binding = {
  id: 'cap-1:project:project-1:agent-1',
  capabilityId: 'cap-1',
  scope: 'project',
  projectId: 'project-1',
  agentId: 'agent-1',
  enabled: true,
  settings: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('capability mutations', () => {
  it('disables a package with a bounded PATCH and returns the record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(capability));
    const mutations = createCapabilityMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.setEnabled('cap-1', false);

    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/capabilities/cap-1');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
    expect(result).toEqual({ state: 'ok', httpStatus: 200, data: capability });
  });

  it('assigns to one agent of a project with the daemon assignment shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(binding));
    const mutations = createCapabilityMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.assign('cap-1', { projectId: 'project-1', agentId: 'agent-1' });

    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/capabilities/cap-1/assign');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      scope: 'project',
      projectId: 'project-1',
      agentId: 'agent-1',
      enabled: true,
      settings: {},
    });
    expect(result).toEqual({ state: 'ok', httpStatus: 200, data: binding });
  });

  it('unassigns from the whole project when no agent is named', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...binding, agentId: undefined }));
    const mutations = createCapabilityMutations(fetchImpl as unknown as typeof fetch);

    await mutations.unassign('cap-1', { projectId: 'project-1' });

    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/capabilities/cap-1/unassign');
    expect(JSON.parse(init.body as string)).toEqual({
      scope: 'project',
      projectId: 'project-1',
      enabled: true,
      settings: {},
    });
  });

  it('rescans with an empty JSON body and returns the diagnostics', async () => {
    const scan = {
      capabilities: [],
      diagnostics: {
        rootsScanned: 3,
        rootsUnavailable: 1,
        malformedManifests: 0,
        ignoredEntries: 0,
        conflictsSkipped: 0,
        truncated: false,
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(scan));
    const mutations = createCapabilityMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.rescan();

    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/capabilities/scan');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(result).toEqual({ state: 'ok', httpStatus: 200, data: scan });
  });

  it('surfaces a daemon refusal in its own code and message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'CAPABILITY_CONFLICT',
            message: 'A project capability can only be assigned inside its owning project.',
          },
        },
        409,
      ),
    );
    const mutations = createCapabilityMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.assign('cap-1', { projectId: 'project-2' })).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'CAPABILITY_CONFLICT',
      message: 'A project capability can only be assigned inside its owning project.',
    });
  });

  it('refuses blank ids before any request, and reports transport and invalid bodies apart', async () => {
    const idle = vi.fn();
    const mutations = createCapabilityMutations(idle as unknown as typeof fetch);
    expect(await mutations.setEnabled(' ', true)).toMatchObject({
      state: 'failed',
      reason: 'http',
    });
    expect(await mutations.assign('cap-1', { projectId: '' })).toMatchObject({
      state: 'failed',
      reason: 'http',
    });
    expect(await mutations.unassign('cap-1', { projectId: 'p', agentId: ' ' })).toMatchObject({
      state: 'failed',
      reason: 'http',
    });
    expect(idle).not.toHaveBeenCalled();

    const down = createCapabilityMutations(
      vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    );
    expect(await down.rescan()).toEqual({ state: 'failed', reason: 'transport' });

    const garbage = createCapabilityMutations(
      vi.fn().mockResolvedValue(jsonResponse({ nope: true })) as unknown as typeof fetch,
    );
    expect(await garbage.setEnabled('cap-1', true)).toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 200,
    });
  });
});
