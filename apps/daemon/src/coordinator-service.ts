import { randomUUID } from 'node:crypto';

import {
  createRuntimeEvent,
  type Coordinator,
  type CoordinatorView,
  type RuntimeEvent,
  type SessionStatus,
} from '@luwi/protocol';
import type { CoordinatorRepository } from '@luwi/redis';
import {
  COORDINATOR_CLAIM_MAX_ATTEMPTS,
  ApplicationError,
  evaluateCoordinatorClaim,
} from '@luwi/runtime';

import type { SessionService } from './session-service.js';

/**
 * The per-project coordinator role (ADR 0035): the single session a project
 * routes its dispatch through.
 *
 * The service owns the policy the Redis Function deliberately does not — which
 * session may hold the role, when a terminal holder may be taken over, and what
 * a live holder means to the caller — through the pure `evaluateCoordinatorClaim`.
 * The Function owns only the atomic compare-and-set. Because the holder's
 * liveness is read here (in TypeScript), a contended claim re-reads and
 * re-decides up to `COORDINATOR_CLAIM_MAX_ATTEMPTS` times, exactly as the native
 * session binding does.
 *
 * This is coordination-plane identity, not task orchestration (AGENTS.md §21):
 * it records WHO coordinates and never any task, work, stage, or queue.
 */

export type CoordinatorService = {
  /** `takeover` (ADR 0035 amendment) evicts a still-live different holder — an explicit operator gesture only. */
  claim(input: { projectId: string; sessionId: string; takeover?: boolean }): Promise<Coordinator>;
  release(input: { projectId: string; sessionId: string }): Promise<void>;
  get(projectId: string): Promise<CoordinatorView>;
};

/** A coordinator holder is free once its session is terminal (ADR 0035). */
function holderIsLive(status: SessionStatus | undefined): boolean {
  return status !== undefined && status !== 'completed' && status !== 'disconnected';
}

export function createCoordinatorService(options: {
  repository: CoordinatorRepository;
  sessions: SessionService;
  workspaceId: string;
  now?: () => Date;
  createId?: () => string;
}): CoordinatorService {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  const event = (
    type: 'coordinator.claimed' | 'coordinator.released',
    record: { projectId: string; sessionId: string; agentId?: string },
    payload: Record<string, unknown> = {},
  ): RuntimeEvent =>
    createRuntimeEvent({
      type,
      workspaceId: options.workspaceId,
      projectId: record.projectId,
      sessionId: record.sessionId,
      // A release only knows the project and session; agentId is optional on the
      // event envelope, so it is omitted rather than sent empty.
      ...(record.agentId ? { agentId: record.agentId } : {}),
      payload,
    });

  /** The holder session's status, or `undefined` when its record is gone. */
  const holderStatus = async (sessionId: string): Promise<SessionStatus | undefined> =>
    (await options.sessions.get(sessionId))?.status;

  return {
    async claim(input) {
      // The role belongs to a session, so the claimant must exist, live in this
      // project, and still be alive. A coordinator outliving its session is the
      // failure mode single-holder identity exists to prevent.
      const session = await options.sessions.get(input.sessionId);
      if (session === null) {
        throw new ApplicationError(
          'COORDINATOR_SESSION_NOT_FOUND',
          'The coordinator role requires a registered session to hold it.',
          404,
        );
      }
      if (session.projectId !== input.projectId) {
        throw new ApplicationError(
          'COORDINATOR_SESSION_PROJECT_MISMATCH',
          'A session can only coordinate its own project.',
          409,
        );
      }
      if (!holderIsLive(session.status)) {
        throw new ApplicationError(
          'COORDINATOR_SESSION_NOT_ACTIVE',
          'A terminal session cannot hold the coordinator role.',
          409,
        );
      }

      for (let attempt = 0; attempt < COORDINATOR_CLAIM_MAX_ATTEMPTS; attempt += 1) {
        const holder = await options.repository.getCoordinator(input.projectId);
        const decision = evaluateCoordinatorClaim({
          holder:
            holder === null
              ? undefined
              : {
                  sessionId: holder.sessionId,
                  version: holder.version,
                  claimId: holder.claimId,
                  sessionStatus:
                    holder.sessionId === input.sessionId
                      ? session.status
                      : await holderStatus(holder.sessionId),
                },
          sessionId: input.sessionId,
          ...(input.takeover === undefined ? {} : { takeover: input.takeover }),
        });

        if (decision.outcome === 'unchanged') {
          // Already the coordinator; the claim is idempotent and writes nothing.
          return holder as Coordinator;
        }
        if (decision.outcome === 'conflict') {
          throw new ApplicationError(
            'COORDINATOR_CONFLICT',
            `Project ${input.projectId} is already coordinated by session ${decision.heldBySessionId}.`,
            409,
          );
        }

        const record: Omit<Coordinator, 'version'> = {
          projectId: input.projectId,
          sessionId: input.sessionId,
          agentId: session.agentId,
          // A fresh incarnation nonce every claim; the take-over CAS keys on it.
          claimId: createId(),
          claimedAt: now().toISOString(),
        };
        const result = await options.repository.claimCoordinator({
          record,
          expectedVersion: decision.expectedVersion,
          expectedClaimId: decision.outcome === 'takeover' ? decision.expectedClaimId : '',
          event: event('coordinator.claimed', record, { version: decision.expectedVersion + 1 }),
        });

        if (result.status === 'claimed') return { ...record, version: result.version };
        // `version_conflict`: another claim moved the version between the read
        // and the CAS. Re-read and re-decide.
      }

      throw new ApplicationError(
        'COORDINATOR_CONTENDED',
        'The coordinator role is being claimed concurrently; retry.',
        409,
      );
    },

    async release(input) {
      const result = await options.repository.releaseCoordinator({
        projectId: input.projectId,
        sessionId: input.sessionId,
        event: event('coordinator.released', {
          projectId: input.projectId,
          sessionId: input.sessionId,
        }),
      });

      if (result.status === 'released') return;
      if (result.status === 'not_found') {
        throw new ApplicationError(
          'COORDINATOR_NOT_FOUND',
          'This project has no coordinator to release.',
          404,
        );
      }
      throw new ApplicationError(
        'COORDINATOR_NOT_HELD_BY_SESSION',
        `Only the coordinating session ${result.heldBySessionId} can release the role.`,
        409,
      );
    },

    async get(projectId) {
      const coordinator = await options.repository.getCoordinator(projectId);
      if (coordinator === null) return { coordinator: null, live: false };
      return { coordinator, live: holderIsLive(await holderStatus(coordinator.sessionId)) };
    },
  };
}
