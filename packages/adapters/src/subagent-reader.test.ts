import { describe, expect, it } from 'vitest';

import { listNativeSubagents } from './subagent-reader.js';
import type { TranscriptFileSystem } from './types.js';

/**
 * Every fixture here is synthesised (ADR 0023): no line is copied from a real
 * transcript. A secret string sits in every place the reader must never read —
 * text, thinking, tool input and tool result — so a leak fails loudly.
 */
const SECRET = 'TOP-SECRET-PROSE';
const root = 'C:/home/.claude/projects';
const nsid = '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34';
const now = Date.parse('2026-09-25T10:00:00.000Z');

type FakeFile = { content: string; modifiedAtMs: number };

function memoryFileSystem(files: Record<string, FakeFile>) {
  const calls: string[] = [];
  const fileSystem: TranscriptFileSystem = {
    async listDirectory(path) {
      calls.push(`list:${path}`);
      const prefix = `${path}/`;
      const children = new Map<string, boolean>();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) children.set(rest, false);
        else children.set(rest.slice(0, slash), true);
      }
      if (children.size === 0) return undefined;
      return [...children].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async stat(path) {
      calls.push(`stat:${path}`);
      const file = files[path];
      return file === undefined
        ? undefined
        : { modifiedAtMs: file.modifiedAtMs, sizeBytes: file.content.length };
    },
    async readLines(path, maxBytes) {
      calls.push(`readLines:${path}`);
      const file = files[path];
      if (file === undefined) return undefined;
      return {
        lines: file.content.slice(0, maxBytes).split('\n'),
        truncated: file.content.length > maxBytes,
      };
    },
    async readTail(path, maxBytes) {
      calls.push(`readTail:${path}`);
      const file = files[path];
      if (file === undefined) return undefined;
      const truncated = file.content.length > maxBytes;
      // Mirrors the node reader: one character before the window says whether it starts a line.
      const lines = file.content.slice(truncated ? -maxBytes - 1 : 0).split('\n');
      if (truncated) lines.shift();
      return { lines, truncated };
    },
  };
  return { fileSystem, calls };
}

function record(fields: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-09-25T09:00:00.000Z',
    sessionId: nsid,
    isSidechain: true,
    cwd: 'C:/xampp/htdocs/app',
    gitBranch: 'main',
    ...fields,
  });
}

const toolUse = record({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: SECRET },
      { type: 'text', text: SECRET },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: SECRET } },
    ],
    stop_reason: 'tool_use',
  },
});
const toolResult = record({
  type: 'user',
  cwd: 'C:/xampp/htdocs/app/.worktrees/backend',
  gitBranch: 'lane/backend',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: SECRET }],
  },
});
const endTurn = record({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: SECRET }],
    stop_reason: 'end_turn',
  },
});
const attachment = record({ type: 'attachment', attachment: { content: SECRET } });
const structuredOutput = record({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_9', name: 'StructuredOutput', input: { a: SECRET } }],
    stop_reason: 'tool_use',
  },
});
const structuredOutputResult = record({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: SECRET }],
  },
});
function finalText(stopReason: string | null): string {
  return record({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: SECRET }],
      stop_reason: stopReason,
    },
  });
}
const thinkingOnly = record({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: SECRET }],
    stop_reason: null,
  },
});
const structuredOutputError = record({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: SECRET }],
  },
});
const streamingToolUse = record({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { path: SECRET } }],
    stop_reason: null,
  },
});

const project = `${root}/C--xampp-htdocs-app`;
const flat = `${project}/${nsid}/subagents`;

function file(lines: string[], modifiedAtMs: number): FakeFile {
  return { content: `${lines.join('\n')}\n`, modifiedAtMs };
}

