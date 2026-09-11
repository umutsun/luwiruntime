import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { DaemonClient, ResourceResult } from './client.js';
import {
  loadProjectScope,
  projectResourcesForEvent,
  projectScopeResourceKeys,
} from './project-scope.js';

const SHA256 = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

const gitFixture = {
  id: 'git-1',
  projectId: 'proj-1',
  repositoryRoot: 'C:/work/demo',
  branch: 'master',
  headSha: COMMIT,
  defaultBranch: 'main',
  remoteUrl: 'https://example.invalid/demo.git',
  clean: false,
  stagedCount: 2,
  unstagedCount: 3,
  untrackedCount: 4,
  ahead: 1,
  behind: 0,
  branches: ['master', 'main'],
  tags: ['v1'],
  worktrees: [
    { path: 'C:/work/demo', headSha: COMMIT, branch: 'master' },
    { path: 'C:/work/demo-wt', headSha: COMMIT, detached: true, locked: true },
  ],
  recentCommits: [
    {
      sha: COMMIT,
      parentShas: [],
      committedAt: '2026-08-08T00:00:00.000Z',
      subject: 'initial',
      authorIdentity: 'dev',
      changedPaths: ['src/index.ts'],
      trailers: {},
      merge: false,
    },
  ],
  observedAt: '2026-08-08T00:00:00.000Z',
  repositoryStateHash: SHA256,
};

const packagesFixture = {
  packages: [
    {
      id: 'pkg-1',
      projectId: 'proj-1',
      ecosystem: 'node',
      packageName: 'fastify',
      declaredVersion: '^5.10.0',
      dependencyType: 'production',
      direct: true,
      workspaceLocation: 'apps/daemon',
      manifestPath: 'apps/daemon/package.json',
      detectedAt: '2026-08-08T00:00:00.000Z',
      manifestHash: SHA256,
    },
  ],
  truncated: true,
};

const technologiesFixture = {
  technologies: [
    {
      id: 'tech-1',
      projectId: 'proj-1',
      name: 'TypeScript',
      category: 'language',
      confidence: 'high',
      evidence: [{ kind: 'manifest', value: 'tsconfig.json', path: 'tsconfig.json' }],
      detectedAt: '2026-08-08T00:00:00.000Z',
    },
    {
      id: 'tech-2',
      projectId: 'proj-1',
      name: 'Mystery',
      category: 'framework',
      confidence: 'unknown',
      evidence: [{ kind: 'file-pattern', value: '*.mystery' }],
      detectedAt: '2026-08-08T00:00:00.000Z',
    },
  ],
  truncated: false,
};

const attributionsFixture = {
  attributions: [
    {
      id: 'attr-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      commitSha: COMMIT,
      confidence: 'correlated',
      observedAt: '2026-08-08T00:00:00.000Z',
      evidenceIds: ['git-1', COMMIT],
      reasons: ['session-window-overlap'],
    },
    {
      id: 'attr-2',
      projectId: 'proj-1',
      commitSha: 'c'.repeat(40),
      confidence: 'unknown',
      observedAt: '2026-08-08T00:00:00.000Z',
      evidenceIds: ['git-1'],
      reasons: ['insufficient-session-correlation'],
    },
  ],
  truncated: true,
};

