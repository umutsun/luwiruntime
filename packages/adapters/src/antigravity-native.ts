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

type WireValue = { wire: number; bytes?: Uint8Array; value?: bigint };

/** Reads a base-128 varint at `pos`, returning the value and the next position. */
function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, p];
}

/**
 * Walks one protobuf message into a field-number → occurrences map. Unknown wire
 * types abort the walk (returning what was parsed), so a non-protobuf buffer is a
 * partial read rather than a throw.
 */
function fields(buf: Uint8Array): Map<number, WireValue[]> {
  const out = new Map<number, WireValue[]>();
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) break;
    let entry: WireValue;
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos);
      pos = next;
      entry = { wire, value };
    } else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, pos);
      const end = afterLen + Number(len);
      if (end > buf.length) break;
      entry = { wire, bytes: buf.subarray(afterLen, end) };
      pos = end;
    } else if (wire === 1) {
      pos += 8;
      entry = { wire };
    } else if (wire === 5) {
      pos += 4;
      entry = { wire };
    } else {
      break;
    }
    const list = out.get(field);
    if (list === undefined) out.set(field, [entry]);
    else list.push(entry);
  }
  return out;
}

function firstBytes(map: Map<number, WireValue[]>, field: number): Uint8Array | undefined {
  return map.get(field)?.[0]?.bytes;
}

function firstString(map: Map<number, WireValue[]>, field: number): string | undefined {
  const bytes = firstBytes(map, field);
  if (bytes === undefined) return undefined;
  const text = Buffer.from(bytes).toString('utf8');
  return text.length === 0 ? undefined : text;
}

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
  const top = fields(bytes);
  for (const envelope of top.get(1) ?? []) {
    if (envelope.bytes === undefined) continue;
    const env = fields(envelope.bytes);
    const conversationId = firstString(env, 1);
    if (conversationId === undefined) continue;
    const summaryBytes = firstBytes(env, 2);
    const summary = summaryBytes === undefined ? undefined : fields(summaryBytes);
    const workspaceBytes = summary === undefined ? undefined : firstBytes(summary, 9);
    summaries.set(conversationId, {
      conversationId,
      title: summary === undefined ? undefined : firstString(summary, 1),
      workspaceUri:
        workspaceBytes === undefined ? undefined : firstString(fields(workspaceBytes), 1),
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
