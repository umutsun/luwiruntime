import {
  agentMessageSchema,
  workflowCollectionSchema,
  workflowViewSchema,
  type AgentMessage,
  type ContinueWorkflowRequest,
  type WorkflowView,
} from '@luwi/protocol';
import { createWorkflowDecisionFingerprint } from '@luwi/runtime';

import { createMessageRepository, type CreateMessageInput } from './message-repository.js';
import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

export type CreateWorkflowInput = {
  workflow: {
    id: string;
    projectId: string;
    coordinatorSessionId: string;
    rootCorrelationId: string;
    objective: string;
    createFingerprint: string;
  };
  firstMessage: CreateMessageInput['message'];
  workspaceId: string;
  eventId: string;
};

export type CreateWorkflowResult = {
  status: 'created' | 'existing';
  workflow: WorkflowView;
  message: AgentMessage;
};

export type ContinueWorkflowInput = ContinueWorkflowRequest & {
  /** Trusted route identity. This is injected from the actor session path, never the request body. */
  actorSessionId: string;
  /**
   * Fully resolved durable message. Required only for `next_message`. The
   * Redis Function derives causation from the stored proof atomically.
   */
  nextMessage?: Omit<CreateMessageInput['message'], 'causationId'> & { causationId?: never };
  /** Fresh fence required only when the decision becomes `waiting_for_human`. */
  nextHumanContinuationId?: string;
  workspaceId: string;
  eventId: string;
};

export type ContinueWorkflowResult = {
  /** Replays intentionally return this exact committed status and projection. */
  status: 'updated';
  workflow: WorkflowView;
  message?: AgentMessage;
};

export type ListWorkflowsQuery = {
  projectId?: string;
  coordinatorSessionId?: string;
  limit?: number;
};

export interface WorkflowRepository {
  create(input: CreateWorkflowInput): Promise<CreateWorkflowResult>;
  continue(input: ContinueWorkflowInput): Promise<ContinueWorkflowResult>;
  get(workflowId: string): Promise<WorkflowView | null>;
  getByRootCorrelation(rootCorrelationId: string): Promise<WorkflowView | null>;
  list(query?: ListWorkflowsQuery): Promise<WorkflowView[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pairsToRecord(reply: unknown): Record<string, unknown> | null {
  if (!Array.isArray(reply)) {
    if (isRecord(reply)) {
      return reply;
    }
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow data is invalid.');
  }
  if (reply.length === 0) {
    return null;
  }
  if (reply.length % 2 !== 0) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow data is invalid.');
  }
  const record: Record<string, unknown> = {};
  for (let index = 0; index < reply.length; index += 2) {
    const key = reply[index];
    const value = reply[index + 1];
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow data is invalid.');
    }
    record[key] = value;
  }
  return record;
}

function stringArray(reply: unknown, description: string): string[] {
  if (!Array.isArray(reply) || !reply.every((item) => typeof item === 'string')) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', `Redis ${description} is invalid.`);
  }
  return reply;
}