const bindingsFixture = {
  bindings: [
    {
      id: 'bind-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      enabled: true,
      role: 'primary',
      profileIds: [],
      capabilityBindingIds: [],
      overrides: {},
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
  ],
};

type Reply = { body: unknown } | { fail: 'transport' } | { fail: 'http'; status: number };

/**
 * The stub runs the real schema against the fixture, so these tests prove the
 * fixtures match `@luwi/protocol` as well as proving the mapping. A drifted
 * schema fails here rather than at runtime in the browser.
 */
function stubClient(replies: Record<string, Reply>) {
  const paths: string[] = [];
  const client: DaemonClient = {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<ResourceResult<T>> {
      paths.push(path);
      const matched = Object.entries(replies).find(([prefix]) => path.startsWith(prefix));
      const reply = matched?.[1];
      if (reply === undefined) return { state: 'unavailable', reason: 'transport' };
      if ('fail' in reply) {
        return reply.fail === 'transport'
          ? { state: 'unavailable', reason: 'transport' }
          : { state: 'unavailable', reason: 'http', httpStatus: reply.status };
      }
      return {
        state: 'ready',
        data: schema.parse(reply.body),
        httpStatus: 200,
        receivedAt: '2026-08-08T00:00:00.000Z',
      };
    },
  };
  return { client, paths };
}

/** Ordered longest-prefix first: the stub matches on `startsWith`, and
 * `/git/attributions` would otherwise be swallowed by `/git`. */
const capabilitiesFixture = {
  capabilities: [
    {
      id: 'cap-1',
      kind: 'skill',
      name: 'release-notes',
      version: '1.2.0',
      scope: 'project',
      projectId: 'proj-1',
      source: 'luwi-project',
      path: 'C:/work/demo/.claude/skills/release-notes/SKILL.md',
      checksum: SHA256,
      compatibleAgentKinds: ['claude-code'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { managementMode: 'observed', observation: { scannedAt: '2026-09-11' } },
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    },
    {
      id: 'cap-2',
      kind: 'instruction',
      name: 'AGENTS.md',
      scope: 'project',
      projectId: 'proj-1',
      source: 'agent-native',
      checksum: SHA256,
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: false,
      manifest: {},
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    },
  ],
  truncated: false,
};

const globalCapabilitiesFixture = {
  capabilities: [
    {
      id: 'cap-global',
      kind: 'skill',
      name: 'brainstorming',
      scope: 'global',
      source: 'agent-native',
      path: 'C:/Users/dev/.claude/skills/brainstorming',
      checksum: SHA256,
      compatibleAgentKinds: ['claude-code'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { managementMode: 'observed', observation: {} },
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    },
  ],
  truncated: true,
};

const allReady: Record<string, Reply> = {
  '/api/v1/capabilities?scope=project': { body: capabilitiesFixture },
  '/api/v1/capabilities?scope=global': { body: globalCapabilitiesFixture },
  '/api/v1/projects/proj-1/git/attributions': { body: attributionsFixture },
  '/api/v1/projects/proj-1/git': { body: gitFixture },
  '/api/v1/projects/proj-1/packages': { body: packagesFixture },
  '/api/v1/projects/proj-1/technologies': { body: technologiesFixture },
  '/api/v1/projects/proj-1/agents': { body: bindingsFixture },
};

describe('loadProjectScope', () => {
  it('maps every resource from schema-valid daemon responses', async () => {
    const { client } = stubClient(allReady);

    const result = await loadProjectScope(client, 'proj-1', projectScopeResourceKeys);

    expect(result.git).toEqual({
      state: 'ready',
      data: expect.objectContaining({ branch: 'master', clean: false, headSha: COMMIT }),
    });
    expect(result.packages).toEqual({
      state: 'ready',
      data: { items: expect.any(Array), truncated: true },
    });
    expect(result.technologies?.state).toBe('ready');
    expect(result.bindings?.state).toBe('ready');
  });

  it('carries branches, tags and worktrees rather than reducing them to counts', async () => {
    const { client } = stubClient(allReady);

    const result = await loadProjectScope(client, 'proj-1', ['git']);

    expect(result.git).toMatchObject({
      state: 'ready',
      data: {
        branches: ['master', 'main'],
        tags: ['v1'],
        worktrees: [
          { path: 'C:/work/demo', headSha: COMMIT, branch: 'master' },
          { path: 'C:/work/demo-wt', headSha: COMMIT, detached: true, locked: true },
        ],
      },
    });
  });

  it('omits absent worktree flags rather than asserting false', async () => {
    const { client } = stubClient(allReady);

    const result = await loadProjectScope(client, 'proj-1', ['git']);
    const attached = result.git?.state === 'ready' ? result.git.data.worktrees[0] : undefined;

    expect(attached).toBeDefined();
    expect('detached' in (attached ?? {})).toBe(false);
    expect('locked' in (attached ?? {})).toBe(false);
  });

  it('maps commit attribution including its ungraded, unattributed rows', async () => {
    const { client } = stubClient(allReady);

    const result = await loadProjectScope(client, 'proj-1', ['attributions']);

    expect(result.attributions).toEqual({
      state: 'ready',
      data: {
        truncated: true,
        items: [
          {
            id: 'attr-1',
            commitSha: COMMIT,
            sessionId: 'sess-1',
            agentId: 'agent-1',
            confidence: 'correlated',
            reasons: ['session-window-overlap'],
            observedAt: '2026-08-08T00:00:00.000Z',
          },
          {
            id: 'attr-2',
            commitSha: 'c'.repeat(40),
            confidence: 'unknown',
            reasons: ['insufficient-session-correlation'],
            observedAt: '2026-08-08T00:00:00.000Z',
          },
        ],
      },
    });
  });

  it('treats an empty attribution collection as the empty answer, never as not-observed', async () => {
    const { client } = stubClient({
      '/api/v1/projects/proj-1/git/attributions': {
        body: { attributions: [], truncated: false },
      },
    });

    const result = await loadProjectScope(client, 'proj-1', ['attributions']);

    expect(result.attributions).toEqual({ state: 'ready', data: { items: [], truncated: false } });
  });

  it('never reads attribution as not-observed, even on a 404', async () => {
    const { client } = stubClient({
      '/api/v1/projects/proj-1/git/attributions': { fail: 'http', status: 404 },
    });

    const result = await loadProjectScope(client, 'proj-1', ['attributions']);

    expect(result.attributions).toEqual({ state: 'unavailable' });
  });

  it('bounds the attribution read', async () => {
    const { client, paths } = stubClient(allReady);

    await loadProjectScope(client, 'proj-1', ['attributions']);

    expect(paths).toEqual(['/api/v1/projects/proj-1/git/attributions?limit=100']);
  });

  it('preserves the truncation flag rather than hiding a bounded list', async () => {
    const { client } = stubClient(allReady);
    const result = await loadProjectScope(client, 'proj-1', ['packages', 'technologies']);

    expect(result.packages).toMatchObject({ data: { truncated: true } });
    expect(result.technologies).toMatchObject({ data: { truncated: false } });
  });

  it('maps a 404 Git response to not-observed, not unavailable', async () => {
    const { client } = stubClient({
      ...allReady,
      '/api/v1/projects/proj-1/git': { fail: 'http', status: 404 },
    });

    const result = await loadProjectScope(client, 'proj-1', ['git']);

    expect(result.git).toEqual({ state: 'not-observed' });
  });

  it('maps a transport failure and a 500 to unavailable, distinct from not-observed', async () => {
    const transport = await loadProjectScope(
      stubClient({ '/api/v1/projects/proj-1/git': { fail: 'transport' } }).client,
      'proj-1',
      ['git'],
    );
    const serverError = await loadProjectScope(
      stubClient({ '/api/v1/projects/proj-1/git': { fail: 'http', status: 500 } }).client,
      'proj-1',
      ['git'],
    );

    expect(transport.git).toEqual({ state: 'unavailable' });
    expect(serverError.git).toEqual({ state: 'unavailable' });
  });

  it('only treats 404 as not-observed for Git, never for the bounded collections', async () => {
    const { client } = stubClient({
      '/api/v1/projects/proj-1/packages': { fail: 'http', status: 404 },
      '/api/v1/projects/proj-1/technologies': { fail: 'http', status: 404 },
      '/api/v1/projects/proj-1/agents': { fail: 'http', status: 404 },
    });

    const result = await loadProjectScope(client, 'proj-1', [
      'packages',
      'technologies',
      'bindings',
    ]);

    expect(result.packages).toEqual({ state: 'unavailable' });
    expect(result.technologies).toEqual({ state: 'unavailable' });
    expect(result.bindings).toEqual({ state: 'unavailable' });
  });

  it('keeps siblings readable when one resource fails', async () => {
    const { client } = stubClient({
      ...allReady,
      '/api/v1/projects/proj-1/packages': { fail: 'transport' },
    });

    const result = await loadProjectScope(client, 'proj-1', projectScopeResourceKeys);

    expect(result.packages).toEqual({ state: 'unavailable' });
    expect(result.git?.state).toBe('ready');
    expect(result.technologies?.state).toBe('ready');
    expect(result.bindings?.state).toBe('ready');
  });

  it('requests only the selected resources', async () => {
    const { client, paths } = stubClient(allReady);

    await loadProjectScope(client, 'proj-1', ['git']);

    expect(paths).toEqual(['/api/v1/projects/proj-1/git']);
  });

  it('bounds the collection reads so an unbounded response cannot be requested', async () => {
    const { client, paths } = stubClient(allReady);

    await loadProjectScope(client, 'proj-1', ['packages', 'technologies']);

    expect(paths).toContain('/api/v1/projects/proj-1/packages?limit=100');
    expect(paths).toContain('/api/v1/projects/proj-1/technologies?limit=100');
  });

  it('encodes the project id so it cannot escape its path segment', async () => {
    const { client, paths } = stubClient({});

    await loadProjectScope(client, '../../health', ['git']);

    expect(paths).toEqual(['/api/v1/projects/..%2F..%2Fhealth/git']);
  });

  it('forwards the abort signal to every request', async () => {
    const controller = new AbortController();
    const get = vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'transport' });

    await loadProjectScope({ get } as unknown as DaemonClient, 'proj-1', projectScopeResourceKeys, {
      signal: controller.signal,
    });

    // One request per resource, plus one: capabilities reads its project and global pages.
    expect(get).toHaveBeenCalledTimes(projectScopeResourceKeys.length + 1);
    for (const call of get.mock.calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });

  it('issues no request at all for an empty key set', async () => {
    const { client, paths } = stubClient(allReady);

    const result = await loadProjectScope(client, 'proj-1', []);

    expect(paths).toEqual([]);
    expect(result).toEqual({});
  });
});

describe('projectResourcesForEvent', () => {
  it('maps every Git observation event family to the repository panel', () => {
    for (const type of [
      'git.observed',
      'git.head.changed',
      'git.commit.detected',
      'git.worktree.detected',
    ]) {
      expect(projectResourcesForEvent(type)).toEqual(['git']);
    }
  });

  it('maps inventory and detection events to their own panels', () => {
    expect(projectResourcesForEvent('package.inventory.updated')).toEqual(['packages']);
    expect(projectResourcesForEvent('technology.detected')).toEqual(['technologies']);
  });

  it('maps the capability inventory events, and not an agent loading a skill', () => {
    expect(projectResourcesForEvent('capability.registered')).toEqual(['capabilities']);
    expect(projectResourcesForEvent('capability.disabled')).toEqual(['capabilities']);
    expect(projectResourcesForEvent('context.capability.loaded')).toEqual([]);
  });

  it('maps attribution events to the attribution panel alone', () => {
    for (const type of ['attribution.recorded', 'attribution.updated']) {
      expect(projectResourcesForEvent(type)).toEqual(['attributions']);
    }
  });

  it('does not refresh attribution from a Git event as well', () => {
    // A scan emits `attribution.recorded` per record, so mapping `git.` here
    // too would refresh the same panel twice for one cause.
    expect(projectResourcesForEvent('git.observed')).not.toContain('attributions');
  });

  it('maps every binding transition to the bound-agent panel', () => {
    for (const type of ['project.agent.bound', 'project.agent.unbound', 'project.agent.updated']) {
      expect(projectResourcesForEvent(type)).toEqual(['bindings']);
    }
  });

  it('refreshes everything on a runtime lifecycle event', () => {
    expect(projectResourcesForEvent('runtime.started')).toEqual([...projectScopeResourceKeys]);
  });

  it('does not confuse a plain project event with a binding event', () => {
    expect(projectResourcesForEvent('project.registered')).toEqual([]);
    expect(projectResourcesForEvent('project.updated')).toEqual([]);
  });

  it('ignores event families that no project panel renders', () => {
    for (const type of [
      'session.heartbeat',
      'message.requested',
      'usage.reported',
      'graph.node.projected',
      'optimization.finding.detected',
      'unknown.future.event',
    ]) {
      expect(projectResourcesForEvent(type)).toEqual([]);
    }
  });
});

describe('project capabilities', () => {
  it('reads the project’s own and the global capabilities, keeping where each file lives', async () => {
    const { client, paths } = stubClient(allReady);

    const result = await loadProjectScope(client, 'proj/1', ['capabilities']);

    expect(paths).toEqual([
      '/api/v1/capabilities?scope=project&projectId=proj%2F1&limit=100',
      '/api/v1/capabilities?scope=global&limit=100',
    ]);
    expect(result.capabilities).toEqual({
      state: 'ready',
      data: {
        // Either read's cut is disclosed: the global page was truncated.
        truncated: true,
        items: [
          {
            id: 'cap-1',
            kind: 'skill',
            name: 'release-notes',
            version: '1.2.0',
            scope: 'project',
            source: 'luwi-project',
            path: 'C:/work/demo/.claude/skills/release-notes/SKILL.md',
            enabled: true,
            observed: true,
            updatedAt: '2026-09-11T00:00:00.000Z',
          },
          {
            id: 'cap-2',
            kind: 'instruction',
            name: 'AGENTS.md',
            scope: 'project',
            source: 'agent-native',
            enabled: false,
            observed: false,
            updatedAt: '2026-09-11T00:00:00.000Z',
          },
          {
            id: 'cap-global',
            kind: 'skill',
            name: 'brainstorming',
            scope: 'global',
            source: 'agent-native',
            path: 'C:/Users/dev/.claude/skills/brainstorming',
            enabled: true,
            observed: true,
            updatedAt: '2026-09-11T00:00:00.000Z',
          },
        ],
      },
    });
  });

  it('reports the capabilities unavailable when either read fails', async () => {
    const { client } = stubClient({
      ...allReady,
      '/api/v1/capabilities?scope=global': { fail: 'transport' },
    });
    const result = await loadProjectScope(client, 'proj-1', ['capabilities']);
    expect(result.capabilities).toEqual({ state: 'unavailable' });
  });
});
