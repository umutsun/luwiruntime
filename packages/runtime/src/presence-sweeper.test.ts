import { describe, expect, it } from 'vitest';

import { createPresenceSweeper, type HeartbeatDeadline } from './index.js';

describe('presence sweeper', () => {
  it('uses the injected clock to select and process expired deadlines', async () => {
    const observed: HeartbeatDeadline[] = [];
    const sweeper = createPresenceSweeper({
      now: () => 12_000,
      batchSize: 100,
      repository: {
        findExpiredHeartbeatDeadlines: async (nowMs, limit) => {
          expect(nowMs).toBe(12_000);
          expect(limit).toBe(100);
          return [
            { sessionId: 'session-1', deadlineMs: 10_000 },
            { sessionId: 'session-2', deadlineMs: 11_000 },
          ];
        },
        disconnectExpiredSession: async (deadline) => {
          observed.push(deadline);
          return deadline.sessionId === 'session-1' ? 'disconnected' : 'reconciled';
        },
      },
    });

    await expect(sweeper.sweepOnce()).resolves.toEqual({
      candidates: 2,
      disconnected: 1,
      reconciled: 1,
      unchanged: 0,
    });
    expect(observed).toHaveLength(2);
  });

  it('stops processing after the service is stopped', async () => {
    let searches = 0;
    const sweeper = createPresenceSweeper({
      now: () => 12_000,
      batchSize: 100,
      repository: {
        findExpiredHeartbeatDeadlines: async () => {
          searches += 1;
          return [];
        },
        disconnectExpiredSession: async () => 'unchanged',
      },
    });

    sweeper.stop();
    await expect(sweeper.sweepOnce()).resolves.toEqual({
      candidates: 0,
      disconnected: 0,
      reconciled: 0,
      unchanged: 0,
    });
    expect(searches).toBe(0);
  });
});
