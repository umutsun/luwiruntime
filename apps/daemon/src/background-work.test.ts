import { describe, expect, it, vi } from 'vitest';

import {
  closeWithinDeadline,
  createBackgroundWorkTracker,
  waitForCompletion,
} from './background-work.js';

describe('background work draining', () => {
  it('stops accepting work and waits for active work to settle', async () => {
    let resolveWork: (() => void) | undefined;
    const tracker = createBackgroundWorkTracker();
    const started = tracker.run(
      () =>
        new Promise<void>((resolve) => {
          resolveWork = resolve;
        }),
      vi.fn(),
    );

    expect(started).toBe(true);
    tracker.stop();
    expect(tracker.run(async () => undefined, vi.fn())).toBe(false);

    const waiting = tracker.waitForIdle(100);
    resolveWork?.();
    await expect(waiting).resolves.toBe(true);
  });

  it('returns at the deadline when work or relay shutdown does not settle', async () => {
    const never = new Promise<void>(() => undefined);
    const tracker = createBackgroundWorkTracker();
    tracker.run(() => never, vi.fn());
    tracker.stop();

    await expect(tracker.waitForIdle(5)).resolves.toBe(false);
    await expect(waitForCompletion(never, 5)).resolves.toBe(false);
  });

  it('forces transport close and returns when application close never settles', async () => {
    const forceClose = vi.fn();
    const close = vi.fn(() => new Promise<void>(() => undefined));

    await expect(closeWithinDeadline(close, forceClose, 5, 5)).resolves.toBe(false);

    expect(close).toHaveBeenCalledTimes(1);
    expect(forceClose).toHaveBeenCalledTimes(1);
  });
});
