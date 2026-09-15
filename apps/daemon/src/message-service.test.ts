import type {
  AgentMessage,
  InboxClaimResponse,
  MessageCreateRequest,
  SessionView,
} from '@luwi/protocol';
import { RedisRepositoryError, type MessageRepository } from '@luwi/redis';
import { createMessageRequestFingerprint } from '@luwi/runtime';
import { describe, expect, it, vi } from 'vitest';

import { createMessageService } from './message-service.js';
import type { SessionService } from './session-service.js';

const now = '2026-07-29T12:00:00.000Z';
const source: SessionView = {
  id: 'source',
  agentId: 'claude-sim',
  projectId: 'project-1',
  status: 'idle',
  workingDirectory: 'C:/workspace',
  startedAt: now,
  lastHeartbeatAt: now,
  metadata: {},
  presence: 'online',
};
const target: SessionView = {
  ...source,
  id: 'target',
  agentId: 'gemini-sim',
};
const message: AgentMessage = {
  id: 'message-1',
  correlationId: 'correlation-1',
  projectId: 'project-1',
  sourceSessionId: 'source',
  sourceAgentId: 'claude-sim',
  targetSessionId: 'target',
  targetAgentId: 'gemini-sim',
  selectionReason: 'direct target session target',
  kind: 'question',
  content: 'Status?',
  evidenceRequirements: [],
  state: 'queued',
  createdAt: now,
  updatedAt: now,
  deadlineAt: '2026-07-29T12:02:00.000Z',
};

function sessionService(sessions = [source, target]): SessionService {
  return {
    register: vi.fn(),
    get: async (sessionId) => sessions.find(({ id }) => id === sessionId) ?? null,
    list: async () => sessions,
    heartbeat: vi.fn(),
    updateStatus: vi.fn(),
    close: vi.fn(),
  };
}

function repository(overrides: Partial<MessageRepository> = {}): MessageRepository {
  return {
    createMessage: async () => ({
      status: 'created',
      message,
      event: {
        id: 'event-1',
        version: 1,
        type: 'message.requested',
        occurredAt: now,
        workspaceId: 'local',
        projectId: 'project-1',
        agentId: 'gemini-sim',
        sessionId: 'target',
        correlationId: 'correlation-1',
        payload: { messageId: 'message-1' },
      },
      globalStreamId: '1-0',
      projectStreamId: '1-0',
      inboxStreamId: '1-0',
    }),
    findIdempotentMessage: async () => null,
    getMessage: async () => message,
    getMessageById: async () => message,
    listMessages: async () => [message],
    transitionMessage: async () => ({ status: 'unchanged', message }),
    findDueMessageDeadlines: async () => [],
    ...overrides,
  };
}

const request: MessageCreateRequest = {
  sourceSessionId: 'source',
  targetSessionId: 'target',
  kind: 'question',
  content: 'Status?',
  evidenceRequirements: [],
  timeoutMs: 120_000,
};

