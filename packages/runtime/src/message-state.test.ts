import type { MessageState } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { evaluateMessageTransition } from './index.js';

const states: MessageState[] = [
  'queued',
  'delivered',
  'acknowledged',
  'processing',
  'responded',
  'rejected',
  'timed_out',
  'failed',
];

const allowed: Readonly<Record<MessageState, readonly MessageState[]>> = {
  queued: ['delivered', 'timed_out', 'failed'],
  delivered: ['acknowledged', 'processing', 'responded', 'rejected', 'timed_out', 'failed'],
  acknowledged: ['processing', 'responded', 'rejected', 'timed_out', 'failed'],
  processing: ['responded', 'rejected', 'timed_out', 'failed'],
  responded: [],
  rejected: [],
  timed_out: [],
  failed: [],
};

describe('message state transitions', () => {
  it('defines every changed, unchanged, invalid, and terminal combination', () => {
    for (const current of states) {
      for (const target of states) {
        const result = evaluateMessageTransition(current, target);

        if (current === target) {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'unchanged' });
        } else if (allowed[current].includes(target)) {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'updated' });
        } else if (allowed[current].length === 0) {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'terminal' });
        } else {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'invalid_transition' });
        }
      }
    }
  });
});
