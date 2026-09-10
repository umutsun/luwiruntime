import { randomUUID } from 'node:crypto';
import { setTimeout as delayTimer } from 'node:timers/promises';

import type {
  AgentMessage,
  AgentMessageResponse,
  InboxClaimRequest,
  InboxClaimResponse,
  MessageCollectionResponse,
  MessageCreateRequest,
  MessageCreateResponse,
  MessageListQuery,
  MessageTransitionRequest,
  RuntimeStateName,
  SessionView,
} from '@luwi/protocol';
import {
  RedisRepositoryError,
  type MessageRepository,
  type MessageTransitionKind,
} from '@luwi/redis';
import {
  ApplicationError,
  createMessageRequestFingerprint,
  hashIdempotencyKey,
  selectMessageTarget,
  utf8ByteLength,
} from '@luwi/runtime';

import type { SessionService } from './session-service.js';

const terminalStates = new Set<AgentMessage['state']>([
  'responded',
  'rejected',
  'timed_out',
  'failed',
]);

export type MessageService = {
  ask(request: MessageCreateRequest, idempotencyKey?: string): Promise<MessageCreateResponse>;
  get(correlationId: string): Promise<AgentMessage>;
  list(query?: Partial<MessageListQuery>): Promise<MessageCollectionResponse>;
  wait(correlationId: string, waitMs: number): Promise<AgentMessage>;
  acknowledge(correlationId: string, request: MessageTransitionRequest): Promise<AgentMessage>;
  processing(correlationId: string, request: MessageTransitionRequest): Promise<AgentMessage>;
  respond(
    correlationId: string,
    responderSessionId: string,
    response: AgentMessageResponse,
  ): Promise<AgentMessage>;
  reject(
    correlationId: string,
    responderSessionId: string,
    response: AgentMessageResponse,
  ): Promise<AgentMessage>;
  fail(
    correlationId: string,
    responderSessionId: string,
    response: AgentMessageResponse,
  ): Promise<AgentMessage>;
  claimInbox(sessionId: string, request: InboxClaimRequest): Promise<InboxClaimResponse>;
  timeoutMessage(messageId: string, expectedDeadlineMs: number): Promise<'timed_out' | 'unchanged'>;
};

export type MessageServiceOptions = {
  repository: MessageRepository;
  sessions: SessionService;
  workspaceId: string;
  claimInbox?: (sessionId: string, request: InboxClaimRequest) => Promise<InboxClaimResponse>;
  createId?: () => string;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  runtimeState?: () => RuntimeStateName;
  idempotencyRetentionMs?: number;
  maxContentBytes?: number;
  maxSubjectBytes?: number;
  maxResponseBytes?: number;
  maxEvidenceItems?: number;
  maxTimeoutMs?: number;
};

function isAvailable(session: SessionView): boolean {
  return (
    session.presence === 'online' &&
    session.status !== 'completed' &&
    session.status !== 'disconnected'
  );
}

function repositoryError(error: unknown): never {
  if (!(error instanceof RedisRepositoryError) || error.code === 'REDIS_UNAVAILABLE') {
    throw error;
  }
  const mapping: Record<string, { statusCode: number; message: string }> = {
    MESSAGE_NOT_FOUND: { statusCode: 404, message: 'The message was not found.' },
    MESSAGE_TERMINAL: { statusCode: 409, message: 'The message is already terminal.' },
    MESSAGE_TRANSITION_INVALID: {
      statusCode: 409,
      message: 'The requested message transition is invalid.',
    },
    TARGET_SESSION_UNAVAILABLE: {
      statusCode: 409,
      message: 'The target session is unavailable.',
    },
    TARGET_PROJECT_MISMATCH: {
      statusCode: 409,
      message: 'The source and target sessions must share a project.',
    },
    SOURCE_SESSION_INVALID: {
      statusCode: 409,
      message: 'The source session is unavailable.',
    },
    RESPONDER_SESSION_MISMATCH: {
      statusCode: 403,
      message: 'The responder is not the selected target session.',
    },
    INBOX_ENTRY_INVALID: {
      statusCode: 422,
      message: 'The inbox contains an invalid entry.',
    },
    INBOX_CONSUMER_INVALID: {
      statusCode: 400,
      message: 'The inbox consumer identity is invalid.',
    },
    IDEMPOTENCY_KEY_CONFLICT: {
      statusCode: 409,
      message: 'The Idempotency-Key was already used for another request.',
    },
    MESSAGE_RESPONSE_TOO_LARGE: {
      statusCode: 413,
      message: 'The message response is invalid or too large.',
    },
    MESSAGE_CONTENT_TOO_LARGE: {
      statusCode: 413,
      message: 'The message content or subject is too large.',
    },
    MESSAGE_TIMEOUT_INVALID: {
      statusCode: 400,
      message: 'The message timeout is invalid.',
    },
    REDIS_ARGUMENT_INVALID: {
      statusCode: 400,
      message: 'The message transition arguments are invalid.',
    },
  };
  const mapped = mapping[error.code];
  if (mapped === undefined) {
    throw error;
  }
  throw new ApplicationError(error.code, mapped.message, mapped.statusCode);
}

