import type { NativeSessionBinding, RuntimeStateName, SessionView } from '@luwi/protocol';

/**
 * Mirrors a vendor's own chat title onto its LUWI session, server-side.
 *
 * Each vendor names a session somewhere local and keys it by the same native
 * session id the session declared as its binding: the Claude Code desktop app
 * stores a `title` under `%APPDATA%/Claude/claude-code-sessions/**` keyed by the
 * cliSessionId, and Codex appends a `thread_name` to `~/.codex/session_index.jsonl`
 * keyed by the logical session id. So for any live session that carries a `main`
 * binding for an adapter with a title source and has no title yet, the daemon
 * reads that title locally and writes it into the session metadata the dashboard
 * already renders (`metadata.title`). One place, no client poll.
 *
 * Deliberately conservative, because the only write channel here is the session
 * heartbeat, which also renews presence:
 * - **Online, non-terminal sessions only** — never re-assert liveness for an
 *   offline or completed session.
 * - **Only when the title is absent** — at most one write per session lifetime
 *   (titles are stable on disk), so a scan cannot sustain a dead session, and it
 *   never fights the CLI attach poller that may already own the title.
 * - **Best-effort per session** — a missing store, a missing binding, or a write
 *   that races a close is counted, never thrown, so one session cannot abort the
 *   scan.
 */

export type NativeTitleSummary = {
  sessionsScanned: number;
  candidates: number;
  titlesResolved: number;
  titlesWritten: number;
  skippedNotLive: number;
  skippedHasTitle: number;
  skippedNoBinding: number;
  skippedNoSource: number;
  skippedNoTitleOnDisk: number;
  writeErrors: number;
};

/** Answers the vendor's title for a native session id, or undefined for "none yet". */
export type NativeTitleSource = (nativeSessionId: string) => Promise<string | undefined>;

export type NativeTitleDependencies = {
  /** One source per adapter id; a binding whose adapter has no source is skipped. */
  sources: Readonly<Record<string, NativeTitleSource>>;
  repository: {
    listSessions(): Promise<SessionView[]>;
    getSessionNativeBindingId(sessionId: string): Promise<string | null>;
    getNativeBinding(bindingId: string): Promise<NativeSessionBinding | null>;
  };
  /** Writes `metadata` onto the session via the heartbeat path (full replacement). */
  setTitle: (sessionId: string, metadata: SessionView['metadata']) => Promise<void>;
};

export interface NativeTitleService {
  resolveOnce(): Promise<NativeTitleSummary>;
}

function hasTitle(metadata: Record<string, unknown>): boolean {
  const title = metadata['title'];
  return typeof title === 'string' && title.trim() !== '';
}

function emptySummary(): NativeTitleSummary {
  return {
    sessionsScanned: 0,
    candidates: 0,
    titlesResolved: 0,
    titlesWritten: 0,
    skippedNotLive: 0,
    skippedHasTitle: 0,
    skippedNoBinding: 0,
    skippedNoSource: 0,
    skippedNoTitleOnDisk: 0,
    writeErrors: 0,
  };
}

export function createNativeTitleService(
  dependencies: NativeTitleDependencies,
): NativeTitleService {
  const { sources, repository, setTitle } = dependencies;

  return {
    async resolveOnce(): Promise<NativeTitleSummary> {
      const summary = emptySummary();
      if (Object.keys(sources).length === 0) return summary;

      const sessions = await repository.listSessions();
      for (const session of sessions) {
        summary.sessionsScanned += 1;

        // Only live sessions: the heartbeat write renews presence, so never touch
        // an offline or terminal session.
        if (session.presence !== 'online' || session.status === 'completed') {
          summary.skippedNotLive += 1;
          continue;
        }
        // The attach poller may already own the title; a title on disk is stable,
        // so one write per session is enough. Either way, don't overwrite.
        if (hasTitle(session.metadata)) {
          summary.skippedHasTitle += 1;
          continue;
        }
        summary.candidates += 1;

        const bindingId = await repository.getSessionNativeBindingId(session.id);
        if (bindingId === null) {
          summary.skippedNoBinding += 1;
          continue;
        }
        const binding = await repository.getNativeBinding(bindingId);
        const source = binding === null ? undefined : sources[binding.adapterId];
        if (binding === null || source === undefined || binding.kind !== 'main') {
          summary.skippedNoSource += 1;
          continue;
        }

        const title = await source(binding.nativeSessionId);
        if (title === undefined) {
          summary.skippedNoTitleOnDisk += 1;
          continue;
        }
        summary.titlesResolved += 1;

        try {
          await setTitle(session.id, { ...session.metadata, title });
          summary.titlesWritten += 1;
        } catch {
          // A write that races a close (or any transient repo error) must not
          // abort the scan; the next tick retries a still-live, still-untitled one.
          summary.writeErrors += 1;
        }
      }
      return summary;
    },
  };
}

export type NativeTitleTickDependencies = {
  runtimeState: () => RuntimeStateName;
  schedule: (work: () => Promise<void>, onError: (error: unknown) => void) => boolean;
  resolveOnce: () => Promise<NativeTitleSummary>;
  onComplete: (summary: NativeTitleSummary) => void;
  onError: (error: unknown) => void;
};

/** A re-entrancy-safe timer callback that refuses new work outside ready state. */
export function createNativeTitleTick(dependencies: NativeTitleTickDependencies): () => void {
  let resolving = false;

  return () => {
    if (resolving || dependencies.runtimeState() !== 'ready') return;
    resolving = true;
    const scheduled = dependencies.schedule(async () => {
      try {
        dependencies.onComplete(await dependencies.resolveOnce());
      } finally {
        resolving = false;
      }
    }, dependencies.onError);
    if (!scheduled) resolving = false;
  };
}
