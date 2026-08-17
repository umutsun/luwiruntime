import type { NativeSessionBinding, NativeSessionLink } from '@luwi/protocol';

/**
 * Attribution of a native transcript observation to a LUWI session, decided here
 * and nowhere else.
 *
 * Attribution is interval containment and nothing more. ADR 0022 decided the
 * hard case and ADR 0023 did not reopen it: a record outside every interval, or
 * inside one that link retention has trimmed, stays **unbound** and is never
 * assigned to the nearest session. An unbound outcome is a real answer — the
 * honest report that no session can claim this evidence — not a failure to try
 * harder.
 */

export type NativeAttributionObservation = {
  /** The winning record's timestamp, so counters and attribution agree. */
  observedAt: string;
  /** The declared binding, or `null` when the native session was never declared. */
  binding: Pick<NativeSessionBinding, 'oldestRetainedLinkedAt'> | null;
  /** The link containing `observedAt`, as resolved by the repository, or `null`. */
  link: NativeSessionLink | null;
};

export type NativeAttribution =
  | { outcome: 'bound'; sessionId: string }
  | { outcome: 'unbound'; reason: 'no-binding' | 'outside-interval' | 'trimmed' };

function contains(link: NativeSessionLink, atMs: number): boolean {
  const linkedMs = Date.parse(link.linkedAt);
  if (Number.isNaN(linkedMs) || atMs < linkedMs) {
    return false;
  }
  if (link.unlinkedAt === undefined) {
    return true;
  }
  const unlinkedMs = Date.parse(link.unlinkedAt);
  // Half-open: the closing instant belongs to the next interval, not this one.
  return Number.isNaN(unlinkedMs) ? false : atMs < unlinkedMs;
}

export function attributeObservation(observation: NativeAttributionObservation): NativeAttribution {
  const atMs = Date.parse(observation.observedAt);
  if (Number.isNaN(atMs)) {
    return { outcome: 'unbound', reason: 'outside-interval' };
  }

  if (observation.link !== null && contains(observation.link, atMs)) {
    return { outcome: 'bound', sessionId: observation.link.sessionId };
  }

  if (observation.binding?.oldestRetainedLinkedAt !== undefined) {
    const oldestMs = Date.parse(observation.binding.oldestRetainedLinkedAt);
    if (!Number.isNaN(oldestMs) && atMs < oldestMs) {
      return { outcome: 'unbound', reason: 'trimmed' };
    }
  }

  return {
    outcome: 'unbound',
    reason: observation.binding === null ? 'no-binding' : 'outside-interval',
  };
}
