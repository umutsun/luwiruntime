import type { SessionStatus } from '@luwi/protocol';

export type SessionStatusTransitionResult =
  | { status: 'updated' }
  | { status: 'unchanged' }
  | { status: 'terminal' }
  | { status: 'invalid_transition' };

export function evaluateSessionStatusTransition(
  current: SessionStatus,
  target: SessionStatus,
): SessionStatusTransitionResult {
  if (target === 'starting' || target === 'disconnected') {
    return { status: 'invalid_transition' };
  }

  if (current === target) {
    return { status: 'unchanged' };
  }

  if (current === 'completed' || current === 'disconnected') {
    return { status: 'terminal' };
  }

  return { status: 'updated' };
}
