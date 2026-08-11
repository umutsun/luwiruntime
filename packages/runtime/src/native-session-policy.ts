import type { NativeSessionBinding, SessionStatus } from '@luwi/protocol';

/**
 * The product decision for a native declaration, made here and nowhere else.
 *
 * Lua never owns this. The daemon reads the binding and the linked session's
 * state, this function turns that observation into one outcome, and the Redis
 * Function only validates that the observation still holds before applying the
 * decision. That split is what keeps a Function from having to derive another
 * session's key name, which AGENTS.md section 7 forbids.
 */

export type NativeOpenLinkObservation = {
  id: string;
  sessionId: string;
  sessionStatus: SessionStatus;
};

export type NativeDeclarationObservation = {
  binding: NativeSessionBinding | undefined;
  /**
   * The link named by `binding.openLinkId`, together with its session's status.
   * `undefined` means the binding named an open link whose record could not be
   * read — which is a fault, not a free reference.
   */
  openLink: NativeOpenLinkObservation | undefined;
  /** The LUWI session being registered. */
  sessionId: string;
};

export type NativeDeclarationDecision =
  | {
      outcome: 'created' | 'linked';
      /** `0` means "the binding key must not exist". */
      expectedVersion: number;
      expectedOpenLinkId?: string;
      /** An open link over a terminal session, closed by the same transition. */
      staleLinkId?: string;
    }
  | { outcome: 'unchanged' }
  | { outcome: 'conflict'; heldBySessionId: string }
  | { outcome: 'inconsistent'; openLinkId: string };

/** One initial attempt plus two retries. */
export const NATIVE_DECLARATION_MAX_ATTEMPTS = 3;

function isTerminal(status: SessionStatus): boolean {
  return status === 'completed' || status === 'disconnected';
}

export function evaluateNativeDeclaration(
  observation: NativeDeclarationObservation,
): NativeDeclarationDecision {
  const { binding, openLink, sessionId } = observation;

  if (binding === undefined) {
    return { outcome: 'created', expectedVersion: 0 };
  }

  if (binding.openLinkId === undefined) {
    return { outcome: 'linked', expectedVersion: binding.version };
  }

  if (openLink === undefined) {
    return { outcome: 'inconsistent', openLinkId: binding.openLinkId };
  }

  if (openLink.sessionId === sessionId) {
    return { outcome: 'unchanged' };
  }

  if (!isTerminal(openLink.sessionStatus)) {
    return { outcome: 'conflict', heldBySessionId: openLink.sessionId };
  }

  return {
    outcome: 'linked',
    expectedVersion: binding.version,
    expectedOpenLinkId: openLink.id,
    staleLinkId: openLink.id,
  };
}
