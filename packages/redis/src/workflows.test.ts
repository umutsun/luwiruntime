import { describe, expect, it } from 'vitest';

import {
  createFunctionRegistry,
  createMessageRepository,
  createRedisKeys,
  createWorkflowRepository,
  type ContinueWorkflowInput,
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

const workflow = {
  id: 'workflow-1',
  projectId: 'project-1',
  coordinatorSessionId: 'session-source',
  rootCorrelationId: 'correlation-1',
  objective: 'Complete the delegated implementation.',
  createFingerprint: 'f'.repeat(64),
};

const firstMessage = {
  id: 'message-1',
  correlationId: 'correlation-1',
  projectId: 'project-1',
  sourceSessionId: 'session-source',
  sourceAgentId: 'codex',
  targetSessionId: 'session-target',
  targetAgentId: 'gemini',
  selectionReason: 'direct target session session-target',
  kind: 'instruction' as const,
  subject: 'Implement the frontend slice',
  content: 'Implement and report the completed evidence.',
  evidenceRequirements: ['session_state' as const],
  timeoutMs: 120_000,
  requestFingerprint: 'a'.repeat(64),
};

const storedWorkflow = {
  id: workflow.id,
  projectId: workflow.projectId,
  coordinatorSessionId: workflow.coordinatorSessionId,
  rootCorrelationId: workflow.rootCorrelationId,
  objective: workflow.objective,
  revision: 1,
  state: 'active',
  currentMessageId: firstMessage.id,
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
} as const;

const storedMessage = {
  id: firstMessage.id,
  correlationId: firstMessage.correlationId,
  projectId: firstMessage.projectId,
  sourceSessionId: firstMessage.sourceSessionId,
  sourceAgentId: firstMessage.sourceAgentId,
  targetSessionId: firstMessage.targetSessionId,
  targetAgentId: firstMessage.targetAgentId,
  selectionReason: firstMessage.selectionReason,
  kind: firstMessage.kind,
  subject: firstMessage.subject,
  content: firstMessage.content,
  evidenceRequirements: firstMessage.evidenceRequirements,
  state: 'queued',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
  deadlineAt: '2026-09-09T12:02:00.000Z',
} as const;

const continuedMessage = {
  ...storedMessage,
  id: 'message-2',
  correlationId: 'correlation-2',
  sourceSessionId: 'session-source',
  targetSessionId: 'session-target',
  subject: 'Continue the implementation',
  content: 'Complete the next bounded step.',
  createdAt: '2026-09-09T12:01:00.000Z',
  updatedAt: '2026-09-09T12:01:00.000Z',
  deadlineAt: '2026-09-09T12:03:00.000Z',
} as const;

const activeWakeWorkflow = {
  ...storedWorkflow,
  currentWakeIntentId: 'wake-1',
} as const;

const continuedWorkflow = {
  ...storedWorkflow,
  revision: 2,
  currentMessageId: continuedMessage.id,
  updatedAt: '2026-09-09T12:01:00.000Z',
} as const;

const continuation: ContinueWorkflowInput = {
  workflowId: workflow.id,
  expectedRevision: 1,
  proof: { kind: 'wake', wakeIntentId: 'wake-1' },
  decision: {
    kind: 'next_message',
    targetAgentId: 'gemini',
    message: {
      kind: 'instruction',
      subject: continuedMessage.subject,
      content: continuedMessage.content,
    },
  },
  actorSessionId: 'session-source',
  nextMessage: {
    id: continuedMessage.id,
    correlationId: continuedMessage.correlationId,
    projectId: 'project-1',
    sourceSessionId: 'session-source',
    sourceAgentId: 'codex',
    targetSessionId: 'session-target',
    targetAgentId: 'gemini',
    selectionReason: 'direct target session session-target',
    kind: 'instruction',
    subject: continuedMessage.subject,
    content: continuedMessage.content,
    evidenceRequirements: ['session_state'],
    timeoutMs: 120_000,
    requestFingerprint: 'c'.repeat(64),
  },
  workspaceId: 'local',
  eventId: 'event-message-2',
};

describe('workflow repository boundary', () => {
  it('constructs every key for atomic workflow and first-message creation', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      JSON.stringify({
        status: 'created',
        workflow: storedWorkflow,
        message: storedMessage,
      }),
    ];
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createWorkflowRepository({ client, keys, functions });

    await expect(
      repository.create({
        workflow,
        firstMessage,
        workspaceId: 'local',
        eventId: 'event-1',
      }),
    ).resolves.toEqual({
      status: 'created',
      workflow: storedWorkflow,
      message: storedMessage,
    });

    expect(client.commands[0]?.slice(0, 24)).toEqual([
      'FCALL',
      functions.functions.workflowCreate,
      '21',
      keys.workflow(workflow.id),
      keys.workflowRootCorrelation(workflow.rootCorrelationId),
      keys.workflowsIndex,
      keys.projectWorkflows(workflow.projectId),
      keys.coordinatorSessionWorkflows(workflow.coordinatorSessionId),
      keys.workflowMessages(workflow.id),
      keys.message(firstMessage.id),
      keys.messageCorrelation(firstMessage.correlationId),
      keys.messageIdempotency(firstMessage.sourceSessionId, firstMessage.id),
      keys.messagesIndex,
      keys.projectMessages(firstMessage.projectId),
      keys.sourceSessionMessages(firstMessage.sourceSessionId),
      keys.targetSessionMessages(firstMessage.targetSessionId),
      keys.messageDeadlines,
      keys.session(firstMessage.sourceSessionId),
      keys.sessionPresence(firstMessage.sourceSessionId),
      keys.session(firstMessage.targetSessionId),
      keys.sessionPresence(firstMessage.targetSessionId),
      keys.sessionInbox(firstMessage.targetSessionId),
      keys.globalEvents,
      keys.projectEvents(firstMessage.projectId),
    ]);
  });

  it('loads the authoritative projections for an idempotent Function result', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      JSON.stringify({
        status: 'existing',
        workflowId: workflow.id,
        messageId: firstMessage.id,
      }),
      Object.entries(storedWorkflow).flatMap(([key, value]) => [key, String(value)]),
      Object.entries({
        ...storedMessage,
        evidenceRequirements: JSON.stringify(storedMessage.evidenceRequirements),
      }).flatMap(([key, value]) => [key, String(value)]),
      [workflow.createFingerprint, firstMessage.id],
      [workflow.id, '1'],
    ];
    const repository = createWorkflowRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(
      repository.create({ workflow, firstMessage, workspaceId: 'local', eventId: 'event-retry' }),
    ).resolves.toEqual({
      status: 'existing',
      workflow: storedWorkflow,
      message: storedMessage,
    });
  });

  it('lists only messages linked to the requested workflow', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      ['message-1'],
      workflow.id,
      Object.entries({
        ...storedMessage,
        evidenceRequirements: JSON.stringify(storedMessage.evidenceRequirements),
      }).flat(),
    ];
    const keys = createRedisKeys();
    const repository = createMessageRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });

    await expect(repository.listByWorkflow(workflow.id)).resolves.toEqual([storedMessage]);
    expect(client.commands[0]).toEqual(['ZRANGE', keys.workflowMessages(workflow.id), '0', '99']);
  });

  it('rejects a corrupt workflow-message association', async () => {
    const client = new FakeCommandClient();
    client.replies = [['message-1'], 'workflow-other'];
    const repository = createMessageRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.listByWorkflow(workflow.id)).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });

  it('rejects an unbounded workflow message request before touching Redis', async () => {
    const client = new FakeCommandClient();
    const repository = createMessageRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.listByWorkflow(workflow.id, 1001)).rejects.toMatchObject({
      code: 'WORKFLOW_QUERY_INVALID',
    });
    expect(client.commands).toEqual([]);
  });

  it('constructs the complete atomic continuation key set and parses its committed result', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      Object.entries(activeWakeWorkflow).flatMap(([key, value]) => [key, String(value)]),
      JSON.stringify({
        status: 'updated',
        workflow: continuedWorkflow,
        message: continuedMessage,
      }),
    ];
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createWorkflowRepository({
      client,
      keys,
      functions,
      decisionReceiptRetentionMs: 60_000,
    });

    await expect(repository.continue(continuation)).resolves.toEqual({
      status: 'updated',
      workflow: continuedWorkflow,
      message: continuedMessage,
    });

    expect(client.commands[1]?.slice(0, 25)).toEqual([
      'FCALL',
      functions.functions.workflowContinue,
      '22',
      keys.workflow(workflow.id),
      keys.workflowDecision(workflow.id, 1),
      keys.session('session-source'),
      keys.coordinatorSessionWorkflows('session-source'),
      keys.session('session-source'),
      keys.sessionPresence('session-source'),
      keys.coordinatorSessionWorkflows('session-source'),
      keys.wakeIntent('wake-1'),
      keys.workflowMessages(workflow.id),
      keys.message('message-2'),
      keys.messageCorrelation('correlation-2'),
      keys.messageIdempotency('session-source', 'message-2'),
      keys.messagesIndex,
      keys.projectMessages('project-1'),
      keys.sourceSessionMessages('session-source'),
      keys.targetSessionMessages('session-target'),
      keys.messageDeadlines,
      keys.session('session-target'),
      keys.sessionPresence('session-target'),
      keys.sessionInbox('session-target'),
      keys.globalEvents,
      keys.projectEvents('project-1'),
    ]);
    expect(client.commands[1]?.at(-1)).toBe('60000');
    expect(JSON.parse(client.commands[1]?.at(-4) ?? '{}')).not.toHaveProperty('causationId');
  });

  it('rejects an invalid decision receipt retention window at construction', () => {
    expect(() =>
      createWorkflowRepository({
        client: new FakeCommandClient(),
        keys: createRedisKeys(),
        functions: createFunctionRegistry(),
        decisionReceiptRetentionMs: 0,
      }),
    ).toThrow('decisionReceiptRetentionMs must be a positive safe integer.');
  });

  it('uses the oldest-first bounded workflow index', async () => {
    const client = new FakeCommandClient();
    client.replies = [[]];
    const keys = createRedisKeys();
    const repository = createWorkflowRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });

    await expect(repository.list({ limit: 5 })).resolves.toEqual([]);
    expect(client.commands[0]).toEqual(['ZRANGE', keys.workflowsIndex, '0', '4']);
  });

  it('fails closed when a bounded workflow index points at a missing projection', async () => {
    const client = new FakeCommandClient();
    client.replies = [['workflow-missing'], []];
    const repository = createWorkflowRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.list({ limit: 1 })).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });
});
