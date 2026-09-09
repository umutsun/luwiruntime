import { randomUUID } from 'node:crypto';

import type {
  NativeSessionBinding,
  NativeSessionLink,
  SessionView,
  WakeDispatchTarget,
  WakeIntentClaimBatchResponse,
  WakeIntentClaimRequest,
  WakeIntentCompleteRequest,
  WakeIntentCompleteResponse,
  WakeIntentDispatchingRequest,
  WakeIntentDispatchingResponse,
  WakeIntentListQuery,
  WakeIntentRecoverRequest,
  WakeIntentView,
} from '@luwi/protocol';
import { wakeIntentClaimBatchResponseSchema } from '@luwi/protocol';
import {
  RedisRepositoryError,
  type RedisCommandClient,
  type RedisKeys,
  type RuntimeRepository,
  type SweepWakeIntentsResult,
  type WakeClaimBatch,
  type WakeIntentRepository,
} from '@luwi/redis';
import { ApplicationError } from '@luwi/runtime';

/**
 * The private proof used to release a wake target. It never crosses a public
 * read boundary. `conflicted` records that the source/binding/link changed
 * while the evidence reader was taking its bounded snapshot.
 */
export type WakeDispatchObservation = {
  sourceSession: SessionView | null;
  reverseBindingId: string | null;
  binding: NativeSessionBinding | null;
  openLink: NativeSessionLink | null;
  hostWakeAdapter: unknown;
  hostWakeMcpSessionId: unknown;
  identityProvenanceSource: unknown;
  launcherInstanceId: unknown;
  conflicted: boolean;
};

export type WakeDispatchEvidence = {
  observe(sourceSessionId: string): Promise<WakeDispatchObservation>;
};

export type WakeDispatchResolution = { target: WakeDispatchTarget } | { refusalReasonCode: string };

const terminalSessionStates = new Set<SessionView['status']>(['completed', 'disconnected']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Releases the opaque vendor target only after every retained proof agrees on
 * this exact, live LUWI main session. Any incomplete or stale observation is
 * an inbox-only refusal; callers never infer a target from nearby history.
 */
export function resolveWakeDispatchTarget(
  observation: WakeDispatchObservation,
): WakeDispatchResolution {
  const session = observation.sourceSession;
  if (session === null || terminalSessionStates.has(session.status)) {
    return { refusalReasonCode: 'source_session_not_live' };
  }
  if (session.presence !== 'online') {
    return { refusalReasonCode: 'source_session_offline' };
  }
  if (observation.conflicted) {
    return { refusalReasonCode: 'native_binding_conflict' };
  }
  if (session.wakeCapable !== true || observation.hostWakeAdapter !== 'codex-queue-v1') {
    return { refusalReasonCode: 'adapter_mismatch' };
  }
  if (observation.hostWakeMcpSessionId !== session.id) {
    return { refusalReasonCode: 'mcp_session_mismatch' };
  }

  const reverseBindingId = observation.reverseBindingId;
  const binding = observation.binding;
  if (reverseBindingId === null || binding === null) {
    return { refusalReasonCode: 'native_binding_stale' };
  }
  if (binding.id !== reverseBindingId) {
    return { refusalReasonCode: 'native_binding_conflict' };
  }
  if (binding.trimmedLinkCount > 0) {
    return { refusalReasonCode: 'native_binding_trimmed' };
  }
  if (binding.kind !== 'main') {
    return { refusalReasonCode: 'native_subagent' };
  }
  if (binding.adapterId !== 'codex-native-v1') {
    return { refusalReasonCode: 'native_adapter_mismatch' };
  }

  const link = observation.openLink;
  if (
    binding.openLinkId === undefined ||
    link === null ||
    link.id !== binding.openLinkId ||
    link.bindingId !== binding.id ||
    link.sessionId !== session.id ||
    link.unlinkedAt !== undefined
  ) {
    return { refusalReasonCode: 'native_binding_stale' };
  }
  if (
    observation.identityProvenanceSource !== 'host_launcher' ||
    typeof observation.launcherInstanceId !== 'string' ||
    !identifierPattern.test(observation.launcherInstanceId)
  ) {
    return { refusalReasonCode: 'identity_untrusted' };
  }

  return {
    target: {
      adapter: 'codex-queue-v1',
      nativeSessionId: binding.nativeSessionId,
    },
  };
}

type PrivatePair = readonly [unknown, unknown];

function privatePair(value: unknown): PrivatePair {
  return Array.isArray(value) && value.length === 2 ? [value[0], value[1]] : [undefined, undefined];
}

function sameSession(left: SessionView | null, right: SessionView | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.status === right.status &&
    left.presence === right.presence &&
    left.lastHeartbeatAt === right.lastHeartbeatAt &&
    left.wakeCapable === right.wakeCapable
  );
}