async function requireSource(sessions: SessionService, sessionId: string): Promise<SessionView> {
  const session = await sessions.get(sessionId);
  if (session === null || !isAvailable(session)) {
    throw new ApplicationError('SOURCE_SESSION_INVALID', 'The source session is unavailable.', 409);
  }
  return session;
}

export function createMessageService(options: MessageServiceOptions): MessageService {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds: number) => delayTimer(milliseconds));
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const runtimeState = options.runtimeState ?? (() => 'ready');
  const maxContentBytes = options.maxContentBytes ?? 32_768;
  const maxSubjectBytes = options.maxSubjectBytes ?? 512;
  const maxResponseBytes = options.maxResponseBytes ?? 65_536;
  const maxEvidenceItems = options.maxEvidenceItems ?? 32;
  const maxTimeoutMs = options.maxTimeoutMs ?? 86_400_000;

  const get = async (correlationId: string): Promise<AgentMessage> => {
    try {
      const message = await options.repository.getMessage(correlationId);
      if (message === null) {
        throw new ApplicationError('MESSAGE_NOT_FOUND', 'The message was not found.', 404);
      }
      return message;
    } catch (error) {
      return repositoryError(error);
    }
  };

  const transition = async (
    kind: MessageTransitionKind,
    correlationId: string,
    responderSessionId: string,
    response?: AgentMessageResponse,
  ): Promise<AgentMessage> => {
    if (
      response !== undefined &&
      (utf8ByteLength(JSON.stringify(response)) > maxResponseBytes ||
        response.evidence.length > maxEvidenceItems)
    ) {
      throw new ApplicationError(
        'MESSAGE_RESPONSE_TOO_LARGE',
        'The message response is invalid or too large.',
        413,
      );
    }
    try {
      const result = await options.repository.transitionMessage(kind, {
        correlationId,
        responderSessionId,
        workspaceId: options.workspaceId,
        eventId: createId(),
        ...(response === undefined ? {} : { responseJson: JSON.stringify(response) }),
        idempotencyRetentionMs: options.idempotencyRetentionMs ?? 86_400_000,
      });
      return result.message;
    } catch (error) {
      return repositoryError(error);
    }
  };

  return {
    async ask(request, idempotencyKey) {
      if (
        utf8ByteLength(request.content) > maxContentBytes ||
        (request.subject !== undefined && utf8ByteLength(request.subject) > maxSubjectBytes) ||
        request.evidenceRequirements.length > maxEvidenceItems
      ) {
        throw new ApplicationError(
          'MESSAGE_CONTENT_TOO_LARGE',
          'The message content, subject, or evidence requirements exceed configured limits.',
          413,
        );
      }
      if (request.timeoutMs < 1 || request.timeoutMs > maxTimeoutMs) {
        throw new ApplicationError(
          'MESSAGE_TIMEOUT_INVALID',
          'The message timeout is outside the configured range.',
          400,
        );
      }
      let idempotencyKeyHash: string | undefined;
      if (idempotencyKey !== undefined) {
        try {
          idempotencyKeyHash = hashIdempotencyKey(idempotencyKey);
        } catch {
          throw new ApplicationError(
            'IDEMPOTENCY_KEY_INVALID',
            'Idempotency-Key must be 1-128 characters without control characters.',
            400,
          );
        }
      }
      const requestFingerprint = createMessageRequestFingerprint(request);
      if (idempotencyKeyHash !== undefined) {
        try {
          const existing = await options.repository.findIdempotentMessage(
            request.sourceSessionId,
            idempotencyKeyHash,
          );
          if (existing !== null) {
            if (existing.requestFingerprint !== requestFingerprint) {
              throw new ApplicationError(
                'IDEMPOTENCY_KEY_CONFLICT',
                'The Idempotency-Key was already used for another request.',
                409,
              );
            }
            return {
              message: existing.message,
              selectedTargetSessionId: existing.message.targetSessionId,
              selectedTargetAgentId: existing.message.targetAgentId,
              selectionReason: existing.message.selectionReason,
              idempotent: true,
            };
          }
        } catch (error) {
          return repositoryError(error);
        }
      }

      const sourceSession = await requireSource(options.sessions, request.sourceSessionId);
      const selection = selectMessageTarget({
        sourceSession,
        sessions: await options.sessions.list(),
        ...(request.targetSessionId === undefined
          ? {}
          : { targetSessionId: request.targetSessionId }),
        ...(request.targetAgentId === undefined ? {} : { targetAgentId: request.targetAgentId }),
      });
      if (selection.status === 'unavailable') {
        throw new ApplicationError(
          'TARGET_SESSION_UNAVAILABLE',
          'The target session is unavailable.',
          409,
        );
      }
      if (selection.status === 'project_mismatch') {
        throw new ApplicationError(
          'TARGET_PROJECT_MISMATCH',
          'The source and target sessions must share a project.',
          409,
        );
      }
      const messageId = createId();
      const correlationId = createId();
      const target = selection.session;
      try {
        const result = await options.repository.createMessage({
          message: {
            id: messageId,
            correlationId,
            projectId: sourceSession.projectId,
            sourceSessionId: sourceSession.id,
            sourceAgentId: sourceSession.agentId,
            targetSessionId: target.id,
            targetAgentId: target.agentId,
            selectionReason: selection.reason,
            kind: request.kind,
            ...(request.subject === undefined ? {} : { subject: request.subject }),
            content: request.content,
            evidenceRequirements: request.evidenceRequirements,
            timeoutMs: request.timeoutMs,
            requestFingerprint,
            ...(idempotencyKeyHash === undefined ? {} : { idempotencyKeyHash }),
          },
          workspaceId: options.workspaceId,
          eventId: createId(),
        });
        return {
          message: result.message,
          selectedTargetSessionId: result.message.targetSessionId,
          selectedTargetAgentId: result.message.targetAgentId,
          selectionReason: result.message.selectionReason,
          idempotent: result.status === 'existing',
        };
      } catch (error) {
        return repositoryError(error);
      }
    },

    get,

    async list(query = {}) {
      try {
        return { messages: await options.repository.listMessages(query) };
      } catch (error) {
        return repositoryError(error);
      }
    },

    async wait(correlationId, waitMs) {
      if (runtimeState() !== 'ready') {
        throw new ApplicationError(
          'RUNTIME_NOT_READY',
          'The runtime is not ready to wait for message state.',
          503,
        );
      }
      const deadline = now() + waitMs;
      let message = await get(correlationId);
      while (!terminalStates.has(message.state) && now() < deadline) {
        if (runtimeState() !== 'ready') {
          throw new ApplicationError(
            'RUNTIME_NOT_READY',
            'The runtime is not ready to wait for message state.',
            503,
          );
        }
        await delay(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
        message = await get(correlationId);
      }
      return message;
    },

    acknowledge: (correlationId, request) =>
      transition('acknowledged', correlationId, request.responderSessionId),
    processing: (correlationId, request) =>
      transition('processing', correlationId, request.responderSessionId),
    respond: (correlationId, responderSessionId, response) =>
      transition('responded', correlationId, responderSessionId, response),
    reject: (correlationId, responderSessionId, response) =>
      transition('rejected', correlationId, responderSessionId, response),
    fail: (correlationId, responderSessionId, response) =>
      transition('failed', correlationId, responderSessionId, response),

    async claimInbox(sessionId, request) {
      const session = await options.sessions.get(sessionId);
      if (session === null || !isAvailable(session)) {
        throw new ApplicationError(
          'TARGET_SESSION_UNAVAILABLE',
          'The target session is unavailable.',
          409,
        );
      }
      if (options.claimInbox === undefined) {
        throw new ApplicationError('INBOX_UNAVAILABLE', 'The session inbox is unavailable.', 503);
      }
      // ponytail: reading the inbox is the readiness proof. A session that claims work is
      // a live reader, not a reader-less 'starting' ghost, so mark it idle — that is the
      // signal selectMessageTarget routes on (a 'starting' session is never auto-selected).
      // Only 'starting' moves; a session already working keeps its status. Best-effort: a
      // status write must never fail the claim — LUWI must not stop the tool it coordinates.
      if (session.status === 'starting') {
        try {
          await options.sessions.updateStatus(sessionId, 'idle');
        } catch {
          // Readiness is advisory; the claim proceeds even if the transition is refused.
        }
      }
      try {
        const deadline = now() + request.blockMs;
        const nonBlockingRequest = { ...request, blockMs: 0 };
        let claimed = await options.claimInbox(sessionId, nonBlockingRequest);
        while (claimed.items.length === 0 && now() < deadline) {
          if (runtimeState() !== 'ready') {
            throw new ApplicationError(
              'RUNTIME_NOT_READY',
              'The runtime is not ready to wait for inbox work.',
              503,
            );
          }
          await delay(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
          claimed = await options.claimInbox(sessionId, nonBlockingRequest);
        }
        return claimed;
      } catch (error) {
        return repositoryError(error);
      }
    },

    async timeoutMessage(messageId, expectedDeadlineMs) {
      try {
        const message = await options.repository.getMessageById(messageId);
        if (message === null || terminalStates.has(message.state)) {
          return 'unchanged';
        }
        const result = await options.repository.transitionMessage('timed_out', {
          correlationId: message.correlationId,
          responderSessionId: '',
          workspaceId: options.workspaceId,
          eventId: createId(),
          expectedDeadlineMs,
        });
        return result.status === 'updated' ? 'timed_out' : 'unchanged';
      } catch (error) {
        return repositoryError(error);
      }
    },
  };
}
