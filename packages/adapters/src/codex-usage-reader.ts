import { NodeTranscriptFileSystem } from './node-collaborators.js';
import type {
  TranscriptReader,
  TranscriptReaderOptions,
  TranscriptScanInput,
} from './transcript-reader.js';
import type {
  TranscriptFileSystem,
  TranscriptScanCursor,
  TranscriptScanResult,
  TranscriptUsageObservation,
} from './types.js';

/**
 * Reads Codex rollout transcripts and returns one usage observation per response.
 *
 * The same shape the Claude transcript reader emits, so the daemon's vendor-
 * generic ingest service attributes and persists Codex usage identically — only
 * the record parsing differs. Codex writes JSONL rollouts under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and the fields it uses are:
 *
 * - `session_meta.payload.session_id` — the stable logical session id, which is
 *   also what `resolveCodexFromDisk` declares as the native ref, so it is the
 *   join key. It appears again on every `token_usage_record.payload.session_id`.
 * - `token_usage_record` — one per response, carrying `payload.response_id`
 *   (the dedupe key) and `payload.usage` counters.
 * - `turn_context.payload.model` — the model in force, tracked as the walk
 *   proceeds so each response's usage carries the model that produced it.
 *
 * Codex's `input_tokens` is the whole prompt including the cached and freshly
 * written parts, unlike Claude's split counters, so the fresh input is
 * `input_tokens - cached_input_tokens - cache_write_input_tokens`. Mapping it
 * this way makes the dashboard's context size (input + cache) equal Codex's own
 * `input_tokens`, and never double-counts the cache.
 *
 * Counters and identifiers only: it never returns, stores or logs prompt or
 * response text, and it executes nothing it finds.
 */

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_SCAN = 2_000;
const DEFAULT_MAX_MALFORMED_LINES_PER_FILE = 100;
const DEFAULT_MAX_DEPTH = 8;

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

type CodexUsage = {
  nativeSessionId: string;
  requestId: string;
  observedAt: string;
  model: string | undefined;
  total: number;
  observation: TranscriptUsageObservation;
};

/** Parses one `token_usage_record` line into an observation, else `undefined`. */
function extractUsage(
  record: Record<string, unknown>,
  model: string | undefined,
): CodexUsage | undefined {
  if (record['type'] !== 'token_usage_record') return undefined;
  const observedAt = optionalString(record['timestamp']);
  const payload = asRecord(record['payload']);
  if (observedAt === undefined || payload === undefined) return undefined;

  const nativeSessionId = optionalString(payload['session_id']);
  const requestId = optionalString(payload['response_id']);
  const usage = asRecord(payload['usage']);
  if (nativeSessionId === undefined || requestId === undefined || usage === undefined) {
    return undefined;
  }

  const totalInput = nonNegativeInteger(usage['input_tokens']);
  const cacheRead = nonNegativeInteger(usage['cached_input_tokens']);
  const cacheCreation = nonNegativeInteger(usage['cache_write_input_tokens']);
  // `input_tokens` already includes the cached and freshly written parts; the
  // fresh remainder is what Claude reports as `input_tokens`. Clamp at zero in
  // case a future record's parts exceed the total.
  const freshInput = Math.max(0, totalInput - cacheRead - cacheCreation);
  const outputTokens = nonNegativeInteger(usage['output_tokens']);

  return {
    nativeSessionId,
    requestId,
    observedAt,
    model,
    total: totalInput + outputTokens,
    observation: {
      nativeSessionId,
      requestId,
      observedAt,
      inputTokens: freshInput,
      outputTokens,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      ...(model === undefined ? {} : { model }),
    },
  };
}

/** The model in force at a `turn_context`/`session_meta`/`world_state` line. */
function extractModel(record: Record<string, unknown>): string | undefined {
  const payload = asRecord(record['payload']);
  if (payload === undefined) return undefined;
  const direct = optionalString(payload['model']);
  if (direct !== undefined) return direct;
  const state = asRecord(payload['state']);
  return state === undefined ? undefined : optionalString(state['model']);
}

export function createCodexUsageReader(options: TranscriptReaderOptions): TranscriptReader {
  const fileSystem: TranscriptFileSystem = options.fileSystem ?? new NodeTranscriptFileSystem();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFilesPerScan = options.maxFilesPerScan ?? DEFAULT_MAX_FILES_PER_SCAN;
  const maxMalformedLinesPerFile =
    options.maxMalformedLinesPerFile ?? DEFAULT_MAX_MALFORMED_LINES_PER_FILE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  async function collectFiles(directory: string, depth: number, into: string[]): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await fileSystem.listDirectory(directory);
    if (entries === undefined) return;
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        await collectFiles(path, depth + 1, into);
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        into.push(path);
      }
    }
  }

  return {
    async scan(input: TranscriptScanInput): Promise<TranscriptScanResult> {
      const result: TranscriptScanResult = {
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

      const root = input.root.replaceAll('\\', '/').replace(/\/$/, '');
      const files: string[] = [];
      await collectFiles(root, 0, files);
      const previousCursors = input.cursors ?? {};

      for (const path of files) {
        if (result.filesScanned >= maxFilesPerScan) {
          result.filesSkippedOverCap += 1;
          continue;
        }
        const stat = await fileSystem.stat(path);
        if (stat === undefined) continue;

        const cursor: TranscriptScanCursor = {
          modifiedAtMs: stat.modifiedAtMs,
          sizeBytes: stat.sizeBytes,
        };
        result.cursors[path] = cursor;
        const previous = previousCursors[path];
        if (
          previous !== undefined &&
          previous.modifiedAtMs === cursor.modifiedAtMs &&
          previous.sizeBytes === cursor.sizeBytes
        ) {
          result.filesSkippedUnchanged += 1;
          continue;
        }

        const file = await fileSystem.readLines(path, maxFileBytes);
        if (file === undefined) continue;
        result.filesScanned += 1;
        if (file.truncated) result.truncatedFiles += 1;

        const winners = new Map<string, CodexUsage>();
        let currentModel: string | undefined;
        let malformedInFile = 0;

        for (const line of file.lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let record: Record<string, unknown> | undefined;
          try {
            const parsed: unknown = JSON.parse(trimmed);
            record = asRecord(parsed);
          } catch {
            malformedInFile += 1;
            result.malformedLines += 1;
            if (malformedInFile >= maxMalformedLinesPerFile) {
              result.filesStoppedMalformedCap += 1;
              break;
            }
            continue;
          }
          if (record === undefined) continue;

          const model = extractModel(record);
          if (model !== undefined) currentModel = model;

          const usage = extractUsage(record, currentModel);
          if (usage !== undefined) {
            const current = winners.get(usage.requestId);
            // One record per response in practice; keep the largest total and
            // resolve a tie to the last, mirroring the Claude reader's rule.
            if (current === undefined || usage.total >= current.total) {
              winners.set(usage.requestId, usage);
            }
          }
        }

        for (const usage of winners.values()) result.observations.push(usage.observation);
      }

      return result;
    },
  };
}
