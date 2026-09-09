import { randomUUID } from 'node:crypto';

import {
  agentMessageResponseSchema,
  agentMessageSchema,
  messageCollectionResponseSchema,
  messageListQuerySchema,
  redisStreamIdSchema,
  runtimeEventSchema,
  type AgentMessage,
  type EvidenceType,
  type MessageKind,
  type MessageListQuery,
  type RuntimeEvent,
} from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

export type CreateMessageInput = {
  message: {
    id: string;
    correlationId: string;
    projectId: string;
    sourceSessionId: string;
    sourceAgentId: string;
    targetSessionId: string;
    targetAgentId: string;
    selectionReason: string;
    kind: MessageKind;
    subject?: string;
    content: string;
    evidenceRequirements: EvidenceType[];
    timeoutMs: number;
    requestFingerprint: string;
    idempotencyKeyHash?: string;
    /** Private causal link copied only to the durable message event and Redis metadata. */
    causationId?: string;
  };
  workspaceId: string;
  eventId: string;
};

export type CreateMessageResult =
  | {
      status: 'created';
      message: AgentMessage;
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
      inboxStreamId: string;
    }
  | {
      status: 'existing';
      message: AgentMessage;
    };

export type MessageTransitionKind =
  'delivered' | 'acknowledged' | 'processing' | 'responded' | 'rejected' | 'failed' | 'timed_out';

export type TransitionMessageInput = {
  correlationId: string;
  responderSessionId: string;
  workspaceId: string;
  eventId: string;
  responseJson?: string;
  expectedDeadlineMs?: number;
  idempotencyRetentionMs?: number;
};

export type TransitionMessageResult =
  | {
      status: 'updated';
      message: AgentMessage;
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
    }
  | {
      status: 'unchanged';
      message: AgentMessage;
    };

export interface MessageRepository {
  createMessage(input: CreateMessageInput): Promise<CreateMessageResult>;
  findIdempotentMessage(
    sourceSessionId: string,
    idempotencyKeyHash: string,
  ): Promise<{ message: AgentMessage; requestFingerprint: string } | null>;
  getMessage(correlationId: string): Promise<AgentMessage | null>;
  getMessageById(messageId: string): Promise<AgentMessage | null>;
  listMessages(query?: Partial<MessageListQuery>): Promise<AgentMessage[]>;
  listByWorkflow(workflowId: string, limit?: number): Promise<AgentMessage[]>;
  transitionMessage(
    kind: MessageTransitionKind,
    input: TransitionMessageInput,
  ): Promise<TransitionMessageResult>;
  findDueMessageDeadlines(
    nowMs: number,
    limit: number,
  ): Promise<Array<{ messageId: string; deadlineMs: number }>>;
}

function decodeJsonReply(reply: unknown): unknown {
  if (typeof reply !== 'string') {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an invalid message transition result.',
    );
  }
  try {
    return JSON.parse(reply) as unknown;
  } catch {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an invalid message transition result.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pairsToRecord(reply: unknown): Record<string, unknown> | null {
  if (!Array.isArray(reply)) {
    if (isRecord(reply)) {
      return reply;
    }
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message data is invalid.');
  }
  if (reply.length === 0) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (let index = 0; index < reply.length; index += 2) {
    const key = reply[index];
    const value = reply[index + 1];
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message data is invalid.');
    }
    record[key] = value;
  }
  return record;
}

function parseJsonField(value: unknown, field: string): unknown {
  if (typeof value !== 'string') {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', `Redis message ${field} is invalid.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', `Redis message ${field} is invalid.`);
  }
}

function normalizeEmptyArray(value: unknown): unknown {
  return value === null ||
    value === undefined ||
    (isRecord(value) && Object.keys(value).length === 0)
    ? []
    : value;
}

function normalizeRedisPublicMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const normalized: Record<string, unknown> = {
    ...value,
    evidenceRequirements: normalizeEmptyArray(value.evidenceRequirements),
  };
  if (isRecord(value.response)) {
    normalized.response = {
      ...value.response,
      evidence:
        value.response.evidence === undefined ? [] : normalizeEmptyArray(value.response.evidence),
    };
  }
  return normalized;
}

