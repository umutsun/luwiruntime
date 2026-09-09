import { describe, expect, it } from 'vitest';

import { parseContinueWorkflowRequest } from './workflow.js';

describe('workflow continuation request', () => {
  it('rejects a completion decision that smuggles a target agent', () => {
    expect(() =>
      parseContinueWorkflowRequest({
        workflowId: 'w',
        expectedRevision: 1,
        wakeIntentId: 'i',
        decision: { kind: 'complete', targetAgentId: 'x' },
      }),
    ).toThrow();
  });
});
