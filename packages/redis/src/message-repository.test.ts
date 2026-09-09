import { describe, expect, it } from 'vitest';

import {
  createFunctionRegistry,
  createMessageRepository,
  createRedisKeys,
  type RedisCommandClient,
} from './index.js';

class FakeCommandClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  replies: unknown[] = [];

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    return this.replies.shift();
  }
}

const input = {
  message: {
    id: 'message-1',
    correlationId: 'correlation-1',
    projectId: 'project-1',
    sourceSessionId: 'session-source',
    sourceAgentId: 'claude-sim',
    targetSessionId: 'session-target',
    targetAgentId: 'gemini-sim',
    selectionReason: 'direct target session session-target',
    kind: 'question' as const,
    subject: 'Status',
    content: 'Project status?',
    evidenceRequirements: ['session_state' as const],
    timeoutMs: 120_000,
    requestFingerprint: 'f'.repeat(64),
    idempotencyKeyHash: 'a'.repeat(64),
  },
  workspaceId: 'local',
  eventId: 'event-1',
};

const storedMessage = {
  id: 'message-1',
  correlationId: 'correlation-1',
  projectId: 'project-1',
  sourceSessionId: 'session-source',
  sourceAgentId: 'claude-sim',
  targetSessionId: 'session-target',
  targetAgentId: 'gemini-sim',
  selectionReason: 'direct target session session-target',
  kind: 'question',
  subject: 'Status',
  content: 'Project status?',
  evidenceRequirements: ['session_state'],
  state: 'queued',
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
  deadlineAt: '2026-07-29T12:02:00.000Z',
};

function storedRecord(
  overrides: Partial<typeof storedMessage> & { respondedAt?: string } = {},
): Record<string, string> {
  const value = { ...storedMessage, ...overrides };
  return {
    ...value,
    evidenceRequirements: JSON.stringify(value.evidenceRequirements),
  };
}

