import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalJsonStringify,
  type CanonicalJsonValue,
  type ContinueWorkflowRequest,
  type SessionView,
  type WorkflowCreateRequest,
  type WorkflowListQuery,
  type WorkflowView,
} from '@luwi/protocol';
import {
  RedisRepositoryError,
  type ContinueWorkflowInput,
  type ContinueWorkflowResult,
  type CreateMessageInput,
  type CreateWorkflowResult,
  type WorkflowRepository,
} from '@luwi/redis';
import {
  ApplicationError,
  createMessageRequestFingerprint,
  selectMessageTarget,
  utf8ByteLength,
} from '@luwi/runtime';

import type { SessionService } from './session-service.js';

export type WorkflowService = {
  create(request: WorkflowCreateRequest): Promise<CreateWorkflowResult>;
  get(workflowId: string): Promise<WorkflowView>;
  list(query?: Partial<WorkflowListQuery>): Promise<WorkflowView[]>;
  continue(
    actorSessionId: string,
    workflowId: string,
    request: ContinueWorkflowRequest,
  ): Promise<ContinueWorkflowResult>;
};

function sha256(value: CanonicalJsonValue): string {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}

function createFingerprint(request: WorkflowCreateRequest): string {
  return sha256({
    objective: request.objective,
    coordinatorSessionId: request.coordinatorSessionId,
    rootCorrelationId: request.rootCorrelationId,
    firstMessage: {
      targetAgentId: request.firstMessage.targetAgentId,
      kind: request.firstMessage.kind,
      subject: request.firstMessage.subject ?? null,
      content: request.firstMessage.content,
    },
  });
}

function live(session: SessionView | null): session is SessionView {
  return (
    session !== null &&
    session.presence === 'online' &&
    session.status !== 'completed' &&
    session.status !== 'disconnected'
  );
}

function repositoryError(error: unknown): never {
  if (!(error instanceof RedisRepositoryError) || error.code === 'REDIS_UNAVAILABLE') throw error;
  const mapping: Record<string, { statusCode: number; message: string }> = {
    WORKFLOW_INPUT_INVALID: { statusCode: 400, message: 'The workflow request is invalid.' },
    WORKFLOW_QUERY_INVALID: { statusCode: 400, message: 'The workflow query is invalid.' },
    REDIS_ARGUMENT_INVALID: { statusCode: 400, message: 'The workflow request is invalid.' },
    WORKFLOW_NOT_FOUND: { statusCode: 404, message: 'The workflow was not found.' },
    WORKFLOW_COORDINATOR_MISMATCH: {
      statusCode: 403,
      message: 'The workflow coordinator identity was rejected.',
    },
    WORKFLOW_ACTOR_INVALID: {
      statusCode: 403,
      message: 'The workflow actor is unavailable or unauthorized.',
    },
    WORKFLOW_NOT_ACTIVE: { statusCode: 409, message: 'The workflow cannot be continued.' },
    WORKFLOW_REVISION_MISMATCH: { statusCode: 409, message: 'The workflow revision changed.' },
    WORKFLOW_PROOF_MISMATCH: { statusCode: 409, message: 'The workflow proof changed.' },
    WORKFLOW_REPLACEMENT_REQUIRED: {
      statusCode: 409,
      message: 'A replacement coordinator is required for this continuation.',
    },
    WORKFLOW_DECISION_CONFLICT: {
      statusCode: 409,
      message: 'This workflow revision already has another decision.',
    },
    WORKFLOW_CREATE_CONFLICT: {
      statusCode: 409,
      message: 'The root correlation already belongs to another workflow request.',
    },
    SOURCE_SESSION_INVALID: { statusCode: 409, message: 'The source session is unavailable.' },
    TARGET_SESSION_UNAVAILABLE: { statusCode: 409, message: 'The target session is unavailable.' },
    TARGET_PROJECT_MISMATCH: {
      statusCode: 409,
      message: 'The source and target sessions must share a project.',
    },
  };
  const mapped = mapping[error.code];
  if (mapped === undefined) throw error;
  throw new ApplicationError(error.code, mapped.message, mapped.statusCode);
}

