/**
 * Reads the human chat title Antigravity (Google's Gemini IDE, launched here as
 * `agy`) gives a conversation.
 *
 * Antigravity writes no JSON: its live summaries live in a single protobuf file,
 * `~/.gemini/antigravity/agyhub_summaries_proto.pb`, one record per conversation
 * carrying the conversation id, the human title and the workspace uri. The daemon
 * titles an antigravity session by the conversation id its binding already
 * carries — the id the IDE's attach hook declared (`--native-adapter antigravity
 * --native-session <conversationId>`), which is the .pb record key. This reader
 * only maps that id to its title; it never guesses which conversation a session
 * is, so it cannot bind one session to another's conversation.
 *
 * Best-effort and read-only: a missing or unparseable file is "no title", never
 * an error, and nothing here is executed. Protobuf field numbers are a stable
 * contract, so a schema-less wire walk is enough; a layout change degrades to no
 * title rather than a wrong one.
 */

import { firstMessage, firstString, walkMessage } from './protobuf-wire.js';

/** The subset of filesystem access this reader needs; injected for tests. */
export interface AntigravityFileSystem {
  readFileBytes(path: string, maxBytes: number): Promise<Uint8Array | undefined>;
}

export type AntigravitySummary = {
  conversationId: string;
  title: string | undefined;
  workspaceUri: string | undefined;
};

/** The summaries protobuf is small; cap the read so a corrupt file cannot stall. */
const MAX_PB_BYTES = 16 * 1024 * 1024;

function pbPath(agHome: string): string {
  return `${agHome.replace(/\/+$/u, '')}/agyhub_summaries_proto.pb`;
}

/**
 * Parses the summaries protobuf into one record per conversation. The layout,
 * measured on this machine: top-level repeated field 1 is an envelope whose
 * field 1 is the conversation id and field 2 the summary; the summary's field 1
 * is the title and its field 9 the workspace message, whose field 1 is the uri.
 */
async function readSummaries(
  fileSystem: AntigravityFileSystem,
  agHome: string,
): Promise<Map<string, AntigravitySummary>> {
  const bytes = await fileSystem.readFileBytes(pbPath(agHome), MAX_PB_BYTES);
  const summaries = new Map<string, AntigravitySummary>();
  if (bytes === undefined) return summaries;
  const top = walkMessage(bytes);
  for (const envelope of top.get(1) ?? []) {
    if (envelope.bytes === undefined) continue;
    const env = walkMessage(envelope.bytes);
    const conversationId = firstString(env, 1);
    if (conversationId === undefined) continue;
    const summary = firstMessage(env, 2);
    const workspace = summary === undefined ? undefined : firstMessage(summary, 9);
    summaries.set(conversationId, {
      conversationId,
      title: summary === undefined ? undefined : firstString(summary, 1),
      workspaceUri: workspace === undefined ? undefined : firstString(workspace, 1),
    });
  }
  return summaries;
}

export async function findAntigravityTitle(
  fileSystem: AntigravityFileSystem,
  agHome: string,
  conversationId: string,
): Promise<string | undefined> {
  const summaries = await readSummaries(fileSystem, agHome);
  return summaries.get(conversationId)?.title;
}