describe('listNativeSubagents', () => {
  it('lists flat and workflow subagents with inferred state, meta fields and no content', async () => {
    const { fileSystem } = memoryFileSystem({
      [`${flat}/agent-aaa111.jsonl`]: file([toolUse, toolResult, endTurn], now - 60_000),
      [`${flat}/agent-aaa111.meta.json`]: file(
        [
          JSON.stringify({
            agentType: 'general-purpose',
            description: 'A0 admin prep refactor',
            toolUseId: 'toolu_x',
            worktreePath: 'C:/wt/a0',
            worktreeBranch: 'lane/a0',
            prompt: SECRET,
          }),
        ],
        now,
      ),
      // Running: ends in a tool result, written a minute ago, and a partial line.
      [`${flat}/agent-bbb222.jsonl`]: {
        content: `${toolUse}\n${toolResult}\n{"type":"assist`,
        modifiedAtMs: now - 60_000,
      },
      [`${flat}/agent-bbb222.meta.json`]: file(['{not json'], now),
      // Quiet: no end_turn, last written an hour ago.
      [`${flat}/workflows/wf-1/agent-ccc333.jsonl`]: file([toolUse, attachment], now - 3_600_000),
      [`${flat}/workflows/wf-1/agent-ccc333.meta.json`]: file(
        [JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 })],
        now,
      ),
      // Names the reader must never open.
      [`${flat}/notes.jsonl`]: file([endTurn], now),
      [`${flat}/agent-bad.name.jsonl`]: file([endTurn], now),
      [`${flat}/workflows/bad dir!/agent-ddd444.jsonl`]: file([endTurn], now),
      // Another session's subagents.
      [`${project}/11111111-2222-4333-8444-555555555555/subagents/agent-eee555.jsonl`]: file(
        [endTurn],
        now,
      ),
    });

    const result = await listNativeSubagents({
      fileSystem,
      projectsRoot: root,
      nativeSessionId: nsid,
      nowMs: now,
    });

    expect(result).toEqual({
      truncated: false,
      subagents: [
        {
          agentId: 'bbb222',
          state: 'running',
          lastActivityAt: new Date(now - 60_000).toISOString(),
          lastToolName: 'Bash',
          workingDirectory: 'C:/xampp/htdocs/app/.worktrees/backend',
          gitBranch: 'lane/backend',
        },
        {
          agentId: 'ccc333',
          workflowId: 'wf-1',
          agentType: 'workflow-subagent',
          state: 'quiet',
          lastActivityAt: new Date(now - 3_600_000).toISOString(),
          lastToolName: 'Bash',
          workingDirectory: 'C:/xampp/htdocs/app',
          gitBranch: 'main',
        },
        {
          agentId: 'aaa111',
          agentType: 'general-purpose',
          description: 'A0 admin prep refactor',
          state: 'finished',
          lastActivityAt: new Date(now - 60_000).toISOString(),
          lastToolName: 'Bash',
          workingDirectory: 'C:/wt/a0',
          gitBranch: 'lane/a0',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('toolu_');
  });

  it.each([
    ['an end_turn', 'finished', [toolUse, toolResult, finalText('end_turn')], 0],
    ['a stop_sequence', 'finished', [toolUse, toolResult, finalText('stop_sequence')], 0],
    [
      'the answer to its StructuredOutput call',
      'finished',
      [toolUse, toolResult, structuredOutput, attachment, structuredOutputResult],
      0,
    ],
    ['a settled text-only message', 'finished', [toolUse, toolResult, finalText(null)], 180_000],
    ['a text-only message still streaming', 'running', [toolUse, finalText(null)], 59_000],
    // A text block can precede a tool_use whose input streams for minutes (p99.9 185 s measured).
    ['a text-only message paused two minutes', 'running', [toolUse, finalText(null)], 120_000],
    ['a thinking-only record', 'running', [toolUse, toolResult, thinkingOnly], 300_000],
    [
      'a rejected StructuredOutput call',
      'running',
      [toolUse, toolResult, structuredOutput, structuredOutputError],
      0,
    ],
    ['a streaming tool_use', 'running', [streamingToolUse], 60_000],
    ['a result for another tool', 'running', [structuredOutput, toolUse, toolResult], 0],
    ['a tool result, long unwritten', 'quiet', [toolUse, toolResult], 3_600_000],
  ] as const)('ending in %s reads %s', async (_ending, state, lines, ageMs) => {
    const { fileSystem } = memoryFileSystem({
      [`${flat}/agent-aaa111.jsonl`]: file([...lines], now - ageMs),
    });

    const result = await listNativeSubagents({
      fileSystem,
      projectsRoot: root,
      nativeSessionId: nsid,
      nowMs: now,
    });

    expect(result.subagents.map((subagent) => subagent.state)).toEqual([state]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('toolu_');
  });

  it('re-reads a wider tail when the final record is larger than the window', async () => {
    const huge = record({
      type: 'assistant',
      cwd: 'C:/wt/big',
      gitBranch: 'lane/big',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: SECRET.repeat(3_000) }],
        stop_reason: 'end_turn',
      },
    });
    const { fileSystem, calls } = memoryFileSystem({
      [`${flat}/agent-aaa111.jsonl`]: file([toolUse, huge], now),
    });

    const result = await listNativeSubagents({
      fileSystem,
      projectsRoot: root,
      nativeSessionId: nsid,
      nowMs: now,
    });

    expect(huge.length).toBeGreaterThan(32_768);
    expect(result.subagents).toEqual([
      {
        agentId: 'aaa111',
        state: 'finished',
        lastActivityAt: new Date(now).toISOString(),
        lastToolName: 'Bash',
        workingDirectory: 'C:/wt/big',
        gitBranch: 'lane/big',
      },
    ]);
    expect(calls.filter((call) => call.startsWith('readTail:'))).toHaveLength(2);
  });

  it('re-reads a wider tail when the answered StructuredOutput call is outside the window', async () => {
    const hugeCall = record({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'StructuredOutput',
            input: { report: SECRET.repeat(3_000) },
          },
        ],
        stop_reason: 'tool_use',
      },
    });
    const { fileSystem, calls } = memoryFileSystem({
      [`${flat}/agent-aaa111.jsonl`]: file([hugeCall, attachment, structuredOutputResult], now),
    });

    const result = await listNativeSubagents({
      fileSystem,
      projectsRoot: root,
      nativeSessionId: nsid,
      nowMs: now,
    });

    expect(result.subagents.map((subagent) => subagent.state)).toEqual(['finished']);
    expect(calls.filter((call) => call.startsWith('readTail:'))).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports a listing cut by the directory cap as truncated', async () => {
    const twoProjects = memoryFileSystem({
      [`${flat}/agent-aaa111.jsonl`]: file([endTurn], now),
      [`${root}/D--other/${nsid}/subagents/agent-bbb222.jsonl`]: file([endTurn], now),
    });
    const twoWorkflows = memoryFileSystem({
      [`${flat}/workflows/wf-1/agent-aaa111.jsonl`]: file([endTurn], now),
      [`${flat}/workflows/wf-2/agent-bbb222.jsonl`]: file([endTurn], now),
    });

    for (const { fileSystem } of [twoProjects, twoWorkflows]) {
      const result = await listNativeSubagents({
        fileSystem,
        projectsRoot: root,
        nativeSessionId: nsid,
        nowMs: now,
        maxDirectories: 1,
      });
      expect(result.subagents).toHaveLength(1);
      expect(result.truncated).toBe(true);
    }
  });

  it('caps and cleans untrusted strings from the meta file', async () => {
    const { fileSystem } = memoryFileSystem({
      [`${flat}/agent-aaa111.jsonl`]: file([endTurn], now),
      [`${flat}/agent-aaa111.meta.json`]: file(
        [
          JSON.stringify({
            agentType: 't'.repeat(150),
            description: `Fix\u0007 the\u001b[31m bug ${'x'.repeat(300)}`,
            worktreePath: 42,
            worktreeBranch: ['lane/a0'],
          }),
        ],
        now,
      ),
    });

    const [subagent] = (
      await listNativeSubagents({
        fileSystem,
        projectsRoot: root,
        nativeSessionId: nsid,
        nowMs: now,
      })
    ).subagents;

    expect(subagent?.agentType).toBe('t'.repeat(100));
    expect(subagent?.description).toHaveLength(200);
    expect(subagent?.description?.startsWith('Fix the[31m bug x')).toBe(true);
    expect(subagent?.workingDirectory).toBe('C:/xampp/htdocs/app');
    expect(subagent?.gitBranch).toBe('main');
  });

  it('touches no disk for a native id that is not a UUID', async () => {
    const { fileSystem, calls } = memoryFileSystem({});
    for (const nativeSessionId of ['../etc', `${nsid}:stream`, 'agent-abc', '']) {
      expect(
        await listNativeSubagents({ fileSystem, projectsRoot: root, nativeSessionId, nowMs: now }),
      ).toEqual({ subagents: [], truncated: false });
    }
    expect(calls).toEqual([]);
  });

  it('merges case-variant project directories, keeping the newest file', async () => {
    const { fileSystem } = memoryFileSystem({
      [`${flat}/agent-aaa111.jsonl`]: file([endTurn], now - 1_000),
      [`${root}/c--xampp-htdocs-app/${nsid}/subagents/agent-aaa111.jsonl`]: file(
        [toolUse],
        now - 5_000,
      ),
    });

    const result = await listNativeSubagents({
      fileSystem,
      projectsRoot: root,
      nativeSessionId: nsid,
      nowMs: now,
    });

    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0]).toMatchObject({ agentId: 'aaa111', state: 'finished' });
  });

  it('returns the most recent subagents up to the limit and tails only those', async () => {
    const { fileSystem, calls } = memoryFileSystem({
      [`${flat}/agent-old.jsonl`]: file([endTurn], now - 30_000),
      [`${flat}/agent-mid.jsonl`]: file([endTurn], now - 20_000),
      [`${flat}/agent-new.jsonl`]: file([endTurn], now - 10_000),
    });

    const result = await listNativeSubagents({
      fileSystem,
      projectsRoot: root,
      nativeSessionId: nsid,
      nowMs: now,
      limit: 2,
    });

    expect(result.truncated).toBe(true);
    expect(result.subagents.map((subagent) => subagent.agentId)).toEqual(['new', 'mid']);
    expect(calls.filter((call) => call.startsWith('readTail:'))).toHaveLength(2);
  });

  it('answers an empty listing when the session has no subagents directory', async () => {
    const { fileSystem } = memoryFileSystem({ [`${project}/${nsid}.jsonl`]: file([endTurn], now) });
    expect(
      await listNativeSubagents({
        fileSystem,
        projectsRoot: root,
        nativeSessionId: nsid,
        nowMs: now,
      }),
    ).toEqual({ subagents: [], truncated: false });
  });
});
