import type { AgentMessage, SessionView, WorkflowView } from '@luwi/protocol';
import { RedisRepositoryError, type WorkflowRepository } from '@luwi/redis';
import { describe, expect, it, vi } from 'vitest';

import type { SessionService } from './session-service.js';
import { createWorkflowService } from './workflow-service.js';

const coordinator: SessionView = {
  id: 'session-coordinator',
  agentId: 'codex',
  projectId: 'project-1',
  status: 'idle',
  workingDirectory: 'C:/workspace',
  startedAt: '2026-09-09T12:00:00.000Z',
  lastHeartbeatAt: '2026-09-09T12:00:10.000Z',
  metadata: {},
  presence: 'online',
};
const target: SessionView = {
  ...coordinator,
  id: 'session-target',
  agentId: 'claude-code',
  metadata: { bridge: 'native-headless' },
};
const workflow: WorkflowView = {
  id: 'workflow-1',
  projectId: 'project-1',
  coordinatorSessionId: 'session-coordinator',
  rootCorrelationId: 'correlation-root',
  objective: 'Implement and verify the delegated slice.',
  revision: 1,
  state: 'active',
  currentMessageId: 'message-1',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
};
const message: AgentMessage = {
  id: 'message-1',
  correlationId: 'correlation-root',
  projectId: 'project-1',
  sourceSessionId: 'session-coordinator',
  sourceAgentId: 'codex',
  targetSessionId: 'session-target',
  targetAgentId: 'claude-code',
  selectionReason:
    'selected agent claude-code session session-target by native-headless bridge preference, status, heartbeat, and session ID',
  kind: 'instruction',
  subject: 'Implement slice',
  content: 'Implement it and return evidence.',
  evidenceRequirements: [],
  state: 'queued',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
  deadlineAt: '2026-09-09T12:02:00.000Z',
};

const createRequest = {
  objective: workflow.objective,
  coordinatorSessionId: coordinator.id,
  rootCorrelationId: workflow.rootCorrelationId,
  firstMessage: {
    targetAgentId: target.agentId,
    kind: 'instruction' as const,
    subject: 'Implement slice',
    content: 'Implement it and return evidence.',
  },
};

function sessions(values: SessionView[] = [coordinator, target]): SessionService {
  return {
    get: vi.fn(async (id: string) => values.find((value) => value.id === id) ?? null),
    list: vi.fn(async () => values),
  } as unknown as SessionService;
}

function build(repository: Partial<WorkflowRepository>, values?: SessionView[]) {
  const ids = ['workflow-1', 'message-1', 'event-1'];
  return createWorkflowService({
    repository: {
      getByRootCorrelation: vi.fn().mockResolvedValue(null),
      ...repository,
    } as WorkflowRepository,
    sessions: sessions(values),
    workspaceId: 'local',
    messageTimeoutMs: 120_000,
    maxContentBytes: 32_768,
    maxSubjectBytes: 512,
    createId: () => ids.shift() ?? 'unexpected-id',
  });
}

