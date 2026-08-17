import type {
  TranscriptReader,
  TranscriptScanCursor,
  TranscriptUsageObservation,
} from '@luwi/adapters';
import type {
  NativeSessionBinding,
  NativeSessionLink,
  RuntimeStateName,
  UsageIngestRequest,
} from '@luwi/protocol';
import {
  ApplicationError,
  attributeObservation,
  deriveNativeBindingId,
  type NativeAttribution,
} from '@luwi/runtime';

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
  intelligence: {
    ingestUsage(input: UsageIngestRequest): Promise<{ id: string }>;
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
  };
}

function countUnbound(summary: TranscriptIngestSummary, attribution: NativeAttribution): void {
  if (attribution.outcome !== 'unbound') return;
  if (attribution.reason === 'no-binding') summary.skippedNoBinding += 1;
  else if (attribution.reason === 'trimmed') summary.skippedTrimmed += 1;
  else summary.skippedOutsideInterval += 1;
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

  async function attribute(observation: TranscriptUsageObservation): Promise<NativeAttribution> {
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

      return summary;
    },
  };
}
