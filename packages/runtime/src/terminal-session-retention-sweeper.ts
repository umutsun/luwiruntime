/**
 * Terminal-session retention (a permanent trim of dead sessions).
 *
 * Sessions register in the observed set and, once terminal, are never trimmed on
 * their own — the presence sweeper and the starting-session reaper only move a
 * session to `disconnected`/`completed`, they never remove it. Left unbounded the
 * set grows without limit (measured live: ~3300 sessions, ~4 online), which
 * inflates every bulk `listSessions` read (retention sweep, reaper, message-target
 * list, native-title resolution) and the Redis snapshot cost. This decides which
 * terminal sessions are old enough to purge, and the sweeper drives the purge in
 * bounded batches; the actual key removal is the repository's own (the same
 * `project-purge` per-session removal), injected as `purge`.
 *
 * Pure policy, no I/O — like the coordinator and presence policies, so the rule is
 * unit-testable in isolation and the daemon only wires the seam.
 */
const TERMINAL_STATUSES = new Set(['completed', 'disconnected']);

export type SessionRetentionObservation = {
  status: string;
  presence: 'online' | 'offline';
  /** The age proxy: a terminal session has no closedAt, and this sits just before it. */
  lastHeartbeatAt: string;
  nowMs: number;
  retentionMs: number;
};

export type SessionRetentionDecision =
  { verdict: 'spare'; reason: 'not-terminal' | 'online' | 'too-recent' } | { verdict: 'purge' };

/**
 * Each guard spares, so the safe direction wins: a non-terminal, online, recent,
 * or unparseable-timestamp session is never purged. Only an old, terminal,
 * offline session with a parseable age past `retentionMs` is purged.
 */
export function evaluateSessionRetention(o: SessionRetentionObservation): SessionRetentionDecision {
  if (!TERMINAL_STATUSES.has(o.status)) return { verdict: 'spare', reason: 'not-terminal' };
  if (o.presence === 'online') return { verdict: 'spare', reason: 'online' };
  // `!(age >= retentionMs)` is NaN-safe: an unparseable timestamp spares the row.
  const age = o.nowMs - Date.parse(o.lastHeartbeatAt);
  if (!(age >= o.retentionMs)) return { verdict: 'spare', reason: 'too-recent' };
  return { verdict: 'purge' };
}

export type TerminalSessionRetentionInput = {
  id: string;
  status: string;
  presence: 'online' | 'offline';
  lastHeartbeatAt: string;
  projectId: string;
  agentId?: string;
};

export type TerminalSessionRetentionSweepResult = {
  examined: number;
  eligible: number;
  purged: number;
  failed: number;
};

export type TerminalSessionRetentionSweeperOptions = {
  now: () => number;
  retentionMs: number;
  batchSize: number;
  /** Removes one terminal session's Redis leaves (the repository's own purge). */
  purge: (session: { id: string; projectId: string; agentId?: string }) => Promise<void>;
};

export interface TerminalSessionRetentionSweeper {
  /**
   * Purges up to `batchSize` eligible sessions from the given snapshot, driven off
   * the caller's already-read `listSessions` result so one poison record is simply
   * absent from the batch, never purged on a failed read. A purge failure is
   * counted and skipped, never allowed to abort the batch.
   */
  sweepOnce(
    sessions: readonly TerminalSessionRetentionInput[],
  ): Promise<TerminalSessionRetentionSweepResult>;
  stop(): void;
}

class RuntimeTerminalSessionRetentionSweeper implements TerminalSessionRetentionSweeper {
  readonly #options: TerminalSessionRetentionSweeperOptions;
  #stopped = false;

  constructor(options: TerminalSessionRetentionSweeperOptions) {
    this.#options = options;
  }

  async sweepOnce(
    sessions: readonly TerminalSessionRetentionInput[],
  ): Promise<TerminalSessionRetentionSweepResult> {
    const result: TerminalSessionRetentionSweepResult = {
      examined: 0,
      eligible: 0,
      purged: 0,
      failed: 0,
    };
    if (this.#stopped) return result;

    const nowMs = this.#options.now();
    result.examined = sessions.length;
    for (const session of sessions) {
      if (this.#stopped) break;
      const decision = evaluateSessionRetention({
        status: session.status,
        presence: session.presence,
        lastHeartbeatAt: session.lastHeartbeatAt,
        nowMs,
        retentionMs: this.#options.retentionMs,
      });
      if (decision.verdict !== 'purge') continue;
      result.eligible += 1;
      if (result.purged + result.failed >= this.#options.batchSize) continue;
      try {
        await this.#options.purge({
          id: session.id,
          projectId: session.projectId,
          ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        });
        result.purged += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  stop(): void {
    this.#stopped = true;
  }
}

export function createTerminalSessionRetentionSweeper(
  options: TerminalSessionRetentionSweeperOptions,
): TerminalSessionRetentionSweeper {
  return new RuntimeTerminalSessionRetentionSweeper(options);
}