describe('message service', () => {
  it('selects an online same-project target and passes a hashed idempotency key', async () => {
    const createMessage = vi.fn(async () => ({
      status: 'created' as const,
      message,
      event: {
        id: 'event-1',
        version: 1 as const,
        type: 'message.requested' as const,
        occurredAt: now,
        workspaceId: 'local',
        projectId: 'project-1',
        payload: {},
      },
      globalStreamId: '1-0',
      projectStreamId: '1-0',
      inboxStreamId: '1-0',
    }));
    const service = createMessageService({
      repository: repository({ createMessage }),
      sessions: sessionService(),
      workspaceId: 'local',
      createId: (() => {
        const ids = ['message-1', 'correlation-1', 'event-1'];
        return () => ids.shift() ?? 'unexpected';
      })(),
    });

    await expect(service.ask(request, ' retry-1 ')).resolves.toMatchObject({
      message: { correlationId: 'correlation-1' },
      selectedTargetSessionId: 'target',
      idempotent: false,
    });
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          idempotencyKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it('rejects offline sources, unavailable targets, and cross-project direct targets', async () => {
    const offlineSource = { ...source, presence: 'offline' as const };
    const crossProject = { ...target, projectId: 'project-2' };
    for (const [sessions, code] of [
      [[offlineSource, target], 'SOURCE_SESSION_INVALID'],
      [[source], 'TARGET_SESSION_UNAVAILABLE'],
      [[source, crossProject], 'TARGET_PROJECT_MISMATCH'],
    ] as const) {
      const service = createMessageService({
        repository: repository(),
        sessions: sessionService([...sessions]),
        workspaceId: 'local',
      });
      await expect(service.ask(request)).rejects.toMatchObject({ code });
    }
  });

  it('returns an existing idempotent request even when the original target is now offline', async () => {
    const fingerprint = createMessageRequestFingerprint(request);
    const service = createMessageService({
      repository: repository({
        findIdempotentMessage: async () => ({
          message: { ...message, state: 'responded' },
          requestFingerprint: fingerprint,
        }),
      }),
      sessions: sessionService([
        source,
        { ...target, presence: 'offline', status: 'disconnected' },
      ]),
      workspaceId: 'local',
    });

    await expect(service.ask(request, 'retry-1')).resolves.toMatchObject({
      message: { state: 'responded' },
      selectedTargetSessionId: 'target',
      idempotent: true,
    });
  });

  it('returns authoritative terminal state or a bounded latest projection while waiting', async () => {
    let reads = 0;
    let clock = 0;
    const service = createMessageService({
      repository: repository({
        getMessage: async () => {
          reads += 1;
          return reads >= 3 ? { ...message, state: 'responded' } : message;
        },
      }),
      sessions: sessionService(),
      workspaceId: 'local',
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
      pollIntervalMs: 10,
      runtimeState: () => 'ready',
    });

    await expect(service.wait('correlation-1', 30)).resolves.toMatchObject({
      state: 'responded',
    });
    expect(reads).toBe(3);
  });

  it('stops waits during draining and maps repository errors safely', async () => {
    const service = createMessageService({
      repository: repository({
        getMessage: async () => {
          throw new RedisRepositoryError('MESSAGE_NOT_FOUND', 'internal');
        },
      }),
      sessions: sessionService(),
      workspaceId: 'local',
      runtimeState: () => 'draining',
    });

    await expect(service.wait('missing', 10)).rejects.toMatchObject({
      code: 'RUNTIME_NOT_READY',
    });
  });

  it('claims only the addressed session inbox through the injected durable claim operation', async () => {
    const claimInbox = vi.fn(async (): Promise<InboxClaimResponse> => ({
      items: [],
    }));
    const service = createMessageService({
      repository: repository(),
      sessions: sessionService(),
      workspaceId: 'local',
      claimInbox,
    });

    await expect(
      service.claimInbox('target', {
        bridgeInstanceId: 'bridge-1',
        limit: 10,
        blockMs: 0,
        minIdleMs: 0,
      }),
    ).resolves.toEqual({ items: [] });
    expect(claimInbox).toHaveBeenCalledWith(
      'target',
      expect.objectContaining({ bridgeInstanceId: 'bridge-1' }),
    );
  });

  it('implements bounded inbox waiting without passing a blocking read to Redis', async () => {
    let clock = 0;
    let claimCount = 0;
    const claimInbox = vi.fn(async (): Promise<InboxClaimResponse> => {
      claimCount += 1;
      if (claimCount === 1) {
        return { items: [] };
      }
      return {
        items: [
          {
            streamId: '1-0',
            itemKind: 'request',
            messageId: 'message-1',
            correlationId: 'correlation-1',
            sourceSessionId: 'source',
            targetSessionId: 'target',
            createdAt: now,
            payload: {
              kind: 'question',
              content: 'Status?',
              evidenceRequirements: [],
              deadlineAt: '2026-07-29T12:02:00.000Z',
            },
          },
        ],
      };
    });
    const service = createMessageService({
      repository: repository(),
      sessions: sessionService(),
      workspaceId: 'local',
      claimInbox,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
      pollIntervalMs: 10,
      runtimeState: () => 'ready',
    });

    await expect(
      service.claimInbox('target', {
        bridgeInstanceId: 'bridge-1',
        limit: 10,
        blockMs: 25,
        minIdleMs: 0,
      }),
    ).resolves.toMatchObject({ items: [{ correlationId: 'correlation-1' }] });
    expect(claimInbox).toHaveBeenCalledTimes(2);
    expect(claimInbox).toHaveBeenNthCalledWith(
      1,
      'target',
      expect.objectContaining({ blockMs: 0 }),
    );
    expect(claimInbox).toHaveBeenNthCalledWith(
      2,
      'target',
      expect.objectContaining({ blockMs: 0 }),
    );
  });

  it('marks a starting reader idle when it claims its inbox (readiness signal)', async () => {
    const starting: SessionView = { ...target, status: 'starting' };
    const sessions = sessionService([source, starting]);
    const service = createMessageService({
      repository: repository(),
      sessions,
      workspaceId: 'local',
      claimInbox: async () => ({ items: [] }),
    });

    await service.claimInbox('target', {
      bridgeInstanceId: 'bridge-1',
      limit: 10,
      blockMs: 0,
      minIdleMs: 0,
    });

    expect(sessions.updateStatus).toHaveBeenCalledWith('target', 'idle');
  });

  it('leaves the status of a reader already past starting untouched', async () => {
    const working: SessionView = { ...target, status: 'thinking' };
    const sessions = sessionService([source, working]);
    const service = createMessageService({
      repository: repository(),
      sessions,
      workspaceId: 'local',
      claimInbox: async () => ({ items: [] }),
    });

    await service.claimInbox('target', {
      bridgeInstanceId: 'bridge-1',
      limit: 10,
      blockMs: 0,
      minIdleMs: 0,
    });

    expect(sessions.updateStatus).not.toHaveBeenCalled();
  });

  it('still claims when the readiness transition is refused (best-effort)', async () => {
    const starting: SessionView = { ...target, status: 'starting' };
    const sessions = sessionService([source, starting]);
    sessions.updateStatus = vi.fn(async () => {
      throw new Error('status write failed');
    });
    const service = createMessageService({
      repository: repository(),
      sessions,
      workspaceId: 'local',
      claimInbox: async () => ({ items: [] }),
    });

    await expect(
      service.claimInbox('target', {
        bridgeInstanceId: 'bridge-1',
        limit: 10,
        blockMs: 0,
        minIdleMs: 0,
      }),
    ).resolves.toEqual({ items: [] });
  });
});

describe('responder session status follows the message lifecycle', () => {
  const answer = {
    status: 'answered' as const,
    answer: 'done',
    evidence: [],
    verifiedAt: now,
  };

  it('marks the responder tool_running on processing and idle on respond', async () => {
    const sessions = sessionService();
    const service = createMessageService({
      repository: repository(),
      sessions,
      workspaceId: 'local',
    });

    await service.processing('correlation-1', { responderSessionId: 'target' });
    expect(sessions.updateStatus).toHaveBeenCalledWith('target', 'tool_running');

    await service.respond('correlation-1', 'target', answer);
    expect(sessions.updateStatus).toHaveBeenCalledWith('target', 'idle');
  });

  it('settles the responder to idle on reject and fail too', async () => {
    const sessions = sessionService();
    const service = createMessageService({
      repository: repository(),
      sessions,
      workspaceId: 'local',
    });

    await service.reject('correlation-1', 'target', { ...answer, status: 'rejected' });
    await service.fail('correlation-1', 'target', { ...answer, status: 'failed' });
    expect(sessions.updateStatus).toHaveBeenNthCalledWith(1, 'target', 'idle');
    expect(sessions.updateStatus).toHaveBeenNthCalledWith(2, 'target', 'idle');
  });

  it('never fails the message transition when the status write throws', async () => {
    const sessions = sessionService();
    sessions.updateStatus = vi.fn(async () => {
      throw new Error('SESSION_TERMINAL');
    });
    const service = createMessageService({
      repository: repository(),
      sessions,
      workspaceId: 'local',
    });

    await expect(service.respond('correlation-1', 'target', answer)).resolves.toBeDefined();
  });
});
