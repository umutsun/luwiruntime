import { describe, expect, it, vi } from 'vitest';

import { createLeaseExpirySweeper } from './lease-expiry-sweeper.js';

describe('createLeaseExpirySweeper', () => {
  it('expires every due lease and reports the counts separately', async () => {
    const expireLease = vi
      .fn()
      .mockResolvedValueOnce('expired')
      .mockResolvedValueOnce('unchanged')
      .mockResolvedValueOnce('expired');
    const sweeper = createLeaseExpirySweeper({
      now: () => 1_000,
      batchSize: 10,
      repository: {
        findDueLeases: vi.fn().mockResolvedValue(['a', 'b', 'c']),
        expireLease,
      },
    });

    expect(await sweeper.sweepOnce()).toEqual({ candidates: 3, expired: 2, unchanged: 1 });
    expect(expireLease).toHaveBeenCalledTimes(3);
  });

  it('asks for no more than one batch, so one sweep cannot monopolise the connection', async () => {
    const findDueLeases = vi.fn().mockResolvedValue([]);
    const sweeper = createLeaseExpirySweeper({
      now: () => 5_000,
      batchSize: 25,
      repository: { findDueLeases, expireLease: vi.fn() },
    });

    await sweeper.sweepOnce();

    expect(findDueLeases).toHaveBeenCalledWith(5_000, 25);
  });

  /**
   * A lease the holder released between the scan and the transition is
   * `unchanged`, which is an ordinary race and not a fault.
   */
  it('counts an already-gone lease as unchanged rather than failing the sweep', async () => {
    const sweeper = createLeaseExpirySweeper({
      now: () => 1,
      batchSize: 5,
      repository: {
        findDueLeases: vi.fn().mockResolvedValue(['gone']),
        expireLease: vi.fn().mockResolvedValue('unchanged'),
      },
    });

    expect(await sweeper.sweepOnce()).toEqual({ candidates: 1, expired: 0, unchanged: 1 });
  });

  it('does no work once stopped, so shutdown cannot start another transition', async () => {
    const findDueLeases = vi.fn().mockResolvedValue(['a']);
    const sweeper = createLeaseExpirySweeper({
      now: () => 1,
      batchSize: 5,
      repository: { findDueLeases, expireLease: vi.fn() },
    });

    sweeper.stop();

    expect(await sweeper.sweepOnce()).toEqual({ candidates: 0, expired: 0, unchanged: 0 });
    expect(findDueLeases).not.toHaveBeenCalled();
  });
});
