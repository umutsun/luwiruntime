import { randomUUID } from 'node:crypto';

import {
  LEASE_MAX_ACTIVE_PER_PROJECT,
  LeasePathError,
  createRuntimeEvent,
  normalizeLeasePath,
  type LeaseConflict,
  type RuntimeEvent,
  type WorkLease,
} from '@luwi/protocol';
import type { LeaseRepository } from '@luwi/redis';
import { ApplicationError, type ExpireLeaseResult } from '@luwi/runtime';

import type { SessionService } from './session-service.js';

/**
 * Advisory work leases.
 *
 * The service owns the policy the Redis Function deliberately does not: which
 * session may hold a lease at all, what a denial means to the caller, and the
 * timestamps. The Function owns only the part that has to be atomic.
 */

export type AcquireLeaseOutcome =
  { status: 'granted'; lease: WorkLease } | { status: 'denied'; conflict: LeaseConflict };

export type LeaseService = {
  acquire(input: {
    projectId: string;
    sessionId: string;
    path: string;
    reason: string;
    durationMs: number;
  }): Promise<AcquireLeaseOutcome>;
  renew(leaseId: string, sessionId: string, durationMs: number): Promise<WorkLease>;
  release(leaseId: string, sessionId: string): Promise<WorkLease>;
  get(leaseId: string): Promise<WorkLease>;
  list(query: { projectId?: string; sessionId?: string; limit: number }): Promise<WorkLease[]>;
  /** Used by the background sweep; never by an HTTP caller. */
  expire(leaseId: string): Promise<ExpireLeaseResult>;
  /**
   * Expires every lease a now-terminal session still holds, best-effort, and
   * returns how many were expired. This is the runtime's own (holder-less)
   * transition, invoked when a session goes terminal so its leases do not sit
   * under a dead holder — blocking overlaps and unreleasable by the successor —
   * until the deadline sweep reaches them. The sweep stays the backstop for any
   * lease this could not expire, so a single failure never aborts the rest.
   */
  releaseForSession(sessionId: string): Promise<number>;
  findDueLeases(nowMs: number, limit: number): Promise<string[]>;
};

const ID_RETRIES = 3;

