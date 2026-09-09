import {
  agentMessageSchema,
  workflowCollectionSchema,
  workflowViewSchema,
  type AgentMessage,
  type WorkflowView,
} from '@luwi/protocol';

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

export type ListWorkflowsQuery = {
  projectId?: string;
  coordinatorSessionId?: string;
  limit?: number;
};

export interface WorkflowRepository {
  create(input: CreateWorkflowInput): Promise<CreateWorkflowResult>;
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
  for (const field of ['currentMessageId', 'currentWakeIntentId'] as const) {
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
}): WorkflowRepository {
  const messagesForRead = createMessageRepository(options);
  const get = async (workflowId: string): Promise<WorkflowView | null> =>
    parseStoredWorkflow(
      await options.client.sendCommand(['HGETALL', options.keys.workflow(workflowId)]),
    );
  const getByRootCorrelation = async (rootCorrelationId: string): Promise<WorkflowView | null> => {
    const rawReceipt = await options.client.sendCommand([
      'GET',
      options.keys.workflowRootCorrelation(rootCorrelationId),
    ]);
    if (rawReceipt === null) {
      return null;
    }
    const receipt = decodeJsonReply(rawReceipt);
    if (
      !isRecord(receipt) ||
      typeof receipt.workflowId !== 'string' ||
      typeof receipt.messageId !== 'string' ||
      typeof receipt.fingerprint !== 'string'
    ) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow receipt is invalid.');
    }
    const workflow = await get(receipt.workflowId);
    if (
      workflow === null ||
      workflow.rootCorrelationId !== rootCorrelationId ||
      workflow.currentMessageId !== receipt.messageId
    ) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow receipt is invalid.');
    }
    return workflow;
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
      const reply = decodeJsonReply(
        await options.client.sendCommand([
          'FCALL',
          options.functions.functions.workflowCreate,
          '21',
          options.keys.workflow(input.workflow.id),
          options.keys.workflowRootCorrelation(input.workflow.rootCorrelationId),
          options.keys.workflowsIndex,
          options.keys.projectWorkflows(input.workflow.projectId),
          options.keys.coordinatorSessionWorkflows(input.workflow.coordinatorSessionId),
          options.keys.workflowMessages(input.workflow.id),
          options.keys.message(input.firstMessage.id),
          options.keys.messageCorrelation(input.firstMessage.correlationId),
          options.keys.messageIdempotency(
            input.firstMessage.sourceSessionId,
            input.firstMessage.id,
          ),
          options.keys.messagesIndex,
          options.keys.projectMessages(input.firstMessage.projectId),
          options.keys.sourceSessionMessages(input.firstMessage.sourceSessionId),
          options.keys.targetSessionMessages(input.firstMessage.targetSessionId),
          options.keys.messageDeadlines,
          options.keys.session(input.firstMessage.sourceSessionId),
          options.keys.sessionPresence(input.firstMessage.sourceSessionId),
          options.keys.session(input.firstMessage.targetSessionId),
          options.keys.sessionPresence(input.firstMessage.targetSessionId),
          options.keys.sessionInbox(input.firstMessage.targetSessionId),
          options.keys.globalEvents,
          options.keys.projectEvents(input.firstMessage.projectId),
          JSON.stringify(input.workflow),
          JSON.stringify(input.firstMessage),
          input.workspaceId,
          input.eventId,
        ]),
      );
      if (isRecord(reply) && reply.status === 'existing') {
        if (typeof reply.workflowId !== 'string' || typeof reply.messageId !== 'string') {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
        }
        const [storedWorkflow, storedMessage] = await Promise.all([
          get(reply.workflowId),
          messagesForRead.getMessageById(reply.messageId),
        ]);
        if (
          storedWorkflow === null ||
          storedMessage === null ||
          storedWorkflow.currentMessageId !== storedMessage.id ||
          storedWorkflow.rootCorrelationId !== storedMessage.correlationId ||
          storedWorkflow.projectId !== storedMessage.projectId
        ) {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis workflow result is invalid.');
        }
        return { status: 'existing', workflow: storedWorkflow, message: storedMessage };
      }
      return parseCreateResult(reply);
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
        await options.client.sendCommand(['ZREVRANGE', index, '0', String(limit - 1)]),
        'workflow index',
      );
      const workflows: WorkflowView[] = [];
      for (const id of ids) {
        const workflow = await get(id);
        if (
          workflow !== null &&
          (query.projectId === undefined || workflow.projectId === query.projectId) &&
          (query.coordinatorSessionId === undefined ||
            workflow.coordinatorSessionId === query.coordinatorSessionId)
        ) {
          workflows.push(workflow);
        }
      }
      return workflowCollectionSchema.parse({ workflows }).workflows;
    },
  };
}
