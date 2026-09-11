import { describe, expect, it } from 'vitest';

import { createStartingSessionReaper, type StartingSessionCandidate } from './index.js';

describe('starting session reaper', () => {
  it('uses the injected clock and grace to select and reap candidates', async () => {
    const observed: StartingSessionCandidate[] = [];
    const reaper = createStartingSessionReaper({
      now: () => 200_000,
      graceMs: 180_000,
      batchSize: 100,
      repository: {
        findStartingSessionsPastGrace: async (nowMs, graceMs, limit) => {
          expect(nowMs).toBe(200_000);
          expect(graceMs).toBe(180_000);
          expect(limit).toBe(100);
          return [
            { sessionId: 'session-1', projectId: 'project-1' },
            { sessionId: 'session-2', projectId: 'project-1' },
          ];
        },
        reapStartingSession: async (candidate) => {
          observed.push(candidate);
          return candidate.sessionId === 'session-1' ? 'reaped' : 'skipped';
        },
      },
    });

    await expect(reaper.sweepOnce()).resolves.toEqual({
      candidates: 2,
      reaped: 1,
      skipped: 1,
    });
    expect(observed).toHaveLength(2);
  });

  it('stops processing after the service is stopped', async () => {
    let searches = 0;
    const reaper = createStartingSessionReaper({
      now: () => 200_000,
      graceMs: 180_000,
      batchSize: 100,
      repository: {
        findStartingSessionsPastGrace: async () => {
          searches += 1;
          return [];
        },
        reapStartingSession: async () => 'reaped',
      },
    });

    reaper.stop();
    await expect(reaper.sweepOnce()).resolves.toEqual({
      candidates: 0,
      reaped: 0,
      skipped: 0,
    });
    expect(searches).toBe(0);
  });
});
