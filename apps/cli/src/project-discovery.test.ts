import { posix } from 'node:path';

import type { Project } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { createProjectDiscoveryService } from './project-discovery.js';

const root = '/xampp/htdocs';
const directories = [
  'arshahomes',
  'corenine',
  'dashboard',
  'flybydeniz',
  'glasshouse',
  'img',
  'luwi-clients',
  'luwi-dev',
  'luwilisting',
  'luwipress',
  'luwiruntime',
  'luwistudio',
  'luwi-themes-inspect',
  'semantic-bridge',
  'webalizer',
  'xampp',
];

const names: Record<string, string> = {
  arshahomes: 'Arsha Homes',
  corenine: 'Corenine',
  flybydeniz: 'Fly by Deniz',
  glasshouse: 'Glasshouse',
  'luwi-dev': 'LUWI Dev',
  luwilisting: 'LUWI Listing',
  luwipress: 'LUWI Press',
  luwiruntime: 'LUWI Runtime',
  luwistudio: 'LUWI Studio',
  'semantic-bridge': 'Semantic Bridge',
};

const existingProjects: Project[] = Object.entries(names).map(([directory, name], index) => ({
  id: `project-${index}`,
  name,
  localPath: `${root}/${directory}`,
  canonicalPath: `${root}/${directory}`,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
}));

describe('project discovery', () => {
  it('selects the approved ten immediate projects and preserves canonical display names', async () => {
    const service = createProjectDiscoveryService({
      platform: 'win32',
      pathApi: posix,
      fileSystem: {
        canonicalize: async (path) => path,
        listDirectory: async () => directories.map((name) => ({ name, isDirectory: true })),
      },
    });

    const plan = await service.createPlan({
      root,
      excludes: ['dashboard', 'img', 'webalizer', 'xampp', 'luwi-clients', 'luwi-themes-inspect'],
      names: {},
      existingProjects,
    });

    expect(plan.selected.map(({ displayName }) => displayName)).toEqual([
      'Arsha Homes',
      'Corenine',
      'Fly by Deniz',
      'Glasshouse',
      'LUWI Dev',
      'LUWI Listing',
      'LUWI Press',
      'LUWI Runtime',
      'LUWI Studio',
      'Semantic Bridge',
    ]);
    expect(plan.excluded.map(({ directoryName }) => directoryName)).toEqual([
      'dashboard',
      'img',
      'luwi-clients',
      'luwi-themes-inspect',
      'webalizer',
      'xampp',
    ]);
    expect(plan.invalid).toEqual([]);
    expect(plan.selected.every(({ existingProjectId }) => existingProjectId !== undefined)).toBe(
      true,
    );
  });

  it('rejects glob-like and path-bearing exclusions before reading the root', async () => {
    const service = createProjectDiscoveryService({
      platform: 'win32',
      pathApi: posix,
      fileSystem: {
        canonicalize: async (path) => path,
        listDirectory: async () => [],
      },
    });

    await expect(
      service.createPlan({ root, excludes: ['luwi-*'], names: {}, existingProjects: [] }),
    ).rejects.toMatchObject({ code: 'PROJECT_DISCOVERY_OPTION_INVALID' });
    await expect(
      service.createPlan({ root, excludes: ['nested/project'], names: {}, existingProjects: [] }),
    ).rejects.toMatchObject({ code: 'PROJECT_DISCOVERY_OPTION_INVALID' });
  });

  it('rejects escaping links, classifies unreadable children, ignores files, and is deterministic', async () => {
    const service = createProjectDiscoveryService({
      platform: 'win32',
      pathApi: posix,
      fileSystem: {
        canonicalize: async (path) => {
          if (path.endsWith('/outside-link')) return '/elsewhere/project';
          if (path.endsWith('/unreadable')) throw new Error('access denied');
          return path;
        },
        listDirectory: async () => [
          { name: 'notes.txt', isDirectory: false },
          { name: 'unreadable', isDirectory: true },
          { name: 'outside-link', isDirectory: true },
          { name: 'luwiruntime', isDirectory: true },
        ],
      },
    });
    const input = {
      root,
      excludes: [],
      names: { LUWIRUNTIME: 'Runtime Override' },
      existingProjects,
    };

    const first = await service.createPlan(input);
    const second = await service.createPlan(input);

    expect(second).toEqual(first);
    expect(first.selected).toEqual([
      expect.objectContaining({
        directoryName: 'luwiruntime',
        displayName: 'Runtime Override',
        existingProjectId: expect.any(String),
      }),
    ]);
    expect(first.invalid).toEqual([
      expect.objectContaining({ directoryName: 'outside-link', reason: 'outside_root' }),
      expect.objectContaining({ directoryName: 'unreadable', reason: 'unreadable' }),
    ]);
  });
});
