import { describe, expect, it } from 'vitest';

import {
  projectCollectionResponseSchema,
  projectRegistrationRequestSchema,
  projectResponseSchema,
  projectSchema,
  projectUpdateRequestSchema,
} from './index.js';

const project = {
  id: 'project-1',
  name: 'LUWI Runtime',
  localPath: 'C:/workspace/luwi',
  canonicalPath: 'C:/workspace/luwi',
  repositoryUrl: 'https://example.test/luwi.git',
  defaultBranch: 'main',
  createdAt: '2026-07-28T12:00:00.000Z',
  updatedAt: '2026-07-28T12:00:00.000Z',
};

describe('project protocol', () => {
  it('validates a project registration request', () => {
    expect(
      projectRegistrationRequestSchema.parse({
        name: 'LUWI Runtime',
        localPath: '.',
      }),
    ).toEqual({
      name: 'LUWI Runtime',
      localPath: '.',
    });
  });

  it('rejects unknown project registration fields', () => {
    expect(() =>
      projectRegistrationRequestSchema.parse({
        name: 'LUWI Runtime',
        localPath: '.',
        githubToken: 'secret',
      }),
    ).toThrow();
  });

  it('validates project and collection responses', () => {
    expect(projectResponseSchema.parse(project)).toEqual(project);
    expect(projectCollectionResponseSchema.parse({ projects: [project] })).toEqual({
      projects: [project],
    });
  });
});

describe('repository URL shapes', () => {
  // The register path fills repositoryUrl from `git config remote.origin.url`
  // when the caller omits it, and the most common SSH remote is scp-style —
  // `git@host:owner/repo.git` — which is not an RFC URL. Rejecting it poisoned
  // a projection: Lua wrote a record the TypeScript read path refused, and one
  // refused record turns the whole project list into a 500 (ADR 0015).
  it('accepts an scp-style git remote as a repository url', () => {
    const parsed = projectSchema.safeParse({
      id: 'p1',
      name: 'Press',
      localPath: 'C:/work/press',
      canonicalPath: 'C:/work/press',
      repositoryUrl: 'git@github.com:owner/luwi-press.git',
      defaultBranch: 'master',
      createdAt: '2026-08-15T10:00:00.000Z',
      updatedAt: '2026-08-15T10:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts https remotes and rejects free text', () => {
    const base = {
      id: 'p1',
      name: 'Press',
      localPath: 'C:/work/press',
      canonicalPath: 'C:/work/press',
      createdAt: '2026-08-15T10:00:00.000Z',
      updatedAt: '2026-08-15T10:00:00.000Z',
    };
    expect(
      projectSchema.safeParse({ ...base, repositoryUrl: 'https://github.com/o/r.git' }).success,
    ).toBe(true);
    expect(projectSchema.safeParse({ ...base, repositoryUrl: 'not a remote' }).success).toBe(false);
  });
});

describe('project update request', () => {
  it('accepts a partial patch and null as the word for clearing a field', () => {
    expect(projectUpdateRequestSchema.parse({ name: ' Renamed ', repositoryUrl: null })).toEqual({
      name: 'Renamed',
      repositoryUrl: null,
    });
    expect(projectUpdateRequestSchema.parse({ defaultBranch: 'main' })).toEqual({
      defaultBranch: 'main',
    });
  });

  it('refuses an empty patch, a null name, and any attempt to name the path', () => {
    expect(projectUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ name: null }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ localPath: 'C:/x' }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ canonicalPath: 'C:/x' }).success).toBe(false);
  });
});
