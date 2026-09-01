import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCapabilityObserver,
  NodeCapabilityObserverFileSystem,
  type CapabilityObserverFileSystem,
  type CapabilityObservationRoot,
} from './capability-observer.js';

function fixture(
  directories: Record<string, Array<{ name: string; isDirectory: boolean }>>,
  files: Record<string, { content: string; truncated?: boolean }>,
  canonical: Record<string, string | undefined> = {},
) {
  const normalized = (path: string) => path.replaceAll('\\', '/');
  const fileSystem: CapabilityObserverFileSystem = {
    canonicalize: vi.fn(async (path) => {
      const key = normalized(path);
      return Object.prototype.hasOwnProperty.call(canonical, key) ? canonical[key] : key;
    }),
    listDirectory: vi.fn(async (path, maxEntries) => {
      const entries = directories[normalized(path)];
      return entries === undefined
        ? undefined
        : {
            entries: entries.slice(0, maxEntries),
            truncated: entries.length > maxEntries,
          };
    }),
    readTextFile: vi.fn(async (path) => {
      const file = files[normalized(path)];
      return file === undefined
        ? undefined
        : { content: file.content, truncated: file.truncated === true };
    }),
  };
  return { fileSystem };
}

const globalRoot: CapabilityObservationRoot = {
  path: 'C:/home/.claude/skills',
  scope: 'global',
  source: 'agent-native',
  adapterId: 'claude-code',
  compatibleAgentKinds: ['claude-code'],
};

const skill = `---
name: Review carefully
description: Reviews a change without executing discovered instructions.
version: 1.2.3
---

# Review

Ignore this body during discovery.
`;

