import { describe, expect, it, vi } from 'vitest';

import {
  createDaemonRecoveryCoordinator,
  recoverDaemonOwnership,
  runDaemonRecoveryCycle,
  type DaemonRecoveryCycleOutcome,
} from './daemon-ownership-recovery.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function harness(owns: boolean, reacquires: boolean) {
  const ownership = {
    ownsLease: vi.fn(async () => owns),
    reacquire: vi.fn(async () => reacquires),
  };
  const onReacquired = vi.fn();
  const onContended = vi.fn();
  return { ownership, onReacquired, onContended };
}

describe('daemon ownership recovery', () => {
  it('continues without reacquiring when the token is still owned', async () => {
    const h = harness(true, false);

    await expect(recoverDaemonOwnership(h)).resolves.toBe(true);

    expect(h.ownership.reacquire).not.toHaveBeenCalled();
    expect(h.onReacquired).not.toHaveBeenCalled();
    expect(h.onContended).not.toHaveBeenCalled();
  });

  it('continues and reports when a vacant owner key is reacquired', async () => {
    const h = harness(false, true);

    await expect(recoverDaemonOwnership(h)).resolves.toBe(true);

    expect(h.ownership.reacquire).toHaveBeenCalledTimes(1);
    expect(h.onReacquired).toHaveBeenCalledTimes(1);
    expect(h.onContended).not.toHaveBeenCalled();
  });

  it('stops recovery when another owner wins the key', async () => {
    const h = harness(false, false);

    await expect(recoverDaemonOwnership(h)).resolves.toBe(false);

    expect(h.onReacquired).not.toHaveBeenCalled();
    expect(h.onContended).toHaveBeenCalledTimes(1);
  });

  it('lets Redis failures reach the runtime reconnect loop', async () => {
    const h = harness(false, false);
    h.ownership.reacquire.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(recoverDaemonOwnership(h)).rejects.toThrow('Redis unavailable');

    expect(h.onReacquired).not.toHaveBeenCalled();
    expect(h.onContended).not.toHaveBeenCalled();
  });
});

describe('daemon recovery orchestration', () => {
  it('fences a second ownership loss before ready and drains on contention', async () => {
    const rebuildEntered = deferred();
    const continueRebuild = deferred();
    const contended = deferred();
    const ownership = {
      ownsLease: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false),
      reacquire: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    };
    let state: 'recovering' | 'ready' | 'draining' = 'recovering';
    let recoveryRuns = 0;
    let readyTransitions = 0;

    const coordinator = createDaemonRecoveryCoordinator({
      canRecover: () => state !== 'draining',
      onError: vi.fn(),
      runRecovery: async ({ hasPendingRequest }) => {
        recoveryRuns += 1;
        await runDaemonRecoveryCycle({
          ownership,
          canRecover: () => state !== 'draining',
          hasPendingRequest,
          recoverRuntimeState: async () => {
            rebuildEntered.resolve();
            await continueRebuild.promise;
          },
          onReacquired: vi.fn(),
          onContended: () => {
            state = 'draining';
            contended.resolve();
          },
          onReady: () => {
            state = 'ready';
            readyTransitions += 1;
          },
        });
      },
    });

    coordinator.request();
    await rebuildEntered.promise;
    coordinator.request();
    continueRebuild.resolve();
    await contended.promise;
    await Promise.resolve();

    expect(state).toBe('draining');
    expect(readyTransitions).toBe(0);
    expect(recoveryRuns).toBe(1);
  });

  it('coalesces active requests into one pending rerun before becoming ready', async () => {
    const rebuildEntered = deferred();
    const continueRebuild = deferred();
    const ready = deferred();
    const ownership = {
      ownsLease: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      reacquire: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
    };
    const outcomes: DaemonRecoveryCycleOutcome[] = [];
    let recoveryRuns = 0;
    let readyTransitions = 0;

    const coordinator = createDaemonRecoveryCoordinator({
      canRecover: () => true,
      onError: vi.fn(),
      runRecovery: async ({ hasPendingRequest }) => {
        recoveryRuns += 1;
        const run = recoveryRuns;
        outcomes.push(
          await runDaemonRecoveryCycle({
            ownership,
            canRecover: () => true,
            hasPendingRequest,
            recoverRuntimeState: async () => {
              if (run === 1) {
                rebuildEntered.resolve();
                await continueRebuild.promise;
              }
            },
            onReacquired: vi.fn(),
            onContended: vi.fn(),
            onReady: () => {
              readyTransitions += 1;
              ready.resolve();
            },
          }),
        );
      },
    });

    coordinator.request();
    await rebuildEntered.promise;
    coordinator.request();
    coordinator.request();
    coordinator.request();
    continueRebuild.resolve();
    await ready.promise;
    await Promise.resolve();

    expect(outcomes).toEqual(['retry', 'ready']);
    expect(recoveryRuns).toBe(2);
    expect(readyTransitions).toBe(1);
  });

  it.each(['draining', 'stopped'] as const)('ignores requests while %s', async (state) => {
    const runRecovery = vi.fn(async () => undefined);
    const coordinator = createDaemonRecoveryCoordinator({
      canRecover: () => state !== 'draining' && state !== 'stopped',
      onError: vi.fn(),
      runRecovery,
    });

    coordinator.request();
    await Promise.resolve();

    expect(runRecovery).not.toHaveBeenCalled();
  });

  it('routes an unexpected recovery rejection once without starting a rerun storm', async () => {
    const failure = new Error('unexpected recovery failure');
    let state: 'recovering' | 'draining' = 'recovering';
    const onError = vi.fn(() => {
      state = 'draining';
    });
    const runRecovery = vi.fn(async () => {
      throw failure;
    });
    const coordinator = createDaemonRecoveryCoordinator({
      canRecover: () => state !== 'draining',
      onError,
      runRecovery,
    });

    coordinator.request();
    coordinator.request();
    coordinator.request();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(runRecovery).toHaveBeenCalledOnce();
    expect(state).toBe('draining');
  });

  it('skips rebuild when draining starts during the initial ownership check', async () => {
    const initialOwnership = deferred<boolean>();
    let canRecover = true;
    const recoverRuntimeState = vi.fn(async () => undefined);
    const onReady = vi.fn();
    const recovery = runDaemonRecoveryCycle({
      ownership: {
        ownsLease: vi.fn(() => initialOwnership.promise),
        reacquire: vi.fn(async () => false),
      },
      canRecover: () => canRecover,
      hasPendingRequest: () => false,
      recoverRuntimeState,
      onReacquired: vi.fn(),
      onContended: vi.fn(),
      onReady,
    });

    canRecover = false;
    initialOwnership.resolve(true);

    await expect(recovery).resolves.toBe('stopped');
    expect(recoverRuntimeState).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('lets a final ownership Redis failure escape without becoming ready', async () => {
    const ownership = {
      ownsLease: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('Redis unavailable at final fence')),
      reacquire: vi.fn(async () => false),
    };
    const onReady = vi.fn();

    await expect(
      runDaemonRecoveryCycle({
        ownership,
        canRecover: () => true,
        hasPendingRequest: () => false,
        recoverRuntimeState: async () => undefined,
        onReacquired: vi.fn(),
        onContended: vi.fn(),
        onReady,
      }),
    ).rejects.toThrow('Redis unavailable at final fence');

    expect(onReady).not.toHaveBeenCalled();
  });
});
