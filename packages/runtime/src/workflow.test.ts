import { describe, expect, it } from 'vitest';

import { authorizeWorkflowContinuation } from './workflow.js';

describe('workflow continuation authorization', () => {
  const expected = {
    expectedRevision: 3,
    actualRevision: 3,
    expectedWakeIntentId: 'wake-1',
    actualWakeIntentId: 'wake-1',
  } as const;

  it('permits the exact active revision and wake intent', () => {
    expect(authorizeWorkflowContinuation(expected)).toEqual({ allowed: true });
  });

  it.each([
    [{ actualRevision: 4 }, 'revision_mismatch'],
    [{ actualWakeIntentId: 'wake-2' }, 'wake_intent_mismatch'],
    [{ actualRevision: 4, actualWakeIntentId: 'wake-2' }, 'revision_mismatch'],
  ] as const)('refuses stale or mismatched continuations with a stable reason', (patch, reason) => {
    expect(authorizeWorkflowContinuation({ ...expected, ...patch })).toEqual({
      allowed: false,
      reason,
    });
  });
});
