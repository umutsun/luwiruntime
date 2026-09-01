import { describe, expect, it } from 'vitest';

import {
  createFunctionRegistry,
  createRedisKeys,
  createRuntimeRepository,
  type RedisCommandClient,
} from './index.js';

class FakeCommandClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  reply: unknown;

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    return this.reply;
  }
}

const projectInput = {
  project: {
    id: 'project-1',
    name: 'LUWI Runtime',
    localPath: 'C:/workspace/luwi',
    canonicalPath: 'C:/workspace/luwi',
    identityPath: 'c:/workspace/luwi',
    pathIdentityHash: 'a'.repeat(64),
  },
  workspaceId: 'local',
  eventId: 'event-1',
};

const sessionInput = {
  session: {
    id: 'session-1',
    agentId: 'codex-sim',
    projectId: 'project-1',
    status: 'starting' as const,
    workingDirectory: 'C:/workspace/luwi',
    metadataJson: '{"source":"test"}',
  },
  workspaceId: 'local',
  eventId: 'event-session-1',
  presenceTtlMs: 15_000,
};

describe('runtime repository project boundary', () => {
  it('invokes the registered Function with only centrally constructed keys', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({
      status: 'created',
      project: {
        id: 'project-1',
        name: 'LUWI Runtime',
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/luwi',
        createdAt: '2026-07-28T12:00:00.000Z',
        updatedAt: '2026-07-28T12:00:00.000Z',
      },
      event: {
        id: 'event-1',
        version: 1,
        type: 'project.registered',
        occurredAt: '2026-07-28T12:00:00.000Z',
        workspaceId: 'local',
        projectId: 'project-1',
        payload: {},
      },
      globalStreamId: '1-0',
      projectStreamId: '2-0',
    });
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createRuntimeRepository({ client, keys, functions });

    await expect(repository.registerProject(projectInput)).resolves.toMatchObject({
      status: 'created',
      globalStreamId: '1-0',
      projectStreamId: '2-0',
    });
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]?.slice(0, 8)).toEqual([
      'FCALL',
      functions.functions.projectRegister,
      '5',
      keys.project('project-1'),
      keys.projectPathIndex('a'.repeat(64)),
      keys.projectsIndex,
      keys.globalEvents,
      keys.projectEvents('project-1'),
    ]);
  });

  it('validates Function results instead of trusting Redis data', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({ status: 'created', project: { id: 'invalid' } });
    const repository = createRuntimeRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.registerProject(projectInput)).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });

  it('passes canonical project timestamps through the validated Function payload', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({ status: 'conflict', reason: 'hash_collision' });
    const repository = createRuntimeRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });
    const createdAt = '2026-08-01T10:00:00.000Z';
    const updatedAt = '2026-08-02T10:00:00.000Z';

    await repository.registerProject({
      ...projectInput,
      project: { ...projectInput.project, createdAt, updatedAt },
    });

    const payload = JSON.parse(client.commands[0]?.[8] ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({ createdAt, updatedAt });
  });
});

