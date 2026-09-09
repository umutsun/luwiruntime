import { describe, expect, it } from 'vitest';

import {
  WAKE_MAX_CLAIM_LIMIT,
  parseWakeIntentView,
  wakeIntentClaimBatchResponseSchema,
  wakeIntentClaimRequestSchema,
  wakeIntentClaimResponseSchema,
  wakeIntentCollectionSchema,
  wakeIntentCompleteRequestSchema,
  wakeIntentCompleteResponseSchema,
  wakeIntentDispatchingRequestSchema,
  wakeIntentDispatchingResponseSchema,
  wakeIntentListQuerySchema,
  wakeIntentRecoverRequestSchema,
  wakeIntentRecoverResponseSchema,
  wakeIntentReclaimResponseSchema,
} from './wake.js';

const intent = {
  id: 'wake-1',
  messageId: 'message-1',
  workflowId: 'workflow-1',
  sourceSessionId: 'session-1',
  correlationId: 'correlation-1',
  terminalState: 'responded',
  adapter: 'codex-queue-v1',
  state: 'pending',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
};

describe('wake intent view', () => {
  it.each(['nativeSessionId', 'dispatcherInstanceId', 'claimId', 'attemptId'])(
    'rejects private %s data from its redacted public shape',
    (field) => {
      expect(() => parseWakeIntentView({ ...intent, [field]: 'private' })).toThrow();
    },
  );

  it('keeps private dispatch fields out of the public collection', () => {
    expect(() =>
      wakeIntentCollectionSchema.parse({
        wakeIntents: [{ ...intent, claimId: 'claim-1' }],
      }),
    ).toThrow();
  });
});

