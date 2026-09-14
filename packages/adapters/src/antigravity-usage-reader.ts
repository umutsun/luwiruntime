import type { TranscriptScanResult, TranscriptUsageObservation } from './types.js';
import type { TranscriptReader, TranscriptScanInput } from './transcript-reader.js';
import {
  firstMessage,
  firstString,
  firstVarint,
  readVarint,
  walkMessage,
} from './protobuf-wire.js';

/**
 * Reads Antigravity (the Gemini IDE, `agy`) per-generation usage and returns one
 * observation per generation, in the same shape the Claude/Codex readers emit, so
 * the daemon's vendor-generic ingest attributes and persists it identically.
 *
 * Antigravity writes no JSONL: each conversation is a SQLite file
 * `~/.gemini/antigravity/conversations/<conversationId>.db` whose `gen_metadata`
 * table holds one small protobuf record per generation. The join key is the
 * conversation id — the .db filename stem, which is exactly the native reference
 * the IDE's attach hook declared, so the binding resolves the same way (adapterId
 * 'antigravity'). SQLite access is injected behind `AntigravityUsageStore` so the
 * parsing is unit-testable without a database.
 *
 * The field map, measured 2026-09-14 on this machine and validated by internal
 * consistency (`#4.#3 == #4.#9 + #4.#10` on every record; the `#9.#10.#4` context
 * window is a constant 256000):
 * - `#1.#4.#2` — fresh (non-cached) input tokens.
 * - `#1.#4.#5` — cached input tokens reused this turn (absent on the first turn).
 * - `#1.#4.#3` — output tokens (candidates + thoughts).
 * - `#1.#19` — the model.
 * - `#1.#20` — repeated `{ key, value }`, carrying `request_id` (the dedupe key,
 *   unique per generation) and `last_step_index` (the join to the step timestamp).
 *
 * Gemini's implicit caching does not bill cache creation separately, so
 * `cacheCreationInputTokens` is 0. The observation timestamp is the step the
 * generation completed at, read from the `steps` table. Counters and identifiers
 * only: no prompt or response text is returned, stored, or logged.
 */

export type AntigravityGenUsage = {
  requestId: string;
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  lastStepIndex: number | undefined;
};

/** Timestamps live in this epoch-seconds window; token counts never reach it. */
const MIN_EPOCH_SECONDS = 1_700_000_000;
const MAX_EPOCH_SECONDS = 1_850_000_000;

function nonNegativeInt(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Parses one `gen_metadata` record, or undefined when it is not a usage record. */
export function parseGenMetadataUsage(bytes: Uint8Array): AntigravityGenUsage | undefined {
  const outer = walkMessage(bytes);
  const record = firstMessage(outer, 1);
  if (record === undefined) return undefined;

  let requestId: string | undefined;
  let lastStepIndex: number | undefined;
  for (const entry of record.get(20) ?? []) {
    if (entry.bytes === undefined) continue;
    const kv = walkMessage(entry.bytes);
    const key = firstString(kv, 1);
    const value = firstString(kv, 2);
    if (key === 'request_id') requestId = value;
    else if (key === 'last_step_index' && value !== undefined) {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) lastStepIndex = parsed;
    }
  }
  if (requestId === undefined) return undefined;

  const usage = firstMessage(record, 4);
  return {
    requestId,
    model: firstString(record, 19),
    inputTokens: nonNegativeInt(usage && firstVarint(usage, 2)),
    outputTokens: nonNegativeInt(usage && firstVarint(usage, 3)),
    cacheReadInputTokens: nonNegativeInt(usage && firstVarint(usage, 5)),
    cacheCreationInputTokens: 0,
    lastStepIndex,
  };
}

/**
 * The latest epoch-ms timestamp anywhere in a `steps` record's metadata. Step
 * metadata carries protobuf Timestamp messages ({ seconds }); the generation
 * completes at the latest of them. Token-sized varints cannot fall in the epoch
 * window, so a plain deep scan for the largest in-window varint is safe.
 */
