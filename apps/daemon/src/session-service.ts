import { randomUUID } from 'node:crypto';

import {
  canonicalJsonStringify,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type SessionRegistrationRequest,
  type SessionStatusTarget,
  type SessionView,
} from '@luwi/protocol';
import type { RuntimeRepository } from '@luwi/redis';
import { ApplicationError, canonicalizeWorkingDirectory, type CanonicalPath } from '@luwi/runtime';

export type SessionService = {
  register(request: SessionRegistrationRequest): Promise<SessionView>;
  get(sessionId: string): Promise<SessionView | null>;
  list(projectId?: string): Promise<SessionView[]>;
  updateStatus(sessionId: string, targetStatus: SessionStatusTarget): Promise<SessionView>;
  heartbeat(sessionId: string, request: HeartbeatRequest): Promise<HeartbeatResponse>;
  close(sessionId: string): Promise<SessionView>;
};

export type SessionServiceOptions = {
  repository: RuntimeRepository;
  workspaceId: string;
  presenceTtlMs: number;
  heartbeatEventIntervalMs?: number;
  createId?: () => string;
  canonicalizeWorkingDirectory?: (input: string) => Promise<CanonicalPath>;
};

function sessionNotFound(): ApplicationError {
  return new ApplicationError('SESSION_NOT_FOUND', 'The session was not found.', 404);
}

async function requireSession(
  repository: RuntimeRepository,
  sessionId: string,
): Promise<SessionView> {
  const session = await repository.getSession(sessionId);
  if (session === null) {
    throw sessionNotFound();
  }
  return session;
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const createId = options.createId ?? randomUUID;
  const canonicalize = options.canonicalizeWorkingDirectory ?? canonicalizeWorkingDirectory;
  const heartbeatEventIntervalMs = options.heartbeatEventIntervalMs ?? 30_000;

  return {
    async register(request) {
      if ((await options.repository.getProject(request.projectId)) === null) {
        throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
      }
      const workingDirectory = await canonicalize(request.workingDirectory);
      const worktree =
        request.worktreePath === undefined ? undefined : await canonicalize(request.worktreePath);
      const sessionId = createId();
      const result = await options.repository.registerSession({
        session: {
          id: sessionId,
          agentId: request.agentId,
          projectId: request.projectId,
          status: 'starting',
          workingDirectory: workingDirectory.canonicalPath,
          metadataJson: canonicalJsonStringify(request.metadata),
          ...(request.taskSummary === undefined ? {} : { taskSummary: request.taskSummary }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
          ...(worktree === undefined ? {} : { worktreePath: worktree.canonicalPath }),
        },
        workspaceId: options.workspaceId,
        eventId: createId(),
        presenceTtlMs: options.presenceTtlMs,
      });
      if (result.status === 'not_found') {
        throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
      }
      return requireSession(options.repository, sessionId);
    },

    get: (sessionId) => options.repository.getSession(sessionId),
    list: (projectId) => options.repository.listSessions(projectId),

    async updateStatus(sessionId, targetStatus) {
      const session = await requireSession(options.repository, sessionId);
      const result = await options.repository.updateSessionStatus({
        sessionId,
        projectId: session.projectId,
        targetStatus,
        workspaceId: options.workspaceId,
        eventId: createId(),
      });
      if (result.status === 'not_found') {
        throw sessionNotFound();
      }
      if (result.status === 'terminal') {
        throw new ApplicationError(
          'SESSION_TERMINAL',
          'The session is already in a terminal state.',
          409,
        );
      }
      if (result.status === 'invalid_transition') {
        throw new ApplicationError(
          'SESSION_TRANSITION_INVALID',
          'The requested session status transition is invalid.',
          409,
        );
      }
      return requireSession(options.repository, sessionId);
    },

    async heartbeat(sessionId, request) {
      const session = await requireSession(options.repository, sessionId);
      const result = await options.repository.heartbeatSession({
        sessionId,
        projectId: session.projectId,
        workspaceId: options.workspaceId,
        eventId: createId(),
        presenceTtlMs: options.presenceTtlMs,
        eventIntervalMs: heartbeatEventIntervalMs,
        ...(request.metadata === undefined
          ? {}
          : { metadataJson: canonicalJsonStringify(request.metadata) }),
      });
      if (result.status === 'not_found') {
        throw sessionNotFound();
      }
      if (result.status === 'terminal') {
        throw new ApplicationError(
          'SESSION_TERMINAL',
          'The session is already in a terminal state.',
          409,
        );
      }
      return {
        status: 'renewed',
        eventEmitted: result.eventEmitted,
      };
    },

    async close(sessionId) {
      const session = await requireSession(options.repository, sessionId);
      const result = await options.repository.closeSession({
        sessionId,
        projectId: session.projectId,
        workspaceId: options.workspaceId,
        eventId: createId(),
      });
      if (result.status === 'not_found') {
        throw sessionNotFound();
      }
      return requireSession(options.repository, sessionId);
    },
  };
}
