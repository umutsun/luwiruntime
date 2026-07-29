import { describe, expect, it, vi } from 'vitest';

import { createRuntimeReadiness } from './index.js';

describe('runtime readiness', () => {
  it('accepts mutation slots only while ready and releases exactly once', () => {
    const readiness = createRuntimeReadiness('starting');
    expect(readiness.tryAcquireMutation()).toBeNull();

    readiness.transitionTo('recovering');
    readiness.transitionTo('ready');
    const slot = readiness.tryAcquireMutation();

    expect(slot).not.toBeNull();
    expect(readiness.inFlightMutations).toBe(1);

    slot?.release();
    slot?.release();
    expect(readiness.inFlightMutations).toBe(0);
  });

  it('prevents new slots after draining while allowing accepted work to finish', async () => {
    vi.useFakeTimers();
    try {
      const readiness = createRuntimeReadiness('ready');
      const slot = readiness.tryAcquireMutation();

      readiness.beginDraining();
      expect(readiness.state).toBe('draining');
      expect(readiness.tryAcquireMutation()).toBeNull();

      const drained = readiness.waitForInFlight(1000);
      slot?.release();
      await expect(drained).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a bounded drain timeout when work remains in flight', async () => {
    vi.useFakeTimers();
    try {
      const readiness = createRuntimeReadiness('ready');
      readiness.tryAcquireMutation();
      readiness.beginDraining();

      const drained = readiness.waitForInFlight(1000);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(drained).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid lifecycle transitions', () => {
    const readiness = createRuntimeReadiness('starting');
    expect(() => readiness.transitionTo('ready')).toThrow();
    readiness.transitionTo('recovering');
    readiness.transitionTo('ready');
    expect(() => readiness.transitionTo('starting')).toThrow();
  });
});