describe('message repository boundary', () => {
  it('invokes request Function with centrally constructed keys only', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      JSON.stringify({
        status: 'created',
        message: storedMessage,
        event: {
          id: 'event-1',
          version: 1,
          type: 'message.requested',
          occurredAt: '2026-07-29T12:00:00.000Z',
          workspaceId: 'local',
          projectId: 'project-1',
          correlationId: 'correlation-1',
          payload: { messageId: 'message-1' },
        },
        globalStreamId: '1-0',
        projectStreamId: '1-0',
        inboxStreamId: '1-0',
      }),
    ];
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createMessageRepository({ client, keys, functions });

    await expect(repository.createMessage(input)).resolves.toMatchObject({
      status: 'created',
      message: { id: 'message-1', state: 'queued' },
      event: { type: 'message.requested' },
    });
    expect(client.commands[0]?.slice(0, 18)).toEqual([
      'FCALL',
      functions.functions.messageRequest,
      '15',
      keys.message('message-1'),
      keys.messageCorrelation('correlation-1'),
      keys.messageIdempotency('session-source', 'a'.repeat(64)),
      keys.messagesIndex,
      keys.projectMessages('project-1'),
      keys.sourceSessionMessages('session-source'),
      keys.targetSessionMessages('session-target'),
      keys.messageDeadlines,
      keys.session('session-source'),
      keys.sessionPresence('session-source'),
      keys.session('session-target'),
      keys.sessionPresence('session-target'),
      keys.sessionInbox('session-target'),
      keys.globalEvents,
      keys.projectEvents('project-1'),
    ]);
  });

  it('loads and validates the authoritative projection after an idempotent retry', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      JSON.stringify({
        status: 'existing',
        messageId: 'message-1',
        correlationId: 'correlation-1',
      }),
      'message-1',
      [
        'id',
        'message-1',
        'correlationId',
        'correlation-1',
        'projectId',
        'project-1',
        'sourceSessionId',
        'session-source',
        'sourceAgentId',
        'claude-sim',
        'targetSessionId',
        'session-target',
        'targetAgentId',
        'gemini-sim',
        'selectionReason',
        'direct target session session-target',
        'kind',
        'question',
        'subject',
        'Status',
        'content',
        'Project status?',
        'evidenceRequirements',
        '["session_state"]',
        'state',
        'queued',
        'createdAt',
        '2026-07-29T12:00:00.000Z',
        'updatedAt',
        '2026-07-29T12:00:00.000Z',
        'deadlineAt',
        '2026-07-29T12:02:00.000Z',
      ],
    ];
    const repository = createMessageRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.createMessage(input)).resolves.toEqual({
      status: 'existing',
      message: storedMessage,
    });
    expect(client.commands.map((command) => command[0])).toEqual(['FCALL', 'GET', 'HGETALL']);
  });

  it('rejects malformed Function and stored projection data', async () => {
    const client = new FakeCommandClient();
    client.replies = [JSON.stringify({ status: 'created', message: { id: 'broken' } })];
    const repository = createMessageRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.createMessage(input)).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });

  it('resolves the original request through its scoped idempotency index', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      JSON.stringify({
        messageId: 'message-1',
        correlationId: 'correlation-1',
        fingerprint: 'f'.repeat(64),
      }),
      storedRecord(),
      'f'.repeat(64),
    ];
    const keys = createRedisKeys();
    const repository = createMessageRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });

    await expect(
      repository.findIdempotentMessage('session-source', 'a'.repeat(64)),
    ).resolves.toMatchObject({
      message: { id: 'message-1' },
      requestFingerprint: 'f'.repeat(64),
    });
    expect(client.commands[0]).toEqual([
      'GET',
      keys.messageIdempotency('session-source', 'a'.repeat(64)),
    ]);
  });

  it('pages sparse filtered indexes until the requested limit or exhaustion', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      ['message-1', 'message-2', 'message-3', 'message-4'],
      storedRecord({ id: 'message-1', correlationId: 'correlation-1' }),
      storedRecord({ id: 'message-2', correlationId: 'correlation-2' }),
      storedRecord({ id: 'message-3', correlationId: 'correlation-3' }),
      storedRecord({ id: 'message-4', correlationId: 'correlation-4' }),
      ['message-5'],
      storedRecord({
        id: 'message-5',
        correlationId: 'correlation-5',
        state: 'responded',
        respondedAt: '2026-07-29T12:01:00.000Z',
        updatedAt: '2026-07-29T12:01:00.000Z',
      }),
    ];
    const repository = createMessageRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.listMessages({ state: 'responded', limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: 'message-5', state: 'responded' }),
    ]);
    expect(client.commands.filter((command) => command[0] === 'ZREVRANGE')).toHaveLength(2);
  });

  it('constructs transition keys from the authoritative message projection', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      'message-1',
      [
        'id',
        'message-1',
        'correlationId',
        'correlation-1',
        'projectId',
        'project-1',
        'sourceSessionId',
        'session-source',
        'sourceAgentId',
        'claude-sim',
        'targetSessionId',
        'session-target',
        'targetAgentId',
        'gemini-sim',
        'selectionReason',
        'direct target session session-target',
        'kind',
        'question',
        'subject',
        'Status',
        'content',
        'Project status?',
        'evidenceRequirements',
        '["session_state"]',
        'state',
        'queued',
        'createdAt',
        '2026-07-29T12:00:00.000Z',
        'updatedAt',
        '2026-07-29T12:00:00.000Z',
        'deadlineAt',
        '2026-07-29T12:02:00.000Z',
      ],
      'a'.repeat(64),
      JSON.stringify({
        status: 'updated',
        message: { ...storedMessage, state: 'delivered' },
        event: {
          id: 'event-delivered',
          version: 1,
          type: 'message.delivered',
          occurredAt: '2026-07-29T12:00:01.000Z',
          workspaceId: 'local',
          projectId: 'project-1',
          correlationId: 'correlation-1',
          payload: { messageId: 'message-1' },
        },
        globalStreamId: '2-0',
        projectStreamId: '2-0',
      }),
    ];
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createMessageRepository({ client, keys, functions });

    await expect(
      repository.transitionMessage('delivered', {
        correlationId: 'correlation-1',
        responderSessionId: 'session-target',
        workspaceId: 'local',
        eventId: 'event-delivered',
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      message: { state: 'delivered' },
    });
    expect(client.commands[3]?.slice(0, 13)).toEqual([
      'FCALL',
      functions.functions.messageDelivered,
      '10',
      keys.message('message-1'),
      keys.session('session-target'),
      keys.globalEvents,
      keys.projectEvents('project-1'),
      keys.sessionInbox('session-target'),
      keys.sessionInbox('session-source'),
      keys.messageDeadlines,
      keys.terminalMessages,
      keys.messageIdempotency('session-source', 'a'.repeat(64)),
      keys.messageCorrelation('correlation-1'),
    ]);
  });

  it('declares the complete workflow wake boundary for a linked terminal transition', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      'message-1',
      Object.entries(storedRecord()).flatMap(([field, value]) => [field, value]),
      ['a'.repeat(64), 'workflow-1', '1'],
      JSON.stringify({
        status: 'updated',
        message: {
          ...storedMessage,
          state: 'failed',
          respondedAt: '2026-07-29T12:00:01.000Z',
          updatedAt: '2026-07-29T12:00:01.000Z',
          response: {
            status: 'failed',
            answer: 'Failed safely.',
            evidence: [],
            verifiedAt: '2026-07-29T12:00:01.000Z',
          },
        },
        event: {
          id: 'event-failed',
          version: 1,
          type: 'message.failed',
          occurredAt: '2026-07-29T12:00:01.000Z',
          workspaceId: 'local',
          projectId: 'project-1',
          correlationId: 'correlation-1',
          payload: { messageId: 'message-1' },
        },
        globalStreamId: '2-0',
        projectStreamId: '2-0',
      }),
    ];
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const ids = ['wake-event-1', 'continuation-1'];
    const repository = createMessageRepository({
      client,
      keys,
      functions,
      createId: () => ids.shift() ?? 'unexpected',
    });

    await repository.transitionMessage('failed', {
      correlationId: 'correlation-1',
      responderSessionId: 'session-target',
      workspaceId: 'local',
      eventId: 'event-failed',
      responseJson: JSON.stringify({
        status: 'failed',
        answer: 'Failed safely.',
        evidence: [],
        verifiedAt: '2026-07-29T12:00:01.000Z',
      }),
    });

    expect(client.commands[3]).toEqual([
      'FCALL',
      functions.functions.messageFail,
      '18',
      keys.message('message-1'),
      keys.session('session-target'),
      keys.globalEvents,
      keys.projectEvents('project-1'),
      keys.sessionInbox('session-target'),
      keys.sessionInbox('session-source'),
      keys.messageDeadlines,
      keys.terminalMessages,
      keys.messageIdempotency('session-source', 'a'.repeat(64)),
      keys.messageCorrelation('correlation-1'),
      keys.session('session-source'),
      keys.sessionPresence('session-source'),
      keys.workflow('workflow-1'),
      keys.wakeIntent('message-1'),
      keys.wakeStream,
      keys.wakeIntentsIndex,
      keys.projectWakeIntents('project-1'),
      keys.wakeIntentDeadlines,
      'correlation-1',
      'session-target',
      'local',
      'event-failed',
      JSON.stringify({
        status: 'failed',
        answer: 'Failed safely.',
        evidence: [],
        verifiedAt: '2026-07-29T12:00:01.000Z',
      }),
      '',
      '86400000',
      'luwi-session-inbox-v1',
      '1',
      'wake-event-1',
      'continuation-1',
    ]);
  });
});