export function parseStepTimestampMs(bytes: Uint8Array): number | undefined {
  let best: number | undefined;
  const walk = (buf: Uint8Array, depth: number): void => {
    if (depth > 10) return;
    let pos = 0;
    while (pos < buf.length) {
      const [tag, afterTag] = readVarint(buf, pos);
      pos = afterTag;
      const wire = Number(tag & 7n);
      if (Number(tag >> 3n) === 0) return;
      if (wire === 0) {
        const [value, next] = readVarint(buf, pos);
        pos = next;
        const seconds = Number(value);
        if (seconds >= MIN_EPOCH_SECONDS && seconds <= MAX_EPOCH_SECONDS) {
          if (best === undefined || seconds > best) best = seconds;
        }
      } else if (wire === 2) {
        const [len, afterLen] = readVarint(buf, pos);
        const end = afterLen + Number(len);
        if (end > buf.length) return;
        walk(buf.subarray(afterLen, end), depth + 1);
        pos = end;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else {
        return;
      }
    }
  };
  walk(bytes, 0);
  return best === undefined ? undefined : best * 1000;
}

/** One conversation database and its change cursor. */
export type AntigravityConversation = {
  conversationId: string;
  path: string;
  modifiedAtMs: number;
  sizeBytes: number;
};

export type AntigravityConversationData = {
  /** The `gen_metadata` blobs, in generation order. */
  genMetadata: Uint8Array[];
  /** `steps.idx` → the step's metadata blob, for timestamp resolution. */
  stepMetadata: Map<number, Uint8Array>;
};

/**
 * SQLite access, injected so the reader's parsing and orchestration are testable
 * without a real database. The Node implementation opens each `.db` read-only
 * once per conversation.
 */
export interface AntigravityUsageStore {
  listConversations(root: string): Promise<AntigravityConversation[]>;
  readConversation(path: string): Promise<AntigravityConversationData>;
}

export type AntigravityUsageReaderOptions = {
  store: AntigravityUsageStore;
  maxFilesPerScan?: number;
};

const DEFAULT_MAX_FILES_PER_SCAN = 2_000;

function emptyResult(): TranscriptScanResult {
  return {
    observations: [],
    fileObservations: [],
    cursors: {},
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    malformedLines: 0,
    filesStoppedMalformedCap: 0,
    truncatedFiles: 0,
    filesSkippedOverCap: 0,
    fileChangesObserved: 0,
    skippedUnresolved: 0,
    skippedUnknownTool: 0,
  };
}

export function createAntigravityUsageReader(
  options: AntigravityUsageReaderOptions,
): TranscriptReader {
  const maxFiles = options.maxFilesPerScan ?? DEFAULT_MAX_FILES_PER_SCAN;

  return {
    async scan(input: TranscriptScanInput): Promise<TranscriptScanResult> {
      const result = emptyResult();
      const priorCursors = input.cursors ?? {};
      const conversations = await options.store.listConversations(input.root);

      let filesConsidered = 0;
      for (const conversation of conversations) {
        if (filesConsidered >= maxFiles) {
          result.filesSkippedOverCap += 1;
          continue;
        }
        filesConsidered += 1;

        const prior = priorCursors[conversation.path];
        const cursor = {
          modifiedAtMs: conversation.modifiedAtMs,
          sizeBytes: conversation.sizeBytes,
        };
        // A conversation whose file is byte-for-byte unchanged has no new
        // generations; carry its cursor forward and skip the read.
        if (
          prior !== undefined &&
          prior.modifiedAtMs === cursor.modifiedAtMs &&
          prior.sizeBytes === cursor.sizeBytes
        ) {
          result.cursors[conversation.path] = cursor;
          result.filesSkippedUnchanged += 1;
          continue;
        }

        result.cursors[conversation.path] = cursor;
        result.filesScanned += 1;
        const { genMetadata, stepMetadata } = await options.store.readConversation(
          conversation.path,
        );
        for (const blob of genMetadata) {
          const usage = parseGenMetadataUsage(blob);
          if (usage === undefined) {
            result.malformedLines += 1;
            continue;
          }
          const stepBytes =
            usage.lastStepIndex === undefined ? undefined : stepMetadata.get(usage.lastStepIndex);
          const observedAtMs =
            stepBytes === undefined ? undefined : parseStepTimestampMs(stepBytes);
          // A generation with no resolvable timestamp cannot be placed in a
          // session's link window, so it is counted and left unattributed.
          if (observedAtMs === undefined) {
            result.malformedLines += 1;
            continue;
          }
          const observation: TranscriptUsageObservation = {
            nativeSessionId: conversation.conversationId,
            requestId: usage.requestId,
            observedAt: new Date(observedAtMs).toISOString(),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            ...(usage.model === undefined ? {} : { model: usage.model }),
          };
          result.observations.push(observation);
        }
      }
      return result;
    },
  };
}
