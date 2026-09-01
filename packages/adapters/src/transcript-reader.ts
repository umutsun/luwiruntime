import type {
  TranscriptFileObservation,
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

/** The mutating tools whose successful calls are file changes (E1). A read-only
 * tool such as `Read` carries a `file_path` too, so an allowlist is the only
 * safe rule — "any tool with a path" would turn every read into a change. */
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

type ToolUse = {
  id: string;
  name: string;
  path: string | undefined;
  nativeSessionId: string;
  observedAt: string;
};

type ToolResult = {
  toolUseId: string;
  isError: boolean;
};

/**
 * Parses one line to a raw record, `undefined` for a blank or non-object line,
 * and throws `SyntaxError` for an unparseable one. A transcript is untrusted
 * input, so the caller checks every field rather than assuming it. Parsing runs
 * once per line and feeds both extractions (E6).
 */
function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new SyntaxError('unparseable transcript line');
  }
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Extracts one request's usage from a parsed record, or `undefined` when the
 * record carries none. Bookkeeping and `<synthetic>` records legitimately do.
 */
function extractUsage(record: Record<string, unknown>): ParsedRecord | undefined {
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

/**
 * Extracts `tool_use` and `tool_result` content blocks from a parsed record.
 * Only the path is ever read out of a tool's input — never `content`,
 * `new_string`, or any other prose it carries (§4). A `tool_use` and its
 * `tool_result` sit on different records, so they are paired by the caller
 * within the file.
 */
function extractToolBlocks(record: Record<string, unknown>): {
  toolUses: ToolUse[];
  toolResults: ToolResult[];
} {
  const toolUses: ToolUse[] = [];
  const toolResults: ToolResult[] = [];

  const message = record['message'];
  if (typeof message !== 'object' || message === null) return { toolUses, toolResults };
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return { toolUses, toolResults };

  const nativeSessionId = optionalString(record['sessionId']);
  const observedAt = optionalString(record['timestamp']);

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const blockRecord = block as Record<string, unknown>;
    const type = blockRecord['type'];

    if (type === 'tool_use') {
      const id = optionalString(blockRecord['id']);
      const name = optionalString(blockRecord['name']);
      // Without the record's own session and timestamp a tool call cannot be
      // attributed, so it is not a usable observation.
      if (
        id === undefined ||
        name === undefined ||
        nativeSessionId === undefined ||
        observedAt === undefined
      ) {
        continue;
      }
      const input = blockRecord['input'];
      let path: string | undefined;
      if (typeof input === 'object' && input !== null) {
        const inputRecord = input as Record<string, unknown>;
        path =
          optionalString(inputRecord['file_path']) ?? optionalString(inputRecord['notebook_path']);
      }
      toolUses.push({ id, name, path, nativeSessionId, observedAt });
    } else if (type === 'tool_result') {
      const toolUseId = optionalString(blockRecord['tool_use_id']);
      if (toolUseId === undefined) continue;
      toolResults.push({ toolUseId, isError: blockRecord['is_error'] === true });
    }
  }

  return { toolUses, toolResults };
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
        // request never spans two. Tool calls accumulate alongside, to be paired
        // by id once the file has been read (E2).
        const winners = new Map<string, ParsedRecord>();
        const toolUses = new Map<string, ToolUse>();
        const toolResults = new Map<string, ToolResult>();
        let malformedInFile = 0;

        for (const line of file.lines) {
          let record: Record<string, unknown> | undefined;
          try {
            record = parseLine(line);
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

          const usage = extractUsage(record);
          if (usage !== undefined) {
            const current = winners.get(usage.requestId);
            // Output accumulates across a streamed response, so the greatest is
            // the completed message; a tie resolves to the last in file order.
            if (
              current === undefined ||
              usage.counters.outputTokens >= current.counters.outputTokens
            ) {
              winners.set(usage.requestId, usage);
            }
          }

          // The second extraction shares this one parse (E6).
          const blocks = extractToolBlocks(record);
          for (const toolUse of blocks.toolUses) toolUses.set(toolUse.id, toolUse);
          for (const toolResult of blocks.toolResults) {
            toolResults.set(toolResult.toolUseId, toolResult);
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

        // A change is an allowlisted mutating tool (E1) whose paired result
        // exists and is not an error (E2). Everything else is counted apart and
        // produces no observation.
        for (const toolUse of toolUses.values()) {
          if (!MUTATING_TOOLS.has(toolUse.name)) {
            // A path-carrying read (e.g. Read) is seen and deliberately not a
            // change; an unrecognised tool is never guessed at.
            if (toolUse.path !== undefined) result.skippedUnknownTool += 1;
            continue;
          }
          if (toolUse.path === undefined) continue;
          const toolResult = toolResults.get(toolUse.id);
          if (toolResult === undefined) {
            // The turn was cut off before the result: assuming success would
            // invent evidence and assuming failure would lose it.
            result.skippedUnresolved += 1;
            continue;
          }
          if (toolResult.isError) continue;
          const observation: TranscriptFileObservation = {
            nativeSessionId: toolUse.nativeSessionId,
            toolName: toolUse.name,
            absolutePath: toolUse.path,
            observedAt: toolUse.observedAt,
          };
          result.fileObservations.push(observation);
          result.fileChangesObserved += 1;
        }
      }

      return result;
    },
  };
}
