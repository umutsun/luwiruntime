import { describe, expect, it } from 'vitest';

import { evaluateCoordinatorClaim } from './coordinator-policy.js';

describe('coordinator claim policy', () => {
  it('grants when no coordinator holds the role', () => {
    expect(evaluateCoordinatorClaim({ holder: undefined, sessionId: 's1' })).toEqual({
      outcome: 'grant',
      expectedVersion: 0,
    });
  });

  it('is idempotent when the same session re-claims', () => {
    expect(
      evaluateCoordinatorClaim({
        holder: { sessionId: 's1', version: 3, claimId: 'c1', sessionStatus: 'idle' },
        sessionId: 's1',
      }),
    ).toEqual({ outcome: 'unchanged' });
  });

  it('refuses a second claim while a live holder exists, naming the holder', () => {
    expect(
      evaluateCoordinatorClaim({
        holder: { sessionId: 's1', version: 3, claimId: 'c1', sessionStatus: 'tool_running' },
        sessionId: 's2',
      }),
    ).toEqual({ outcome: 'conflict', heldBySessionId: 's1' });
  });

  it('takes over from a terminal or vanished holder, CAS on its version and incarnation', () => {
    for (const sessionStatus of ['completed', 'disconnected', undefined] as const) {
      expect(
        evaluateCoordinatorClaim({
          holder: { sessionId: 's1', version: 4, claimId: 'c-old', sessionStatus },
          sessionId: 's2',
        }),
      ).toEqual({ outcome: 'takeover', expectedVersion: 4, expectedClaimId: 'c-old' });
    }
  });
});
