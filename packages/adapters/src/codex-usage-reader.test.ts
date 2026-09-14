import { describe, expect, it } from 'vitest';

import { createCodexUsageReader } from './codex-usage-reader.js';
import type {
  TranscriptDirectoryEntry,
  TranscriptFileStat,
  TranscriptFileSystem,
} from './types.js';

/** A one-file store under `<root>/2026/09/14/rollout-*.jsonl`. */
function store(lines: unknown[]): TranscriptFileSystem {
  const root = 'C:/home/.codex/sessions';
  const file = `${root}/2026/09/14/rollout-x.jsonl`;
  const tree: Record<string, TranscriptDirectoryEntry[]> = {
    [root]: [{ name: '2026', isDirectory: true }],
    [`${root}/2026`]: [{ name: '09', isDirectory: true }],
    [`${root}/2026/09`]: [{ name: '14', isDirectory: true }],
    [`${root}/2026/09/14`]: [{ name: 'rollout-x.jsonl', isDirectory: false }],
  };
  return {
    async listDirectory(path: string) {
      return tree[path];
    },
    async stat(path: string): Promise<TranscriptFileStat | undefined> {
      return path === file ? { modifiedAtMs: 1, sizeBytes: 100 } : undefined;
    },
    async readLines(path: string) {
      return path === file
        ? { lines: lines.map((line) => JSON.stringify(line)), truncated: false }
        : undefined;
    },
  };
}

const meta = { type: 'session_meta', payload: { session_id: 'sess-1', id: 'file-1' } };
const turn = { type: 'turn_context', payload: { model: 'codex-auto-review' } };
const usage = (responseId: string, u: Record<string, number>) => ({
  timestamp: '2026-09-14T12:00:00.000Z',
  type: 'token_usage_record',
  payload: { session_id: 'sess-1', response_id: responseId, usage: u },
});

describe('createCodexUsageReader', () => {
  it('maps codex usage to the Claude-shaped observation and joins on session_id', async () => {
    const reader = createCodexUsageReader({
      fileSystem: store([
        meta,
        turn,
        usage('resp-1', {
          input_tokens: 19932,
          cached_input_tokens: 4864,
          cache_write_input_tokens: 0,
          output_tokens: 189,
          reasoning_output_tokens: 122,
          total_tokens: 20121,
        }),
      ]),
    });
    const result = await reader.scan({ root: 'C:/home/.codex/sessions' });
    expect(result.observations).toEqual([
      {
        nativeSessionId: 'sess-1',
        requestId: 'resp-1',
        observedAt: '2026-09-14T12:00:00.000Z',
        inputTokens: 15068, // 19932 - 4864 - 0 (fresh)
        outputTokens: 189,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 4864,
        model: 'codex-auto-review',
      },
    ]);
    // Context size (input + cache) equals codex's own input_tokens.
    const o = result.observations[0]!;
    expect(o.inputTokens + o.cacheReadInputTokens + o.cacheCreationInputTokens).toBe(19932);
  });

  it('dedupes by response_id keeping the largest total', async () => {
    const reader = createCodexUsageReader({
      fileSystem: store([
        meta,
        usage('resp-1', { input_tokens: 100, output_tokens: 5, total_tokens: 105 }),
        usage('resp-1', { input_tokens: 200, output_tokens: 9, total_tokens: 209 }),
      ]),
    });
    const result = await reader.scan({ root: 'C:/home/.codex/sessions' });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.inputTokens).toBe(200);
  });

  it('skips a record without session_id, response_id, or usage', async () => {
    const reader = createCodexUsageReader({
      fileSystem: store([
        meta,
        { timestamp: 't', type: 'token_usage_record', payload: { response_id: 'r', usage: {} } },
      ]),
    });
    const result = await reader.scan({ root: 'C:/home/.codex/sessions' });
    expect(result.observations).toEqual([]);
  });
});
