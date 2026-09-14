import { DatabaseSync } from 'node:sqlite';
import { readdir, stat } from 'node:fs/promises';

import type {
  AntigravityConversation,
  AntigravityConversationData,
  AntigravityUsageStore,
} from './antigravity-usage-reader.js';

/**
 * Node SQLite access for the Antigravity usage reader. Each conversation is a
 * `.db`; this opens it read-only, reads the small `gen_metadata` records (the
 * large content blob is excluded by size — usage records are ~1 KB, content is
 * hundreds of KB) and the `steps` metadata for timestamps. Best-effort: a locked,
 * missing or corrupt database yields empty data rather than throwing, because
 * Antigravity may be writing the file while the daemon scans it.
 *
 * ponytail: `gen_metadata` is filtered at < 64 KB to skip the one large content
 * record per conversation; raise the bound if a usage record ever grows past it.
 */
const MAX_USAGE_RECORD_BYTES = 65_536;

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  return undefined;
}

export class NodeAntigravityUsageStore implements AntigravityUsageStore {
  async listConversations(root: string): Promise<AntigravityConversation[]> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const conversations: AntigravityConversation[] = [];
    for (const name of entries) {
      if (!name.endsWith('.db')) continue;
      const path = `${root.replace(/[\\/]+$/u, '')}/${name}`;
      try {
        const stats = await stat(path);
        conversations.push({
          conversationId: name.slice(0, -'.db'.length),
          path,
          modifiedAtMs: stats.mtimeMs,
          sizeBytes: stats.size,
        });
      } catch {
        // A file that vanished between listing and stat is simply skipped.
      }
    }
    return conversations;
  }

  async readConversation(path: string): Promise<AntigravityConversationData> {
    const empty: AntigravityConversationData = { genMetadata: [], stepMetadata: new Map() };
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const genMetadata: Uint8Array[] = [];
      for (const row of db
        .prepare('SELECT data FROM gen_metadata WHERE length(data) < ? ORDER BY idx')
        .all(MAX_USAGE_RECORD_BYTES) as Array<{ data: unknown }>) {
        const bytes = asBytes(row.data);
        if (bytes !== undefined) genMetadata.push(bytes);
      }
      const stepMetadata = new Map<number, Uint8Array>();
      for (const row of db
        .prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL')
        .all() as Array<{ idx: number; metadata: unknown }>) {
        const bytes = asBytes(row.metadata);
        if (bytes !== undefined) stepMetadata.set(Number(row.idx), bytes);
      }
      return { genMetadata, stepMetadata };
    } catch {
      return empty;
    } finally {
      db?.close();
    }
  }
}
