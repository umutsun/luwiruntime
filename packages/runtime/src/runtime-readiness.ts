import type { RuntimeStateName } from '@luwi/protocol';

export type MutationSlot = {
  release: () => void;
};

export interface RuntimeReadiness {
  readonly state: RuntimeStateName;
  readonly inFlightMutations: number;
  transitionTo(state: RuntimeStateName): void;
  tryAcquireMutation(): MutationSlot | null;
  beginDraining(): void;
  waitForInFlight(timeoutMs: number): Promise<boolean>;
}

const allowedTransitions: Record<RuntimeStateName, readonly RuntimeStateName[]> = {
  starting: ['recovering', 'stopped'],
  recovering: ['ready', 'degraded', 'draining', 'stopped'],
  ready: ['degraded', 'recovering', 'draining'],
  degraded: ['recovering', 'draining'],
  draining: ['stopped'],
  stopped: [],
};

class RuntimeReadinessState implements RuntimeReadiness {
  #state: RuntimeStateName;
  #inFlightMutations = 0;
  readonly #drainWaiters = new Set<() => void>();

  constructor(initial: RuntimeStateName) {
    this.#state = initial;
  }

  get state(): RuntimeStateName {
    return this.#state;
  }

  get inFlightMutations(): number {
    return this.#inFlightMutations;
  }

  transitionTo(state: RuntimeStateName): void {
    if (!allowedTransitions[this.#state].includes(state)) {
      throw new Error(`Invalid runtime transition: ${this.#state} -> ${state}`);
    }
    this.#state = state;
  }

  tryAcquireMutation(): MutationSlot | null {
    if (this.#state !== 'ready') {
      return null;
    }

    this.#inFlightMutations += 1;
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#inFlightMutations -= 1;
        if (this.#inFlightMutations === 0) {
          for (const waiter of this.#drainWaiters) {
            waiter();
          }
          this.#drainWaiters.clear();
        }
      },
    };
  }

  beginDraining(): void {
    if (this.#state !== 'draining') {
      this.transitionTo('draining');
    }
  }

  async waitForInFlight(timeoutMs: number): Promise<boolean> {
    if (this.#inFlightMutations === 0) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.#drainWaiters.delete(onDrained);
        resolve(drained);
      };
      const onDrained = (): void => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.#drainWaiters.add(onDrained);
    });
  }
}

export function createRuntimeReadiness(initial: RuntimeStateName): RuntimeReadiness {
  return new RuntimeReadinessState(initial);
}
