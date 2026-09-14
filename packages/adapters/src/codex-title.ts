import type { TranscriptFileSystem } from './types.js';

/**
 * Reads the thread name Codex gives a session.
 *
 * Codex keeps one JSONL index at `~/.codex/session_index.jsonl`, one
 * `{ id, thread_name, updated_at }` per line, appended when a thread is named
 * and again when it is renamed. Measured 2026-09-14 against every September
 * rollout on this machine: `id` is the logical `session_id` (the root of a resume
 * chain, which is what `resolveCodexFromDisk` declares as the native ref) — never
 * the per-rollout `id` — and headless `codex exec` sessions are never indexed, so
 * a fleet worker stays untitled without a rule of its own.
 *
 * Best-effort: a missing index, a malformed line or a blank name is "no title".
 */

/** ~70 entries after two months; the cap only keeps a corrupt file from stalling. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

export async function findCodexThreadName(
  fileSystem: Pick<TranscriptFileSystem, 'readLines'>,
  indexPath: string,
  nativeSessionId: string,
): Promise<string | undefined> {
  const read = await fileSystem.readLines(indexPath, MAX_INDEX_BYTES);
  if (read === undefined) return undefined;
  // A rename appends; the newest line for the id is the current name.
  let title: string | undefined;
  for (const line of read.lines) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as { id?: unknown; thread_name?: unknown };
    if (record.id !== nativeSessionId) continue;
    if (typeof record.thread_name === 'string' && record.thread_name.trim() !== '') {
      title = record.thread_name;
    }
  }
  return title;
}
