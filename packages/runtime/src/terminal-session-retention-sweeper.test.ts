import { describe, expect, it, vi } from 'vitest';

import {
  createTerminalSessionRetentionSweeper,
  evaluateSessionRetention,
  type TerminalSessionRetentionInput,
} from './terminal-session-retention-sweeper.js';

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;

const obs = (over: Partial<Parameters<typeof evaluateSessionRetention>[0]> = {}) => ({
  status: 'completed',
  presence: 'offline' as const,
  lastHeartbeatAt: new Date(NOW - 48 * HOUR).toISOString(),
  nowMs: NOW,
  retentionMs: 24 * HOUR,
  ...over,
});

describe('evaluateSessionRetention', () => {
  it('purges an old, terminal, offline session', () => {
    expect(evaluateSessionRetention(obs())).toEqual({ verdict: 'purge' });
    expect(evaluateSessionRetention(obs({ status: 'disconnected' }))).toEqual({ verdict: 'purge' });
  });

  it('spares a session that is not terminal', () => {
    for (const status of ['starting', 'idle', 'thinking', 'blocked', 'waiting_for_input']) {
      expect(evaluateSessionRetention(obs({ status }))).toEqual({
        verdict: 'spare',
        reason: 'not-terminal',
      });
    }
  });

  it('spares an online session even if the record looks terminal (defense in depth)', () => {
    expect(evaluateSessionRetention(obs({ presence: 'online' }))).toEqual({
      verdict: 'spare',
      reason: 'online',
    });
  });

  it('spares a terminal session younger than the retention age', () => {
    expect(
      evaluateSessionRetention(obs({ lastHeartbeatAt: new Date(NOW - HOUR).toISOString() })),
    ).toEqual({ verdict: 'spare', reason: 'too-recent' });
  });

  it('spares a session whose timestamp cannot be parsed (NaN age never exceeds retention)', () => {
    expect(evaluateSessionRetention(obs({ lastHeartbeatAt: 'not-a-date' }))).toEqual({
      verdict: 'spare',
      reason: 'too-recent',
    });
  });
});

const session = (
  over: Partial<TerminalSessionRetentionInput> = {},
): TerminalSessionRetentionInput => ({
  id: 's-old',
  status: 'completed',
  presence: 'offline',
  lastHeartbeatAt: new Date(NOW - 48 * HOUR).toISOString(),
  projectId: 'p1',
  agentId: 'a1',
  ...over,
});

describe('createTerminalSessionRetentionSweeper', () => {
  const make = (
    purge: (s: { id: string; projectId: string; agentId?: string }) => Promise<void>,
    batchSize = 500,
  ) =>
    createTerminalSessionRetentionSweeper({
      now: () => NOW,
      retentionMs: 24 * HOUR,
      batchSize,
      purge,
    });

  it('purges only the eligible sessions and spares the rest', async () => {
    const purged: string[] = [];
    const sweeper = make(async (s) => {
      purged.push(s.id);
    });

    const result = await sweeper.sweepOnce([
      session({ id: 'old-completed' }),
      session({ id: 'old-disconnected', status: 'disconnected' }),
      session({ id: 'live', status: 'idle' }),
      session({ id: 'online-terminal', presence: 'online' }),
      session({ id: 'recent', lastHeartbeatAt: new Date(NOW - HOUR).toISOString() }),
    ]);

    expect(purged.sort()).toEqual(['old-completed', 'old-disconnected']);
    expect(result).toEqual({ examined: 5, eligible: 2, purged: 2, failed: 0 });
  });

  it('passes the project and agent context to purge', async () => {
    const purge = vi.fn().mockResolvedValue(undefined);
    await make(purge).sweepOnce([session({ id: 's', projectId: 'proj', agentId: 'agent' })]);
    expect(purge).toHaveBeenCalledWith({ id: 's', projectId: 'proj', agentId: 'agent' });
  });

  it('bounds the work to batchSize eligible sessions per sweep', async () => {
    const purged: string[] = [];
    const many = Array.from({ length: 10 }, (_, i) => session({ id: `s${i}` }));
    const result = await make(async (s) => {
      purged.push(s.id);
    }, 3).sweepOnce(many);

    expect(result).toEqual({ examined: 10, eligible: 10, purged: 3, failed: 0 });
    expect(purged).toHaveLength(3);
  });

  it('counts a failed purge and keeps going instead of aborting the batch', async () => {
    const purged: string[] = [];
    const sweeper = make(async (s) => {
      if (s.id === 'boom') throw new Error('redis hiccup');
      purged.push(s.id);
    });

    const result = await sweeper.sweepOnce([
      session({ id: 'ok-1' }),
      session({ id: 'boom' }),
      session({ id: 'ok-2' }),
    ]);

    expect(purged.sort()).toEqual(['ok-1', 'ok-2']);
    expect(result).toEqual({ examined: 3, eligible: 3, purged: 2, failed: 1 });
  });

  it('does nothing once stopped', async () => {
    const purge = vi.fn().mockResolvedValue(undefined);
    const sweeper = make(purge);
    sweeper.stop();
    const result = await sweeper.sweepOnce([session()]);
    expect(purge).not.toHaveBeenCalled();
    expect(result).toEqual({ examined: 0, eligible: 0, purged: 0, failed: 0 });
  });
});
