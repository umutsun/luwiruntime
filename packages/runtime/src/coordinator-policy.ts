import type { SessionStatus } from '@luwi/protocol';

/**
 * The product decision for a per-project coordinator claim (ADR 0035), made here
 * and nowhere else.
 *
 * Lua never owns this. The daemon reads the current holder and the holder
 * session's status, this function turns that observation into one outcome, and
 * the Redis Function only compare-and-sets the monotonic `version` before
 * applying. That split keeps a Function from having to derive another session's
 * key name, which AGENTS.md section 7 forbids.
 */

export type CoordinatorHolderObservation = {
  sessionId: string;
  version: number;
  /**
   * The holder's incarnation nonce. A take-over must CAS on this, not on
   * `version` alone: `version` resets to 1 after a release, so a stale take-over
   * decided against a dead holder could otherwise match a newer live holder that
   * coincidentally reached the same `version` (ADR 0035 ABA hazard).
   */
  claimId: string;
  /**
   * The holder session's status, or `undefined` when its record could not be
   * read. A coordinator whose session has vanished frees the role, so a missing
   * status is treated as terminal (vacant), never as a fault.
   */
  sessionStatus: SessionStatus | undefined;
};

export type CoordinatorClaimObservation = {
  /** The current coordinator record for the project, or `undefined` if none. */
  holder: CoordinatorHolderObservation | undefined;
  /** The LUWI session claiming the coordinator role. */
  sessionId: string;
  /**
   * A human-initiated take-over (ADR 0035 amendment): when `true`, a still-LIVE
   * different holder is taken over instead of refused. Automated callers leave
   * it unset, so two agents racing still produce one grant and one conflict —
   * only an explicit operator gesture evicts a live coordinator. The CAS is
   * unchanged: it keys on the observed holder's `version` and `claimId`.
   */
  takeover?: boolean;
};

export type CoordinatorClaimDecision =
  | { outcome: 'grant'; expectedVersion: number } // `0` means "the coordinator key must not exist".
  | { outcome: 'unchanged' }
  // The take-over CAS keys on both the observed version and the observed
  // incarnation nonce; the nonce is what makes it safe across a version reset.
  | { outcome: 'takeover'; expectedVersion: number; expectedClaimId: string }
  | { outcome: 'conflict'; heldBySessionId: string };

/** One initial attempt plus two retries. */
export const COORDINATOR_CLAIM_MAX_ATTEMPTS = 3;

/**
 * A coordinator holder is free once its session is terminal. Unlike a work
 * lease (ADR 0020), a `disconnected` holder counts as vacant: a dead coordinator
 * process must release the role to a successor. A missing status is vacant too.
 */
function isVacant(status: SessionStatus | undefined): boolean {
  return status === undefined || status === 'completed' || status === 'disconnected';
}

export function evaluateCoordinatorClaim(
  observation: CoordinatorClaimObservation,
): CoordinatorClaimDecision {
  const { holder, sessionId, takeover } = observation;

  if (holder === undefined) {
    return { outcome: 'grant', expectedVersion: 0 };
  }

  if (holder.sessionId === sessionId) {
    return { outcome: 'unchanged' };
  }

  // A live different holder is refused — unless a human explicitly asked to take
  // it over. A terminal/vanished holder is always takeable.
  if (!isVacant(holder.sessionStatus) && takeover !== true) {
    return { outcome: 'conflict', heldBySessionId: holder.sessionId };
  }

  return {
    outcome: 'takeover',
    expectedVersion: holder.version,
    expectedClaimId: holder.claimId,
  };
}
