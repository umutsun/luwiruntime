import { nativeDeclarationResponseSchema } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import {
  evaluateNativeDeclaration,
  NATIVE_DECLARATION_MAX_ATTEMPTS,
  type NativeDeclarationDecision,
} from './native-session-policy.js';

const timestamp = '2026-08-11T00:00:00.000Z';

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b'.repeat(64),
    adapterId: 'claude-code-native-v1',
    nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
    kind: 'main' as const,
    version: 4,
    linkCount: 2,
    trimmedLinkCount: 0,
    firstLinkedAt: timestamp,
    lastLinkedAt: timestamp,
    ...overrides,
  };
}

describe('native declaration policy', () => {
  it('creates a binding when none exists, expecting an absent key', () => {
    expect(
      evaluateNativeDeclaration({ binding: undefined, openLink: undefined, sessionId: 's1' }),
    ).toEqual({ outcome: 'created', expectedVersion: 0 });
  });

  it('links when the binding exists with no open link', () => {
    expect(
      evaluateNativeDeclaration({ binding: binding(), openLink: undefined, sessionId: 's2' }),
    ).toEqual({ outcome: 'linked', expectedVersion: 4 });
  });

  /**
   * Unreachable through registration, which always mints a new session id. It is
   * specified so that a future declaration surface inherits the rule instead of
   * reinventing it, and so registration can refuse rather than fall through.
   */
  it('is idempotent when the open link already points at this session', () => {
    expect(
      evaluateNativeDeclaration({
        binding: binding({ openLinkId: 'l1' }),
        openLink: { id: 'l1', sessionId: 's3', sessionStatus: 'thinking' },
        sessionId: 's3',
      }),
    ).toEqual({ outcome: 'unchanged' });
  });

  /** A live holder is reported, never evicted. */
  it('conflicts when another non-terminal session holds the reference', () => {
    for (const sessionStatus of [
      'starting',
      'idle',
      'thinking',
      'tool_running',
      'blocked',
    ] as const) {
      expect(
        evaluateNativeDeclaration({
          binding: binding({ openLinkId: 'l1' }),
          openLink: { id: 'l1', sessionId: 'held', sessionStatus },
          sessionId: 'new',
        }),
        sessionStatus,
      ).toEqual({ outcome: 'conflict', heldBySessionId: 'held' });
    }
  });

  it('links over a stale open link without mutating the old session', () => {
    for (const sessionStatus of ['completed', 'disconnected'] as const) {
      expect(
        evaluateNativeDeclaration({
          binding: binding({ openLinkId: 'l1' }),
          openLink: { id: 'l1', sessionId: 'old', sessionStatus },
          sessionId: 'new',
        }),
        sessionStatus,
      ).toEqual({
        outcome: 'linked',
        expectedVersion: 4,
        expectedOpenLinkId: 'l1',
        staleLinkId: 'l1',
      });
    }
  });

  /**
   * The binding says someone holds the reference and the record that says who
   * is gone. Writing a fresh link would destroy the discrepancy instead of
   * reporting it, so the declaration fails and the state stays inspectable.
   */
  it('reports an unreadable open link as inconsistent rather than as free', () => {
    expect(
      evaluateNativeDeclaration({
        binding: binding({ openLinkId: 'l1' }),
        openLink: undefined,
        sessionId: 'new',
      }),
    ).toEqual({ outcome: 'inconsistent', openLinkId: 'l1' });
  });

  it('bounds contention retries', () => {
    expect(NATIVE_DECLARATION_MAX_ATTEMPTS).toBe(3);
  });

  /**
   * The declaration surface must account for every outcome this policy can
   * produce: the declarable ones in its response enum, the rest as refusals.
   * The Record below stops compiling when the decision union changes, and the
   * assertion fails when the protocol enum drifts, so the two cannot separate
   * silently.
   */
  it('is surfaced completely by the protocol declaration outcome enum', () => {
    const surfaced: Record<NativeDeclarationDecision['outcome'], 'response' | 'refusal'> = {
      created: 'response',
      linked: 'response',
      unchanged: 'response',
      conflict: 'refusal',
      inconsistent: 'refusal',
    };
    const responses = Object.entries(surfaced)
      .filter(([, surface]) => surface === 'response')
      .map(([outcome]) => outcome)
      .sort();
    expect([...nativeDeclarationResponseSchema.shape.outcome.options].sort()).toEqual(responses);
  });
});
