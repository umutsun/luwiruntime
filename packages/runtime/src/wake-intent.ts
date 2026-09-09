import type { WakeIntentState } from '@luwi/protocol';

export type WakeProcessClassification = Extract<
  WakeIntentState,
  'dispatched' | 'fallback_only' | 'indeterminate'
>;

export type WakeProcessResult = {
  started: boolean;
  spawnFailure?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  signal?: string;
  crashed?: boolean;
  ownershipLost?: boolean;
};

function hasPostSpawnEvidence(result: WakeProcessResult): boolean {
  return (
    result.exitCode !== undefined ||
    result.timedOut === true ||
    result.signal !== undefined ||
    result.crashed === true ||
    result.ownershipLost === true
  );
}

/** The durable wake state machine has no transitions out of terminal states. */
export function canTransitionWakeIntent(from: WakeIntentState, to: WakeIntentState): boolean {
  switch (from) {
    case 'pending':
      return to === 'claimed';
    case 'claimed':
      return to === 'dispatching' || to === 'fallback_only' || to === 'indeterminate';
    case 'dispatching':
      return to === 'dispatched' || to === 'fallback_only' || to === 'indeterminate';
    case 'dispatched':
    case 'fallback_only':
    case 'indeterminate':
      return false;
  }
}

/**
 * A host command may be replayed only when its failure was proven before it
 * started. Once process creation might have occurred, uncertainty is terminal.
 */
export function classifyWakeProcessResult(result: WakeProcessResult): WakeProcessClassification {
  if (!result.started && result.spawnFailure && !hasPostSpawnEvidence(result)) {
    return 'fallback_only';
  }
  if (
    result.started &&
    !result.spawnFailure &&
    result.exitCode === 0 &&
    !result.timedOut &&
    result.signal === undefined &&
    !result.crashed &&
    !result.ownershipLost
  ) {
    return 'dispatched';
  }
  return 'indeterminate';
}
