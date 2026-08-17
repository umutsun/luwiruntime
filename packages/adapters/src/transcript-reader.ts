import type {
  TranscriptFileSystem,
  TranscriptScanCursor,
  TranscriptScanResult,
  TranscriptUsageObservation,
} from './types.js';
import { NodeTranscriptFileSystem } from './node-collaborators.js';

/**
 * Reads native transcripts and returns one usage observation per request.
 *
 * Three measured facts shape this reader, and each is easy to get wrong in a way
 * that looks fine:
 *
 * - Subagent transcripts are nested under `<sessionId>/subagents/...` and hold
 *   roughly a ninth of all requests, so the walk is recursive. Their filename
 *   stem is an agent id, so the join key is the in-record `sessionId` and the
 *   filename is nothing at all.
 * - Usage is per `requestId`, not per record: one request spans several records
 *   and summing per record over-counts by 1.88x.
 * - Those repeated records do not always agree, so the winner is stated rather
 *   than left to whichever record happens to be read last.
 *
 * It emits counters and identifiers only. It never returns, stores or logs
 * prompt or response text, and it executes nothing it finds.
 */

export type TranscriptReaderOptions = {
  fileSystem?: TranscriptFileSystem;
  /** Per-file byte cap. A file cut short is reported, never silently trimmed. */
  maxFileBytes?: number;
  maxFilesPerScan?: number;
  maxMalformedLinesPerFile?: number;
  /** Directory recursion depth, guarding against a pathological tree. */
  maxDepth?: number;
};

export type TranscriptScanInput = {
  /** The transcript projects root, enumerated rather than derived. */
  root: string;
  /** Cursors from a previous scan, used only to skip unchanged files. */
  cursors?: Record<string, TranscriptScanCursor>;
};

export interface TranscriptReader {
  scan(input: TranscriptScanInput): Promise<TranscriptScanResult>;
}

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_SCAN = 2_000;
const DEFAULT_MAX_MALFORMED_LINES_PER_FILE = 100;
const DEFAULT_MAX_DEPTH = 8;

type UsageCounters = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

type ParsedRecord = {
  nativeSessionId: string;
  requestId: string;
  observedAt: string;
  model: string | undefined;
  counters: UsageCounters;
};

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Turns one transcript line into a record, or `undefined` when the line carries
 * no attributable usage. A transcript is untrusted input: every field is checked
 * rather than assumed.
 */
function parseRecord(line: string): ParsedRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new SyntaxError('unparseable transcript line');
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const record = value as Record<string, unknown>;
  // The join key. Bookkeeping records legitimately carry none.
  const nativeSessionId = optionalString(record['sessionId']);
  const requestId = optionalString(record['requestId']);
  const observedAt = optionalString(record['timestamp']);
  if (nativeSessionId === undefined || requestId === undefined || observedAt === undefined) {
    return undefined;
  }

  const message = record['message'];
  if (typeof message !== 'object' || message === null) return undefined;
  const messageRecord = message as Record<string, unknown>;

  const model = optionalString(messageRecord['model']);
  // Synthetic records carry all-zero counters and describe no real inference.
  if (model === '<synthetic>') return undefined;

  const usage = messageRecord['usage'];
  if (typeof usage !== 'object' || usage === null) return undefined;
  const usageRecord = usage as Record<string, unknown>;

  return {
    nativeSessionId,
    requestId,
    observedAt,
    model,
    counters: {
      inputTokens: nonNegativeInteger(usageRecord['input_tokens']),
      outputTokens: nonNegativeInteger(usageRecord['output_tokens']),
      cacheCreationInputTokens: nonNegativeInteger(usageRecord['cache_creation_input_tokens']),
      cacheReadInputTokens: nonNegativeInteger(usageRecord['cache_read_input_tokens']),
      // `iterations` repeats these same counters per inference step and is
      // deliberately never summed.
    },
  };
}

export function createTranscriptReader(options: TranscriptReaderOptions): TranscriptReader {
  const fileSystem = options.fileSystem ?? new NodeTranscriptFileSystem();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFilesPerScan = options.maxFilesPerScan ?? DEFAULT_MAX_FILES_PER_SCAN;
  const maxMalformedLinesPerFile =
    options.maxMalformedLinesPerFile ?? DEFAULT_MAX_MALFORMED_LINES_PER_FILE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  async function collectFiles(directory: string, depth: number, into: string[]): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await fileSystem.listDirectory(directory);
    if (entries === undefined) return;
    // Sorted so a scan is deterministic regardless of directory order.
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        await collectFiles(path, depth + 1, into);
      } else if (entry.name.endsWith('.jsonl')) {
        into.push(path);
      }
    }
  }

  return {
    async scan(input) {
      const result: TranscriptScanResult = {
        observations: [],
        cursors: {},
        filesScanned: 0,
        filesSkippedUnchanged: 0,
        malformedLines: 0,
        filesStoppedMalformedCap: 0,
        truncatedFiles: 0,
        filesSkippedOverCap: 0,
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
          // The cursor only skips work. Correctness comes from ingest-side
          // deduplication, so a wrong cursor costs a re-read, never a record.
          result.filesSkippedUnchanged += 1;
          continue;
        }

        const file = await fileSystem.readLines(path, maxFileBytes);
        if (file === undefined) continue;

        result.filesScanned += 1;
        if (file.truncated) result.truncatedFiles += 1;

        // Winners per request, within this file. Grouping is per file because a
        // request never spans two.
        const winners = new Map<string, ParsedRecord>();
        let malformedInFile = 0;

        for (const line of file.lines) {
          let record: ParsedRecord | undefined;
          try {
            record = parseRecord(line);
          } catch {
            malformedInFile += 1;
            result.malformedLines += 1;
            // A file that is mostly unparseable is not a transcript being
            // appended to; stop rather than grind through it.
            if (malformedInFile >= maxMalformedLinesPerFile) {
              result.filesStoppedMalformedCap += 1;
              break;
            }
            continue;
          }
          if (record === undefined) continue;

          const current = winners.get(record.requestId);
          // Output accumulates across a streamed response, so the greatest is
          // the completed message; a tie resolves to the last in file order.
          if (
            current === undefined ||
            record.counters.outputTokens >= current.counters.outputTokens
          ) {
            winners.set(record.requestId, record);
          }
        }

        for (const record of winners.values()) {
          const observation: TranscriptUsageObservation = {
            nativeSessionId: record.nativeSessionId,
            requestId: record.requestId,
            observedAt: record.observedAt,
            inputTokens: record.counters.inputTokens,
            outputTokens: record.counters.outputTokens,
            cacheCreationInputTokens: record.counters.cacheCreationInputTokens,
            cacheReadInputTokens: record.counters.cacheReadInputTokens,
            ...(record.model === undefined ? {} : { model: record.model }),
          };
          result.observations.push(observation);
        }
      }

      return result;
    },
  };
}
