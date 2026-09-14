import { findNativeSessionTitle, type TranscriptFileSystem } from '@luwi/adapters';
import type { NativeSessionBinding, RuntimeStateName, SessionView } from '@luwi/protocol';

/**
 * Mirrors the Claude Code desktop chat title onto its LUWI session, server-side.
 *
 * The desktop app titles a chat after its first turns and stores it under
 * `%APPDATA%/Claude/claude-code-sessions/**` keyed by the cliSessionId — which is
 * exactly the `nativeSessionId` a claude-code session declares. So for any live
 * session that carries a claude-code `main` binding and has no title yet, the
 * daemon reads that title locally and writes it into the session metadata the
 * dashboard already renders (`metadata.title`). One place, no client poll.
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
  skippedNotClaudeCode: number;
  skippedNoTitleOnDisk: number;
  writeErrors: number;
};

export type NativeTitleDependencies = {
  fileSystem: Pick<TranscriptFileSystem, 'listDirectory' | 'readLines'>;
  /** `ccdSessionsDir(env)`; undefined (no %APPDATA%) makes the scan a no-op. */
  ccdRoot: string | undefined;
  repository: {
    listSessions(): Promise<SessionView[]>;
    getSessionNativeBindingId(sessionId: string): Promise<string | null>;
    getNativeBinding(bindingId: string): Promise<NativeSessionBinding | null>;
  };
  /** Writes `metadata` onto the session via the heartbeat path (full replacement). */
  setTitle: (sessionId: string, metadata: SessionView['metadata']) => Promise<void>;
  /** The adapter half of the binding identity — 'claude-code'. */
  adapterId: string;
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
    skippedNotClaudeCode: 0,
    skippedNoTitleOnDisk: 0,
    writeErrors: 0,
  };
}

export function createNativeTitleService(
  dependencies: NativeTitleDependencies,
): NativeTitleService {
  const { fileSystem, ccdRoot, repository, setTitle, adapterId } = dependencies;

  return {
    async resolveOnce(): Promise<NativeTitleSummary> {
      const summary = emptySummary();
      if (ccdRoot === undefined) return summary;

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
        if (binding === null || binding.adapterId !== adapterId || binding.kind !== 'main') {
          summary.skippedNotClaudeCode += 1;
          continue;
        }

        const found = await findNativeSessionTitle(fileSystem, ccdRoot, binding.nativeSessionId);
        if (found === undefined) {
          summary.skippedNoTitleOnDisk += 1;
          continue;
        }
        summary.titlesResolved += 1;

        try {
          await setTitle(session.id, { ...session.metadata, title: found.title });
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
