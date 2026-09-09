import { describe, expect, it } from 'vitest';

import { authorizeWorkflowContinuation, createWorkflowDecisionFingerprint } from './workflow.js';

const base = {
  expectedRevision: 3,
  workflow: {
    id: 'workflow-1',
    projectId: 'project-1',
    coordinatorSessionId: 'session-coordinator',
    revision: 3,
    state: 'active' as const,
    currentWakeIntentId: 'wake-1',
  },
  coordinator: {
    sessionId: 'session-coordinator',
    agentId: 'codex',
    projectId: 'project-1',
  },
  actor: {
    sessionId: 'session-coordinator',
    agentId: 'codex',
    projectId: 'project-1',
    live: true,
  },
  proof: { kind: 'wake' as const, wakeIntentId: 'wake-1' },
  wakeIntent: {
    id: 'wake-1',
    workflowId: 'workflow-1',
    workflowRevision: 3,
    sourceSessionId: 'session-coordinator',
    state: 'dispatching' as const,
  },
  decisionKind: 'next_message' as const,
};

describe('workflow continuation authorization', () => {
  it.each(['dispatching', 'dispatched', 'indeterminate'] as const)(
    'permits the exact coordinator wake while it is %s',
    (state) => {
      expect(
        authorizeWorkflowContinuation({
          ...base,
          wakeIntent: { ...base.wakeIntent, state },
        }),
      ).toEqual({ allowed: true, rebindCoordinator: false });
    },
  );

  it.each([
    [{ expectedRevision: 2 }, 'revision_mismatch'],
    [{ actor: { ...base.actor, sessionId: 'session-other' } }, 'coordinator_mismatch'],
    [{ proof: { kind: 'wake', wakeIntentId: 'wake-other' } }, 'wake_intent_mismatch'],
    [
      { wakeIntent: { ...base.wakeIntent, sourceSessionId: 'session-other' } },
      'wake_record_mismatch',
    ],
    [{ wakeIntent: { ...base.wakeIntent, state: 'fallback_only' } }, 'wake_intent_state_invalid'],
  ] as const)('refuses an invalid wake continuation %#', (patch, reason) => {
    expect(authorizeWorkflowContinuation({ ...base, ...patch })).toEqual({
      allowed: false,
      reason,
    });
  });

  it('treats a human token only as a fence and authorizes a live same-agent replacement', () => {
    expect(
      authorizeWorkflowContinuation({
        ...base,
        workflow: {
          ...base.workflow,
          state: 'waiting_for_human',
          currentWakeIntentId: undefined,
          currentHumanContinuationId: 'human-1',
        },
        actor: { ...base.actor, sessionId: 'session-replacement' },
        proof: { kind: 'human', continuationId: 'human-1' },
        wakeIntent: undefined,
      }),
    ).toEqual({ allowed: true, rebindCoordinator: true });
  });

  it.each([
    [
      { actor: { ...base.actor, sessionId: 'session-replacement', live: false } },
      'actor_unavailable',
    ],
    [
      { actor: { ...base.actor, sessionId: 'session-replacement', agentId: 'gemini' } },
      'actor_agent_mismatch',
    ],
    [
      { actor: { ...base.actor, sessionId: 'session-replacement', projectId: 'project-2' } },
      'actor_project_mismatch',
    ],
    [{ actor: base.actor }, 'replacement_coordinator_required'],
  ] as const)('refuses unauthorized human next-message continuation %#', (actorPatch, reason) => {
    expect(
      authorizeWorkflowContinuation({
        ...base,
        workflow: {
          ...base.workflow,
          state: 'waiting_for_human',
          currentWakeIntentId: undefined,
          currentHumanContinuationId: 'human-1',
        },
        proof: { kind: 'human', continuationId: 'human-1' },
        wakeIntent: undefined,
        ...actorPatch,
      }),
    ).toEqual({ allowed: false, reason });
  });
});

describe('workflow decision fingerprint', () => {
  const request = {
    workflowId: 'workflow-1',
    expectedRevision: 3,
    proof: { kind: 'wake' as const, wakeIntentId: 'wake-1' },
    decision: {
      kind: 'next_message' as const,
      targetAgentId: 'gemini',
      message: { kind: 'instruction' as const, content: 'Continue the bounded work.' },
    },
    actorSessionId: 'session-coordinator',
  };

  it('is stable for an exact semantic replay', () => {
    const fingerprint = createWorkflowDecisionFingerprint(request);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(createWorkflowDecisionFingerprint({ ...request })).toBe(fingerprint);
  });

  it('binds the trusted actor and public decision', () => {
    const fingerprint = createWorkflowDecisionFingerprint(request);
    expect(
      createWorkflowDecisionFingerprint({ ...request, actorSessionId: 'session-other' }),
    ).not.toBe(fingerprint);
    expect(
      createWorkflowDecisionFingerprint({ ...request, decision: { kind: 'complete' } }),
    ).not.toBe(fingerprint);
  });
});