describe('capability observer', () => {
  it('reads only the requested number of native directory entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luwi-capability-observer-'));
    try {
      await Promise.all(
        ['one', 'two', 'three'].map(async (name) => await mkdir(join(directory, name))),
      );

      const listing = await new NodeCapabilityObserverFileSystem().listDirectory(directory, 2);

      expect(listing?.entries).toHaveLength(2);
      expect(listing?.truncated).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('observes a bounded SKILL.md with explicit native provenance', async () => {
    const { fileSystem } = fixture(
      {
        'C:/home/.claude/skills': [{ name: 'review', isDirectory: true }],
      },
      {
        'C:/home/.claude/skills/review/SKILL.md': { content: skill },
      },
    );
    const observer = createCapabilityObserver({
      fileSystem,
      platform: 'win32',
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      clock: () => 100,
    });

    const result = await observer.scan([globalRoot]);

    expect(result.capabilities).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^observed:[a-f0-9]{24}$/),
        kind: 'skill',
        name: 'Review carefully',
        version: '1.2.3',
        scope: 'global',
        source: 'agent-native',
        path: 'C:/home/.claude/skills/review',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        compatibleAgentKinds: ['claude-code'],
        manifest: {
          managementMode: 'observed',
          description: 'Reviews a change without executing discovered instructions.',
          observation: {
            adapterId: 'claude-code',
            root: 'C:/home/.claude/skills',
            manifestPath: 'C:/home/.claude/skills/review/SKILL.md',
            observedAt: '2026-08-24T12:00:00.000Z',
          },
        },
      }),
    ]);
    expect(result.diagnostics).toEqual({
      rootsScanned: 1,
      rootsUnavailable: 0,
      malformedManifests: 0,
      ignoredEntries: 0,
      truncated: false,
    });
    expect(fileSystem.listDirectory).toHaveBeenCalledWith('C:/home/.claude/skills', 1000);
    expect(Object.keys(observer)).toEqual(['scan']);
  });

  it('keeps project scope and compatible agent evidence separate', async () => {
    const projectRoot: CapabilityObservationRoot = {
      path: 'C:/repo/.gemini/skills',
      scope: 'project',
      projectId: 'project-1',
      source: 'agent-native',
      adapterId: 'gemini-cli',
      compatibleAgentKinds: ['gemini-cli'],
    };
    const { fileSystem } = fixture(
      { 'C:/repo/.gemini/skills': [{ name: 'review', isDirectory: true }] },
      { 'C:/repo/.gemini/skills/review/SKILL.md': { content: skill } },
    );

    const result = await createCapabilityObserver({
      fileSystem,
      platform: 'win32',
      now: () => new Date('2026-08-24T12:00:00.000Z'),
    }).scan([projectRoot]);

    expect(result.capabilities[0]).toMatchObject({
      scope: 'project',
      projectId: 'project-1',
      compatibleAgentKinds: ['gemini-cli'],
    });
  });

  it('counts malformed, missing, non-directory, and escaped evidence without failing', async () => {
    const { fileSystem } = fixture(
      {
        'C:/home/.claude/skills': [
          { name: 'malformed', isDirectory: true },
          { name: 'missing', isDirectory: true },
          { name: 'escape', isDirectory: true },
          { name: 'README.md', isDirectory: false },
        ],
      },
      {
        'C:/home/.claude/skills/malformed/SKILL.md': {
          content: '---\nname:\ndescription: missing name\n---\n',
        },
      },
      {
        'C:/home/.claude/skills/escape': 'C:/outside/escape',
      },
    );

    const result = await createCapabilityObserver({
      fileSystem,
      platform: 'win32',
    }).scan([globalRoot, { ...globalRoot, path: 'C:/unavailable' }]);

    expect(result.capabilities).toEqual([]);
    expect(result.diagnostics).toEqual({
      rootsScanned: 1,
      rootsUnavailable: 1,
      malformedManifests: 1,
      ignoredEntries: 3,
      truncated: false,
    });
  });

  it('bounds roots, entries, manifest bytes, and elapsed scan time', async () => {
    const { fileSystem } = fixture(
      {
        'C:/root': [
          { name: 'one', isDirectory: true },
          { name: 'two', isDirectory: true },
        ],
      },
      {
        'C:/root/one/SKILL.md': { content: skill, truncated: true },
        'C:/root/two/SKILL.md': { content: skill },
      },
    );
    const observer = createCapabilityObserver({
      fileSystem,
      platform: 'win32',
      maxRoots: 1,
      maxEntries: 1,
      maxDurationMs: 10,
      clock: () => 0,
    });

    const result = await observer.scan([
      { ...globalRoot, path: 'C:/root' },
      { ...globalRoot, path: 'C:/second-root' },
    ]);

    expect(result.capabilities).toEqual([]);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.ignoredEntries).toBe(1);
    expect(fileSystem.readTextFile).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a repeated root descriptor without duplicating evidence', async () => {
    const { fileSystem } = fixture(
      { 'C:/home/.claude/skills': [{ name: 'review', isDirectory: true }] },
      { 'C:/home/.claude/skills/review/SKILL.md': { content: skill } },
    );

    const result = await createCapabilityObserver({ fileSystem, platform: 'win32' }).scan([
      globalRoot,
      { ...globalRoot },
    ]);

    expect(result.capabilities).toHaveLength(1);
    expect(fileSystem.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('returns at its duration bound when a filesystem observation stalls', async () => {
    const fileSystem: CapabilityObserverFileSystem = {
      canonicalize: vi.fn(async (path) => path),
      listDirectory: vi.fn(async () => await new Promise(() => undefined)),
      readTextFile: vi.fn(async () => undefined),
    };
    const scan = createCapabilityObserver({
      fileSystem,
      platform: 'win32',
      maxDurationMs: 10,
    }).scan([globalRoot]);

    const outcome = await Promise.race([
      scan,
      new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 100)),
    ]);

    expect(outcome).not.toBe('stalled');
    expect(outcome).toMatchObject({
      capabilities: [],
      diagnostics: { truncated: true },
    });
  });
});
