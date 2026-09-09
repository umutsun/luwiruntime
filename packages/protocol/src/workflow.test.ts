import { describe, expect, it } from 'vitest';

import { parseContinueWorkflowRequest } from './workflow.js';

describe('workflow continuation request', () => {
  it.each([
    { kind: 'wake', wakeIntentId: 'intent-1' },
    { kind: 'human', continuationId: 'continuation-1' },
  ])('accepts a bounded $kind continuation proof', (proof) => {
    expect(
      parseContinueWorkflowRequest({
        workflowId: 'w',
        expectedRevision: 1,
        proof,
        decision: { kind: 'complete' },
      }),
    ).toMatchObject({ proof });
  });

  it('rejects a completion decision that smuggles a target agent', () => {
    expect(() =>
      parseContinueWorkflowRequest({
        workflowId: 'w',
        expectedRevision: 1,
        proof: { kind: 'wake', wakeIntentId: 'i' },
        decision: { kind: 'complete', targetAgentId: 'x' },
      }),
    ).toThrow();
  });

  it.each([
    { kind: 'wake', continuationId: 'continuation-1' },
    { kind: 'human', wakeIntentId: 'intent-1' },
    { kind: 'human' },
  ])('rejects a malformed continuation proof %#', (proof) => {
    expect(() =>
      parseContinueWorkflowRequest({
        workflowId: 'w',
        expectedRevision: 1,
        proof,
        decision: { kind: 'complete' },
      }),
    ).toThrow();
  });
});
