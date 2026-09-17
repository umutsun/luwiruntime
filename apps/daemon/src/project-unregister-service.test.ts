import type { AgentMessage, Project, SessionView, WorkLease } from '@luwi/protocol';
import { RedisRepositoryError } from '@luwi/redis';
import { describe, expect, it, vi } from 'vitest';

import {
  createProjectUnregisterService,
  type ProjectUnregisterDependencies,
} from './project-unregister-service.js';

const project: Project = {
  id: 'project-1',
  name: 'Alpha',
  localPath: 'C:/workspace/alpha',
  canonicalPath: 'C:/workspace/alpha',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const session = (id: string, status: SessionView['status']): SessionView => ({
  id,
  agentId: 'agent-1',
  projectId: project.id,
  status,
  workingDirectory: project.canonicalPath,
  startedAt: '2026-09-01T00:00:00.000Z',
  lastHeartbeatAt: '2026-09-01T00:00:00.000Z',
  metadata: {},
  presence: status === 'completed' || status === 'disconnected' ? 'offline' : 'online',
});

const lease = (id: string, state: WorkLease['state']): WorkLease => ({
  id,
  projectId: project.id,
  sessionId: 's-done',
  agentId: 'agent-1',
  path: 'src/a.ts',
  matchPath: 'src/a.ts',
  reason: 'edit',
  state,
  acquiredAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-01T00:05:00.000Z',
});

const message = (correlationId: string, state: AgentMessage['state']): AgentMessage =>
  ({ correlationId, state }) as AgentMessage;

type Fakes = {
  calls: string[];
  dependencies: ProjectUnregisterDependencies;
  unregisterResults: Array<
    { status: 'unregistered' } | { status: 'not_found' } | { status: 'raced'; sessions: number }
  >;
  sessionLists: SessionView[][];
};

function fakes(
  overrides: {
    project?: Project | null;
    sessions?: SessionView[][];
    leases?: WorkLease[];
    coordinator?: { sessionId: string } | null;
    messages?: AgentMessage[];
    unregister?: Fakes['unregisterResults'];
    purgeError?: Error;
    busyUntil?: number;
  } = {},
): Fakes {
  const calls: string[] = [];
  const sessionLists = overrides.sessions ?? [[session('s-done', 'completed')]];
  const unregisterResults = overrides.unregister ?? [{ status: 'unregistered' }];
  const onUnregistered = vi.fn();
  let busyPolls = overrides.busyUntil ?? 0;
  const dependencies: ProjectUnregisterDependencies = {
    repository: {
      getProject: async () => (overrides.project === undefined ? project : overrides.project),
      listSessions: async () => {
        calls.push('listSessions');
        return sessionLists.length > 1 ? sessionLists.shift()! : sessionLists[0]!;
      },
      unregisterProject: async (input) => {
        calls.push(`unregister:${input.event.type}`);
        const next =
          unregisterResults.length > 1 ? unregisterResults.shift()! : unregisterResults[0]!;
        return next.status === 'unregistered'
          ? { status: 'unregistered', event: input.event }
          : next;
      },
    },
    leases: { listProjectLeases: async () => overrides.leases ?? [] },
    messages: { listMessages: async () => overrides.messages ?? [] },
    coordinator: { getCoordinator: async () => overrides.coordinator ?? null },
    purge: {
      purgeProjectLeaves: async () => {
        calls.push('purge');
        if (overrides.purgeError !== undefined) throw overrides.purgeError;
        return {};
      },
    },
    canonicalStore: {
      untrackProject: async () => {
        calls.push('untrack');
      },
      trackProject: async () => {
        calls.push('retrack');
      },
    },
    awaitQuiescence: async () => {
      calls.push(busyPolls > 0 ? `wait:${String(busyPolls)}` : 'quiet');
      busyPolls = 0;
    },
    workspaceId: 'local',
    onUnregistered,
  };
  return { calls, dependencies, unregisterResults, sessionLists };
}

describe('project unregister', () => {
  it('waits for background writers, untracks the manifest, purges the leaves, then ends atomically', async () => {
    const { calls, dependencies } = fakes({ busyUntil: 3 });
    await createProjectUnregisterService(dependencies).remove(project.id);
    expect(calls).toEqual([
      'listSessions',
      'wait:3',
      'untrack',
      'purge',
      'unregister:project.unregistered',
    ]);
    expect(dependencies.onUnregistered).toHaveBeenCalledWith(project);
  });

  it('re-tracks the manifest and answers 409 when the purge itself meets a blocker', async () => {
    const { calls, dependencies } = fakes({
      purgeError: new RedisRepositoryError(
        'PROJECT_HAS_HELD_LEASES',
        'A held work lease cannot be purged with its project.',
      ),
    });
    await expect(
      createProjectUnregisterService(dependencies).remove(project.id),
    ).rejects.toMatchObject({ code: 'PROJECT_HAS_HELD_LEASES', statusCode: 409 });
    expect(calls).toEqual(['listSessions', 'quiet', 'untrack', 'purge', 'retrack']);
    expect(dependencies.onUnregistered).not.toHaveBeenCalled();
  });

  it('re-tracks the manifest and rethrows any other failure after the untrack', async () => {
    const { calls, dependencies } = fakes({ purgeError: new Error('redis went away') });
    await expect(createProjectUnregisterService(dependencies).remove(project.id)).rejects.toThrow(
      'redis went away',
    );
    expect(calls.at(-1)).toBe('retrack');
  });

  it('answers 404 for an unknown project and writes nothing', async () => {
    const { calls, dependencies } = fakes({ project: null });
    await expect(createProjectUnregisterService(dependencies).remove('nope')).rejects.toMatchObject(
      {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      },
    );
    expect(calls).toEqual([]);
  });

  it.each([
    [
      'a session that is not terminal',
      { sessions: [[session('s-live', 'idle'), session('s-done', 'completed')]] },
      { code: 'PROJECT_HAS_ACTIVE_SESSIONS', details: { count: 1, sessions: 's-live' } },
    ],
    [
      'a held lease',
      { leases: [lease('l-1', 'held'), lease('l-2', 'released')] },
      { code: 'PROJECT_HAS_HELD_LEASES', details: { count: 1, leases: 'l-1' } },
    ],
    [
      'a live coordinator',
      { sessions: [[session('s-pm', 'starting')]], coordinator: { sessionId: 's-pm' } },
      { code: 'PROJECT_HAS_ACTIVE_SESSIONS', details: { count: 1, sessions: 's-pm' } },
    ],
    [
      'a message in flight',
      { messages: [message('c-1', 'processing'), message('c-2', 'responded')] },
      { code: 'PROJECT_HAS_INFLIGHT_MESSAGES', details: { count: 1, messages: 'c-1' } },
    ],
  ])('refuses while %s blocks it, before touching the manifest', async (_, overrides, expected) => {
    const { calls, dependencies } = fakes(overrides);
    await expect(
      createProjectUnregisterService(dependencies).remove(project.id),
    ).rejects.toMatchObject({ ...expected, statusCode: 409 });
    expect(calls).toEqual(['listSessions']);
  });

  it('answers 404 when the project vanished before the atomic end, and re-tracks nothing it can', async () => {
    const { calls, dependencies } = fakes({ unregister: [{ status: 'not_found' }] });
    await expect(
      createProjectUnregisterService(dependencies).remove(project.id),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    // Re-tracking a project the runtime no longer holds is undone by the next
    // reconcile; the manifest still follows the runtime, which is the rule.
    expect(calls.at(-1)).toBe('retrack');
  });

  it('refuses a coordinator whose holder is still live even when the holder session is terminal elsewhere', async () => {
    // A terminal holder is not live: the role is takeable and goes with the project.
    const { dependencies } = fakes({
      sessions: [[session('s-done', 'completed')]],
      coordinator: { sessionId: 's-done' },
    });
    await expect(
      createProjectUnregisterService(dependencies).remove(project.id),
    ).resolves.toBeUndefined();
  });

  it('retries once when a session slipped in and already ended, refuses when it is live', async () => {
    const ended = fakes({
      sessions: [[session('s-done', 'completed')], [session('s-late', 'disconnected')]],
      unregister: [{ status: 'raced', sessions: 1 }, { status: 'unregistered' }],
    });
    await createProjectUnregisterService(ended.dependencies).remove(project.id);
    expect(ended.calls).toEqual([
      'listSessions',
      'quiet',
      'untrack',
      'purge',
      'unregister:project.unregistered',
      'listSessions',
      'purge',
      'unregister:project.unregistered',
    ]);

    const live = fakes({
      sessions: [[session('s-done', 'completed')], [session('s-late', 'idle')]],
      unregister: [{ status: 'raced', sessions: 1 }],
    });
    await expect(
      createProjectUnregisterService(live.dependencies).remove(project.id),
    ).rejects.toMatchObject({ code: 'PROJECT_HAS_ACTIVE_SESSIONS', statusCode: 409 });
  });

  it('gives up after three raced attempts', async () => {
    const { dependencies } = fakes({
      unregister: [
        { status: 'raced', sessions: 1 },
        { status: 'raced', sessions: 1 },
        { status: 'raced', sessions: 1 },
      ],
    });
    await expect(
      createProjectUnregisterService(dependencies).remove(project.id),
    ).rejects.toMatchObject({ code: 'PROJECT_UNREGISTER_RACED', statusCode: 409 });
  });
});
