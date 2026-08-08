import { describe, expect, it } from 'vitest';

import { createMessageTimeoutSweeper, type MessageDeadline } from './index.js';

describe('message timeout sweeper', () => {
  it('uses the injected clock and preserves response/timeout race outcomes', async () => {
    const observed: MessageDeadline[] = [];
    const sweeper = createMessageTimeoutSweeper({
      now: () => 12_000,
      batchSize: 100,
      repository: {
        findDueMessageDeadlines: async (nowMs, limit) => {
          expect(nowMs).toBe(12_000);
          expect(limit).toBe(100);
          return [
            { messageId: 'message-1', deadlineMs: 10_000 },
            { messageId: 'message-2', deadlineMs: 11_000 },
          ];
        },
        timeoutMessage: async (deadline) => {
          observed.push(deadline);
          return deadline.messageId === 'message-1' ? 'timed_out' : 'unchanged';
        },
      },
    });

    await expect(sweeper.sweepOnce()).resolves.toEqual({
      candidates: 2,
      timedOut: 1,
      unchanged: 1,
    });
    expect(observed).toHaveLength(2);
  });

  it('does not select or mutate after stop', async () => {
    let searches = 0;
    const sweeper = createMessageTimeoutSweeper({
      now: () => 12_000,
      batchSize: 100,
      repository: {
        findDueMessageDeadlines: async () => {
          searches += 1;
          return [];
        },
        timeoutMessage: async () => 'unchanged',
      },
    });

    sweeper.stop();
    await expect(sweeper.sweepOnce()).resolves.toEqual({
      candidates: 0,
      timedOut: 0,
      unchanged: 0,
    });
    expect(searches).toBe(0);
  });
});