function sameBinding(
  left: NativeSessionBinding | null,
  right: NativeSessionBinding | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.openLinkId === right.openLinkId &&
    left.trimmedLinkCount === right.trimmedLinkCount &&
    left.kind === right.kind &&
    left.adapterId === right.adapterId &&
    left.nativeSessionId === right.nativeSessionId
  );
}

function sameLink(left: NativeSessionLink | null, right: NativeSessionLink | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.id === right.id &&
    left.bindingId === right.bindingId &&
    left.sessionId === right.sessionId &&
    left.linkedAt === right.linkedAt &&
    left.unlinkedAt === right.unlinkedAt
  );
}

/**
 * Reads the private fields that the public runtime repository intentionally
 * redacts. A second pass detects evidence rotation during resolution and turns
 * it into an inbox-only conflict instead of releasing a mixed snapshot.
 */
export function createRedisWakeDispatchEvidence(options: {
  repository: RuntimeRepository;
  client: RedisCommandClient;
  keys: RedisKeys;
}): WakeDispatchEvidence {
  const readHostWake = (sessionId: string) =>
    options.client.sendCommand([
      'HMGET',
      options.keys.session(sessionId),
      'hostWakeAdapter',
      'hostWakeMcpSessionId',
    ]);
  const readProvenance = (linkId: string) =>
    options.client.sendCommand([
      'HMGET',
      options.keys.nativeSessionLink(linkId),
      'identityProvenanceSource',
      'launcherInstanceId',
    ]);

  return {
    async observe(sourceSessionId) {
      const [firstSession, firstReverseBindingId, firstHostRaw] = await Promise.all([
        options.repository.getSession(sourceSessionId),
        options.repository.getSessionNativeBindingId(sourceSessionId),
        readHostWake(sourceSessionId),
      ]);
      const firstBinding =
        firstReverseBindingId === null
          ? null
          : await options.repository.getNativeBinding(firstReverseBindingId);
      const firstLink =
        firstBinding?.openLinkId === undefined
          ? null
          : await options.repository.getNativeLink(firstBinding.openLinkId);
      const firstProvenanceRaw =
        firstLink === null ? [undefined, undefined] : await readProvenance(firstLink.id);

      const [session, reverseBindingId, hostRaw] = await Promise.all([
        options.repository.getSession(sourceSessionId),
        options.repository.getSessionNativeBindingId(sourceSessionId),
        readHostWake(sourceSessionId),
      ]);
      const binding =
        reverseBindingId === null
          ? null
          : await options.repository.getNativeBinding(reverseBindingId);
      const openLink =
        binding?.openLinkId === undefined
          ? null
          : await options.repository.getNativeLink(binding.openLinkId);
      const provenanceRaw =
        openLink === null ? [undefined, undefined] : await readProvenance(openLink.id);
      const [hostWakeAdapter, hostWakeMcpSessionId] = privatePair(hostRaw);
      const [identityProvenanceSource, launcherInstanceId] = privatePair(provenanceRaw);

      return {
        sourceSession: session,
        reverseBindingId,
        binding,
        openLink,
        hostWakeAdapter,
        hostWakeMcpSessionId,
        identityProvenanceSource,
        launcherInstanceId,
        conflicted:
          !sameSession(firstSession, session) ||
          firstReverseBindingId !== reverseBindingId ||
          !sameBinding(firstBinding, binding) ||
          !sameLink(firstLink, openLink) ||
          JSON.stringify(privatePair(firstHostRaw)) !== JSON.stringify(privatePair(hostRaw)) ||
          JSON.stringify(privatePair(firstProvenanceRaw)) !==
            JSON.stringify(privatePair(provenanceRaw)),
      };
    },
  };
}

