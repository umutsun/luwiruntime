import type { MessageState } from '@luwi/protocol';

export type MessageTransitionResult =
  | { status: 'updated' }
  | { status: 'unchanged' }
  | { status: 'terminal' }
  | { status: 'invalid_transition' };

const allowedTargets: Readonly<Record<MessageState, ReadonlySet<MessageState>>> = {
  queued: new Set(['delivered', 'timed_out', 'failed']),
  delivered: new Set([
    'acknowledged',
    'processing',
    'responded',
    'rejected',
    'timed_out',
    'failed',
  ]),
  acknowledged: new Set(['processing', 'responded', 'rejected', 'timed_out', 'failed']),
  processing: new Set(['responded', 'rejected', 'timed_out', 'failed']),
  responded: new Set(),
  rejected: new Set(),
  timed_out: new Set(),
  failed: new Set(),
};

export function evaluateMessageTransition(
  current: MessageState,
  target: MessageState,
): MessageTransitionResult {
  if (current === target) {
    return { status: 'unchanged' };
  }
  if (allowedTargets[current].has(target)) {
    return { status: 'updated' };
  }
  if (allowedTargets[current].size === 0) {
    return { status: 'terminal' };
  }
  return { status: 'invalid_transition' };
}
