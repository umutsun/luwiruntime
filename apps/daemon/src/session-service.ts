import { randomUUID } from 'node:crypto';

import {
  canonicalJsonStringify,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type NativeDeclarationResponse,
  type NativeSessionBinding,
  type NativeSessionLink,
  type NativeSessionRef,
  type SessionRegistrationRequest,
  type SessionStatusTarget,
  type SessionView,
} from '@luwi/protocol';
import type { NativeRegistrationInput, NativeUnlinkInput, RuntimeRepository } from '@luwi/redis';
import {
  ApplicationError,
  canonicalizeWorkingDirectory,
  deriveNativeBindingId,
  deriveNativeKind,
  deriveNativeLinkId,
  deriveParentRef,
  evaluateNativeDeclaration,
  NATIVE_DECLARATION_MAX_ATTEMPTS,
  type CanonicalPath,
  type NativeDeclarationDecision,
  type NativeOpenLinkObservation,
} from '@luwi/runtime';

/**
 * Exported so the presence sweeper maps contention the same way. Two copies of
 * this predicate would be two chances for one of them to stop matching what the
 * repository actually throws.
 */
export function isVersionConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'VERSION_CONFLICT'
  );
}

function nativeConflict(): ApplicationError {
  return new ApplicationError(
    'NATIVE_SESSION_CONFLICT',
    'Another live session already holds this native session reference.',
    409,
  );
}

function nativeInconsistent(): ApplicationError {
  return new ApplicationError(
    'NATIVE_BINDING_INCONSISTENT',
    'The native session binding names an open link that cannot be read.',
    409,
  );
}

type NativeBindingObservation = {
  bindingId: string;
  binding: NativeSessionBinding | undefined;
  /** The validated record behind `binding.openLinkId`, when one could be read. */
  openLinkRecord: NativeSessionLink | undefined;
  openLink: NativeOpenLinkObservation | undefined;
};

/**
 * The binding and its open link are read here rather than inside Lua, because a
 * Redis Function may not derive another session's key name. The pure policy in
 * `@luwi/runtime` turns this observation into one outcome; the Function only
 * verifies the observation still holds.
 */
async function observeNativeBinding(
  repository: RuntimeRepository,
  ref: NativeSessionRef,
): Promise<NativeBindingObservation> {
  const bindingId = deriveNativeBindingId(ref);
  const binding = (await repository.getNativeBinding(bindingId)) ?? undefined;
  let openLinkRecord: NativeSessionLink | undefined;
  let openLink: NativeOpenLinkObservation | undefined;
  if (binding?.openLinkId !== undefined) {
    const link = await repository.getNativeLink(binding.openLinkId);
    /**
     * The record read at `openLinkId` must actually be that link, and must
     * belong to this binding. A record that contradicts the pointer is not a
     * free reference: it is the same loss of evidence `inconsistent` exists
     * for, and leaving `openLink` undefined is what reports it.
     */
    if (
      link !== null &&
      link.id === binding.openLinkId &&
      link.bindingId === bindingId &&
      link.unlinkedAt === undefined
    ) {
      const linked = await repository.getSession(link.sessionId);
      if (linked !== null) {
        openLinkRecord = link;
        openLink = { id: link.id, sessionId: link.sessionId, sessionStatus: linked.status };
      }
    }
  }
  return { bindingId, binding, openLinkRecord, openLink };
}

/** Shapes the payload the Function will verify, for a decision that writes. */
function buildNativeDeclaration(
  decision: Extract<NativeDeclarationDecision, { outcome: 'created' | 'linked' }>,
  ref: NativeSessionRef,
  bindingId: string,
  sessionId: string,
  eventIds: { linked: string; unlinked: string },
): NativeRegistrationInput {
  const linkId = deriveNativeLinkId(bindingId, sessionId);
  const parentRef = deriveParentRef(ref);
  return {
    bindingId,
    linkId,
    ...(decision.staleLinkId === undefined ? {} : { staleLinkId: decision.staleLinkId }),
    linkedEventId: eventIds.linked,
    ...(decision.staleLinkId === undefined ? {} : { unlinkedEventId: eventIds.unlinked }),
    payload: {
      bindingId,
      expectedVersion: decision.expectedVersion,
      ...(decision.expectedOpenLinkId === undefined
        ? {}
        : { expectedOpenLinkId: decision.expectedOpenLinkId }),
      ...(decision.staleLinkId === undefined ? {} : { staleLinkId: decision.staleLinkId }),
      link: { id: linkId, sessionId },
      ...(decision.outcome === 'created'
        ? {
            binding: {
              id: bindingId,
              adapterId: ref.adapterId,
              nativeSessionId: ref.nativeSessionId,
              ...(ref.nativeSubagentId === undefined
                ? {}
                : { nativeSubagentId: ref.nativeSubagentId }),
              kind: deriveNativeKind(ref),
              ...(parentRef === undefined ? {} : { parentRefJson: JSON.stringify(parentRef) }),
            },
          }
        : {}),
    },
  };
}

