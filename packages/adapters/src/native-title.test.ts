import { describe, expect, it } from 'vitest';

import type { TranscriptFileSystem } from './types.js';

import { ccdSessionsDir, findNativeSessionTitle } from './native-title.js';

function fakeStore(files: Record<string, string>): TranscriptFileSystem {
  // Build a directory tree from the flat file map.
  const dirs = new Map<string, Set<string>>();
  const add = (child: string): void => {
    const slash = child.lastIndexOf('/');
    if (slash < 0) return;
    const parent = child.slice(0, slash);
    if (!dirs.has(parent)) dirs.set(parent, new Set());
    dirs.get(parent)!.add(child.slice(slash + 1));
    add(parent);
  };
  for (const path of Object.keys(files)) add(path);
  return {
    async listDirectory(path) {
      const names = dirs.get(path);
      if (names === undefined) return undefined;
      return [...names].map((name) => ({
        name,
        isDirectory: dirs.has(`${path}/${name}`),
      }));
    },
    async stat() {
      return undefined;
    },
    async readLines(path) {
      const content = files[path];
      return content === undefined ? undefined : { lines: content.split('\n'), truncated: false };
    },
    async readTail() {
      return undefined;
    },
  };
}

const root = 'C:/ad/Claude/claude-code-sessions';

describe('findNativeSessionTitle', () => {
  it('joins the title to the native cliSessionId across nested store dirs', async () => {
    const store = fakeStore({
      [`${root}/a/b/local_xxx.json`]: JSON.stringify({ cliSessionId: 'other', title: 'Nope' }),
      [`${root}/a/b/local_yyy.json`]: JSON.stringify({
        cliSessionId: 'native-1',
        title: 'Build CB14',
      }),
    });
    const found = await findNativeSessionTitle(store, root, 'native-1');
    expect(found).toEqual({ title: 'Build CB14', filePath: `${root}/a/b/local_yyy.json` });
  });

  it('re-reads only the known file when the id still matches', async () => {
    const path = `${root}/a/b/local_yyy.json`;
    let listCalls = 0;
    const base = fakeStore({
      [path]: JSON.stringify({ cliSessionId: 'native-1', title: 'Renamed' }),
    });
    const store: TranscriptFileSystem = {
      listDirectory: async (p) => {
        listCalls += 1;
        return base.listDirectory(p);
      },
      stat: base.stat,
      readLines: base.readLines,
      readTail: base.readTail,
    };
    const found = await findNativeSessionTitle(store, root, 'native-1', path);
    expect(found?.title).toBe('Renamed');
    expect(listCalls).toBe(0); // fast path: no directory walk
  });

  it('returns undefined for a missing store or unmatched id', async () => {
    const store = fakeStore({});
    expect(await findNativeSessionTitle(store, root, 'native-1')).toBeUndefined();
  });
});

describe('ccdSessionsDir', () => {
  it('is derived from APPDATA, and absent without it', () => {
    expect(ccdSessionsDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(
      'C:/Users/u/AppData/Roaming/Claude/claude-code-sessions',
    );
    expect(ccdSessionsDir({})).toBeUndefined();
  });
});