function decodeJsonReply(reply: unknown): unknown {
  if (typeof reply !== 'string') {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
  try {
    return JSON.parse(reply) as unknown;
  } catch {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
}

function normalizeArray(value: unknown): unknown {
  return value === null ||
    value === undefined ||
    (isRecord(value) && Object.keys(value).length === 0)
    ? []
    : value;
}

function normalizeMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return { ...value, evidenceRequirements: normalizeArray(value.evidenceRequirements) };
}

const redisIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

type WorkflowReceipt = {
  workflowId: string;
  messageId: string;
  fingerprint: string;
};

function parseWorkflowReceipt(value: unknown): WorkflowReceipt {
  if (
    !isRecord(value) ||
    typeof value.workflowId !== 'string' ||
    !redisIdentifierPattern.test(value.workflowId) ||
    typeof value.messageId !== 'string' ||
    !redisIdentifierPattern.test(value.messageId) ||
    typeof value.fingerprint !== 'string' ||
    !sha256Pattern.test(value.fingerprint)
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow receipt is invalid.');
  }
  return {
    workflowId: value.workflowId,
    messageId: value.messageId,
    fingerprint: value.fingerprint,
  };
}

function parseWorkflowLink(reply: unknown): { workflowId: string; revision: number } {
  if (
    !Array.isArray(reply) ||
    reply.length !== 2 ||
    typeof reply[0] !== 'string' ||
    !redisIdentifierPattern.test(reply[0]) ||
    typeof reply[1] !== 'string'
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow link is invalid.');
  }
  const revision = Number(reply[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow link is invalid.');
  }
  return { workflowId: reply[0], revision };
}

function parseWorkflowPrivate(reply: unknown): { fingerprint: string; firstMessageId: string } {
  if (
    !Array.isArray(reply) ||
    reply.length !== 2 ||
    typeof reply[0] !== 'string' ||
    !sha256Pattern.test(reply[0]) ||
    typeof reply[1] !== 'string' ||
    !redisIdentifierPattern.test(reply[1])
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow metadata is invalid.');
  }
  return { fingerprint: reply[0], firstMessageId: reply[1] };
}

function parseStoredWorkflow(reply: unknown): WorkflowView | null {
  const record = pairsToRecord(reply);
  if (record === null) {
    return null;
  }
  const revision = Number(record.revision);
  const candidate: Record<string, unknown> = {
    id: record.id,
    projectId: record.projectId,
    coordinatorSessionId: record.coordinatorSessionId,
    rootCorrelationId: record.rootCorrelationId,
    objective: record.objective,
    revision,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  for (const field of [
    'currentMessageId',
    'currentWakeIntentId',
    'currentHumanContinuationId',
    'humanDecision',
  ] as const) {
    if (typeof record[field] === 'string') {
      candidate[field] = record[field];
    }
  }
  const parsed = workflowViewSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow projection is invalid.');
  }
  return parsed.data;
}

function parseContinueResult(value: unknown, input: ContinueWorkflowInput): ContinueWorkflowResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
  if (value.status === 'error') {
    const code = typeof value.code === 'string' ? value.code : 'REDIS_DATA_INVALID';
    const safeMessages: Record<string, string> = {
      WORKFLOW_NOT_FOUND: 'The workflow was not found.',
      WORKFLOW_NOT_ACTIVE: 'The workflow cannot accept this continuation.',
      WORKFLOW_REVISION_MISMATCH: 'The workflow revision changed.',
      WORKFLOW_PROOF_MISMATCH: 'The workflow continuation proof is stale or invalid.',
      WORKFLOW_COORDINATOR_MISMATCH: 'The actor is not the current workflow coordinator.',
      WORKFLOW_ACTOR_INVALID: 'The actor session cannot authorize this continuation.',
      WORKFLOW_REPLACEMENT_REQUIRED: 'A live replacement coordinator is required.',
      WORKFLOW_DECISION_CONFLICT: 'Another decision is already committed for this revision.',
      TARGET_SESSION_UNAVAILABLE: 'The target session is unavailable.',
      TARGET_PROJECT_MISMATCH: 'The workflow actor and target sessions must share a project.',
      REDIS_ARGUMENT_INVALID: 'The workflow continuation request is invalid.',
      REDIS_STATE_INVALID: 'Redis workflow state is invalid.',
    };
    throw new RedisRepositoryError(code, safeMessages[code] ?? 'Redis workflow state is invalid.');
  }
  if (value.status !== 'updated') {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
  const workflow = workflowViewSchema.safeParse(value.workflow);
  const message =
    value.message === undefined
      ? undefined
      : agentMessageSchema.safeParse(normalizeMessage(value.message));
  if (!workflow.success || (message !== undefined && !message.success)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
  const parsedMessage = message?.data;
  if (
    workflow.data.id !== input.workflowId ||
    workflow.data.revision !== input.expectedRevision + 1 ||
    (input.decision.kind === 'next_message') !== (parsedMessage !== undefined) ||
    (parsedMessage !== undefined &&
      (workflow.data.currentMessageId !== parsedMessage.id ||
        workflow.data.projectId !== parsedMessage.projectId ||
        parsedMessage.sourceSessionId !== workflow.data.coordinatorSessionId))
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is inconsistent.');
  }
  return {
    status: 'updated',
    workflow: workflow.data,
    ...(parsedMessage === undefined ? {} : { message: parsedMessage }),
  };
}

function parseCreateResult(value: unknown): CreateWorkflowResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
  if (value.status === 'error') {
    const code = typeof value.code === 'string' ? value.code : 'REDIS_DATA_INVALID';
    const safeMessages: Record<string, string> = {
      WORKFLOW_CREATE_CONFLICT: 'The root correlation already belongs to another workflow request.',
      SOURCE_SESSION_INVALID: 'The coordinator session is unavailable.',
      TARGET_SESSION_UNAVAILABLE: 'The target session is unavailable.',
      TARGET_PROJECT_MISMATCH: 'The coordinator and target sessions must share a project.',
      REDIS_ARGUMENT_INVALID: 'The workflow request is invalid.',
      REDIS_STATE_INVALID: 'Redis workflow state is invalid.',
    };
    throw new RedisRepositoryError(code, safeMessages[code] ?? 'Redis workflow state is invalid.');
  }
  if (value.status !== 'created' && value.status !== 'existing') {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
  const workflow = workflowViewSchema.safeParse(value.workflow);
  const message = agentMessageSchema.safeParse(normalizeMessage(value.message));
  if (!workflow.success || !message.success) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
  }
  if (
    workflow.data.currentMessageId !== message.data.id ||
    workflow.data.rootCorrelationId !== message.data.correlationId ||
    workflow.data.projectId !== message.data.projectId
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is inconsistent.');
  }
  return { status: value.status, workflow: workflow.data, message: message.data };
}

export function createWorkflowRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
  /** Exact replay window for immutable continuation receipts. */
  decisionReceiptRetentionMs?: number;
}): WorkflowRepository {
  const decisionReceiptRetentionMs = options.decisionReceiptRetentionMs ?? 604_800_000;
  if (!Number.isSafeInteger(decisionReceiptRetentionMs) || decisionReceiptRetentionMs < 1) {
    throw new Error('decisionReceiptRetentionMs must be a positive safe integer.');
  }
  const messagesForRead = createMessageRepository(options);
  const get = async (workflowId: string): Promise<WorkflowView | null> =>
    parseStoredWorkflow(
      await options.client.sendCommand(['HGETALL', options.keys.workflow(workflowId)]),
    );
  const loadAuthoritativeWorkflow = async (
    receipt: WorkflowReceipt,
    expectedRootCorrelationId: string,
    expectedFingerprint: string,
  ): Promise<{ workflow: WorkflowView; message: AgentMessage }> => {
    const [workflow, message, rawWorkflowPrivate, rawLink] = await Promise.all([
      get(receipt.workflowId),
      messagesForRead.getMessageById(receipt.messageId),
      options.client.sendCommand([
        'HMGET',
        options.keys.workflow(receipt.workflowId),
        'createFingerprint',
        'firstMessageId',
      ]),
      options.client.sendCommand([
        'HMGET',
        options.keys.message(receipt.messageId),
        'workflowId',
        'workflowRevision',
      ]),
    ]);
    const workflowPrivate = parseWorkflowPrivate(rawWorkflowPrivate);
    const link = parseWorkflowLink(rawLink);
    if (
      workflow === null ||
      message === null ||
      workflow.id !== receipt.workflowId ||
      message.id !== receipt.messageId ||
      workflowPrivate.fingerprint !== receipt.fingerprint ||
      workflowPrivate.fingerprint !== expectedFingerprint ||
      workflowPrivate.firstMessageId !== receipt.messageId ||
      workflow.rootCorrelationId !== expectedRootCorrelationId ||
      workflow.projectId !== message.projectId ||
      message.correlationId !== expectedRootCorrelationId ||
      link.workflowId !== workflow.id ||
      link.revision !== 1
    ) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow receipt is invalid.');
    }
    return { workflow, message };
  };
  const callCreate = async (
    input: CreateWorkflowInput,
    workflowId: string,
    messageId: string,
  ): Promise<unknown> => {
    const workflow = { ...input.workflow, id: workflowId };
    const firstMessage = { ...input.firstMessage, id: messageId };
    return decodeJsonReply(
      await options.client.sendCommand([
        'FCALL',
        options.functions.functions.workflowCreate,
        '21',
        options.keys.workflow(workflow.id),
        options.keys.workflowRootCorrelation(workflow.rootCorrelationId),
        options.keys.workflowsIndex,
        options.keys.projectWorkflows(workflow.projectId),
        options.keys.coordinatorSessionWorkflows(workflow.coordinatorSessionId),
        options.keys.workflowMessages(workflow.id),
        options.keys.message(firstMessage.id),
        options.keys.messageCorrelation(firstMessage.correlationId),
        options.keys.messageIdempotency(firstMessage.sourceSessionId, firstMessage.id),
        options.keys.messagesIndex,
        options.keys.projectMessages(firstMessage.projectId),
        options.keys.sourceSessionMessages(firstMessage.sourceSessionId),
        options.keys.targetSessionMessages(firstMessage.targetSessionId),
        options.keys.messageDeadlines,
        options.keys.session(firstMessage.sourceSessionId),
        options.keys.sessionPresence(firstMessage.sourceSessionId),
        options.keys.session(firstMessage.targetSessionId),
        options.keys.sessionPresence(firstMessage.targetSessionId),
        options.keys.sessionInbox(firstMessage.targetSessionId),
        options.keys.globalEvents,
        options.keys.projectEvents(firstMessage.projectId),
        JSON.stringify(workflow),
        JSON.stringify(firstMessage),
        input.workspaceId,
        input.eventId,
      ]),
    );
  };
  const getByRootCorrelation = async (rootCorrelationId: string): Promise<WorkflowView | null> => {
    const rawReceipt = await options.client.sendCommand([
      'GET',
      options.keys.workflowRootCorrelation(rootCorrelationId),
    ]);
    if (rawReceipt === null) {
      return null;
    }
    const receipt = parseWorkflowReceipt(decodeJsonReply(rawReceipt));
    return (await loadAuthoritativeWorkflow(receipt, rootCorrelationId, receipt.fingerprint))
      .workflow;
  };

  return {
    async create(input) {
      if (
        input.workflow.rootCorrelationId !== input.firstMessage.correlationId ||
        input.workflow.projectId !== input.firstMessage.projectId ||
        input.workflow.coordinatorSessionId !== input.firstMessage.sourceSessionId ||
        input.firstMessage.idempotencyKeyHash !== undefined
      ) {
        throw new RedisRepositoryError(
          'WORKFLOW_INPUT_INVALID',
          'The workflow and first message are inconsistent.',
        );
      }
      let reply = await callCreate(input, input.workflow.id, input.firstMessage.id);
      if (isRecord(reply) && reply.status === 'replay_required') {
        const replay = parseWorkflowReceipt({
          workflowId: reply.workflowId,
          messageId: reply.messageId,
          fingerprint: input.workflow.createFingerprint,
        });
        reply = await callCreate(input, replay.workflowId, replay.messageId);
        if (isRecord(reply) && reply.status === 'replay_required') {
          throw new RedisRepositoryError(
            'REDIS_DATA_INVALID',
            'Redis workflow replay result is invalid.',
          );
        }
      }
      if (isRecord(reply) && reply.status === 'existing') {
        const receipt = parseWorkflowReceipt({
          workflowId: reply.workflowId,
          messageId: reply.messageId,
          fingerprint: input.workflow.createFingerprint,
        });
        const stored = await loadAuthoritativeWorkflow(
          receipt,
          input.workflow.rootCorrelationId,
          input.workflow.createFingerprint,
        );
        return { status: 'existing', ...stored };
      }
      return parseCreateResult(reply);
    },
    async continue(input) {
      const workflow = await get(input.workflowId);
      if (workflow === null) {
        throw new RedisRepositoryError('WORKFLOW_NOT_FOUND', 'The workflow was not found.');
      }
      const nextMessage = input.nextMessage;
      const decisionFingerprint = createWorkflowDecisionFingerprint(input);
      const nextDecision = input.decision.kind === 'next_message' ? input.decision : undefined;
      const expectsMessage = nextDecision !== undefined;
      const expectsHumanFence = input.decision.kind === 'waiting_for_human';
      if (
        expectsMessage !== (nextMessage !== undefined) ||
        expectsHumanFence !== (input.nextHumanContinuationId !== undefined) ||
        (nextMessage !== undefined &&
          (nextMessage.projectId !== workflow.projectId ||
            nextMessage.sourceSessionId !== input.actorSessionId ||
            nextMessage.idempotencyKeyHash !== undefined ||
            nextDecision === undefined ||
            nextMessage.targetAgentId !== nextDecision.targetAgentId ||
            nextMessage.kind !== nextDecision.message.kind ||
            nextMessage.subject !== nextDecision.message.subject ||
            nextMessage.content !== nextDecision.message.content))
      ) {
        throw new RedisRepositoryError(
          'WORKFLOW_INPUT_INVALID',
          'The workflow continuation and resolved message are inconsistent.',
        );
      }
      const proofId =
        input.proof.kind === 'wake' ? input.proof.wakeIntentId : input.proof.continuationId;
      const commandKeys = [
        options.keys.workflow(input.workflowId),
        options.keys.workflowDecision(input.workflowId, input.expectedRevision),
        options.keys.session(workflow.coordinatorSessionId),
        options.keys.coordinatorSessionWorkflows(workflow.coordinatorSessionId),
        options.keys.session(input.actorSessionId),
        options.keys.sessionPresence(input.actorSessionId),
        options.keys.coordinatorSessionWorkflows(input.actorSessionId),
        options.keys.wakeIntent(proofId),
      ];
      if (nextMessage !== undefined) {
        commandKeys.push(
          options.keys.workflowMessages(input.workflowId),
          options.keys.message(nextMessage.id),
          options.keys.messageCorrelation(nextMessage.correlationId),
          options.keys.messageIdempotency(nextMessage.sourceSessionId, nextMessage.id),
          options.keys.messagesIndex,
          options.keys.projectMessages(nextMessage.projectId),
          options.keys.sourceSessionMessages(nextMessage.sourceSessionId),
          options.keys.targetSessionMessages(nextMessage.targetSessionId),
          options.keys.messageDeadlines,
          options.keys.session(nextMessage.targetSessionId),
          options.keys.sessionPresence(nextMessage.targetSessionId),
          options.keys.sessionInbox(nextMessage.targetSessionId),
          options.keys.globalEvents,
          options.keys.projectEvents(nextMessage.projectId),
        );
      }
      const payload = {
        workflowId: input.workflowId,
        expectedRevision: input.expectedRevision,
        proof: input.proof,
        decision: input.decision,
        actorSessionId: input.actorSessionId,
        decisionFingerprint,
        expectedCoordinatorSessionId: workflow.coordinatorSessionId,
        expectedProjectId: workflow.projectId,
        ...(input.nextHumanContinuationId === undefined
          ? {}
          : { nextHumanContinuationId: input.nextHumanContinuationId }),
      };
      const reply = decodeJsonReply(
        await options.client.sendCommand([
          'FCALL',
          options.functions.functions.workflowContinue,
          String(commandKeys.length),
          ...commandKeys,
          JSON.stringify(payload),
          nextMessage === undefined ? '' : JSON.stringify(nextMessage),
          input.workspaceId,
          input.eventId,
          String(decisionReceiptRetentionMs),
        ]),
      );
      return parseContinueResult(reply, input);
    },
    get,
    getByRootCorrelation,
    async list(query = {}) {
      const limit = query.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new RedisRepositoryError('WORKFLOW_QUERY_INVALID', 'The workflow query is invalid.');
      }
      const index =
        query.coordinatorSessionId !== undefined
          ? options.keys.coordinatorSessionWorkflows(query.coordinatorSessionId)
          : query.projectId !== undefined
            ? options.keys.projectWorkflows(query.projectId)
            : options.keys.workflowsIndex;
      const ids = stringArray(
        await options.client.sendCommand(['ZRANGE', index, '0', String(limit - 1)]),
        'workflow index',
      );
      const workflows: WorkflowView[] = [];
      for (const id of ids) {
        const workflow = await get(id);
        if (
          workflow === null ||
          (query.projectId !== undefined && workflow.projectId !== query.projectId) ||
          (query.coordinatorSessionId !== undefined &&
            workflow.coordinatorSessionId !== query.coordinatorSessionId)
        ) {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow index is invalid.');
        }
        workflows.push(workflow);
      }
      return workflowCollectionSchema.parse({ workflows }).workflows;
    },
  };
}
