import type { NativeSubagent } from '@luwi/protocol';

import type { TranscriptDirectoryEntry, TranscriptFileSystem } from './types.js';

/**
 * Lists the Claude Code subagents a native session is running, read on demand
 * from `<root>/<encoded-cwd>/<nsid>/subagents/[workflows/<wfId>/]agent-<id>.jsonl`
 * (ADR 0038). Nothing is stored, logged or executed.
 *
 * The projects root is enumerated, never derived from a path (the drive-letter
 * case varies), and only listed names that match a strict pattern are opened:
 * no path is ever built from record content. From a transcript only the last
 * tool's name, `cwd`, `gitBranch`, and the structural fields that decide the
 * state (record type, `stop_reason`, tool ids and names) are read; from its meta
 * file only the agent type, description and worktree. Every string is untrusted
 * and capped.
 */

export type ListNativeSubagentsInput = {
  fileSystem: TranscriptFileSystem;
  projectsRoot: string;
  nativeSessionId: string;
  nowMs: number;
  limit?: number;
  maxDirectories?: number;
  tailBytes?: number;
  /** An unfinished transcript written within this window reads `running`, else `quiet`. */
  quietAfterMs?: number;
};

export type NativeSubagentListing = { subagents: NativeSubagent[]; truncated: boolean };

/** A UUID — also what keeps `:` (an NTFS alternate data stream) out of the path. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AGENT_FILE = /^agent-([A-Za-z0-9]{1,64})\.jsonl$/u;
const WORKFLOW_DIR = /^[A-Za-z0-9_-]{1,64}$/u;
const META_MAX_BYTES = 4096;
/** A final record can outgrow the tail (88 KB measured); one wider read finds it. */
const WIDE_TAIL_BYTES = 262_144;
// A text block can precede a tool_use whose input streams for minutes (p99.9 185 s over the
// real transcripts), so a shorter settle reads a still-working agent as finished.
// ponytail: fixed settle; a finished text-only agent reads running this long.
const SETTLED_MS = 180_000;
const STATE_ORDER = { running: 0, quiet: 1, finished: 2 } as const;

type Candidate = { agentId: string; workflowId?: string; directory: string; modifiedAtMs: number };
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Accepts only a string, drops control characters, caps the length. */
function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROL_CHARACTERS, '').trim().slice(0, max);
  return text.length > 0 ? text : undefined;
}