function parseStoredMessage(reply: unknown): AgentMessage | null {
  const record = pairsToRecord(reply);
  if (record === null) {
    return null;
  }
  const candidate: Record<string, unknown> = {
    id: record.id,
    correlationId: record.correlationId,
    projectId: record.projectId,
    sourceSessionId: record.sourceSessionId,
    sourceAgentId: record.sourceAgentId,
    targetSessionId: record.targetSessionId,
    targetAgentId: record.targetAgentId,
    selectionReason: record.selectionReason,
    kind: record.kind,
    content: record.content,
    evidenceRequirements: normalizeEmptyArray(
      parseJsonField(record.evidenceRequirements, 'evidenceRequirements'),
    ),
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deadlineAt: record.deadlineAt,
  };
  for (const field of ['subject', 'acknowledgedAt', 'processingAt', 'respondedAt'] as const) {
    if (typeof record[field] === 'string') {
      candidate[field] = record[field];
    }
  }
  if (record.response !== undefined) {
    const response = parseJsonField(record.response, 'response');
    candidate.response = agentMessageResponseSchema.parse(
      isRecord(response)
        ? {
            ...response,
            evidence: response.evidence === undefined ? [] : normalizeEmptyArray(response.evidence),
          }
        : response,
    );
  }
  const parsed = agentMessageSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message projection is invalid.');
  }
  return parsed.data;
}

function parseFunctionError(value: Record<string, unknown>): never {
  const code = typeof value.code === 'string' ? value.code : 'REDIS_DATA_INVALID';
  const safeMessages: Record<string, string> = {
    IDEMPOTENCY_KEY_CONFLICT: 'The Idempotency-Key was already used for another request.',
    SOURCE_SESSION_INVALID: 'The source session is unavailable.',
    TARGET_SESSION_UNAVAILABLE: 'The target session is unavailable.',
    TARGET_PROJECT_MISMATCH: 'The source and target sessions must share a project.',
    RESPONDER_SESSION_MISMATCH: 'The responder is not the selected target session.',
    MESSAGE_NOT_FOUND: 'The message was not found.',
    MESSAGE_TERMINAL: 'The message is already terminal.',
    MESSAGE_TRANSITION_INVALID: 'The message transition is invalid.',
  };
  throw new RedisRepositoryError(code, safeMessages[code] ?? 'Redis message state is invalid.');
}

function parseCreatedResult(value: unknown): Exclude<CreateMessageResult, { status: 'existing' }> {
  if (!isRecord(value)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
  }
  if (value.status === 'error') {
    return parseFunctionError(value);
  }
  if (value.status !== 'created') {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
  }
  const message = agentMessageSchema.safeParse(normalizeRedisPublicMessage(value.message));
  const event = runtimeEventSchema.safeParse(value.event);
  const globalStreamId = redisStreamIdSchema.safeParse(value.globalStreamId);
  const projectStreamId = redisStreamIdSchema.safeParse(value.projectStreamId);
  const inboxStreamId = redisStreamIdSchema.safeParse(value.inboxStreamId);
  if (
    !message.success ||
    !event.success ||
    !globalStreamId.success ||
    !projectStreamId.success ||
    !inboxStreamId.success
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
  }
  return {
    status: 'created',
    message: message.data,
    event: event.data,
    globalStreamId: globalStreamId.data,
    projectStreamId: projectStreamId.data,
    inboxStreamId: inboxStreamId.data,
  };
}

function parseTransitionResult(value: unknown): TransitionMessageResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
  }
  if (value.status === 'error') {
    return parseFunctionError(value);
  }
  if (value.status !== 'updated' && value.status !== 'unchanged') {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
  }
  const message = agentMessageSchema.safeParse(normalizeRedisPublicMessage(value.message));
  if (!message.success) {
    const rawMessage = isRecord(value.message) ? value.message : {};
    const rawResponse = isRecord(rawMessage.response) ? rawMessage.response : {};
    const rawEvidence = rawResponse.evidence;
    const evidenceShape =
      rawEvidence === null
        ? 'null'
        : Array.isArray(rawEvidence)
          ? 'array'
          : isRecord(rawEvidence)
            ? `object:${Object.keys(rawEvidence).length}`
            : typeof rawEvidence;
    const fields = message.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
      .join(',');
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      `Redis message result is invalid (${fields}; responseEvidence=${evidenceShape}).`,
    );
  }
  if (value.status === 'unchanged') {
    return { status: 'unchanged', message: message.data };
  }
  const event = runtimeEventSchema.safeParse(value.event);
  const globalStreamId = redisStreamIdSchema.safeParse(value.globalStreamId);
  const projectStreamId = redisStreamIdSchema.safeParse(value.projectStreamId);
  if (!event.success || !globalStreamId.success || !projectStreamId.success) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
  }
  return {
    status: 'updated',
    message: message.data,
    event: event.data,
    globalStreamId: globalStreamId.data,
    projectStreamId: projectStreamId.data,
  };
}

