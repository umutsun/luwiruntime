/**
 * A session registers as `starting` and only leaves it when a reader binds — the
 * native-headless bridge poll loop or the LUWI MCP server binding. A session
 * whose reader never binds stays `starting` forever: it keeps heartbeating, so
 * its presence never lapses and the presence sweeper (which only disconnects
 * sessions whose heartbeat deadline expired) never touches it. This reaper is
 * the universal bound on those ghosts, regardless of which spawner created them:
 * a session still `starting` past a grace window is made `disconnected`.
 *
 * It mirrors the presence sweeper's find-then-act shape rather than sharing it,
 * because the two select on different axes — the presence sweeper on an expired
 * heartbeat deadline (a real zset index), this one on `startedAt` age with the
 * status still `starting`.
 */
export type StartingSessionCandidate = {
  sessionId: string;
  projectId: string;
};

export type ReapStartingOutcome = 'reaped' | 'skipped';

export interface StartingSessionReaperRepository {
  /** Sessions whose status is still `starting` and whose `startedAt` is older than `graceMs`. */
  findStartingSessionsPastGrace(
    nowMs: number,
    graceMs: number,
    limit: number,
  ): Promise<StartingSessionCandidate[]>;
  /**
   * Make the candidate `disconnected`, guarded on it still being `starting`. A
   * reader that bound between the find and here leaves the session no longer
   * `starting`, and the transition writes nothing and reports `skipped`.
   */
  reapStartingSession(candidate: StartingSessionCandidate): Promise<ReapStartingOutcome>;
}

export type StartingSessionReapResult = {
  candidates: number;
  reaped: number;
  skipped: number;
};

export type StartingSessionReaperOptions = {
  now: () => number;
  graceMs: number;
  batchSize: number;
  repository: StartingSessionReaperRepository;
};

export interface StartingSessionReaper {
  sweepOnce(): Promise<StartingSessionReapResult>;
  stop(): void;
}

class RuntimeStartingSessionReaper implements StartingSessionReaper {
  readonly #options: StartingSessionReaperOptions;
  #stopped = false;

  constructor(options: StartingSessionReaperOptions) {
    this.#options = options;
  }

  async sweepOnce(): Promise<StartingSessionReapResult> {
    const result: StartingSessionReapResult = {
      candidates: 0,
      reaped: 0,
      skipped: 0,
    };
    if (this.#stopped) {
      return result;
    }

    const candidates = await this.#options.repository.findStartingSessionsPastGrace(
      this.#options.now(),
      this.#options.graceMs,
      this.#options.batchSize,
    );
    result.candidates = candidates.length;

    for (const candidate of candidates) {
      const outcome = await this.#options.repository.reapStartingSession(candidate);
      result[outcome] += 1;
    }

    return result;
  }

  stop(): void {
    this.#stopped = true;
  }
}

export function createStartingSessionReaper(
  options: StartingSessionReaperOptions,
): StartingSessionReaper {
  return new RuntimeStartingSessionReaper(options);
}
