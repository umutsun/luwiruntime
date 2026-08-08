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
