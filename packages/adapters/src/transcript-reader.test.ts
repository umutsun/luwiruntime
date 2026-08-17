import { describe, expect, it, vi } from 'vitest';

import {
  createTranscriptReader,
  type TranscriptDirectoryEntry,
  type TranscriptFileStat,
  type TranscriptFileSystem,
} from './index.js';

/**
 * Every fixture here is synthesised. No line is copied from a real transcript,
 * and none carries prompt or response text — the reader has no business
 * emitting either, so the fixtures do not model them.
 */
class MemoryTranscriptFileSystem implements TranscriptFileSystem {
  readonly reads: string[] = [];
  readonly #files = new Map<string, { lines: string[]; modifiedAtMs: number }>();

  constructor(files: Record<string, { lines: string[]; modifiedAtMs?: number }>) {
    for (const [path, file] of Object.entries(files)) {
      this.#files.set(path.replaceAll('\\', '/'), {
        lines: file.lines,
        modifiedAtMs: file.modifiedAtMs ?? 1_000,
      });
    }
  }

  async listDirectory(path: string): Promise<TranscriptDirectoryEntry[] | undefined> {
    const prefix = `${path.replaceAll('\\', '/').replace(/\/$/, '')}/`;
    const names = new Map<string, boolean>();
    for (const filePath of this.#files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash === -1) names.set(remainder, false);
      else names.set(remainder.slice(0, slash), true);
    }
    if (names.size === 0) return undefined;
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  async stat(path: string): Promise<TranscriptFileStat | undefined> {
    const file = this.#files.get(path.replaceAll('\\', '/'));
    if (file === undefined) return undefined;
    return {
      modifiedAtMs: file.modifiedAtMs,
      sizeBytes: file.lines.join('\n').length,
    };
  }

  async readLines(
    path: string,
    maxBytes: number,
  ): Promise<{ lines: string[]; truncated: boolean } | undefined> {
    const normalized = path.replaceAll('\\', '/');
    const file = this.#files.get(normalized);
    if (file === undefined) return undefined;
    this.reads.push(normalized);
    const lines: string[] = [];
    let used = 0;
    for (const line of file.lines) {
      if (used + line.length > maxBytes) return { lines, truncated: true };
      used += line.length;
      lines.push(line);
    }
    return { lines, truncated: false };
  }
}

function assistantLine(fields: {
  sessionId?: string;
  requestId?: string;
  timestamp: string;
  model?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
    timestamp: fields.timestamp,
    message: {
      model: fields.model ?? 'claude-opus-5',
      usage: {
        input_tokens: fields.input ?? 2,
        output_tokens: fields.output ?? 100,
        cache_creation_input_tokens: fields.cacheCreation ?? 0,
        cache_read_input_tokens: fields.cacheRead ?? 0,
        // Repeats the same counters per inference step; summing it would
        // double-count on top of the per-request rule.
        iterations: [{ input_tokens: fields.input ?? 2, output_tokens: fields.output ?? 100 }],
      },
    },
  });
}

const root = '/fake/home/.claude/projects';