async function planNativeDeclaration(
  repository: RuntimeRepository,
  ref: NativeSessionRef,
  sessionId: string,
  eventIds: { linked: string; unlinked: string },
): Promise<NativeRegistrationInput> {
  const observed = await observeNativeBinding(repository, ref);
  const decision = evaluateNativeDeclaration({
    binding: observed.binding,
    openLink: observed.openLink,
    sessionId,
  });
  if (decision.outcome === 'conflict') {
    throw nativeConflict();
  }
  if (decision.outcome === 'inconsistent') {
    throw nativeInconsistent();
  }
  /**
   * Unreachable during registration, because the session id is new and no open
   * link can already name it. Refused rather than ignored, so the declaration
   * surface below stays the only path that treats it as a result.
   */
  if (decision.outcome === 'unchanged') {
    throw new ApplicationError(
      'NATIVE_BINDING_INCONSISTENT',
      'The native session binding already names this session.',
      409,
    );
  }
  return buildNativeDeclaration(decision, ref, observed.bindingId, sessionId, eventIds);
}

/**
 * Fail-closed. No reverse index means no binding, and the unchanged 5-key path
 * is correct. But once the reverse index exists the evidence must be complete:
 * falling back on partial evidence would complete the session while abandoning
 * an open link, which is the loss this refusal exists to prevent.
 */
async function resolveNativeUnlink(
  repository: RuntimeRepository,
  sessionId: string,
  unlinkedEventId: string,
): Promise<NativeUnlinkInput | undefined> {
  const bindingId = await repository.getSessionNativeBindingId(sessionId);
  if (bindingId === null) return undefined;

  const inconsistent = (): never => {
    throw new ApplicationError(
      'NATIVE_BINDING_INCONSISTENT',
      'The native session binding for this session cannot be resolved.',
      409,
    );
  };

  const binding = await repository.getNativeBinding(bindingId);
  if (binding === null) return inconsistent();
  const openLinkId = binding.openLinkId;
  if (openLinkId === undefined) return inconsistent();

  const link = await repository.getNativeLink(openLinkId);
  if (
    link === null ||
    link.id !== openLinkId ||
    link.bindingId !== bindingId ||
    link.sessionId !== sessionId ||
    link.unlinkedAt !== undefined
  ) {
    return inconsistent();
  }

  return {
    bindingId,
    linkId: link.id,
    expectedVersion: binding.version,
    expectedOpenLinkId: openLinkId,
    unlinkedEventId,
  };
}

