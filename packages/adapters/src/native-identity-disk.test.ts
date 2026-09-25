import { describe, expect, it, vi } from 'vitest';

import { resolveNativeIdentityFromDisk } from './index.js';
import type {
  TranscriptDirectoryEntry,
  TranscriptFileStat,
  TranscriptFileSystem,
} from './types.js';

/**
 * The Codex disk resolver decides what a session declares about itself from a
 * rollout tree it does not own, so every case asserts the absence of a binding as
 * loudly as its presence: a stale, mismatched, or ambiguous read must resolve to
 * nothing rather than to the wrong session.
 */

const NOW = 1_756_000_000_000;
const FRESH = NOW - 1_000;
const STALE = NOW - 900_001; // just past the 15-minute default window
const PROJECT = 'C:\\xampp\\htdocs\\luwiruntime';

type FakeFile = { content: string; modifiedAtMs: number };

/** A `session_meta` first line, followed by a conversation line the reader must never read. */
function rollout(
  sessionId: string,
  cwd: string,
  extra: { id?: string; parent?: string } = {},
): string {
  const meta = {
    timestamp: '2026-09-01T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: extra.id ?? sessionId,
      parent_thread_id: extra.parent,
      cwd,
      originator: 'Codex Desktop',
    },
  };
  const conversation = {
    type: 'response_item',
    payload: { text: 'PROSE THAT MUST NEVER BE READ' },
  };
  return `${JSON.stringify(meta)}\n${JSON.stringify(conversation)}\n`;
}

function normalize(path: string): string {
  return path.replace(/\\/gu, '/').replace(/\/+$/u, '');
}