describe('runtime repository session boundary', () => {
  it('registers through the session Function with projection, indexes, presence, and Streams', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({
      status: 'created',
      session: {
        id: 'session-1',
        agentId: 'codex-sim',
        projectId: 'project-1',
        status: 'starting',
        workingDirectory: 'C:/workspace/luwi',
        startedAt: '2026-07-28T12:00:00.000Z',
        lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
        metadata: { source: 'test' },
      },
      event: {
        id: 'event-session-1',
        version: 1,
        type: 'session.registered',
        occurredAt: '2026-07-28T12:00:00.000Z',
        workspaceId: 'local',
        projectId: 'project-1',
        agentId: 'codex-sim',
        sessionId: 'session-1',
        payload: {},
      },
      globalStreamId: '3-0',
      projectStreamId: '3-1',
    });
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createRuntimeRepository({ client, keys, functions });

    await expect(repository.registerSession(sessionInput)).resolves.toMatchObject({
      status: 'created',
      session: { id: 'session-1', agentId: 'codex-sim' },
    });
    expect(client.commands[0]?.slice(0, 12)).toEqual([
      'FCALL',
      functions.functions.sessionRegister,
      '9',
      keys.session('session-1'),
      keys.project('project-1'),
      keys.projectSessions('project-1'),
      keys.agentSessions('codex-sim'),
      keys.sessionPresence('session-1'),
      keys.heartbeatDeadlines,
      keys.globalEvents,
      keys.projectEvents('project-1'),
      keys.sessionInbox('session-1'),
    ]);
  });

  it('uses the status Function and validates its structured result', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({
      status: 'updated',
      previousStatus: 'starting',
      currentStatus: 'idle',
      event: {
        id: 'event-status-1',
        version: 1,
        type: 'session.status.changed',
        occurredAt: '2026-07-28T12:00:01.000Z',
        workspaceId: 'local',
        projectId: 'project-1',
        agentId: 'codex-sim',
        sessionId: 'session-1',
        payload: { previousStatus: 'starting', currentStatus: 'idle' },
      },
      globalStreamId: '4-0',
      projectStreamId: '4-1',
    });
    const repository = createRuntimeRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(
      repository.updateSessionStatus({
        sessionId: 'session-1',
        projectId: 'project-1',
        targetStatus: 'idle',
        workspaceId: 'local',
        eventId: 'event-status-1',
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      previousStatus: 'starting',
      currentStatus: 'idle',
    });
  });

  it('renews heartbeat state with sampling configuration through one Function', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({
      status: 'renewed',
      eventEmitted: false,
      lastHeartbeatAt: '2026-07-28T12:00:02.000Z',
    });
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createRuntimeRepository({ client, keys, functions });

    await expect(
      repository.heartbeatSession({
        sessionId: 'session-1',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-heartbeat-1',
        presenceTtlMs: 15_000,
        eventIntervalMs: 30_000,
        metadataJson: '{"branchHead":"abc"}',
      }),
    ).resolves.toEqual({
      status: 'renewed',
      eventEmitted: false,
      lastHeartbeatAt: '2026-07-28T12:00:02.000Z',
    });
    expect(client.commands[0]?.slice(0, 8)).toEqual([
      'FCALL',
      functions.functions.sessionHeartbeat,
      '5',
      keys.session('session-1'),
      keys.sessionPresence('session-1'),
      keys.heartbeatDeadlines,
      keys.globalEvents,
      keys.projectEvents('project-1'),
    ]);
  });

  it('closes and disconnects only through their dedicated Functions', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createRuntimeRepository({ client, keys, functions });
    client.reply = JSON.stringify({
      status: 'unchanged',
      currentStatus: 'completed',
    });
    await expect(
      repository.closeSession({
        sessionId: 'session-1',
        projectId: 'project-1',
        workspaceId: 'local',
        eventId: 'event-close-1',
      }),
    ).resolves.toEqual({ status: 'unchanged', currentStatus: 'completed' });

    client.reply = JSON.stringify({ status: 'reconciled', deadlineMs: 12345 });
    await expect(
      repository.disconnectExpiredSession({
        sessionId: 'session-1',
        projectId: 'project-1',
        expectedDeadlineMs: 12000,
        workspaceId: 'local',
        eventId: 'event-disconnect-1',
      }),
    ).resolves.toEqual({ status: 'reconciled', deadlineMs: 12345 });
    expect(client.commands.map((command) => command[1])).toEqual([
      functions.functions.sessionClose,
      functions.functions.sessionDisconnect,
    ]);
  });
});

describe('runtime repository native declaration boundary', () => {
  const timestamp = '2026-08-17T00:00:00.000Z';
  const declareInput = {
    sessionId: 'session-1',
    projectId: 'project-1',
    workspaceId: 'local',
    native: {
      bindingId: 'binding-1',
      linkId: 'link-1',
      linkedEventId: 'event-linked-1',
      payload: {
        bindingId: 'binding-1',
        expectedVersion: 0,
        link: { id: 'link-1', sessionId: 'session-1' },
        binding: {
          id: 'binding-1',
          adapterId: 'claude-code-native-v1',
          nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
          kind: 'main' as const,
        },
      },
    },
  };

  it('declares through the dedicated Function with only centrally constructed keys', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({
      status: 'declared',
      native: {
        transition: 'created',
        binding: {
          id: 'binding-1',
          adapterId: 'claude-code-native-v1',
          nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
          kind: 'main',
          openLinkId: 'link-1',
          version: '1',
          linkCount: '1',
          trimmedLinkCount: '0',
          firstLinkedAt: timestamp,
          lastLinkedAt: timestamp,
        },
        link: {
          id: 'link-1',
          bindingId: 'binding-1',
          sessionId: 'session-1',
          linkedAt: timestamp,
        },
      },
      events: [
        {
          event: {
            id: 'event-linked-1',
            version: 1,
            type: 'session.native.linked',
            occurredAt: timestamp,
            workspaceId: 'local',
            projectId: 'project-1',
            agentId: 'codex-sim',
            sessionId: 'session-1',
            payload: { bindingId: 'binding-1', linkId: 'link-1' },
          },
          globalStreamId: '5-0',
          projectStreamId: '5-1',
        },
      ],
    });
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createRuntimeRepository({ client, keys, functions });

    await expect(repository.declareNativeSession(declareInput)).resolves.toMatchObject({
      status: 'declared',
      native: {
        transition: 'created',
        binding: { id: 'binding-1', openLinkId: 'link-1', version: 1 },
        link: { id: 'link-1', sessionId: 'session-1' },
      },
    });
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]?.slice(0, 11)).toEqual([
      'FCALL',
      functions.functions.nativeDeclare,
      '8',
      keys.session('session-1'),
      keys.nativeSessionBinding('binding-1'),
      keys.nativeSessionLink('link-1'),
      keys.nativeSessionLinks('binding-1'),
      keys.sessionNativeBinding('session-1'),
      // No stale link: the slot repeats the binding key, declared but unwritten.
      keys.nativeSessionBinding('binding-1'),
      keys.globalEvents,
      keys.projectEvents('project-1'),
    ]);
  });

  it('surfaces a Function refusal as a coded error and writes nothing else', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({ status: 'error', code: 'VERSION_CONFLICT' });
    const repository = createRuntimeRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.declareNativeSession(declareInput)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(client.commands).toHaveLength(1);
  });

  it('returns not_found and terminal as structured results, never as throws', async () => {
    const client = new FakeCommandClient();
    const repository = createRuntimeRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    client.reply = JSON.stringify({ status: 'not_found', entity: 'session' });
    await expect(repository.declareNativeSession(declareInput)).resolves.toEqual({
      status: 'not_found',
      entity: 'session',
    });

    client.reply = JSON.stringify({ status: 'terminal', currentStatus: 'completed' });
    await expect(repository.declareNativeSession(declareInput)).resolves.toEqual({
      status: 'terminal',
      currentStatus: 'completed',
    });
  });

  it('validates the declaration result instead of trusting Redis data', async () => {
    const client = new FakeCommandClient();
    client.reply = JSON.stringify({ status: 'declared', native: { transition: 'created' } });
    const repository = createRuntimeRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.declareNativeSession(declareInput)).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });
});

class ScriptedCommandClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  #replies: unknown[];

  constructor(replies: readonly unknown[]) {
    this.#replies = [...replies];
  }

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    return this.#replies.shift();
  }
}

function linkHash(fields: Record<string, string>): string[] {
  return Object.entries(fields).flat();
}

describe('native link point-in-time lookup', () => {
  const bindingId = 'b'.repeat(64);
  const linkId = 'c'.repeat(64);
  const closed = {
    id: linkId,
    bindingId,
    sessionId: 'session-1',
    linkedAt: '2026-08-17T08:13:17.184Z',
    unlinkedAt: '2026-08-17T08:13:32.752Z',
  };
  const linkedMs = Date.parse(closed.linkedAt);
  const unlinkedMs = Date.parse(closed.unlinkedAt);

  function repositoryFor(replies: readonly unknown[]): {
    repository: ReturnType<typeof createRuntimeRepository>;
    client: ScriptedCommandClient;
  } {
    const client = new ScriptedCommandClient(replies);
    return {
      client,
      repository: createRuntimeRepository({
        client,
        keys: createRedisKeys(),
        functions: createFunctionRegistry(),
      }),
    };
  }

  it('reads the greatest linkedAt at or before the instant and resolves containment', async () => {
    const { repository, client } = repositoryFor([[linkId], linkHash(closed)]);

    await expect(repository.findNativeLinkAt(bindingId, linkedMs + 1_000)).resolves.toEqual(closed);
    expect(client.commands[0]).toEqual([
      'ZRANGE',
      createRedisKeys().nativeSessionLinks(bindingId),
      String(linkedMs + 1_000),
      '-inf',
      'BYSCORE',
      'REV',
      'LIMIT',
      '0',
      '1',
    ]);
  });

  it('includes the linkedAt instant and excludes the unlinkedAt instant', async () => {
    // The interval is half-open: [linkedAt, unlinkedAt).
    const atStart = repositoryFor([[linkId], linkHash(closed)]);
    await expect(atStart.repository.findNativeLinkAt(bindingId, linkedMs)).resolves.toEqual(closed);

    const atEnd = repositoryFor([[linkId], linkHash(closed)]);
    await expect(atEnd.repository.findNativeLinkAt(bindingId, unlinkedMs)).resolves.toBeNull();
  });

  it('returns null when no link starts at or before the instant', async () => {
    const { repository, client } = repositoryFor([[]]);

    await expect(repository.findNativeLinkAt(bindingId, linkedMs - 1)).resolves.toBeNull();
    expect(client.commands).toHaveLength(1);
  });

  it('matches an open link at any instant at or after it was linked', async () => {
    const open = {
      id: linkId,
      bindingId,
      sessionId: 'session-1',
      linkedAt: closed.linkedAt,
    };
    const { repository } = repositoryFor([[linkId], linkHash(open)]);

    await expect(repository.findNativeLinkAt(bindingId, linkedMs + 86_400_000)).resolves.toEqual(
      open,
    );
  });

  it('returns null when the indexed link record is gone', async () => {
    // A member whose hash is gone is a record the caller cannot declare, not a
    // reason to guess — the precedent listOldestNativeLinks already sets.
    const { repository } = repositoryFor([[linkId], []]);

    await expect(repository.findNativeLinkAt(bindingId, linkedMs + 1)).resolves.toBeNull();
  });
});