export function createLeaseService(options: {
  repository: LeaseRepository;
  sessions: SessionService;
  workspaceId: string;
  now?: () => Date;
  createId?: () => string;
}): LeaseService {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  const event = (
    type: 'lease.acquired' | 'lease.denied' | 'lease.renewed' | 'lease.released' | 'lease.expired',
    lease: Pick<WorkLease, 'id' | 'projectId' | 'sessionId' | 'agentId' | 'path'>,
    extra: Record<string, string> = {},
  ): RuntimeEvent =>
    createRuntimeEvent({
      type,
      workspaceId: options.workspaceId,
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      agentId: lease.agentId,
      payload: { leaseId: lease.id, path: lease.path, ...extra },
    });

  const requireLease = async (leaseId: string): Promise<WorkLease> => {
    const lease = await options.repository.getLease(leaseId);
    if (lease === null) {
      throw new ApplicationError('LEASE_NOT_FOUND', 'Work lease not found.', 404);
    }
    return lease;
  };

  // Re-reads the lease before expiring it so a holder that released between the
  // scan and here is left alone rather than expired twice. Shared by the
  // deadline sweep (`expire`) and by session-terminal release.
  const expireHeldLease = async (leaseId: string): Promise<ExpireLeaseResult> => {
    const current = await options.repository.getLease(leaseId);
    if (current === null || current.state !== 'held') return 'unchanged';
    const updated: WorkLease = { ...current, state: 'expired' };
    const result = await options.repository.expireLease({
      lease: updated,
      event: event('lease.expired', updated),
    });
    return result.status === 'updated' ? 'expired' : 'unchanged';
  };

  return {
    async acquire(input) {
      let normalized;
      try {
        normalized = normalizeLeasePath(input.path);
      } catch (error) {
        if (error instanceof LeasePathError) {
          throw new ApplicationError('LEASE_PATH_INVALID', error.message, 400);
        }
        throw error;
      }

      // A lease belongs to a session, so the session has to exist and be able
      // to hold one. A lease outliving its holder is the failure mode that
      // makes advisory locking useless.
      const session = await options.sessions.get(input.sessionId);
      if (session === null) {
        throw new ApplicationError(
          'LEASE_SESSION_NOT_FOUND',
          'A work lease requires a registered session to hold it.',
          404,
        );
      }
      if (session.projectId !== input.projectId) {
        throw new ApplicationError(
          'LEASE_SESSION_PROJECT_MISMATCH',
          'A session can only hold leases in its own project.',
          409,
        );
      }
      /**
       * Only a completed session is refused. A missed heartbeat has not yet
       * changed the status here, so refusing on it would hand the path away the
       * instant a beat ran late. When the presence sweeper does mark a lapsed
       * session `disconnected`, it releases that session's leases with it (P12),
       * so a gone holder stops blocking at once rather than at its deadline.
       */
      if (session.status === 'completed') {
        throw new ApplicationError(
          'LEASE_SESSION_NOT_ACTIVE',
          'A completed session cannot hold a work lease.',
          409,
        );
      }

      const acquiredAt = now();
      const expiresAt = new Date(acquiredAt.getTime() + input.durationMs);

      for (let attempt = 0; attempt < ID_RETRIES; attempt += 1) {
        const lease: WorkLease = {
          id: createId(),
          projectId: input.projectId,
          sessionId: input.sessionId,
          agentId: session.agentId,
          path: normalized.path,
          matchPath: normalized.matchPath,
          reason: input.reason,
          state: 'held',
          acquiredAt: acquiredAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };

        const result = await options.repository.acquireLease({
          lease,
          grantedEvent: event('lease.acquired', lease, { reason: lease.reason }),
          deniedEvent: event('lease.denied', lease, { reason: lease.reason }),
          nowMs: acquiredAt.getTime(),
          expiresMs: expiresAt.getTime(),
        });

        if (result.status === 'granted') return { status: 'granted', lease: result.lease };
        if (result.status === 'denied') return { status: 'denied', conflict: result.conflict };
        if (result.status === 'limit_reached') {
          throw new ApplicationError(
            'LEASE_LIMIT_REACHED',
            `A project may hold at most ${String(LEASE_MAX_ACTIVE_PER_PROJECT)} leases at once.`,
            409,
          );
        }
        // `id_conflict` only happens if the generated identifier already
        // exists, which is a retry and not a caller error.
      }

      throw new ApplicationError(
        'LEASE_ID_UNAVAILABLE',
        'Could not allocate a lease identifier.',
        500,
      );
    },

    async renew(leaseId, sessionId, durationMs) {
      const current = await requireLease(leaseId);
      const renewedAt = now();
      const expiresAt = new Date(renewedAt.getTime() + durationMs);
      const updated: WorkLease = {
        ...current,
        expiresAt: expiresAt.toISOString(),
        renewedAt: renewedAt.toISOString(),
      };

      const result = await options.repository.renewLease({
        lease: updated,
        event: event('lease.renewed', updated),
        holderSessionId: sessionId,
        expiresMs: expiresAt.getTime(),
      });

      if (result.status === 'updated') return result.lease;
      if (result.status === 'not_found') {
        throw new ApplicationError('LEASE_NOT_FOUND', 'Work lease not found.', 404);
      }
      if (result.status === 'not_holder') {
        throw new ApplicationError(
          'LEASE_NOT_HELD_BY_SESSION',
          'Only the holding session can renew this lease.',
          409,
        );
      }
      throw new ApplicationError(
        'LEASE_NOT_HELD',
        `This lease is already ${result.lease.state}.`,
        409,
      );
    },

    async release(leaseId, sessionId) {
      const current = await requireLease(leaseId);
      const releasedAt = now();
      const updated: WorkLease = {
        ...current,
        state: 'released',
        releasedAt: releasedAt.toISOString(),
      };

      const result = await options.repository.releaseLease({
        lease: updated,
        event: event('lease.released', updated),
        holderSessionId: sessionId,
      });

      if (result.status === 'updated') return result.lease;
      if (result.status === 'not_found') {
        throw new ApplicationError('LEASE_NOT_FOUND', 'Work lease not found.', 404);
      }
      if (result.status === 'not_holder') {
        throw new ApplicationError(
          'LEASE_NOT_HELD_BY_SESSION',
          'Only the holding session can release this lease.',
          409,
        );
      }
      throw new ApplicationError(
        'LEASE_NOT_HELD',
        `This lease is already ${result.lease.state}.`,
        409,
      );
    },

    get: requireLease,

    async list(query) {
      if (query.sessionId !== undefined) {
        return options.repository.listSessionLeases(query.sessionId, query.limit);
      }
      if (query.projectId !== undefined) {
        return options.repository.listProjectLeases(query.projectId, query.limit);
      }
      // Without a scope there is nothing bounded to read: leases are indexed by
      // project and by session, and no global index exists on purpose.
      throw new ApplicationError(
        'LEASE_SCOPE_REQUIRED',
        'Listing leases requires a projectId or a sessionId.',
        400,
      );
    },

    expire: expireHeldLease,

    async releaseForSession(sessionId) {
      // A session holds leases only in its own project, so its held set is
      // bounded by the per-project cap.
      const leases = await options.repository.listSessionLeases(
        sessionId,
        LEASE_MAX_ACTIVE_PER_PROJECT,
      );
      let expired = 0;
      for (const lease of leases) {
        try {
          if ((await expireHeldLease(lease.id)) === 'expired') expired += 1;
        } catch {
          // Best-effort: the deadline sweep is the backstop for anything left.
        }
      }
      return expired;
    },

    findDueLeases: (nowMs, limit) => options.repository.findDueLeaseDeadlines(nowMs, limit),
  };
}