function createFileSystem(files: Record<string, FakeFile>): TranscriptFileSystem {
  const fileMap = new Map<string, FakeFile>(
    Object.entries(files).map(([path, file]) => [normalize(path), file]),
  );
  return {
    async listDirectory(path: string): Promise<TranscriptDirectoryEntry[] | undefined> {
      const prefix = `${normalize(path)}/`;
      const children = new Map<string, boolean>();
      let exists = false;
      for (const filePath of fileMap.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        exists = true;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) children.set(rest, false);
        else children.set(rest.slice(0, slash), true);
      }
      if (!exists) return undefined;
      return [...children.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async stat(path: string): Promise<TranscriptFileStat | undefined> {
      const file = fileMap.get(normalize(path));
      if (file === undefined) return undefined;
      return {
        modifiedAtMs: file.modifiedAtMs,
        sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      };
    },
    async readLines(
      path: string,
      maxBytes: number,
    ): Promise<{ lines: string[]; truncated: boolean } | undefined> {
      const file = fileMap.get(normalize(path));
      if (file === undefined) return undefined;
      const buffer = Buffer.from(file.content, 'utf8');
      const truncated = buffer.length > maxBytes;
      const lines = buffer
        .subarray(0, Math.min(buffer.length, maxBytes))
        .toString('utf8')
        .split('\n');
      if (truncated) lines.pop();
      return { lines, truncated };
    },
    readTail: async () => undefined,
  };
}

const base = {
  environment: { USERPROFILE: 'C:\\Users\\umuts' },
  workingDirectory: PROJECT,
  platform: 'win32' as NodeJS.Platform,
  now: () => new Date(NOW),
};

const dayDirectory = 'C:/Users/umuts/.codex/sessions/2026/09/01';

describe('codex disk native identity', () => {
  it('resolves the freshest cwd-matching rollout to its session id', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-2026-09-01T14-25-40-01a05c80.jsonl`]: {
        content: rollout('01a05c7d-d90a-7a62-8856-ebd3bf43f1c7', PROJECT),
        modifiedAtMs: FRESH,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: '01a05c7d-d90a-7a62-8856-ebd3bf43f1c7',
    });
  });

  it('picks the most recently written of several fresh cwd-matching rollouts', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-a.jsonl`]: {
        content: rollout('older-session', PROJECT),
        modifiedAtMs: NOW - 5_000,
      },
      [`${dayDirectory}/rollout-b.jsonl`]: {
        content: rollout('newest-session', PROJECT),
        modifiedAtMs: NOW - 500,
      },
      [`${dayDirectory}/rollout-c.jsonl`]: {
        content: rollout('middle-session', PROJECT),
        modifiedAtMs: NOW - 2_000,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'newest-session',
    });
  });

  it('returns the logical session id of a resumed session, never the rollout file id', async () => {
    // A resume writes a new rollout whose own `id` differs from `session_id`; the
    // binding must be the stable root, not the per-file id.
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-2026-09-01T14-25-40-01a05c80.jsonl`]: {
        content: rollout('01a05c7d-root', PROJECT, {
          id: '01a05c80-resume',
          parent: '01a05c7f-prior',
        }),
        modifiedAtMs: FRESH,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: '01a05c7d-root',
    });
  });

  it('binds nothing when the freshest rollout is stale', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-stale.jsonl`]: {
        content: rollout('dead-session', PROJECT),
        modifiedAtMs: STALE,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
  });

  it('binds nothing when no rollout matches the working directory', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-other.jsonl`]: {
        content: rollout('other-project-session', 'C:\\xampp\\htdocs\\arshahomes'),
        modifiedAtMs: FRESH,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
  });

  it('matches the working directory case-insensitively on Windows', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-x.jsonl`]: {
        content: rollout('case-session', 'C:\\xampp\\htdocs\\luwiruntime'),
        modifiedAtMs: FRESH,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        ...base,
        fileSystem,
        workingDirectory: 'c:/xampp/htdocs/luwiruntime',
      }),
    ).resolves.toEqual({ adapterId: 'codex', nativeSessionId: 'case-session' });
  });

  it('reads the sessions root under CODEX_HOME when it is set', async () => {
    const fileSystem = createFileSystem({
      'D:/codex-home/sessions/2026/09/01/rollout-x.jsonl': {
        content: rollout('home-session', PROJECT),
        modifiedAtMs: FRESH,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        ...base,
        environment: { CODEX_HOME: 'D:\\codex-home' },
        fileSystem,
      }),
    ).resolves.toEqual({ adapterId: 'codex', nativeSessionId: 'home-session' });
  });

  it('honors LUWI_CODEX_SESSION_FRESHNESS_MS to widen the window', async () => {
    const twentyMinutesAgo = NOW - 20 * 60 * 1_000;
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-idle.jsonl`]: {
        content: rollout('idle-session', PROJECT),
        modifiedAtMs: twentyMinutesAgo,
      },
    });
    // Default 15-minute window excludes it.
    await expect(
      resolveNativeIdentityFromDisk('codex', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
    // A widened window admits it.
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        ...base,
        environment: {
          USERPROFILE: 'C:\\Users\\umuts',
          LUWI_CODEX_SESSION_FRESHNESS_MS: '1800000',
        },
        fileSystem,
      }),
    ).resolves.toEqual({ adapterId: 'codex', nativeSessionId: 'idle-session' });
  });

  it('skips a malformed first line and resolves a later valid candidate', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-broken.jsonl`]: {
        content: 'not json at all\n',
        modifiedAtMs: NOW - 200,
      },
      [`${dayDirectory}/rollout-valid.jsonl`]: {
        content: rollout('valid-session', PROJECT),
        modifiedAtMs: NOW - 1_500,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'valid-session',
    });
  });

  it('finds a live session whose rollout sits in an older day directory (freshness bounds the scan, not a day count)', async () => {
    // A session open across several days keeps one file in its creation-day
    // directory with a current mtime; the two newest days hold newer but
    // non-matching sessions. Freshness on mtime — not a fixed day-count — is the
    // real bound, so the live cwd-matching rollout must still be found.
    const fileSystem = createFileSystem({
      'C:/Users/umuts/.codex/sessions/2026/09/03/rollout-a.jsonl': {
        content: rollout('day3-other', 'C:\\other'),
        modifiedAtMs: NOW - 4_000,
      },
      'C:/Users/umuts/.codex/sessions/2026/09/02/rollout-b.jsonl': {
        content: rollout('day2-other', 'C:\\other'),
        modifiedAtMs: NOW - 3_000,
      },
      'C:/Users/umuts/.codex/sessions/2026/09/01/rollout-c.jsonl': {
        content: rollout('day1-live', PROJECT),
        modifiedAtMs: NOW - 1_000,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'day1-live',
    });
  });

  it('skips a fresher rollout in another project for this project\u2019s older-but-fresh rollout (no cross-project shadowing)', async () => {
    // Two fresh rollouts coexist: a fresher one in another project and this
    // project's own older one. The cwd guard must skip the fresher foreign session
    // and bind this project's — never attribute another project's tokens here.
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-foreign.jsonl`]: {
        content: rollout('foreign-session', 'C:\\other\\project'),
        modifiedAtMs: NOW - 500,
      },
      [`${dayDirectory}/rollout-mine.jsonl`]: {
        content: rollout('my-session', PROJECT),
        modifiedAtMs: NOW - 5_000,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'my-session',
    });
  });

  it('never trusts a future-dated rollout over the genuinely live one', async () => {
    // A dead session's file can carry a future mtime (restore, clock-ahead copy,
    // NTP step-back). It must neither be admitted as fresh nor win the sort.
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-ghost.jsonl`]: {
        content: rollout('future-ghost', PROJECT),
        modifiedAtMs: NOW + 3_600_000,
      },
      [`${dayDirectory}/rollout-live.jsonl`]: {
        content: rollout('genuinely-live', PROJECT),
        modifiedAtMs: NOW - 3_000,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'genuinely-live',
    });
  });

  it('binds nothing when the only rollout is dated in the future beyond clock jitter', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-ghost.jsonl`]: {
        content: rollout('future-only', PROJECT),
        modifiedAtMs: NOW + 3_600_000,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
  });

  it('still accepts a rollout dated a hair in the future (benign clock jitter within tolerance)', async () => {
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-jitter.jsonl`]: {
        content: rollout('near-now-session', PROJECT),
        modifiedAtMs: NOW + 1_000,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'near-now-session',
    });
  });

  it('descends across a month boundary just after midnight', async () => {
    const fileSystem = createFileSystem({
      'C:/Users/umuts/.codex/sessions/2026/10/01/rollout-empty-day.jsonl': {
        content: rollout('new-month-other', 'C:\\other'),
        modifiedAtMs: 1_759_276_800_000 - 10 * 60 * 1_000,
      },
      'C:/Users/umuts/.codex/sessions/2026/09/30/rollout-carryover.jsonl': {
        content: rollout('carryover-session', PROJECT),
        modifiedAtMs: 1_759_276_800_000 - 3 * 60 * 1_000,
      },
    });
    // now = 2026-10-01T00:03Z
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        ...base,
        fileSystem,
        now: () => new Date(1_759_276_980_000),
      }),
    ).resolves.toEqual({ adapterId: 'codex', nativeSessionId: 'carryover-session' });
  });

  it('descends across a year boundary just after midnight', async () => {
    const fileSystem = createFileSystem({
      'C:/Users/umuts/.codex/sessions/2027/01/01/rollout-newyear.jsonl': {
        content: rollout('new-year-other', 'C:\\other'),
        modifiedAtMs: NOW - 8 * 60 * 1_000,
      },
      'C:/Users/umuts/.codex/sessions/2026/12/31/rollout-carryover.jsonl': {
        content: rollout('year-carryover', PROJECT),
        modifiedAtMs: NOW - 2 * 60 * 1_000,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'year-carryover',
    });
  });

  it('skips a structurally valid session_meta that is missing cwd or session_id', async () => {
    const missingCwd = `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'no-cwd' } })}\n`;
    const fileSystem = createFileSystem({
      [`${dayDirectory}/rollout-incomplete.jsonl`]: {
        content: missingCwd,
        modifiedAtMs: NOW - 200,
      },
      [`${dayDirectory}/rollout-complete.jsonl`]: {
        content: rollout('complete-session', PROJECT),
        modifiedAtMs: NOW - 1_500,
      },
    });
    await expect(resolveNativeIdentityFromDisk('codex', { ...base, fileSystem })).resolves.toEqual({
      adapterId: 'codex',
      nativeSessionId: 'complete-session',
    });
  });

  it('does not match a parent- or child-directory rollout (exact cwd, not containment)', async () => {
    const parent = createFileSystem({
      [`${dayDirectory}/rollout-parent.jsonl`]: {
        content: rollout('parent-session', 'C:\\xampp\\htdocs'),
        modifiedAtMs: FRESH,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        ...base,
        fileSystem: parent,
        workingDirectory: 'C:\\xampp\\htdocs\\luwiruntime',
      }),
    ).resolves.toBeUndefined();

    const child = createFileSystem({
      [`${dayDirectory}/rollout-child.jsonl`]: {
        content: rollout('child-session', 'C:\\xampp\\htdocs\\luwiruntime\\apps'),
        modifiedAtMs: FRESH,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        ...base,
        fileSystem: child,
        workingDirectory: 'C:\\xampp\\htdocs\\luwiruntime',
      }),
    ).resolves.toBeUndefined();
  });

  it('prefers CODEX_HOME over USERPROFILE when both are set', async () => {
    const fileSystem = createFileSystem({
      'D:/codex-home/sessions/2026/09/01/rollout-home.jsonl': {
        content: rollout('home-session', PROJECT),
        modifiedAtMs: FRESH,
      },
      'C:/Users/umuts/.codex/sessions/2026/09/01/rollout-profile.jsonl': {
        content: rollout('profile-session', PROJECT),
        modifiedAtMs: FRESH,
      },
    });
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        ...base,
        environment: { CODEX_HOME: 'D:\\codex-home', USERPROFILE: 'C:\\Users\\umuts' },
        fileSystem,
      }),
    ).resolves.toEqual({ adapterId: 'codex', nativeSessionId: 'home-session' });
  });

  it('resolves from a POSIX HOME root and compares cwd case-sensitively off Windows', async () => {
    const fileSystem = createFileSystem({
      '/home/dev/.codex/sessions/2026/09/01/rollout-x.jsonl': {
        content: rollout('posix-session', '/home/dev/proj'),
        modifiedAtMs: FRESH,
      },
    });
    // The absolute root must survive joinPath, and the match resolves.
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        environment: { HOME: '/home/dev' },
        workingDirectory: '/home/dev/proj',
        platform: 'linux',
        now: () => new Date(NOW),
        fileSystem,
      }),
    ).resolves.toEqual({ adapterId: 'codex', nativeSessionId: 'posix-session' });

    // Case differs — on a case-sensitive filesystem these are distinct directories.
    await expect(
      resolveNativeIdentityFromDisk('codex', {
        environment: { HOME: '/home/dev' },
        workingDirectory: '/home/dev/Proj',
        platform: 'linux',
        now: () => new Date(NOW),
        fileSystem,
      }),
    ).resolves.toBeUndefined();
  });

  it('binds nothing when the sessions root does not exist', async () => {
    const fileSystem = createFileSystem({});
    await expect(
      resolveNativeIdentityFromDisk('codex', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
  });

  it('resolves nothing, and reads no file, for a kind with no disk resolver', async () => {
    // Claude is complete from the environment and Gemini has no per-session id,
    // so neither has a disk resolver and neither touches the filesystem.
    const listDirectory = vi.fn(async () => undefined);
    const fileSystem: TranscriptFileSystem = {
      listDirectory,
      stat: vi.fn(async () => undefined),
      readLines: vi.fn(async () => undefined),
      readTail: vi.fn(async () => undefined),
    };
    await expect(
      resolveNativeIdentityFromDisk('claude-code', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
    await expect(
      resolveNativeIdentityFromDisk('gemini-cli', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('never throws on an unexpected filesystem error — an unreadable tree is an absence', async () => {
    const fileSystem: TranscriptFileSystem = {
      listDirectory: async () => {
        throw new Error('EIO');
      },
      stat: async () => undefined,
      readLines: async () => undefined,
      readTail: async () => undefined,
    };
    await expect(
      resolveNativeIdentityFromDisk('codex', { ...base, fileSystem }),
    ).resolves.toBeUndefined();
  });
});
