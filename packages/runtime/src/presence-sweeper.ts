export type HeartbeatDeadline = {
  sessionId: string;
  deadlineMs: number;
};

export type DisconnectExpiredResult = 'disconnected' | 'reconciled' | 'unchanged';

export interface PresenceSweeperRepository {
  findExpiredHeartbeatDeadlines(nowMs: number, limit: number): Promise<HeartbeatDeadline[]>;
  disconnectExpiredSession(deadline: HeartbeatDeadline): Promise<DisconnectExpiredResult>;
}

export type PresenceSweepResult = {
  candidates: number;
  disconnected: number;
  reconciled: number;
  unchanged: number;
};

export type PresenceSweeperOptions = {
  now: () => number;
  batchSize: number;
  repository: PresenceSweeperRepository;
};

export interface PresenceSweeper {
  sweepOnce(): Promise<PresenceSweepResult>;
  stop(): void;
}

class RuntimePresenceSweeper implements PresenceSweeper {
  readonly #options: PresenceSweeperOptions;
  #stopped = false;

  constructor(options: PresenceSweeperOptions) {
    this.#options = options;
  }

  async sweepOnce(): Promise<PresenceSweepResult> {
    const result: PresenceSweepResult = {
      candidates: 0,
      disconnected: 0,
      reconciled: 0,
      unchanged: 0,
    };
    if (this.#stopped) {
      return result;
    }

    const candidates = await this.#options.repository.findExpiredHeartbeatDeadlines(
      this.#options.now(),
      this.#options.batchSize,
    );
    result.candidates = candidates.length;

    for (const candidate of candidates) {
      const outcome = await this.#options.repository.disconnectExpiredSession(candidate);
      result[outcome] += 1;
    }

    return result;
  }

  stop(): void {
    this.#stopped = true;
  }
}

export function createPresenceSweeper(options: PresenceSweeperOptions): PresenceSweeper {
  return new RuntimePresenceSweeper(options);
}