function parse(line: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A record's `message.content` blocks of one type; only ids and names are read from them. */
function contentBlocks(record: JsonRecord): JsonRecord[] {
  const message = record['message'];
  const content = isRecord(message) ? message['content'] : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function blocks(record: JsonRecord, type: 'tool_use' | 'tool_result'): JsonRecord[] {
  return contentBlocks(record).filter((block) => block['type'] === type);
}

/** Whether the last record is a tool result for a call the records do not hold. */
function answersUnseenCall(records: JsonRecord[]): boolean {
  const last = records.at(-1);
  if (last?.['type'] !== 'user') return false;
  const calls = new Set(
    records.flatMap((record) => blocks(record, 'tool_use').map((b) => b['id'])),
  );
  return blocks(last, 'tool_result').some((block) => !calls.has(block['tool_use_id']));
}

/**
 * Whether the last record ends the agent's work: an assistant turn that stopped
 * on its own, the answer to the agent's final `StructuredOutput` call (how a
 * workflow agent ends), or a text-only message with no `stop_reason` that has
 * not been written for `SETTLED_MS` (a streaming turn could still add a tool).
 */
function isFinished(records: JsonRecord[], idleMs: number): boolean {
  const last = records.at(-1);
  if (last === undefined) return false;
  const message = last['message'];
  const stopReason = isRecord(message) ? message['stop_reason'] : undefined;
  if (last['type'] === 'assistant') {
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return true;
    // Text only: a thinking block is its own record and more of the turn follows it.
    const content = contentBlocks(last);
    return (
      stopReason === null &&
      content.length > 0 &&
      content.every((block) => block['type'] === 'text') &&
      idleMs >= SETTLED_MS
    );
  }
  if (last['type'] !== 'user') return false;
  // A rejected call (schema validation failed) is retried, so only a clean answer ends the agent.
  const answered = new Set(
    blocks(last, 'tool_result')
      .filter((block) => block['is_error'] !== true)
      .map((block) => block['tool_use_id']),
  );
  return records.some((record) =>
    blocks(record, 'tool_use').some(
      (block) =>
        block['name'] === 'StructuredOutput' &&
        typeof block['id'] === 'string' &&
        answered.has(block['id']),
    ),
  );
}

export async function listNativeSubagents(
  input: ListNativeSubagentsInput,
): Promise<NativeSubagentListing> {
  const { fileSystem, nativeSessionId, nowMs } = input;
  const limit = input.limit ?? 50;
  const maxDirectories = input.maxDirectories ?? 500;
  const tailBytes = input.tailBytes ?? 32_768;
  const quietAfterMs = input.quietAfterMs ?? 600_000;
  if (!UUID.test(nativeSessionId)) return { subagents: [], truncated: false };

  const root = input.projectsRoot.replaceAll('\\', '/').replace(/\/$/u, '');
  // Keyed by (workflow, agent) so case-variant project directories merge.
  const candidates = new Map<string, Candidate>();
  const collect = async (
    directory: string,
    entries: TranscriptDirectoryEntry[],
    workflowId?: string,
  ): Promise<void> => {
    for (const entry of entries) {
      const agentId = entry.isDirectory ? undefined : AGENT_FILE.exec(entry.name)?.[1];
      if (agentId === undefined) continue;
      const stat = await fileSystem.stat(`${directory}/${entry.name}`);
      if (stat === undefined) continue;
      const key = `${workflowId ?? ''}/${agentId}`;
      const known = candidates.get(key);
      if (known !== undefined && known.modifiedAtMs >= stat.modifiedAtMs) continue;
      candidates.set(key, {
        agentId,
        ...(workflowId === undefined ? {} : { workflowId }),
        directory,
        modifiedAtMs: stat.modifiedAtMs,
      });
    }
  };

  // A directory list longer than its cap is cut, and the listing says so.
  let cut = false;
  const capped = (entries: TranscriptDirectoryEntry[]): TranscriptDirectoryEntry[] => {
    cut ||= entries.length > maxDirectories;
    return entries.slice(0, maxDirectories);
  };

  const projects = (await fileSystem.listDirectory(root)) ?? [];
  for (const project of capped(projects.filter((entry) => entry.isDirectory))) {
    const subagents = `${root}/${project.name}/${nativeSessionId}/subagents`;
    const entries = await fileSystem.listDirectory(subagents);
    if (entries === undefined) continue;
    await collect(subagents, entries);
    if (!entries.some((entry) => entry.isDirectory && entry.name === 'workflows')) continue;
    const workflows = (await fileSystem.listDirectory(`${subagents}/workflows`)) ?? [];
    for (const workflow of capped(
      workflows.filter((entry) => entry.isDirectory && WORKFLOW_DIR.test(entry.name)),
    )) {
      const directory = `${subagents}/workflows/${workflow.name}`;
      await collect(directory, (await fileSystem.listDirectory(directory)) ?? [], workflow.name);
    }
  }

  const recent = [...candidates.values()].sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  const subagents = await Promise.all(
    recent.slice(0, limit).map((candidate) => describe(candidate)),
  );
  subagents.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
  return { subagents, truncated: cut || recent.length > limit };

  /**
   * The tail's whole records. A truncated tail is read once more, wider, when it
   * held no whole record or its last record answers a call it does not hold (a
   * workflow agent's final StructuredOutput call was measured at up to 194 KB).
   */
  async function tailRecords(path: string): Promise<JsonRecord[]> {
    let records: JsonRecord[] = [];
    for (const bytes of [tailBytes, WIDE_TAIL_BYTES]) {
      const tail = await fileSystem.readTail(path, bytes);
      records = (tail?.lines ?? []).map(parse).filter((record) => record !== undefined);
      if (tail?.truncated !== true || (records.length > 0 && !answersUnseenCall(records))) break;
    }
    return records;
  }

  async function describe(candidate: Candidate): Promise<NativeSubagent> {
    const stem = `${candidate.directory}/agent-${candidate.agentId}`;
    const metaRead = await fileSystem.readLines(`${stem}.meta.json`, META_MAX_BYTES);
    const meta = metaRead === undefined ? undefined : parse(metaRead.lines.join('\n'));
    const records = await tailRecords(`${stem}.jsonl`);

    let toolName: string | undefined;
    let cwd: string | undefined;
    let branch: string | undefined;
    for (const record of records.toReversed()) {
      toolName ??= clean(blocks(record, 'tool_use').at(-1)?.['name'], 100);
      cwd ??= clean(record['cwd'], 1024);
      branch ??= clean(record['gitBranch'], 255);
    }

    const idleMs = nowMs - candidate.modifiedAtMs;
    const state = isFinished(records, idleMs)
      ? 'finished'
      : idleMs <= quietAfterMs
        ? 'running'
        : 'quiet';
    const fields = {
      workflowId: candidate.workflowId,
      agentType: clean(meta?.['agentType'], 100),
      description: clean(meta?.['description'], 200),
      lastToolName: toolName,
      workingDirectory: clean(meta?.['worktreePath'], 1024) ?? cwd,
      gitBranch: clean(meta?.['worktreeBranch'], 255) ?? branch,
    };
    return {
      agentId: candidate.agentId,
      state,
      lastActivityAt: new Date(candidate.modifiedAtMs).toISOString(),
      // Absent, not undefined, so the listing carries only what was observed.
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    };
  }
}
