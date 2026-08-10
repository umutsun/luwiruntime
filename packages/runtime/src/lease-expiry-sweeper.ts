export type ExpireLeaseResult = 'expired' | 'unchanged';

export interface LeaseExpiryRepository {
  /** Lease ids whose expiry has passed, oldest first, bounded by `limit`. */
  findDueLeases(nowMs: number, limit: number): Promise<string[]>;
  expireLease(leaseId: string): Promise<ExpireLeaseResult>;
}

export type LeaseExpirySweepResult = {
  candidates: number;
  expired: number;
  unchanged: number;
};

export type LeaseExpirySweeperOptions = {
  now: () => number;
  batchSize: number;
  repository: LeaseExpiryRepository;
};

export interface LeaseExpirySweeper {
  sweepOnce(): Promise<LeaseExpirySweepResult>;
  stop(): void;
}

/**
 * Turns a passed expiry into a released path and a `lease.expired` event.
 *
 * Nothing else does this. A lease is advisory, so its expiry cannot be enforced
 * by a TTL key: the record has to survive expiry to stay readable, and the
 * transition has to emit the event that tells every observer the path is free
 * again. `unchanged` is the normal outcome for a lease the holder released
 * between the scan and the transition, not a failure.
 */
class RuntimeLeaseExpirySweeper implements LeaseExpirySweeper {
  readonly #options: LeaseExpirySweeperOptions;
  #stopped = false;

  constructor(options: LeaseExpirySweeperOptions) {
    this.#options = options;
  }

  async sweepOnce(): Promise<LeaseExpirySweepResult> {
    const result: LeaseExpirySweepResult = { candidates: 0, expired: 0, unchanged: 0 };
    if (this.#stopped) {
      return result;
    }

    const candidates = await this.#options.repository.findDueLeases(
      this.#options.now(),
      this.#options.batchSize,
    );
    result.candidates = candidates.length;
    for (const leaseId of candidates) {
      const outcome = await this.#options.repository.expireLease(leaseId);
      if (outcome === 'expired') {
        result.expired += 1;
      } else {
        result.unchanged += 1;
      }
    }
    return result;
  }

  stop(): void {
    this.#stopped = true;
  }
}

export function createLeaseExpirySweeper(options: LeaseExpirySweeperOptions): LeaseExpirySweeper {
  return new RuntimeLeaseExpirySweeper(options);
}
