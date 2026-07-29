import type { SessionStatus } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { evaluateSessionStatusTransition } from './index.js';

const statuses: SessionStatus[] = [
  'starting',
  'idle',
  'thinking',
  'tool_running',
  'waiting_for_input',
  'waiting_for_agent',
  'blocked',
  'completed',
  'disconnected',
];

describe('session status transitions', () => {
  it('defines every allowed, unchanged, rejected, and terminal transition', () => {
    for (const current of statuses) {
      for (const target of statuses) {
        const result = evaluateSessionStatusTransition(current, target);

        if (target === 'starting' || target === 'disconnected') {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'invalid_transition' });
        } else if (current === target) {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'unchanged' });
        } else if (current === 'completed' || current === 'disconnected') {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'terminal' });
        } else {
          expect(result, `${current} -> ${target}`).toEqual({ status: 'updated' });
        }
      }
    }
  });
});