function stringArray(reply: unknown): string[] {
  if (!Array.isArray(reply) || !reply.every((item) => typeof item === 'string')) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message index is invalid.');
  }
  return reply;
}

function scoredMembers(reply: unknown): Array<{ messageId: string; deadlineMs: number }> {
  if (Array.isArray(reply) && reply.every((item) => typeof item === 'string')) {
    const deadlines: Array<{ messageId: string; deadlineMs: number }> = [];
    for (let index = 0; index < reply.length; index += 2) {
      const messageId = reply[index];
      const score = reply[index + 1];
      const deadlineMs = Number(score);
      if (messageId === undefined || score === undefined || !Number.isFinite(deadlineMs)) {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis deadline index is invalid.');
      }
      deadlines.push({ messageId, deadlineMs });
    }
    return deadlines;
  }
  if (Array.isArray(reply)) {
    const deadlines: Array<{ messageId: string; deadlineMs: number }> = [];
    for (const item of reply) {
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'string') {
        const deadlineMs = Number(item[1]);
        if (!Number.isFinite(deadlineMs)) {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis deadline index is invalid.');
        }
        deadlines.push({ messageId: item[0], deadlineMs });
        continue;
      }
      if (isRecord(item)) {
        const messageId =
          typeof item.value === 'string'
            ? item.value
            : typeof item.member === 'string'
              ? item.member
              : undefined;
        const deadlineMs = Number(item.score);
        if (messageId !== undefined && Number.isFinite(deadlineMs)) {
          deadlines.push({ messageId, deadlineMs });
          continue;
        }
      }
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis deadline index is invalid.');
    }
    return deadlines;
  }
  if (isRecord(reply)) {
    return Object.entries(reply).map(([messageId, score]) => {
      const deadlineMs = Number(score);
      if (!Number.isFinite(deadlineMs)) {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis deadline index is invalid.');
      }
      return { messageId, deadlineMs };
    });
  }
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis deadline index is invalid.');
}

