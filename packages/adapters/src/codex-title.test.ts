import { describe, expect, it } from 'vitest';

import type { TranscriptFileSystem } from './types.js';

import { findCodexThreadName } from './codex-title.js';

const INDEX = 'C:/u/.codex/session_index.jsonl';

function fakeIndex(lines: string[] | undefined): Pick<TranscriptFileSystem, 'readLines'> {
  return {
    async readLines(path) {
      return path === INDEX && lines !== undefined ? { lines, truncated: false } : undefined;
    },
  };
}

function entry(id: string, threadName: string): string {
  return JSON.stringify({ id, thread_name: threadName, updated_at: '2026-09-14T11:42:54Z' });
}

describe('findCodexThreadName', () => {
  it('joins the thread name to the logical session id', async () => {
    const store = fakeIndex([entry('other', 'Nope'), entry('sess-1', 'Proje görevlerini sürdür')]);
    expect(await findCodexThreadName(store, INDEX, 'sess-1')).toBe('Proje görevlerini sürdür');
  });

  it('lets the last line win when a rename appends a second entry for the same id', async () => {
    const store = fakeIndex([entry('sess-1', 'First name'), entry('sess-1', 'Renamed')]);
    expect(await findCodexThreadName(store, INDEX, 'sess-1')).toBe('Renamed');
  });

  it('returns undefined for a missing index, a malformed line, or a blank name', async () => {
    expect(await findCodexThreadName(fakeIndex(undefined), INDEX, 'sess-1')).toBeUndefined();
    const store = fakeIndex([
      '{not json',
      '',
      entry('sess-1', '   '),
      JSON.stringify({ id: 'sess-1' }),
    ]);
    expect(await findCodexThreadName(store, INDEX, 'sess-1')).toBeUndefined();
  });
});
