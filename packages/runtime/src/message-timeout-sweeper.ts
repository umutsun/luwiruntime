export type MessageDeadline = {
  messageId: string;
  deadlineMs: number;
};

export type TimeoutMessageResult = 'timed_out' | 'unchanged';

export interface MessageTimeoutRepository {
  findDueMessageDeadlines(nowMs: number, limit: number): Promise<MessageDeadline[]>;
  timeoutMessage(deadline: MessageDeadline): Promise<TimeoutMessageResult>;
}

export type MessageTimeoutSweepResult = {
  candidates: number;
  timedOut: number;
  unchanged: number;
};

export type MessageTimeoutSweeperOptions = {
  now: () => number;
  batchSize: number;
  repository: MessageTimeoutRepository;
};

export interface MessageTimeoutSweeper {
  sweepOnce(): Promise<MessageTimeoutSweepResult>;
  stop(): void;
}

class RuntimeMessageTimeoutSweeper implements MessageTimeoutSweeper {
  readonly #options: MessageTimeoutSweeperOptions;
  #stopped = false;

  constructor(options: MessageTimeoutSweeperOptions) {
    this.#options = options;
  }

  async sweepOnce(): Promise<MessageTimeoutSweepResult> {
    const result: MessageTimeoutSweepResult = {
      candidates: 0,
      timedOut: 0,
      unchanged: 0,
    };
    if (this.#stopped) {
      return result;
    }

    const candidates = await this.#options.repository.findDueMessageDeadlines(
      this.#options.now(),
      this.#options.batchSize,
    );
    result.candidates = candidates.length;
    for (const candidate of candidates) {
      const outcome = await this.#options.repository.timeoutMessage(candidate);
      if (outcome === 'timed_out') {
        result.timedOut += 1;
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

export function createMessageTimeoutSweeper(
  options: MessageTimeoutSweeperOptions,
): MessageTimeoutSweeper {
  return new RuntimeMessageTimeoutSweeper(options);
}
