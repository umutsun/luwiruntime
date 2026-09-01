import type { TranscriptReader, TranscriptScanCursor } from '@luwi/adapters';
import {
  normalizeLeasePath,
  type NativeSessionBinding,
  type NativeSessionLink,
  type RuntimeStateName,
  type UsageIngestRequest,
} from '@luwi/protocol';
import {
  ApplicationError,
  attributeObservation,
  deriveNativeBindingId,
  type NativeAttribution,
} from '@luwi/runtime';

import type { SessionFileChangeInput } from './intelligence-service.js';

/**
 * Turns native transcript observations into usage records.
 *
 * The join runs in one direction only: an observation names a native session, a
 * declared binding turns that into an interval, and the interval names the LUWI
 * session. When any link in that chain is missing the observation stays unbound
 * and is counted — never assigned to the nearest session, which is the rule
 * ADR 0022 set and ADR 0023 kept.
 *
 * `projectId` and `agentId` come from the session record rather than from the
 * transcript, which knows neither.
 */

export type TranscriptIngestSummary = {
  filesScanned: number;
  filesSkippedUnchanged: number;
  requestsObserved: number;
  ingested: number;
  skippedDuplicate: number;
  skippedNoBinding: number;
  skippedOutsideInterval: number;
  skippedTrimmed: number;
  skippedSessionMissing: number;
  malformedLines: number;
  filesStoppedMalformedCap: number;
  truncatedFiles: number;
  filesSkippedOverCap: number;
  /** Allowlisted mutating tool calls the reader observed (B2). */
  fileChangesObserved: number;
  /** Session-file-change aggregates written and re-projected as graph edges. */
  fileEdgesProjected: number;
  /** File changes whose path resolved inside no registered project. */
  skippedOutsideProject: number;
  /** Mutating tool calls whose paired result never arrived. */
  skippedUnresolved: number;
  /** Path-carrying tool calls outside the mutating allowlist (e.g. Read). */
  skippedUnknownTool: number;
  fileSkippedNoBinding: number;
  fileSkippedOutsideInterval: number;
  fileSkippedTrimmed: number;
  fileSkippedSessionMissing: number;
};

export type TranscriptIngestDependencies = {
  reader: Pick<TranscriptReader, 'scan'>;
  repository: {
    getNativeBinding(bindingId: string): Promise<NativeSessionBinding | null>;
    findNativeLinkAt(bindingId: string, atMs: number): Promise<NativeSessionLink | null>;
  };
  sessions: {
    get(sessionId: string): Promise<{ id: string; projectId: string; agentId: string } | null>;
  };
  projects: {
    list(): Promise<Array<{ id: string; canonicalPath: string }>>;
  };
  intelligence: {
    ingestUsage(input: UsageIngestRequest): Promise<{ id: string }>;
    projectSessionFileChanges(changes: SessionFileChangeInput[]): Promise<number>;
  };
  transcriptRoot: string;
  /** The adapter half of the binding identity and of `sourceEventId`. */
  adapterId: string;
};

export interface TranscriptIngestService {
  ingestOnce(): Promise<TranscriptIngestSummary>;
}

export type TranscriptIngestTickDependencies = {
  runtimeState: () => RuntimeStateName;
  schedule: (work: () => Promise<void>, onError: (error: unknown) => void) => boolean;
  ingestOnce: () => Promise<TranscriptIngestSummary>;
  onComplete: (summary: TranscriptIngestSummary) => void;
  onError: (error: unknown) => void;
};

/** A re-entrancy-safe timer callback that refuses new work outside ready state. */
export function createTranscriptIngestTick(
  dependencies: TranscriptIngestTickDependencies,
): () => void {
  let ingesting = false;

  return () => {
    if (ingesting || dependencies.runtimeState() !== 'ready') return;
    ingesting = true;
    const scheduled = dependencies.schedule(async () => {
      try {
        dependencies.onComplete(await dependencies.ingestOnce());
      } finally {
        ingesting = false;
      }
    }, dependencies.onError);
    if (!scheduled) ingesting = false;
  };
}

