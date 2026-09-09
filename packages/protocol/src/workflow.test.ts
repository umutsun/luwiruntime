import { describe, expect, it } from 'vitest';

import {
  parseContinueWorkflowRequest,
  workflowCollectionSchema,
  workflowListQuerySchema,
} from './workflow.js';

const workflow = {
  id: 'workflow-1',
  projectId: 'project-1',
  coordinatorSessionId: 'session-1',
  rootCorrelationId: 'correlation-1',
  objective: 'Complete the durable workflow.',
  revision: 1,
  state: 'active',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
};

describe('workflow collection and list query', () => {
  it('accepts only bounded repository-backed list filters', () => {
    expect(
      workflowListQuerySchema.parse({
        projectId: 'project-1',
        coordinatorSessionId: 'session-1',
        limit: '25',
      }),
    ).toEqual({ projectId: 'project-1', coordinatorSessionId: 'session-1', limit: 25 });
    expect(workflowListQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(() => workflowListQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => workflowListQuerySchema.parse({ limit: 1001 })).toThrow();
    expect(() => workflowListQuerySchema.parse({ state: 'active' })).toThrow();
  });

  it('rejects private continuation and dispatcher fields from public workflows', () => {
    expect(() =>
      workflowCollectionSchema.parse({
        workflows: [{ ...workflow, continuationId: 'private' }],
      }),
    ).toThrow();
    expect(() =>
      workflowCollectionSchema.parse({
        workflows: [{ ...workflow, dispatcherInstanceId: 'private' }],
      }),
    ).toThrow();
  });
});

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