export type SessionService = {
  register(request: SessionRegistrationRequest): Promise<SessionView>;
  declareNative(sessionId: string, ref: NativeSessionRef): Promise<NativeDeclarationResponse>;
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
  onRegistered?: (session: SessionView) => void;
  onClosed?: (session: SessionView) => void;
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
      /**
       * The session id and every event id are minted once, before the loop, and
       * reused on every attempt. Minting fresh ids on a retry would append a
       * second registration event for the same registration if an earlier
       * attempt had in fact succeeded unobserved.
       */
      const sessionId = createId();
      const registrationEventId = createId();
      const linkedEventId = createId();
      const unlinkedEventId = createId();
      const bridgeAttachedEventId = request.bridgeOwner === undefined ? undefined : createId();
      const session = {
        id: sessionId,
        agentId: request.agentId,
        projectId: request.projectId,
        status: 'starting' as const,
        workingDirectory: workingDirectory.canonicalPath,
        metadataJson: canonicalJsonStringify(request.metadata),
        ...(request.taskSummary === undefined ? {} : { taskSummary: request.taskSummary }),
        ...(request.branch === undefined ? {} : { branch: request.branch }),
        ...(worktree === undefined ? {} : { worktreePath: worktree.canonicalPath }),
      };

      for (let attempt = 1; attempt <= NATIVE_DECLARATION_MAX_ATTEMPTS; attempt += 1) {
        const native =
          request.native === undefined
            ? undefined
            : await planNativeDeclaration(options.repository, request.native, sessionId, {
                linked: linkedEventId,
                unlinked: unlinkedEventId,
              });

        try {
          const result = await options.repository.registerSession({
            session,
            workspaceId: options.workspaceId,
            eventId: registrationEventId,
            presenceTtlMs: options.presenceTtlMs,
            ...(native === undefined ? {} : { native }),
            ...(request.bridgeOwner === undefined
              ? {}
              : {
                  bridgeOwner: request.bridgeOwner,
                  bridgeAttachedEventId: bridgeAttachedEventId!,
                }),
          });
          if (result.status === 'bridge_slot_not_owner') {
            throw new ApplicationError(
              'BRIDGE_SLOT_NOT_OWNER',
              'The bridge slot ownership is no longer valid.',
              409,
            );
          }
          if (result.status === 'reserved_metadata_rejected') {
            throw new ApplicationError(
              'RESERVED_METADATA_REJECTED',
              'Session metadata contains reserved bridge fields.',
              409,
            );
          }
          if (result.status === 'not_found') {
            throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
          }
          const registered = await requireSession(options.repository, sessionId);
          options.onRegistered?.(registered);
          return registered;
        } catch (error) {
          // A third VERSION_CONFLICT must not escape as a raw repository error,
          // which a caller would see as a 500 for what is a refusal.
          if (!isVersionConflict(error)) throw error;
        }
      }

      throw new ApplicationError(
        'NATIVE_BINDING_CONTENDED',
        'The native session binding changed while it was being declared.',
        409,
      );
    },

    /**
     * B0's declaration surface for an already-registered, live session. The
     * same policy that decides at registration decides here, unchanged;
     * `unchanged` is the one outcome this surface returns instead of refusing,
     * because re-declaration is the steady state for anything that declares at
     * startup or on a timer.
     */
    async declareNative(sessionId, ref) {
      const session = await requireSession(options.repository, sessionId);
      if (session.status === 'completed' || session.status === 'disconnected') {
        throw new ApplicationError(
          'SESSION_TERMINAL',
          'The session is already in a terminal state.',
          409,
        );
      }
      // Minted once and reused on every attempt, so a retry after an
      // unobserved success cannot link a second time.
      const linkedEventId = createId();
      const unlinkedEventId = createId();

      for (let attempt = 1; attempt <= NATIVE_DECLARATION_MAX_ATTEMPTS; attempt += 1) {
        const observed = await observeNativeBinding(options.repository, ref);
        const decision = evaluateNativeDeclaration({
          binding: observed.binding,
          openLink: observed.openLink,
          sessionId,
        });
        if (decision.outcome === 'conflict') {
          throw nativeConflict();
        }
        if (decision.outcome === 'inconsistent') {
          throw nativeInconsistent();
        }
        if (decision.outcome === 'unchanged') {
          // Defined whenever the policy says unchanged; refusing the
          // impossible alternative keeps this fail-closed rather than assumed.
          if (observed.binding === undefined || observed.openLinkRecord === undefined) {
            throw nativeInconsistent();
          }
          return { outcome: 'unchanged', binding: observed.binding, link: observed.openLinkRecord };
        }

        const native = buildNativeDeclaration(decision, ref, observed.bindingId, sessionId, {
          linked: linkedEventId,
          unlinked: unlinkedEventId,
        });
        try {
          const result = await options.repository.declareNativeSession({
            sessionId,
            projectId: session.projectId,
            workspaceId: options.workspaceId,
            native,
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
            outcome: result.native.transition,
            binding: result.native.binding,
            link: result.native.link,
            ...(result.native.staleLink === undefined
              ? {}
              : { staleLink: result.native.staleLink }),
          };
        } catch (error) {
          if (!isVersionConflict(error)) throw error;
        }
      }

      throw new ApplicationError(
        'NATIVE_BINDING_CONTENDED',
        'The native session binding changed while it was being declared.',
        409,
      );
    },

    get: (sessionId) => options.repository.getSession(sessionId),
    list: (projectId) => options.repository.listSessions(projectId),

    async updateStatus(sessionId, targetStatus) {
      const session = await requireSession(options.repository, sessionId);
      const eventId = createId();
      const unlinkedEventId = createId();
      let result: Awaited<ReturnType<RuntimeRepository['updateSessionStatus']>> | undefined;

      for (let attempt = 1; attempt <= NATIVE_DECLARATION_MAX_ATTEMPTS; attempt += 1) {
        // Only `completed` is terminal here, and it is the path that would
        // otherwise leave an open link behind.
        const native =
          targetStatus === 'completed'
            ? await resolveNativeUnlink(options.repository, sessionId, unlinkedEventId)
            : undefined;
        try {
          result = await options.repository.updateSessionStatus({
            sessionId,
            projectId: session.projectId,
            targetStatus,
            workspaceId: options.workspaceId,
            eventId,
            ...(native === undefined ? {} : { native }),
          });
          break;
        } catch (error) {
          if (!isVersionConflict(error)) throw error;
        }
      }

      if (result === undefined) {
        throw new ApplicationError(
          'NATIVE_BINDING_CONTENDED',
          'The native session binding changed while the session status was changing.',
          409,
        );
      }
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
      if (result.status === 'reserved_metadata_rejected') {
        throw new ApplicationError(
          'RESERVED_METADATA_REJECTED',
          'Session metadata contains reserved bridge fields.',
          409,
        );
      }
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
      const eventId = createId();
      const unlinkedEventId = createId();

      for (let attempt = 1; attempt <= NATIVE_DECLARATION_MAX_ATTEMPTS; attempt += 1) {
        const native = await resolveNativeUnlink(options.repository, sessionId, unlinkedEventId);
        try {
          const result = await options.repository.closeSession({
            sessionId,
            projectId: session.projectId,
            workspaceId: options.workspaceId,
            eventId,
            ...(native === undefined ? {} : { native }),
          });
          if (result.status === 'not_found') {
            throw sessionNotFound();
          }
          const closed = await requireSession(options.repository, sessionId);
          options.onClosed?.(closed);
          return closed;
        } catch (error) {
          if (!isVersionConflict(error)) throw error;
        }
      }

      throw new ApplicationError(
        'NATIVE_BINDING_CONTENDED',
        'The native session binding changed while the session was closing.',
        409,
      );
    },
  };
}