function emptySummary(): TranscriptIngestSummary {
  return {
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    requestsObserved: 0,
    ingested: 0,
    skippedDuplicate: 0,
    skippedNoBinding: 0,
    skippedOutsideInterval: 0,
    skippedTrimmed: 0,
    skippedSessionMissing: 0,
    malformedLines: 0,
    filesStoppedMalformedCap: 0,
    truncatedFiles: 0,
    filesSkippedOverCap: 0,
    fileChangesObserved: 0,
    fileEdgesProjected: 0,
    skippedOutsideProject: 0,
    skippedUnresolved: 0,
    skippedUnknownTool: 0,
    fileSkippedNoBinding: 0,
    fileSkippedOutsideInterval: 0,
    fileSkippedTrimmed: 0,
    fileSkippedSessionMissing: 0,
  };
}

function countUnbound(summary: TranscriptIngestSummary, attribution: NativeAttribution): void {
  if (attribution.outcome !== 'unbound') return;
  if (attribution.reason === 'no-binding') summary.skippedNoBinding += 1;
  else if (attribution.reason === 'trimmed') summary.skippedTrimmed += 1;
  else summary.skippedOutsideInterval += 1;
}

function countFileUnbound(summary: TranscriptIngestSummary, attribution: NativeAttribution): void {
  if (attribution.outcome !== 'unbound') return;
  if (attribution.reason === 'no-binding') summary.fileSkippedNoBinding += 1;
  else if (attribution.reason === 'trimmed') summary.fileSkippedTrimmed += 1;
  else summary.fileSkippedOutsideInterval += 1;
}

/**
 * Resolves an absolute transcript path to the registered project that contains
 * it and the project-relative path within it — longest canonical prefix wins,
 * matched case-insensitively on the drive letter (E3). A path inside no project,
 * or the project root itself, resolves to `null`.
 *
 * The absolute prefix match is done here because `normalizeLeasePath` refuses an
 * absolute path; only the stripped relative remainder is handed to it, so the
 * lease domain's normalisation is reused rather than duplicated.
 */
function resolveProjectFile(
  absolutePath: string,
  projects: ReadonlyArray<{ id: string; canonicalPath: string }>,
): { projectId: string; relativePath: string } | null {
  const target = absolutePath.replaceAll('\\', '/');
  const targetLower = target.toLowerCase();
  let best: { id: string; rootLength: number } | null = null;
  for (const project of projects) {
    const root = project.canonicalPath.replaceAll('\\', '/').replace(/\/+$/, '');
    const rootLower = root.toLowerCase();
    if (targetLower === rootLower || targetLower.startsWith(`${rootLower}/`)) {
      if (best === null || root.length > best.rootLength) {
        best = { id: project.id, rootLength: root.length };
      }
    }
  }
  if (best === null) return null;
  const remainder = target.slice(best.rootLength).replace(/^\/+/, '');
  if (remainder === '') return null;
  let relativePath: string;
  try {
    relativePath = normalizeLeasePath(remainder).path;
  } catch {
    return null;
  }
  if (relativePath === '.' || relativePath === '') return null;
  return { projectId: best.id, relativePath };
}

