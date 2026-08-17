import { describe, expect, it } from 'vitest';

import { attributeObservation } from './native-attribution.js';

const linkedAt = '2026-08-17T08:13:17.184Z';
const unlinkedAt = '2026-08-17T08:13:32.752Z';

const closedLink = {
  id: 'c'.repeat(64),
  bindingId: 'b'.repeat(64),
  sessionId: 'session-1',
  linkedAt,
  unlinkedAt,
};

function at(offsetMs: number): string {
  return new Date(Date.parse(linkedAt) + offsetMs).toISOString();
}

describe('native transcript attribution', () => {
  it('binds an observation inside the interval to the link session', () => {
    expect(attributeObservation({ observedAt: at(1_000), binding: {}, link: closedLink })).toEqual({
      outcome: 'bound',
      sessionId: 'session-1',
    });
  });

  it('binds at the opening instant and refuses at the closing instant', () => {
    // The interval is half-open: [linkedAt, unlinkedAt).
    expect(attributeObservation({ observedAt: linkedAt, binding: {}, link: closedLink })).toEqual({
      outcome: 'bound',
      sessionId: 'session-1',
    });
    expect(attributeObservation({ observedAt: unlinkedAt, binding: {}, link: closedLink })).toEqual(
      {
        outcome: 'unbound',
        reason: 'outside-interval',
      },
    );
  });

  it('binds an open link at any instant at or after it was linked', () => {
    const openLink = {
      id: closedLink.id,
      bindingId: closedLink.bindingId,
      sessionId: 'session-1',
      linkedAt,
    };

    expect(
      attributeObservation({ observedAt: at(86_400_000), binding: {}, link: openLink }),
    ).toEqual({
      outcome: 'bound',
      sessionId: 'session-1',
    });
  });

  it('reports no-binding when the native session was never declared', () => {
    expect(attributeObservation({ observedAt: at(1_000), binding: null, link: null })).toEqual({
      outcome: 'unbound',
      reason: 'no-binding',
    });
  });

  it('distinguishes evidence lost to retention from evidence that never had an interval', () => {
    // A record older than the oldest retained link cannot be judged: its interval
    // may have existed and been trimmed. Saying "outside-interval" would claim
    // the runtime looked and found nothing, which is a stronger claim than it can
    // make.
    expect(
      attributeObservation({
        observedAt: at(-60_000),
        binding: { oldestRetainedLinkedAt: linkedAt },
        link: null,
      }),
    ).toEqual({ outcome: 'unbound', reason: 'trimmed' });

    expect(
      attributeObservation({
        observedAt: at(60_000),
        binding: { oldestRetainedLinkedAt: linkedAt },
        link: null,
      }),
    ).toEqual({ outcome: 'unbound', reason: 'outside-interval' });
  });

  it('never falls back to a nearby session', () => {
    // ADR 0022 and ADR 0023 both forbid assigning an unattributable record to the
    // nearest session. This asserts the absence of that behaviour directly,
    // because it is the invariant most likely to be "helpfully" broken later: a
    // link exists, its session is obvious, and the observation still does not
    // belong to it.
    const justBefore = attributeObservation({ observedAt: at(-1), binding: {}, link: closedLink });
    const justAfter = attributeObservation({
      observedAt: new Date(Date.parse(unlinkedAt) + 1).toISOString(),
      binding: {},
      link: closedLink,
    });

    for (const result of [justBefore, justAfter]) {
      expect(result.outcome).toBe('unbound');
      expect(JSON.stringify(result)).not.toContain('session-1');
    }
  });

  it('refuses an observation whose timestamp cannot be read', () => {
    expect(
      attributeObservation({ observedAt: 'not-a-timestamp', binding: {}, link: closedLink }),
    ).toEqual({ outcome: 'unbound', reason: 'outside-interval' });
  });
});
