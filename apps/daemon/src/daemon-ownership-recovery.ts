import type { DaemonOwnershipLease } from '@luwi/redis';

export type DaemonOwnershipRecoveryOptions = {
  ownership: Pick<DaemonOwnershipLease, 'ownsLease' | 'reacquire'>;
  onReacquired: () => void;
  onContended: () => void;
};

export async function recoverDaemonOwnership(
  options: DaemonOwnershipRecoveryOptions,
): Promise<boolean> {
  if (await options.ownership.ownsLease()) {
    return true;
  }
  if (await options.ownership.reacquire()) {
    options.onReacquired();
    return true;
  }
  options.onContended();
  return false;
}

export type DaemonRecoveryCycleOutcome = 'ready' | 'retry' | 'stopped';

export type DaemonRecoveryCycleOptions = DaemonOwnershipRecoveryOptions & {
  canRecover: () => boolean;
  hasPendingRequest: () => boolean;
  recoverRuntimeState: () => Promise<void>;
  onReady: () => void;
};

export async function runDaemonRecoveryCycle(
  options: DaemonRecoveryCycleOptions,
): Promise<DaemonRecoveryCycleOutcome> {
  if (!options.canRecover()) {
    return 'stopped';
  }
  if (!(await recoverDaemonOwnership(options))) {
    return 'stopped';
  }
  if (!options.canRecover()) {
    return 'stopped';
  }

  await options.recoverRuntimeState();

  if (!options.canRecover()) {
    return 'stopped';
  }
  if (!(await recoverDaemonOwnership(options))) {
    return 'stopped';
  }
  if (!options.canRecover()) {
    return 'stopped';
  }
  if (options.hasPendingRequest()) {
    return 'retry';
  }

  options.onReady();
  return 'ready';
}

export type DaemonRecoveryRunContext = {
  hasPendingRequest: () => boolean;
};

export type DaemonRecoveryCoordinatorOptions = {
  canRecover: () => boolean;
  onError: (error: unknown) => void;
  runRecovery: (context: DaemonRecoveryRunContext) => Promise<void>;
};

export type DaemonRecoveryCoordinator = {
  request: () => void;
};

export function createDaemonRecoveryCoordinator(
  options: DaemonRecoveryCoordinatorOptions,
): DaemonRecoveryCoordinator {
  let pending = false;
  let active: Promise<void> | undefined;

  const runPending = async (): Promise<void> => {
    while (pending && options.canRecover()) {
      pending = false;
      await options.runRecovery({ hasPendingRequest: () => pending });
    }
  };

  const request = (): void => {
    if (!options.canRecover()) {
      return;
    }
    pending = true;
    if (active !== undefined) {
      return;
    }

    active = runPending()
      .catch((error: unknown) => {
        pending = false;
        options.onError(error);
      })
      .finally(() => {
        active = undefined;
        if (pending && options.canRecover()) {
          request();
        }
      });
  };

  return { request };
}
