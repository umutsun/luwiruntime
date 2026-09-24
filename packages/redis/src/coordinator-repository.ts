import { coordinatorSchema, type Coordinator, type RuntimeEvent } from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, hashRecord, type RedisCommandClient } from './runtime-repository.js';

/**
 * The per-project coordinator role (ADR 0035).
 *
 * Every transition goes through a Redis Function so the compare-and-set on the
 * monotonic `version`, the write, and the event append are one atomic step: two
 * sessions claiming the same vacant role at once must produce one grant and one
 * `version_conflict`, never two grants. The service (daemon) owns the policy of
 * who may take over from whom; this module owns only the atomic part.
 *
 * Redis data is untrusted on read (AGENTS.md section 7), so the stored record is
 * validated against `coordinatorSchema` before it leaves this module.
 */

export type ClaimCoordinatorResult =
  | { status: 'claimed'; version: number }
  /** A concurrent claim moved the version between the read and the CAS; retry. */
  | { status: 'version_conflict' };

export type ReleaseCoordinatorResult =
  | { status: 'released' }
  | { status: 'not_found' }
  | { status: 'not_holder'; heldBySessionId: string };

export interface CoordinatorRepository {
  getCoordinator(projectId: string): Promise<Coordinator | null>;
  claimCoordinator(input: {
    /** Carries the fresh `claimId` nonce the CAS stamps into the record. */
    record: Omit<Coordinator, 'version'>;
    /** `0` means "the key must not exist"; otherwise the stored version must match. */
    expectedVersion: number;
    /**
     * The incarnation the take-over was decided against; empty for a fresh grant.
     * The Function CASes on it so a version reset (release) cannot let a stale
     * take-over evict a newer holder.
     */
    expectedClaimId: string;
    event: RuntimeEvent;
  }): Promise<ClaimCoordinatorResult>;
  releaseCoordinator(input: {
    projectId: string;
    sessionId: string;
    event: RuntimeEvent;
  }): Promise<ReleaseCoordinatorResult>;
}

function invalid(detail: string): never {
  throw new RedisRepositoryError('REDIS_DATA_INVALID', `Redis coordinator ${detail} is invalid.`);
}

function decodeJsonReply(reply: unknown): Record<string, unknown> {
  if (typeof reply !== 'string') invalid('result');
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply) as unknown;
  } catch {
    invalid('result');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    invalid('result');
  }
  return parsed as Record<string, unknown>;
}

export function createCoordinatorRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
}): CoordinatorRepository {
  /** The three keys every coordinator function declares: the record, the two Streams. */
  const coordinatorKeys = (projectId: string): string[] => [
    options.keys.projectCoordinator(projectId),
    options.keys.globalEvents,
    options.keys.projectEvents(projectId),
  ];

  return {
    async getCoordinator(projectId) {
      const record = hashRecord(
        await options.client.sendCommand(['HGETALL', options.keys.projectCoordinator(projectId)]),
        'coordinator',
      );
      if (record === null) return null;
      const parsed = coordinatorSchema.safeParse(record);
      if (!parsed.success) invalid('record');
      return parsed.data;
    },

    async claimCoordinator(input) {
      const reply = decodeJsonReply(
        await options.client.sendCommand([
          'FCALL',
          options.functions.functions.coordinatorClaim,
          '3',
          ...coordinatorKeys(input.record.projectId),
          JSON.stringify(input.record),
          String(input.expectedVersion),
          JSON.stringify(input.event),
          input.expectedClaimId,
        ]),
      );

      if (reply.status === 'claimed') {
        if (typeof reply.version !== 'number') invalid('claim result');
        return { status: 'claimed', version: reply.version };
      }
      if (reply.code === 'VERSION_CONFLICT') return { status: 'version_conflict' };
      return invalid('claim result');
    },

    async releaseCoordinator(input) {
      const reply = decodeJsonReply(
        await options.client.sendCommand([
          'FCALL',
          options.functions.functions.coordinatorRelease,
          '3',
          ...coordinatorKeys(input.projectId),
          input.sessionId,
          JSON.stringify(input.event),
        ]),
      );

      if (reply.status === 'released') return { status: 'released' };
      if (reply.status === 'not_found') return { status: 'not_found' };
      if (reply.status === 'not_holder') {
        return {
          status: 'not_holder',
          heldBySessionId: typeof reply.heldBySessionId === 'string' ? reply.heldBySessionId : '',
        };
      }
      return invalid('release result');
    },
  };
}