export function createWorkflowService(options: {
  repository: WorkflowRepository;
  sessions: SessionService;
  workspaceId: string;
  messageTimeoutMs?: number;
  maxContentBytes?: number;
  maxSubjectBytes?: number;
  createId?: () => string;
}): WorkflowService {
  const repository = options.repository;
  const createId = options.createId ?? randomUUID;
  const messageTimeoutMs = options.messageTimeoutMs ?? 120_000;
  const maxContentBytes = options.maxContentBytes ?? 32_768;
  const maxSubjectBytes = options.maxSubjectBytes ?? 512;

  const assertMessageSize = (message: { content: string; subject?: string | undefined }): void => {
    if (
      utf8ByteLength(message.content) > maxContentBytes ||
      (message.subject !== undefined && utf8ByteLength(message.subject) > maxSubjectBytes)
    ) {
      throw new ApplicationError(
        'WORKFLOW_CONTENT_TOO_LARGE',
        'The workflow message content or subject is too large.',
        413,
      );
    }
  };

  const requireActor = async (
    sessionId: string,
    errorCode: string,
    statusCode = 409,
  ): Promise<SessionView> => {
    const session = await options.sessions.get(sessionId);
    if (!live(session)) {
      throw new ApplicationError(errorCode, 'The workflow session is unavailable.', statusCode);
    }
    return session;
  };

  const requireWorkflowActor = async (
    sessionId: string,
    projectId: string,
  ): Promise<SessionView> => {
    const actor = await requireActor(sessionId, 'WORKFLOW_ACTOR_INVALID', 403);
    if (actor.projectId !== projectId) {
      throw new ApplicationError(
        'WORKFLOW_ACTOR_INVALID',
        'The workflow actor is unavailable or unauthorized.',
        403,
      );
    }
    return actor;
  };

  const selectTarget = async (sourceSession: SessionView, targetAgentId: string) => {
    const selection = selectMessageTarget({
      sourceSession,
      sessions: await options.sessions.list(),
      targetAgentId,
    });
    if (selection.status === 'project_mismatch') {
      throw new ApplicationError(
        'TARGET_PROJECT_MISMATCH',
        'The source and target sessions must share a project.',
        409,
      );
    }
    if (selection.status !== 'selected') {
      throw new ApplicationError(
        'TARGET_SESSION_UNAVAILABLE',
        'The target session is unavailable.',
        409,
      );
    }
    return selection;
  };

  const buildMessage = async (
    sourceSession: SessionView,
    correlationId: string,
    messageId: string,
    message: WorkflowCreateRequest['firstMessage'],
  ): Promise<NonNullable<ContinueWorkflowInput['nextMessage']>> => {
    assertMessageSize(message);
    const selection = await selectTarget(sourceSession, message.targetAgentId);
    const requestFingerprint = createMessageRequestFingerprint({
      sourceSessionId: sourceSession.id,
      targetAgentId: message.targetAgentId,
      kind: message.kind,
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      content: message.content,
      evidenceRequirements: [],
      timeoutMs: messageTimeoutMs,
    });
    return {
      id: messageId,
      correlationId,
      projectId: sourceSession.projectId,
      sourceSessionId: sourceSession.id,
      sourceAgentId: sourceSession.agentId,
      targetSessionId: selection.session.id,
      targetAgentId: selection.session.agentId,
      selectionReason: selection.reason,
      kind: message.kind,
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      content: message.content,
      evidenceRequirements: [],
      timeoutMs: messageTimeoutMs,
      requestFingerprint,
    };
  };

  const buildReplayMessage = (
    projectId: string,
    actorSessionId: string,
    actorAgentId: string,
    correlationId: string,
    messageId: string,
    message: WorkflowCreateRequest['firstMessage'],
  ): NonNullable<ContinueWorkflowInput['nextMessage']> => {
    assertMessageSize(message);
    const requestFingerprint = createMessageRequestFingerprint({
      sourceSessionId: actorSessionId,
      targetAgentId: message.targetAgentId,
      kind: message.kind,
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      content: message.content,
      evidenceRequirements: [],
      timeoutMs: messageTimeoutMs,
    });
    return {
      id: messageId,
      correlationId,
      projectId,
      sourceSessionId: actorSessionId,
      sourceAgentId: actorAgentId,
      // Redis returns a matching immutable receipt before inspecting these
      // generated routing fields. If the receipt is absent, its revision fence
      // rejects this placeholder before any message write can occur.
      targetSessionId: actorSessionId,
      targetAgentId: message.targetAgentId,
      selectionReason: 'workflow replay receipt lookup',
      kind: message.kind,
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      content: message.content,
      evidenceRequirements: [],
      timeoutMs: messageTimeoutMs,
      requestFingerprint,
    };
  };

  return {
    async create(request) {
      assertMessageSize(request.firstMessage);
      let existingWorkflow: WorkflowView | null;
      try {
        existingWorkflow = await repository.getByRootCorrelation(request.rootCorrelationId);
      } catch (error) {
        return repositoryError(error);
      }
      const workflowId = createId();
      const messageId = createId();
      let projectId: string;
      let firstMessage: CreateMessageInput['message'];
      if (existingWorkflow === null) {
        const coordinator = await requireActor(
          request.coordinatorSessionId,
          'SOURCE_SESSION_INVALID',
        );
        projectId = coordinator.projectId;
        firstMessage = await buildMessage(
          coordinator,
          request.rootCorrelationId,
          messageId,
          request.firstMessage,
        );
      } else {
        projectId = existingWorkflow.projectId;
        firstMessage = buildReplayMessage(
          projectId,
          request.coordinatorSessionId,
          request.firstMessage.targetAgentId,
          request.rootCorrelationId,
          messageId,
          request.firstMessage,
        );
      }
      try {
        return await repository.create({
          workflow: {
            id: workflowId,
            projectId,
            coordinatorSessionId: request.coordinatorSessionId,
            rootCorrelationId: request.rootCorrelationId,
            objective: request.objective,
            createFingerprint: createFingerprint(request),
          },
          firstMessage,
          workspaceId: options.workspaceId,
          eventId: createId(),
        });
      } catch (error) {
        return repositoryError(error);
      }
    },

    async get(workflowId) {
      try {
        const workflow = await repository.get(workflowId);
        if (workflow === null) {
          throw new ApplicationError('WORKFLOW_NOT_FOUND', 'The workflow was not found.', 404);
        }
        return workflow;
      } catch (error) {
        return repositoryError(error);
      }
    },

    async list(query = {}) {
      try {
        const repositoryQuery = {
          ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
          ...(query.coordinatorSessionId === undefined
            ? {}
            : { coordinatorSessionId: query.coordinatorSessionId }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        };
        return (await repository.list(repositoryQuery)).toSorted(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        );
      } catch (error) {
        return repositoryError(error);
      }
    },

    async continue(actorSessionId, workflowId, request) {
      if (request.workflowId !== workflowId) {
        throw new ApplicationError(
          'WORKFLOW_ID_MISMATCH',
          'The workflow path and request identities do not match.',
          400,
        );
      }
      let currentWorkflow: WorkflowView | null;
      try {
        currentWorkflow = await repository.get(workflowId);
      } catch (error) {
        return repositoryError(error);
      }
      if (currentWorkflow === null) {
        throw new ApplicationError('WORKFLOW_NOT_FOUND', 'The workflow was not found.', 404);
      }
      const replayCandidate = currentWorkflow.revision > request.expectedRevision;
      let nextMessage: ContinueWorkflowInput['nextMessage'];
      if (request.decision.kind === 'next_message') {
        const message = {
          targetAgentId: request.decision.targetAgentId,
          ...request.decision.message,
        };
        if (replayCandidate) {
          nextMessage = buildReplayMessage(
            currentWorkflow.projectId,
            actorSessionId,
            request.decision.targetAgentId,
            createId(),
            createId(),
            message,
          );
        } else {
          const actor = await requireWorkflowActor(actorSessionId, currentWorkflow.projectId);
          nextMessage = await buildMessage(actor, createId(), createId(), message);
        }
      } else if (!replayCandidate) {
        await requireWorkflowActor(actorSessionId, currentWorkflow.projectId);
      }
      try {
        return await repository.continue({
          ...request,
          actorSessionId,
          ...(nextMessage === undefined ? {} : { nextMessage }),
          ...(request.decision.kind === 'waiting_for_human'
            ? { nextHumanContinuationId: createId() }
            : {}),
          workspaceId: options.workspaceId,
          eventId: createId(),
        });
      } catch (error) {
        return repositoryError(error);
      }
    },
  };
}
