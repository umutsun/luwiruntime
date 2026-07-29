import type { ProjectRegistrationRequest } from '@luwi/protocol';
import type { RegisterProjectResult, RuntimeRepository } from '@luwi/redis';
import { describe, expect, it } from 'vitest';

import { createProjectService } from './project-service.js';

const request: ProjectRegistrationRequest = {
  name: 'LUWI Runtime',
  localPath: '.',
};

function repositoryReturning(result: RegisterProjectResult): RuntimeRepository {
  return {
    registerProject: async () => result,
    getProject: async () => null,
    listProjects: async () => [],
  };
}

describe('project service', () => {
  it('canonicalizes a path, detects optional Git metadata, and registers it', async () => {
    let registeredInput: unknown;
    const repository: RuntimeRepository = {
      registerProject: async (input) => {
        registeredInput = input;
        return {
          status: 'created',
          project: {
            id: 'project-1',
            name: 'LUWI Runtime',
            localPath: 'C:/workspace/luwi',
            canonicalPath: 'C:/workspace/real/luwi',
            repositoryUrl: 'https://example.test/luwi.git',
            defaultBranch: 'main',
            createdAt: '2026-07-28T12:00:00.000Z',
            updatedAt: '2026-07-28T12:00:00.000Z',
          },
          event: {
            id: 'event-1',
            version: 1,
            type: 'project.registered',
            occurredAt: '2026-07-28T12:00:00.000Z',
            workspaceId: 'local',
            projectId: 'project-1',
            payload: {},
          },
          globalStreamId: '1-0',
          projectStreamId: '2-0',
        };
      },
      getProject: async () => null,
      listProjects: async () => [],
    };
    const service = createProjectService({
      repository,
      workspaceId: 'local',
      createId: (() => {
        const values = ['project-1', 'event-1'];
        return () => values.shift() ?? 'unexpected';
      })(),
      canonicalizePath: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/real/luwi',
        identityPath: 'c:/workspace/real/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
      detectGitMetadata: async () => ({
        repositoryUrl: 'https://example.test/luwi.git',
        defaultBranch: 'main',
      }),
    });

    await expect(service.register(request)).resolves.toMatchObject({
      id: 'project-1',
      repositoryUrl: 'https://example.test/luwi.git',
    });
    expect(registeredInput).toMatchObject({
      project: {
        id: 'project-1',
        identityPath: 'c:/workspace/real/luwi',
        pathIdentityHash: 'a'.repeat(64),
        repositoryUrl: 'https://example.test/luwi.git',
        defaultBranch: 'main',
      },
      workspaceId: 'local',
      eventId: 'event-1',
    });
  });

  it('maps duplicate paths to the approved safe conflict details', async () => {
    const service = createProjectService({
      repository: repositoryReturning({
        status: 'conflict',
        reason: 'duplicate',
        existingProjectId: 'project-existing',
        canonicalPath: 'C:/workspace/luwi',
      }),
      workspaceId: 'local',
      createId: () => 'id-1',
      canonicalizePath: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/luwi',
        identityPath: 'c:/workspace/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
      detectGitMetadata: async () => ({}),
    });

    await expect(service.register(request)).rejects.toMatchObject({
      code: 'PROJECT_ALREADY_REGISTERED',
      statusCode: 409,
      details: {
        existingProjectId: 'project-existing',
        canonicalLocalPath: 'C:/workspace/luwi',
      },
    });
  });
});