describe('wake intent list query', () => {
  it('accepts only bounded public filters', () => {
    expect(
      wakeIntentListQuerySchema.parse({
        projectId: 'project-1',
        state: 'claimed',
        limit: '25',
      }),
    ).toEqual({ projectId: 'project-1', state: 'claimed', limit: 25 });
    expect(wakeIntentListQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(() => wakeIntentListQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => wakeIntentListQuerySchema.parse({ limit: 1001 })).toThrow();
    expect(() => wakeIntentListQuerySchema.parse({ dispatcherInstanceId: 'private' })).toThrow();
  });
});

describe('private wake claim response', () => {
  const claimedIntent = { ...intent, state: 'claimed' };

  it('returns either one strict opaque target or one bounded refusal reason', () => {
    const targetItem = {
      intent: claimedIntent,
      claimId: 'claim-1',
      target: {
        adapter: 'codex-queue-v1',
        nativeSessionId: '01990a16-1490-7a01-a59e-3455ef1a0173',
      },
    };
    const refusedItem = {
      intent: claimedIntent,
      claimId: 'claim-2',
      refusalReasonCode: 'native_binding_trimmed',
    };
    const response = {
      items: [targetItem, refusedItem],
      recoveredDispatching: [],
      terminalAcknowledged: 0,
    };
    expect(wakeIntentClaimBatchResponseSchema.parse(response)).toEqual(response);
    expect(wakeIntentClaimResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      wakeIntentClaimResponseSchema.parse({
        items: [{ ...targetItem, refusalReasonCode: 'native_binding_trimmed' }],
        recoveredDispatching: [],
        terminalAcknowledged: 0,
      }),
    ).toThrow();
    expect(() =>
      wakeIntentClaimResponseSchema.parse({
        items: [{ intent: claimedIntent, claimId: 'claim-3' }],
        recoveredDispatching: [],
        terminalAcknowledged: 0,
      }),
    ).toThrow();
    expect(() =>
      wakeIntentClaimResponseSchema.parse({
        items: [
          {
            ...targetItem,
            target: { ...targetItem.target, executablePath: 'C:/private/codex.exe' },
          },
        ],
        recoveredDispatching: [],
        terminalAcknowledged: 0,
      }),
    ).toThrow();
    expect(() => wakeIntentClaimResponseSchema.parse({ items: [] })).toThrow();
  });

  it('bounds the claimed batch', () => {
    expect(() =>
      wakeIntentClaimResponseSchema.parse({
        items: Array.from({ length: WAKE_MAX_CLAIM_LIMIT + 1 }, (_, index) => ({
          intent: { ...claimedIntent, id: `wake-${index}`, messageId: `message-${index}` },
          claimId: `claim-${index}`,
          refusalReasonCode: 'native_binding_missing',
        })),
        recoveredDispatching: [],
        terminalAcknowledged: 0,
      }),
    ).toThrow();
  });
});

describe('private wake operational identifiers', () => {
  const invalidIdentifiers = ['contains space', 'contains\nnewline', 'contains\0nul', '-leading'];

  it.each(invalidIdentifiers)('rejects unsafe dispatcher identity %j', (dispatcherInstanceId) => {
    expect(() => wakeIntentClaimRequestSchema.parse({ dispatcherInstanceId })).toThrow();
    expect(() => wakeIntentRecoverRequestSchema.parse({ dispatcherInstanceId })).toThrow();
  });

  it.each(['dispatcherInstanceId', 'claimId', 'attemptId'] as const)(
    'rejects unsafe %s fence identity',
    (field) => {
      expect(() =>
        wakeIntentDispatchingRequestSchema.parse({
          dispatcherInstanceId: 'dispatcher-1',
          claimId: 'claim-1',
          attemptId: 'attempt-1',
          [field]: 'contains space',
        }),
      ).toThrow();
    },
  );
});

describe('private wake transition protocol', () => {
  const dispatchingResponse = {
    status: 'updated',
    intent: { ...intent, state: 'dispatching' },
  };
  const completeResponse = {
    status: 'updated',
    intent: { ...intent, state: 'dispatched', reasonCode: 'codex_queue_accepted' },
  };

  it('validates strict dispatching and completion requests', () => {
    const dispatching = {
      dispatcherInstanceId: 'dispatcher-1',
      claimId: 'claim-1',
      attemptId: 'attempt-1',
    };
    expect(wakeIntentDispatchingRequestSchema.parse(dispatching)).toEqual(dispatching);
    expect(() =>
      wakeIntentDispatchingRequestSchema.parse({ ...dispatching, intentId: 'path-owned' }),
    ).toThrow();

    const completion = {
      ...dispatching,
      state: 'dispatched',
      reasonCode: 'codex_queue_accepted',
    };
    expect(wakeIntentCompleteRequestSchema.parse(completion)).toEqual(completion);
    expect(() =>
      wakeIntentCompleteRequestSchema.parse({ ...completion, nativeSessionId: 'private' }),
    ).toThrow();
  });

  it('returns the public intent from strict dispatching and completion responses', () => {
    expect(wakeIntentDispatchingResponseSchema.parse(dispatchingResponse)).toEqual(
      dispatchingResponse,
    );
    expect(wakeIntentCompleteResponseSchema.parse(completeResponse)).toEqual(completeResponse);
    expect(() =>
      wakeIntentDispatchingResponseSchema.parse({
        ...dispatchingResponse,
        intent: { ...dispatchingResponse.intent, attemptId: 'private' },
      }),
    ).toThrow();
    expect(() =>
      wakeIntentCompleteResponseSchema.parse({ ...completeResponse, claimId: 'private' }),
    ).toThrow();
    expect(() =>
      wakeIntentCompleteResponseSchema.parse({
        status: 'updated',
        intent: { ...intent, state: 'fallback_only' },
      }),
    ).toThrow();
  });

  it('validates a bounded dispatcher recovery pass and redacted result', () => {
    expect(
      wakeIntentRecoverRequestSchema.parse({
        dispatcherInstanceId: 'dispatcher-1',
        limit: '5',
        minIdleMs: '15000',
      }),
    ).toEqual({ dispatcherInstanceId: 'dispatcher-1', limit: 5, minIdleMs: 15_000 });
    expect(wakeIntentRecoverRequestSchema.parse({ dispatcherInstanceId: 'dispatcher-1' })).toEqual({
      dispatcherInstanceId: 'dispatcher-1',
      limit: 10,
      minIdleMs: 15_000,
    });
    expect(() =>
      wakeIntentRecoverRequestSchema.parse({
        dispatcherInstanceId: 'dispatcher-1',
        limit: WAKE_MAX_CLAIM_LIMIT + 1,
      }),
    ).toThrow();

    const reclaimed = {
      intent: { ...intent, state: 'claimed' },
      claimId: 'claim-recovered',
      refusalReasonCode: 'native_binding_missing',
    };
    const recovered = { ...intent, state: 'indeterminate', reasonCode: 'dispatcher_recovered' };
    const response = {
      items: [reclaimed],
      recoveredDispatching: [recovered],
      terminalAcknowledged: 1,
    };
    expect(wakeIntentReclaimResponseSchema.parse(response)).toEqual(response);
    expect(wakeIntentRecoverResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      wakeIntentRecoverResponseSchema.parse({
        ...response,
        recoveredDispatching: [{ ...recovered, dispatcherInstanceId: 'private' }],
      }),
    ).toThrow();
    expect(() =>
      wakeIntentRecoverResponseSchema.parse({
        ...response,
        recoveredDispatching: [{ ...intent, state: 'indeterminate' }],
      }),
    ).toThrow();
    expect(() =>
      wakeIntentRecoverResponseSchema.parse({
        ...response,
        recoveredDispatching: Array.from({ length: WAKE_MAX_CLAIM_LIMIT + 1 }, (_, index) => ({
          ...recovered,
          id: `wake-recovered-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      wakeIntentRecoverResponseSchema.parse({
        ...response,
        terminalAcknowledged: WAKE_MAX_CLAIM_LIMIT + 1,
      }),
    ).toThrow();
  });
});