export type WakeIntentService = {
  list(query?: Partial<WakeIntentListQuery>): Promise<WakeIntentView[]>;
  claim(request: WakeIntentClaimRequest): Promise<WakeIntentClaimBatchResponse>;
  reclaim(request: WakeIntentRecoverRequest): Promise<WakeIntentClaimBatchResponse>;
  recover(request: WakeIntentRecoverRequest): Promise<WakeIntentClaimBatchResponse>;
  markDispatching(
    intentId: string,
    request: WakeIntentDispatchingRequest,
  ): Promise<WakeIntentDispatchingResponse>;
  complete(
    intentId: string,
    request: WakeIntentCompleteRequest,
  ): Promise<WakeIntentCompleteResponse>;
  sweep(limit: number): Promise<SweepWakeIntentsResult>;
};

function repositoryError(error: unknown): never {
  if (!(error instanceof RedisRepositoryError) || error.code === 'REDIS_UNAVAILABLE') {
    throw error;
  }
  const mapping: Record<string, { statusCode: number; message: string }> = {
    REDIS_ARGUMENT_INVALID: { statusCode: 400, message: 'The wake request is invalid.' },
    WAKE_INTENT_NOT_FOUND: { statusCode: 404, message: 'The wake intent was not found.' },
    WAKE_FENCE_MISMATCH: { statusCode: 409, message: 'The wake ownership fence changed.' },
    WAKE_TRANSITION_INVALID: {
      statusCode: 409,
      message: 'The wake intent cannot make the requested transition.',
    },
    WAKE_TERMINAL: { statusCode: 409, message: 'The wake intent is already terminal.' },
  };
  const mapped = mapping[error.code];
  if (mapped === undefined) throw error;
  throw new ApplicationError(error.code, mapped.message, mapped.statusCode);
}

export function createWakeIntentService(options: {
  repository: WakeIntentRepository;
  claimRepository: WakeIntentRepository;
  evidence: WakeDispatchEvidence;
  createId?: () => string;
  now?: () => number;
}): WakeIntentService {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;

  const resolveBatch = async (batch: WakeClaimBatch): Promise<WakeIntentClaimBatchResponse> =>
    wakeIntentClaimBatchResponseSchema.parse({
      items: await Promise.all(
        batch.items.map(async ({ intent, claimId }) => ({
          intent,
          claimId,
          ...resolveWakeDispatchTarget(await options.evidence.observe(intent.sourceSessionId)),
        })),
      ),
      recoveredDispatching: batch.recoveredDispatching,
      terminalAcknowledged: batch.terminalAcknowledged,
    });

  const reclaim = async (
    request: WakeIntentRecoverRequest,
  ): Promise<WakeIntentClaimBatchResponse> => {
    try {
      return await resolveBatch(await options.repository.reclaim(request));
    } catch (error) {
      return repositoryError(error);
    }
  };

  const requireIntent = async (intentId: string): Promise<void> => {
    let intent: WakeIntentView | null;
    try {
      intent = await options.repository.get(intentId);
    } catch (error) {
      return repositoryError(error);
    }
    if (intent === null) {
      throw new ApplicationError('WAKE_INTENT_NOT_FOUND', 'The wake intent was not found.', 404);
    }
  };

  return {
    async list(query = {}) {
      try {
        return await options.repository.list(query);
      } catch (error) {
        return repositoryError(error);
      }
    },

    async claim(request) {
      try {
        return await resolveBatch(
          await options.claimRepository.claim({
            dispatcherInstanceId: request.dispatcherInstanceId,
            limit: request.limit,
            blockMs: request.blockMs,
          }),
        );
      } catch (error) {
        return repositoryError(error);
      }
    },

    reclaim,
    recover: reclaim,

    async markDispatching(intentId, request) {
      await requireIntent(intentId);
      try {
        const result = await options.repository.markDispatching({
          intentId,
          ...request,
          eventId: createId(),
        });
        return result as WakeIntentDispatchingResponse;
      } catch (error) {
        return repositoryError(error);
      }
    },

    async complete(intentId, request) {
      await requireIntent(intentId);
      try {
        const result = await options.repository.complete({
          intentId,
          ...request,
          eventId: createId(),
        });
        return result as WakeIntentCompleteResponse;
      } catch (error) {
        return repositoryError(error);
      }
    },

    async sweep(limit) {
      try {
        return await options.repository.sweep({ nowMs: now(), limit });
      } catch (error) {
        return repositoryError(error);
      }
    },
  };
}
