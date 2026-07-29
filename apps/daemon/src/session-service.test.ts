import type { AgentSession, SessionRegistrationRequest, SessionView } from '@luwi/protocol';
import type {
  RegisterSessionResult,
  RuntimeRepository,
  UpdateSessionStatusResult,
} from '@luwi/redis';
import { describe, expect, it } from 'vitest';

import { createSessionService } from './session-service.js';

const baseSession: AgentSession = {
  id: 'session-1',
  agentId: 'codex-sim',
  projectId: 'project-1',
  status: 'starting',
  workingDirectory: 'C:/workspace/luwi',
  startedAt: '2026-07-28T12:00:00.000Z',
  lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
  metadata: { source: 'test' },
};

const view: SessionView = { ...baseSession, presence: 'online' };

function repository(options?: {
  register?: RegisterSessionResult;
  update?: UpdateSessionStatusResult;
}): RuntimeRepository {
  return {
    registerProject: async () => ({ status: 'conflict', reason: 'hash_collision' }),
    getProject: async (projectId) =>
      projectId === 'project-1'
        ? {
            id: 'project-1',
            name: 'LUWI',
            localPath: 'C:/workspace/luwi',
            canonicalPath: 'C:/workspace/luwi',
            createdAt: '2026-07-28T12:00:00.000Z',
            updatedAt: '2026-07-28T12:00:00.000Z',
          }
        : null,
    listProjects: async () => [],
    registerSession: async () =>
      options?.register ?? {
        status: 'created',
        session: baseSession,
        event: {
          id: 'event-1',
          version: 1,
          type: 'session.registered',
          occurredAt: '2026-07-28T12:00:00.000Z',
          workspaceId: 'local',
          projectId: 'project-1',
          agentId: 'codex-sim',
          sessionId: 'session-1',
          payload: {},
        },
        globalStreamId: '1-0',
        projectStreamId: '1-1',
      },
    getSession: async (sessionId) => (sessionId === 'session-1' ? view : null),
    listSessions: async () => [view],
    updateSessionStatus: async () =>
      options?.update ?? {
        status: 'unchanged',
        currentStatus: 'starting',
      },
    heartbeatSession: async () => ({
      status: 'renewed',
      eventEmitted: false,
      lastHeartbeatAt: '2026-07-28T12:00:01.000Z',
    }),
    closeSession: async () => ({ status: 'unchanged', currentStatus: 'completed' }),
    findExpiredHeartbeatDeadlines: async () => [],
    disconnectExpiredSession: async () => ({ status: 'unchanged' }),
  };
}

describe('session service', () => {
  it('registers an unseen opaque agent without requiring an AgentDefinition', async () => {
    let registration: unknown;
    const backing = repository();
    const service = createSessionService({
      repository: {
        ...backing,
        registerSession: async (input) => {
          registration = input;
          return backing.registerSession(input);
        },
      },
      workspaceId: 'local',
      presenceTtlMs: 15_000,
      createId: (() => {
        const values = ['session-1', 'event-1'];
        return () => values.shift() ?? 'unexpected';
      })(),
      canonicalizeWorkingDirectory: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/real/luwi',
        identityPath: 'c:/workspace/real/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
    });
    const request: SessionRegistrationRequest = {
      projectId: 'project-1',
      agentId: 'codex-sim',
      workingDirectory: '.',
      metadata: { z: 1, a: 2 },
    };

    await expect(service.register(request)).resolves.toEqual(view);
    expect(registration).toMatchObject({
      session: {
        id: 'session-1',
        agentId: 'codex-sim',
        workingDirectory: 'C:/workspace/real/luwi',
        metadataJson: '{"a":2,"z":1}',
      },
      presenceTtlMs: 15_000,
    });
  });

  it('canonicalizes heartbeat metadata and maps graceful close/terminal outcomes', async () => {
    let metadataJson: string | undefined;
    const backing = repository();
    const service = createSessionService({
      repository: {
        ...backing,
        heartbeatSession: async (input) => {
          metadataJson = input.metadataJson;
          return {
            status: 'renewed',
            eventEmitted: false,
            lastHeartbeatAt: '2026-07-28T12:00:01.000Z',
          };
        },
      },
      workspaceId: 'local',
      presenceTtlMs: 15_000,
      heartbeatEventIntervalMs: 30_000,
      createId: () => 'event-id',
      canonicalizeWorkingDirectory: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/luwi',
        identityPath: 'c:/workspace/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
    });

    await expect(service.heartbeat('session-1', { metadata: { z: 1, a: 2 } })).resolves.toEqual({
      status: 'renewed',
      eventEmitted: false,
    });
    expect(metadataJson).toBe('{"a":2,"z":1}');
    await expect(service.close('session-1')).resolves.toMatchObject({
      status: 'starting',
    });
  });

  it('maps missing projects and terminal transitions to safe application errors', async () => {
    const service = createSessionService({
      repository: repository({
        update: { status: 'terminal', currentStatus: 'completed' },
      }),
      workspaceId: 'local',
      presenceTtlMs: 15_000,
      createId: () => 'id',
      canonicalizeWorkingDirectory: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/luwi',
        identityPath: 'c:/workspace/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
    });

    await expect(
      service.register({
        projectId: 'missing',
        agentId: 'codex-sim',
        workingDirectory: '.',
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    await expect(service.updateStatus('session-1', 'idle')).rejects.toMatchObject({
      code: 'SESSION_TERMINAL',
      statusCode: 409,
    });
  });
});