describe('native transcript reader', () => {
  it('joins on the in-record sessionId, never the filename', async () => {
    // A subagent transcript's filename stem is an agent id, not a session id.
    // Trusting the stem would invent a native session per subagent and lose the
    // tokens from the session that actually spawned the work.
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa/subagents/workflows/wf-1/agent-zzz.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
            output: 738,
            cacheCreation: 18549,
            cacheRead: 22728,
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const result = await reader.scan({ root });

    expect(result.observations).toEqual([
      {
        nativeSessionId: 'session-aaa',
        requestId: 'req-1',
        model: 'claude-opus-5',
        observedAt: '2026-08-17T08:13:20.000Z',
        inputTokens: 2,
        outputTokens: 738,
        cacheCreationInputTokens: 18549,
        cacheReadInputTokens: 22728,
      },
    ]);
  });

  it('emits one observation per request and resolves disagreement by greatest output', async () => {
    // Records of one request routinely disagree; the largest output_tokens is
    // the completed message, and its timestamp is the one attribution uses.
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
            output: 10,
          }),
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:25.000Z',
            output: 738,
          }),
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:22.000Z',
            output: 500,
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const result = await reader.scan({ root });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.outputTokens).toBe(738);
    expect(result.observations[0]?.observedAt).toBe('2026-08-17T08:13:25.000Z');
  });

  it('breaks a tie on the last record in file order', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
            output: 738,
            cacheRead: 1,
          }),
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:29.000Z',
            output: 738,
            cacheRead: 2,
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const result = await reader.scan({ root });

    expect(result.observations[0]?.cacheReadInputTokens).toBe(2);
    expect(result.observations[0]?.observedAt).toBe('2026-08-17T08:13:29.000Z');
  });

  it('counts a malformed line and still parses the rest of the file', async () => {
    // A transcript being appended to while it is read presents a partial final
    // line. That is normal, not a reason to lose the file.
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
          '{"type":"assistant","sessionId":"session-aaa","mess',
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const result = await reader.scan({ root });

    expect(result.observations).toHaveLength(1);
    expect(result.malformedLines).toBe(1);
  });

  it('reports when the malformed-line cap stops a file early', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        lines: [
          '{broken',
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-after-cap',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem, maxMalformedLinesPerFile: 1 });

    const result = await reader.scan({ root });

    expect(result.observations).toEqual([]);
    expect(result.malformedLines).toBe(1);
    expect(result.filesStoppedMalformedCap).toBe(1);
  });

  it('skips records with no sessionId and synthetic model records', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        lines: [
          // Bookkeeping records really do arrive without a sessionId.
          JSON.stringify({ type: 'file-history-delta', timestamp: '2026-08-17T08:13:19.000Z' }),
          assistantLine({
            requestId: 'req-orphan',
            timestamp: '2026-08-17T08:13:19.500Z',
          }),
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-synthetic',
            timestamp: '2026-08-17T08:13:20.000Z',
            model: '<synthetic>',
            input: 0,
            output: 0,
          }),
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:21.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const result = await reader.scan({ root });

    expect(result.observations.map((observation) => observation.requestId)).toEqual(['req-1']);
  });

  it('skips a file whose cursor is unchanged and reports it', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        modifiedAtMs: 5_000,
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const first = await reader.scan({ root });
    const second = await reader.scan({ root, cursors: first.cursors });

    expect(first.filesScanned).toBe(1);
    expect(second.filesScanned).toBe(0);
    expect(second.filesSkippedUnchanged).toBe(1);
    expect(second.observations).toEqual([]);
  });

  it('re-reads a file whose cursor moved', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        modifiedAtMs: 5_000,
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const second = await reader.scan({
      root,
      cursors: { [`${root}/c--proj/session-aaa.jsonl`]: { modifiedAtMs: 1, sizeBytes: 1 } },
    });

    expect(second.filesScanned).toBe(1);
    expect(second.observations).toHaveLength(1);
  });

  it('reports a truncated file rather than letting a bound read as completeness', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-2',
            timestamp: '2026-08-17T08:13:21.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem, maxFileBytes: 400 });

    const result = await reader.scan({ root });

    expect(result.truncatedFiles).toBe(1);
    expect(result.observations.length).toBeLessThan(2);
  });

  it('reports files left unopened by the per-scan cap', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/a.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
        ],
      },
      [`${root}/c--proj/b.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-bbb',
            requestId: 'req-2',
            timestamp: '2026-08-17T08:13:21.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem, maxFilesPerScan: 1 });

    const result = await reader.scan({ root });

    expect(result.filesScanned).toBe(1);
    expect(result.filesSkippedOverCap).toBe(1);
  });

  it('walks every project subdirectory without deriving a directory name', async () => {
    // The same encoding appears with both a capital and a lowercase drive
    // letter on a real machine, so the reader enumerates instead of guessing.
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/C--xampp-a/session-aaa.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
        ],
      },
      [`${root}/c--xampp-b/session-bbb.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-bbb',
            requestId: 'req-2',
            timestamp: '2026-08-17T08:13:21.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const result = await reader.scan({ root });

    expect(result.observations.map((observation) => observation.nativeSessionId).sort()).toEqual([
      'session-aaa',
      'session-bbb',
    ]);
  });

  it('ignores files that are not .jsonl', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.meta.json`]: { lines: ['{"workflow":"x"}'] },
      [`${root}/c--proj/notes.txt`]: { lines: ['ignored'] },
    });
    const reader = createTranscriptReader({ fileSystem });

    const result = await reader.scan({ root });

    expect(result.filesScanned).toBe(0);
    expect(fileSystem.reads).toEqual([]);
  });

  it('is deterministic across repeated scans', async () => {
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
        ],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    const first = await reader.scan({ root });
    const second = await reader.scan({ root });

    expect(first.observations).toEqual(second.observations);
  });

  it('executes nothing it discovers', async () => {
    // A workflow script or .meta.json found beside a transcript is evidence,
    // never something to run.
    const run = vi.fn();
    const fileSystem = new MemoryTranscriptFileSystem({
      [`${root}/c--proj/session-aaa/subagents/workflows/wf-1/agent-zzz.jsonl`]: {
        lines: [
          assistantLine({
            sessionId: 'session-aaa',
            requestId: 'req-1',
            timestamp: '2026-08-17T08:13:20.000Z',
          }),
        ],
      },
      [`${root}/c--proj/session-aaa/subagents/workflows/wf-1/workflow.mjs`]: {
        lines: ['export default () => {}'],
      },
    });
    const reader = createTranscriptReader({ fileSystem });

    await reader.scan({ root });

    expect(run).not.toHaveBeenCalled();
    expect(fileSystem.reads).not.toContain(
      `${root}/c--proj/session-aaa/subagents/workflows/wf-1/workflow.mjs`,
    );
  });

  it('returns an empty result when the transcript root does not exist', async () => {
    const reader = createTranscriptReader({ fileSystem: new MemoryTranscriptFileSystem({}) });

    const result = await reader.scan({ root: '/fake/absent' });

    expect(result.observations).toEqual([]);
    expect(result.filesScanned).toBe(0);
  });
});
