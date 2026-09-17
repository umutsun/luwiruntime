import { z } from 'zod';

/**
 * The per-project coordinator role (ADR 0035): the one session a project routes
 * its dispatch through. Enforced single-holder — a second claim while a live
 * holder exists is refused, naming the holder; a terminal holder is taken over.
 *
 * This is coordination-plane identity — WHO coordinates — and never carries any
 * task, work, stage, or queue state (that would be §21 task orchestration). The
 * daemon answers atomically and records the holder; it does not stop a process
 * from behaving as coordinator (§3, execution-advisory, like a work lease).
 */

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

export const coordinatorClaimRequestSchema = z.strictObject({
  sessionId: identifierSchema,
  /**
   * A human-initiated take-over of a still-LIVE different holder (ADR 0035
   * amendment). Absent/false keeps the automated rule — a live holder is refused
   * `409 COORDINATOR_CONFLICT` — so two agents racing never evict each other.
   * `true` is only ever set by an explicit operator gesture (the dashboard's
   * "Take over" confirmation); it does not weaken the single-holder CAS, which
   * still keys on the observed holder's `version` and `claimId`.
   */
  takeover: z.boolean().optional(),
});
export type CoordinatorClaimRequest = z.infer<typeof coordinatorClaimRequestSchema>;

export const coordinatorReleaseRequestSchema = z.strictObject({
  sessionId: identifierSchema,
});
export type CoordinatorReleaseRequest = z.infer<typeof coordinatorReleaseRequestSchema>;

/**
 * The stored coordinator record for a project.
 *
 * `claimId` is a fresh nonce minted on every claim; it is the incarnation token
 * the take-over CAS keys on. `version` counts claims since the last release for
 * display and a cheap first CAS check, but it resets to 1 after a release (the
 * key is deleted), so it is NOT a stable generation identifier on its own — a
 * stale take-over whose `version` coincidentally matches a newer holder is
 * caught by the `claimId` mismatch, never by `version` alone (ADR 0035).
 */
export const coordinatorSchema = z.strictObject({
  projectId: identifierSchema,
  sessionId: identifierSchema,
  agentId: identifierSchema,
  claimId: identifierSchema,
  claimedAt: timestampSchema,
  version: z.coerce.number().int().positive(),
});
export type Coordinator = z.infer<typeof coordinatorSchema>;

/**
 * What `GET .../coordinator` returns: the holder (if any) and whether its
 * session is still live. A holder whose session is terminal is reported
 * `live: false` and is takeable by the next claim.
 */
export const coordinatorViewSchema = z.strictObject({
  coordinator: coordinatorSchema.nullable(),
  live: z.boolean(),
});
export type CoordinatorView = z.infer<typeof coordinatorViewSchema>;