describe('workflow service creation', () => {
  it('atomically prepares revision one and its selected first durable message', async () => {
    const create = vi.fn().mockResolvedValue({ status: 'created', workflow, message });
    const service = build({ create });

    await expect(service.create(createRequest)).resolves.toEqual({
      status: 'created',
      workflow,
      message,
    });
    expect(create).toHaveBeenCalledWith({
      workflow: {
        id: 'workflow-1',
        projectId: 'project-1',
        coordinatorSessionId: 'session-coordinator',
        rootCorrelationId: 'correlation-root',
        objective: workflow.objective,
        createFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      firstMessage: {
        id: 'message-1',
        correlationId: 'correlation-root',
        projectId: 'project-1',
        sourceSessionId: 'session-coordinator',
        sourceAgentId: 'codex',
        targetSessionId: 'session-target',
        targetAgentId: 'claude-code',
        selectionReason: expect.stringContaining('native-headless bridge preference'),
        kind: 'instruction',
        subject: 'Implement slice',
        content: 'Implement it and return evidence.',
        evidenceRequirements: [],
        timeoutMs: 120_000,
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      workspaceId: 'local',
      eventId: 'event-1',
    });
  });

  it('refuses unavailable coordinators and targets before writing', async () => {
    const create = vi.fn();
    const missingCoordinator = build({ create }, [target]);
    await expect(missingCoordinator.create(createRequest)).rejects.toMatchObject({
      code: 'SOURCE_SESSION_INVALID',
      statusCode: 409,
    });

    const missingTarget = build({ create }, [coordinator]);
    await expect(missingTarget.create(createRequest)).rejects.toMatchObject({
      code: 'TARGET_SESSION_UNAVAILABLE',
      statusCode: 409,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('uses byte limits for multibyte content and maps it to 413', async () => {
    const service = createWorkflowService({
      repository: {} as WorkflowRepository,
      sessions: sessions(),
      workspaceId: 'local',
      maxContentBytes: 4,
    });

    await expect(
      service.create({
        ...createRequest,
        firstMessage: { ...createRequest.firstMessage, content: 'ééé' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CONTENT_TOO_LARGE', statusCode: 413 });
  });

  it('replays an existing create receipt even after its sessions go offline', async () => {
    const create = vi.fn().mockResolvedValue({ status: 'existing', workflow, message });
    const service = build(
      { create, getByRootCorrelation: vi.fn().mockResolvedValue(workflow) },
      [],
    );

    await expect(service.create(createRequest)).resolves.toEqual({
      status: 'existing',
      workflow,
      message,
    });
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('workflow service reads', () => {
  it('sorts public list responses oldest-first and preserves bounded filters', async () => {
    const newer = {
      ...workflow,
      id: 'workflow-2',
      rootCorrelationId: 'correlation-2',
      createdAt: '2026-09-09T12:01:00.000Z',
      updatedAt: '2026-09-09T12:01:00.000Z',
    };
    const list = vi.fn().mockResolvedValue([newer, workflow]);
    const service = build({ list });

    await expect(service.list({ projectId: 'project-1', limit: 25 })).resolves.toEqual([
      workflow,
      newer,
    ]);
    expect(list).toHaveBeenCalledWith({ projectId: 'project-1', limit: 25 });
  });

  it('maps missing and conflicting repository outcomes to stable HTTP errors', async () => {
    const missing = build({ get: vi.fn().mockResolvedValue(null) });
    await expect(missing.get('workflow-missing')).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
      statusCode: 404,
    });

    const conflict = build({
      create: vi
        .fn()
        .mockRejectedValue(new RedisRepositoryError('WORKFLOW_CREATE_CONFLICT', 'private')),
    });
    await expect(conflict.create(createRequest)).rejects.toMatchObject({
      code: 'WORKFLOW_CREATE_CONFLICT',
      statusCode: 409,
    });
  });
});

describe('workflow continuation service', () => {
  function continuationService(continueWorkflow: ReturnType<typeof vi.fn>) {
    const ids = ['correlation-next', 'message-next', 'human-next', 'event-next'];
    return createWorkflowService({
      repository: {
        get: vi.fn().mockResolvedValue(workflow),
        continue: continueWorkflow,
      } as unknown as WorkflowRepository,
      sessions: sessions(),
      workspaceId: 'local',
      createId: () => ids.shift() ?? 'unexpected-id',
    });
  }

  it('injects the trusted actor path and creates exactly one resolved next message', async () => {
    const continued = { ...workflow, revision: 2, currentMessageId: 'message-next' };
    const continueWorkflow = vi
      .fn()
      .mockResolvedValue({ status: 'updated', workflow: continued, message });
    const service = continuationService(continueWorkflow);
    const request = {
      workflowId: 'workflow-1',
      expectedRevision: 1,
      proof: { kind: 'wake' as const, wakeIntentId: 'message-1' },
      decision: {
        kind: 'next_message' as const,
        targetAgentId: 'claude-code',
        message: { kind: 'instruction' as const, content: 'Continue the implementation.' },
      },
    };

    await service.continue('session-coordinator', 'workflow-1', request);

    expect(continueWorkflow).toHaveBeenCalledWith({
      ...request,
      actorSessionId: 'session-coordinator',
      nextMessage: expect.objectContaining({
        id: 'message-next',
        correlationId: 'correlation-next',
        sourceSessionId: 'session-coordinator',
        targetSessionId: 'session-target',
        targetAgentId: 'claude-code',
        content: 'Continue the implementation.',
      }),
      workspaceId: 'local',
      eventId: 'human-next',
    });
    expect(continueWorkflow.mock.calls[0]?.[0]).not.toHaveProperty('nextHumanContinuationId');
    expect(continueWorkflow.mock.calls[0]?.[0].nextMessage).not.toHaveProperty('causationId');
  });

  it('rejects a live cross-project actor as unauthorized before target selection', async () => {
    const crossProjectActor: SessionView = {
      ...coordinator,
      projectId: 'project-other',
    };
    const continueWorkflow = vi.fn();
    const service = createWorkflowService({
      repository: {
        get: vi.fn().mockResolvedValue(workflow),
        continue: continueWorkflow,
      } as unknown as WorkflowRepository,
      sessions: sessions([crossProjectActor, target]),
      workspaceId: 'local',
    });

    await expect(
      service.continue('session-coordinator', 'workflow-1', {
        workflowId: 'workflow-1',
        expectedRevision: 1,
        proof: { kind: 'wake', wakeIntentId: 'message-1' },
        decision: {
          kind: 'next_message',
          targetAgentId: 'claude-code',
          message: { kind: 'instruction', content: 'Continue the implementation.' },
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ACTOR_INVALID', statusCode: 403 });
    expect(continueWorkflow).not.toHaveBeenCalled();
  });

  it('mints only a human fence for waiting and no private continuation fields for complete', async () => {
    const continueWorkflow = vi.fn().mockResolvedValue({
      status: 'updated',
      workflow: { ...workflow, state: 'waiting_for_human' },
    });
    const waitingService = continuationService(continueWorkflow);
    await waitingService.continue('session-coordinator', 'workflow-1', {
      workflowId: 'workflow-1',
      expectedRevision: 1,
      proof: { kind: 'wake', wakeIntentId: 'message-1' },
      decision: { kind: 'waiting_for_human', humanDecision: 'Approve release.' },
    });
    expect(continueWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        nextHumanContinuationId: 'correlation-next',
        eventId: 'message-next',
      }),
    );
    expect(continueWorkflow.mock.calls[0]?.[0]).not.toHaveProperty('nextMessage');

    const completeWorkflow = vi.fn().mockResolvedValue({
      status: 'updated',
      workflow: { ...workflow, state: 'completed' },
    });
    const completeService = continuationService(completeWorkflow);
    await completeService.continue('session-coordinator', 'workflow-1', {
      workflowId: 'workflow-1',
      expectedRevision: 1,
      proof: { kind: 'wake', wakeIntentId: 'message-1' },
      decision: { kind: 'complete' },
    });
    const input = completeWorkflow.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('nextMessage');
    expect(input).not.toHaveProperty('nextHumanContinuationId');
  });

  it('rejects a body workflow id that differs from the route identity', async () => {
    const continueWorkflow = vi.fn();
    const service = continuationService(continueWorkflow);

    await expect(
      service.continue('session-coordinator', 'workflow-1', {
        workflowId: 'workflow-other',
        expectedRevision: 1,
        proof: { kind: 'wake', wakeIntentId: 'message-1' },
        decision: { kind: 'complete' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ID_MISMATCH', statusCode: 400 });
    expect(continueWorkflow).not.toHaveBeenCalled();
  });

  it('lets Redis replay a committed next-message decision after sessions go offline', async () => {
    const committedWorkflow = { ...workflow, revision: 2, currentMessageId: 'message-next' };
    const continueWorkflow = vi.fn().mockResolvedValue({
      status: 'updated',
      workflow: committedWorkflow,
      message,
    });
    const ids = ['correlation-replay', 'message-replay', 'event-replay'];
    const service = createWorkflowService({
      repository: {
        get: vi.fn().mockResolvedValue(committedWorkflow),
        continue: continueWorkflow,
      } as unknown as WorkflowRepository,
      sessions: sessions([]),
      workspaceId: 'local',
      createId: () => ids.shift() ?? 'unexpected-id',
    });

    await expect(
      service.continue('session-coordinator', 'workflow-1', {
        workflowId: 'workflow-1',
        expectedRevision: 1,
        proof: { kind: 'wake', wakeIntentId: 'message-1' },
        decision: {
          kind: 'next_message',
          targetAgentId: 'claude-code',
          message: { kind: 'instruction', content: 'Continue the implementation.' },
        },
      }),
    ).resolves.toMatchObject({ status: 'updated' });
    expect(continueWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'session-coordinator',
        nextMessage: expect.objectContaining({
          targetSessionId: 'session-coordinator',
          selectionReason: 'workflow replay receipt lookup',
        }),
      }),
    );
  });
});