export function createTranscriptIngestService(
  dependencies: TranscriptIngestDependencies,
): TranscriptIngestService {
  // Cursors live for the lifetime of the daemon and only skip unchanged files.
  // Losing them costs a re-read, never a record: the ingest guard refuses a
  // repeated source event and writes nothing.
  let cursors: Record<string, TranscriptScanCursor> = {};
  // A binding lookup per observation would re-read the same hash for every
  // request in a session, so it is memoised for the duration of one scan only.
  const bindings = new Map<string, NativeSessionBinding | null>();

  async function resolveBinding(
    nativeSessionId: string,
  ): Promise<{ bindingId: string; binding: NativeSessionBinding | null }> {
    const bindingId = deriveNativeBindingId({
      adapterId: dependencies.adapterId,
      nativeSessionId,
    });
    if (!bindings.has(bindingId)) {
      bindings.set(bindingId, await dependencies.repository.getNativeBinding(bindingId));
    }
    return { bindingId, binding: bindings.get(bindingId) ?? null };
  }

  async function attribute(observation: {
    nativeSessionId: string;
    observedAt: string;
  }): Promise<NativeAttribution> {
    const { bindingId, binding } = await resolveBinding(observation.nativeSessionId);
    if (binding === null) {
      return attributeObservation({ observedAt: observation.observedAt, binding, link: null });
    }

    const atMs = Date.parse(observation.observedAt);
    const link = Number.isNaN(atMs)
      ? null
      : await dependencies.repository.findNativeLinkAt(bindingId, atMs);

    return attributeObservation({
      observedAt: observation.observedAt,
      binding,
      link,
    });
  }

  return {
    async ingestOnce() {
      const summary = emptySummary();
      bindings.clear();

      const scan = await dependencies.reader.scan({
        root: dependencies.transcriptRoot,
        cursors,
      });
      cursors = scan.cursors;

      summary.filesScanned = scan.filesScanned;
      summary.filesSkippedUnchanged = scan.filesSkippedUnchanged;
      summary.malformedLines = scan.malformedLines;
      summary.filesStoppedMalformedCap = scan.filesStoppedMalformedCap;
      summary.truncatedFiles = scan.truncatedFiles;
      summary.filesSkippedOverCap = scan.filesSkippedOverCap;
      summary.requestsObserved = scan.observations.length;
      summary.fileChangesObserved = scan.fileChangesObserved;
      summary.skippedUnresolved = scan.skippedUnresolved;
      summary.skippedUnknownTool = scan.skippedUnknownTool;

      for (const observation of scan.observations) {
        const attribution = await attribute(observation);
        if (attribution.outcome !== 'bound') {
          countUnbound(summary, attribution);
          continue;
        }

        const session = await dependencies.sessions.get(attribution.sessionId);
        if (session === null) {
          // The interval named a session that cannot be read. That is an
          // inconsistency worth seeing, not an ordinary miss, so it is counted
          // apart from the three attribution reasons.
          summary.skippedSessionMissing += 1;
          continue;
        }

        const request: UsageIngestRequest = {
          projectId: session.projectId,
          agentId: session.agentId,
          sessionId: session.id,
          source: 'adapter-extracted',
          confidence: 'reported',
          inputTokens: observation.inputTokens,
          outputTokens: observation.outputTokens,
          cacheCreationInputTokens: observation.cacheCreationInputTokens,
          cacheReadInputTokens: observation.cacheReadInputTokens,
          observedAt: observation.observedAt,
          sourceEventId: `${dependencies.adapterId}:${observation.nativeSessionId}:${observation.requestId}`,
          metadata: {},
          ...(observation.model === undefined ? {} : { model: observation.model }),
          // cachedInputTokens and totalTokens stay unset: the first enforces a
          // subset invariant Claude's additive counters contradict, and the
          // second would be forced to exclude cache tokens.
        };

        try {
          await dependencies.intelligence.ingestUsage(request);
          summary.ingested += 1;
        } catch (error) {
          if (error instanceof ApplicationError && error.code === 'USAGE_RECORD_DUPLICATE') {
            // Re-reading a transcript is the steady state, not a failure.
            summary.skippedDuplicate += 1;
            continue;
          }
          throw error;
        }
      }

      // The second extraction: attribute each file change the same way usage is
      // attributed (E4), scope it to a registered project (E3), and project the
      // aggregates as SESSION_CHANGED_FILE edges.
      const projects = await dependencies.projects.list();
      const changes: SessionFileChangeInput[] = [];
      for (const observation of scan.fileObservations) {
        const scoped = resolveProjectFile(observation.absolutePath, projects);
        if (scoped === null) {
          summary.skippedOutsideProject += 1;
          continue;
        }
        const attribution = await attribute(observation);
        if (attribution.outcome !== 'bound') {
          countFileUnbound(summary, attribution);
          continue;
        }
        const session = await dependencies.sessions.get(attribution.sessionId);
        if (session === null) {
          summary.fileSkippedSessionMissing += 1;
          continue;
        }
        // The path resolved to a project and the session names one; a change to a
        // file outside the session's own project is not attributed to it.
        if (session.projectId !== scoped.projectId) {
          summary.skippedOutsideProject += 1;
          continue;
        }
        changes.push({
          projectId: scoped.projectId,
          sessionId: session.id,
          relativePath: scoped.relativePath,
          toolName: observation.toolName,
          observedAt: observation.observedAt,
        });
      }
      if (changes.length > 0) {
        summary.fileEdgesProjected =
          await dependencies.intelligence.projectSessionFileChanges(changes);
      }

      return summary;
    },
  };
}
