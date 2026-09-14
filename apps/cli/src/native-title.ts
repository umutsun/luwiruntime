import path from 'node:path';

import type { TranscriptFileSystem } from '@luwi/adapters';

/**
 * Reads the human chat title the Claude Code desktop app gives a session.
 *
 * The desktop app stores each chat as
 * `%APPDATA%/Claude/claude-code-sessions/<hashA>/<hashB>/local_<uuid>.json`,
 * carrying a `title` and the `cliSessionId` — the native CLI session uuid.
 * LUWI's native reference for an attached claude-code session is that same
 * cliSessionId, so the title joins to the LUWI session by that id and nothing
 * else. The title is auto-generated after the first turns, so it appears only
 * once the chat has run — which is why the attach polls rather than reads once.
 *
 * Desktop-specific and best-effort: no APPDATA, no store, a missing or
 * unparseable file is simply "no title", never an error. The attach must stay
 * visible whether or not the desktop app is the thing that launched it.
 */

/** The ccd session JSON is small; cap the read so a corrupt file cannot stall. */
const MAX_JSON_BYTES = 262_144;
/** Bound the directory walk so a large store cannot make a poll unbounded. */
const MAX_DIRECTORIES = 500;

export function ccdSessionsDir(
  environment: Record<string, string | undefined>,
): string | undefined {
  const appData = environment['APPDATA'];
  if (appData === undefined || appData === '') return undefined;
  return path.join(appData, 'Claude', 'claude-code-sessions').replace(/\\/g, '/');
}

function titleOf(read: { lines: string[] } | undefined, cliSessionId: string): string | undefined {
  if (read === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.lines.join('\n'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as { cliSessionId?: unknown; title?: unknown };
  if (record.cliSessionId !== cliSessionId) return undefined;
  return typeof record.title === 'string' && record.title.trim() !== '' ? record.title : undefined;
}

/**
 * Finds the desktop chat title for a native CLI session id, returning both the
 * title and the file it came from so a caller can re-read only that file on the
 * next poll instead of walking the whole store again.
 */
export async function findNativeSessionTitle(
  fileSystem: TranscriptFileSystem,
  root: string,
  cliSessionId: string,
  knownPath?: string,
): Promise<{ title: string; filePath: string } | undefined> {
  if (knownPath !== undefined) {
    const title = titleOf(await fileSystem.readLines(knownPath, MAX_JSON_BYTES), cliSessionId);
    if (title !== undefined) return { title, filePath: knownPath };
    // The chat moved or was removed; fall through to a fresh walk.
  }
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_DIRECTORIES) {
    const current = queue.shift() as string;
    visited += 1;
    const entries = await fileSystem.listDirectory(current);
    if (entries === undefined) continue;
    for (const entry of entries) {
      const child = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        queue.push(child);
        continue;
      }
      if (!entry.name.startsWith('local_') || !entry.name.endsWith('.json')) continue;
      const title = titleOf(await fileSystem.readLines(child, MAX_JSON_BYTES), cliSessionId);
      if (title !== undefined) return { title, filePath: child };
    }
  }
  return undefined;
}
