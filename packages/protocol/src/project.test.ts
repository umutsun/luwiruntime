import { describe, expect, it } from 'vitest';

import {
  projectCollectionResponseSchema,
  projectRegistrationRequestSchema,
  projectResponseSchema,
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