export function createMessageRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
  createId?: () => string;
}): MessageRepository {
  const createId = options.createId ?? randomUUID;
  const getMessageById = async (messageId: string): Promise<AgentMessage | null> =>
    parseStoredMessage(
      await options.client.sendCommand(['HGETALL', options.keys.message(messageId)]),
    );

  const getMessage = async (correlationId: string): Promise<AgentMessage | null> => {
    const messageId = await options.client.sendCommand([
      'GET',
      options.keys.messageCorrelation(correlationId),
    ]);
    if (messageId === null) {
      return null;
    }
    if (typeof messageId !== 'string') {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis correlation index is invalid.');
    }
    return getMessageById(messageId);
  };

  return {
    async createMessage(input) {
      const idempotencyKey =
        input.message.idempotencyKeyHash === undefined
          ? options.keys.messageIdempotency(input.message.sourceSessionId, input.message.id)
          : options.keys.messageIdempotency(
              input.message.sourceSessionId,
              input.message.idempotencyKeyHash,
            );
      const reply = decodeJsonReply(
        await options.client.sendCommand([
          'FCALL',
          options.functions.functions.messageRequest,
          '15',
          options.keys.message(input.message.id),
          options.keys.messageCorrelation(input.message.correlationId),
          idempotencyKey,
          options.keys.messagesIndex,
          options.keys.projectMessages(input.message.projectId),
          options.keys.sourceSessionMessages(input.message.sourceSessionId),
          options.keys.targetSessionMessages(input.message.targetSessionId),
          options.keys.messageDeadlines,
          options.keys.session(input.message.sourceSessionId),
          options.keys.sessionPresence(input.message.sourceSessionId),
          options.keys.session(input.message.targetSessionId),
          options.keys.sessionPresence(input.message.targetSessionId),
          options.keys.sessionInbox(input.message.targetSessionId),
          options.keys.globalEvents,
          options.keys.projectEvents(input.message.projectId),
          JSON.stringify(input.message),
          input.workspaceId,
          input.eventId,
          input.message.idempotencyKeyHash === undefined ? '0' : '1',
        ]),
      );
      if (!isRecord(reply)) {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
      }
      if (reply.status === 'error') {
        return parseFunctionError(reply);
      }
      if (reply.status === 'existing') {
        if (typeof reply.messageId !== 'string' || typeof reply.correlationId !== 'string') {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
        }
        const message = await getMessage(reply.correlationId);
        if (message === null || message.id !== reply.messageId) {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message result is invalid.');
        }
        return { status: 'existing', message };
      }
      return parseCreatedResult(reply);
    },
    async findIdempotentMessage(sourceSessionId, idempotencyKeyHash) {
      const storedIndex = await options.client.sendCommand([
        'GET',
        options.keys.messageIdempotency(sourceSessionId, idempotencyKeyHash),
      ]);
      if (storedIndex === null) {
        return null;
      }
      if (typeof storedIndex !== 'string') {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis idempotency data is invalid.');
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(storedIndex) as unknown;
      } catch {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis idempotency data is invalid.');
      }
      if (
        !isRecord(decoded) ||
        typeof decoded.messageId !== 'string' ||
        typeof decoded.correlationId !== 'string' ||
        typeof decoded.fingerprint !== 'string'
      ) {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis idempotency data is invalid.');
      }
      const [message, requestFingerprint] = await Promise.all([
        getMessageById(decoded.messageId),
        options.client.sendCommand([
          'HGET',
          options.keys.message(decoded.messageId),
          'requestFingerprint',
        ]),
      ]);
      if (
        message === null ||
        message.correlationId !== decoded.correlationId ||
        typeof requestFingerprint !== 'string' ||
        requestFingerprint.length === 0 ||
        requestFingerprint !== decoded.fingerprint
      ) {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis idempotency data is invalid.');
      }
      return { message, requestFingerprint };
    },
    getMessage,
    getMessageById,
    async listMessages(query = {}) {
      const parsedQuery = messageListQuerySchema.parse(query);
      const index =
        parsedQuery.sourceSessionId !== undefined
          ? options.keys.sourceSessionMessages(parsedQuery.sourceSessionId)
          : parsedQuery.targetSessionId !== undefined
            ? options.keys.targetSessionMessages(parsedQuery.targetSessionId)
            : parsedQuery.projectId !== undefined
              ? options.keys.projectMessages(parsedQuery.projectId)
              : options.keys.messagesIndex;
      const messages: AgentMessage[] = [];
      const batchSize = parsedQuery.limit * 4;
      let offset = 0;
      while (messages.length < parsedQuery.limit) {
        const ids = stringArray(
          await options.client.sendCommand([
            'ZREVRANGE',
            index,
            String(offset),
            String(offset + batchSize - 1),
          ]),
        );
        if (ids.length === 0) {
          break;
        }
        for (const id of ids) {
          const message = await getMessageById(id);
          if (
            message !== null &&
            (parsedQuery.projectId === undefined || message.projectId === parsedQuery.projectId) &&
            (parsedQuery.sourceSessionId === undefined ||
              message.sourceSessionId === parsedQuery.sourceSessionId) &&
            (parsedQuery.targetSessionId === undefined ||
              message.targetSessionId === parsedQuery.targetSessionId) &&
            (parsedQuery.state === undefined || message.state === parsedQuery.state)
          ) {
            messages.push(message);
            if (messages.length === parsedQuery.limit) {
              break;
            }
          }
        }
        offset += ids.length;
        if (ids.length < batchSize) {
          break;
        }
      }
      return messageCollectionResponseSchema.parse({ messages }).messages;
    },
    async listByWorkflow(workflowId, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new RedisRepositoryError('WORKFLOW_QUERY_INVALID', 'The workflow query is invalid.');
      }
      const ids = stringArray(
        await options.client.sendCommand([
          'ZRANGE',
          options.keys.workflowMessages(workflowId),
          '0',
          String(limit - 1),
        ]),
      );
      const messages: AgentMessage[] = [];
      for (const id of ids) {
        const linkedWorkflowId = await options.client.sendCommand([
          'HGET',
          options.keys.message(id),
          'workflowId',
        ]);
        if (linkedWorkflowId !== workflowId) {
          throw new RedisRepositoryError(
            'REDIS_DATA_INVALID',
            'Redis workflow message link is invalid.',
          );
        }
        const message = await getMessageById(id);
        if (message === null) {
          throw new RedisRepositoryError(
            'REDIS_DATA_INVALID',
            'Redis workflow message is missing.',
          );
        }
        messages.push(message);
      }
      return messageCollectionResponseSchema.parse({ messages }).messages;
    },
    async transitionMessage(kind, input) {
      const message = await getMessage(input.correlationId);
      if (message === null) {
        throw new RedisRepositoryError('MESSAGE_NOT_FOUND', 'The message was not found.');
      }
      const terminal =
        kind === 'responded' || kind === 'rejected' || kind === 'failed' || kind === 'timed_out';
      const privateFields = terminal
        ? await options.client.sendCommand([
            'HMGET',
            options.keys.message(message.id),
            'idempotencyKeyHash',
            'workflowId',
            'workflowRevision',
          ])
        : await options.client.sendCommand([
            'HGET',
            options.keys.message(message.id),
            'idempotencyKeyHash',
          ]);
      let idempotencyHash: unknown = privateFields;
      let workflowId: string | undefined;
      if (terminal) {
        if (
          !Array.isArray(privateFields) ||
          privateFields.length !== 3 ||
          !privateFields.every((value) => value === null || typeof value === 'string')
        ) {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message data is invalid.');
        }
        [idempotencyHash] = privateFields;
        const storedWorkflowId = privateFields[1];
        const storedWorkflowRevision = privateFields[2];
        if ((storedWorkflowId === null) !== (storedWorkflowRevision === null)) {
          throw new RedisRepositoryError(
            'REDIS_DATA_INVALID',
            'Redis workflow message link is invalid.',
          );
        }
        if (typeof storedWorkflowId === 'string' && typeof storedWorkflowRevision === 'string') {
          const revision = Number(storedWorkflowRevision);
          if (!Number.isSafeInteger(revision) || revision < 1) {
            throw new RedisRepositoryError(
              'REDIS_DATA_INVALID',
              'Redis workflow message link is invalid.',
            );
          }
          workflowId = storedWorkflowId;
        }
      }
      if (idempotencyHash !== null && typeof idempotencyHash !== 'string') {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis message data is invalid.');
      }
      if (input.responseJson !== undefined) {
        try {
          agentMessageResponseSchema.parse(JSON.parse(input.responseJson) as unknown);
        } catch {
          throw new RedisRepositoryError(
            'MESSAGE_RESPONSE_TOO_LARGE',
            'The message response is invalid.',
          );
        }
      }
      const functionName: Record<MessageTransitionKind, string> = {
        delivered: options.functions.functions.messageDelivered,
        acknowledged: options.functions.functions.messageAcknowledge,
        processing: options.functions.functions.messageProcessing,
        responded: options.functions.functions.messageRespond,
        rejected: options.functions.functions.messageReject,
        failed: options.functions.functions.messageFail,
        timed_out: options.functions.functions.messageTimeout,
      };
      const idempotencyKey =
        typeof idempotencyHash === 'string'
          ? options.keys.messageIdempotency(message.sourceSessionId, idempotencyHash)
          : options.keys.messageIdempotency(message.sourceSessionId, message.id);
      const commandKeys = [
        options.keys.message(message.id),
        options.keys.session(message.targetSessionId),
        options.keys.globalEvents,
        options.keys.projectEvents(message.projectId),
        options.keys.sessionInbox(message.targetSessionId),
        options.keys.sessionInbox(message.sourceSessionId),
        options.keys.messageDeadlines,
        options.keys.terminalMessages,
        idempotencyKey,
        options.keys.messageCorrelation(message.correlationId),
      ];
      const commandArgs = [
        input.correlationId,
        input.responderSessionId,
        input.workspaceId,
        input.eventId,
        input.responseJson ?? '',
        input.expectedDeadlineMs === undefined ? '' : String(input.expectedDeadlineMs),
        String(input.idempotencyRetentionMs ?? 86_400_000),
        'luwi-session-inbox-v1',
        idempotencyHash === null ? '0' : '1',
      ];
      if (workflowId !== undefined) {
        commandKeys.push(
          options.keys.session(message.sourceSessionId),
          options.keys.sessionPresence(message.sourceSessionId),
          options.keys.workflow(workflowId),
          options.keys.wakeIntent(message.id),
          options.keys.wakeStream,
          options.keys.wakeIntentsIndex,
          options.keys.projectWakeIntents(message.projectId),
          options.keys.wakeIntentDeadlines,
        );
        commandArgs.push(createId(), createId());
      }
      const result = decodeJsonReply(
        await options.client.sendCommand([
          'FCALL',
          functionName[kind],
          String(commandKeys.length),
          ...commandKeys,
          ...commandArgs,
        ]),
      );
      return parseTransitionResult(result);
    },
    async findDueMessageDeadlines(nowMs, limit) {
      const reply = await options.client.sendCommand([
        'ZRANGEBYSCORE',
        options.keys.messageDeadlines,
        '-inf',
        String(nowMs),
        'WITHSCORES',
        'LIMIT',
        '0',
        String(limit),
      ]);
      return scoredMembers(reply);
    },
  };
}
