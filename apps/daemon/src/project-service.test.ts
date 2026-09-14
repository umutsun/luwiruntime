import type { ProjectRegistrationRequest } from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import type { RegisterProjectResult, RuntimeRepository } from '@luwi/redis';
import { describe, expect, it, vi } from 'vitest';

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
    updateProject: async () => ({ status: 'not_found' }),
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
      updateProject: async () => ({ status: 'not_found' }),
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

  it('rebuilds a missing project projection from its canonical facts', async () => {
    let registeredInput: unknown;
    const canonicalProject = {
      id: 'project-canonical',
      name: 'Canonical Project',
      localPath: 'C:/workspace/canonical',
      canonicalPath: 'C:/workspace/canonical',
      repositoryUrl: 'https://example.test/canonical.git',
      defaultBranch: 'main',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
    };
    const service = createProjectService({
      repository: {
        getProject: async () => null,
        registerProject: async (input) => {
          registeredInput = input;
          return {
            status: 'created',
            project: canonicalProject,
            event: {
              id: 'event-restore',
              version: 1,
              type: 'project.registered',
              occurredAt: '2026-08-25T10:00:00.000Z',
              workspaceId: 'local',
              projectId: canonicalProject.id,
              payload: { project: canonicalProject },
            },
            globalStreamId: '1-0',
            projectStreamId: '2-0',
          };
        },
      } as RuntimeRepository,
      workspaceId: 'local',
      createId: () => 'event-restore',
      canonicalizePath: async () => ({
        localPath: canonicalProject.localPath,
        canonicalPath: canonicalProject.canonicalPath,
        identityPath: 'c:/workspace/canonical',
        pathIdentityHash: 'c'.repeat(64),
      }),
      detectGitMetadata: async () => ({}),
    });

    await expect(service.reconcileCanonical([canonicalProject])).resolves.toEqual({
      rebuilt: 1,
      unchanged: 0,
    });
    expect(registeredInput).toMatchObject({
      project: {
        id: 'project-canonical',
        identityPath: 'c:/workspace/canonical',
        pathIdentityHash: 'c'.repeat(64),
        createdAt: canonicalProject.createdAt,
        updatedAt: canonicalProject.updatedAt,
      },
      eventId: 'event-restore',
    });
  });

  it('rejects an existing same-id projection whose canonical facts drifted', async () => {
    const canonicalProject = {
      id: 'project-canonical',
      name: 'Canonical Project',
      localPath: 'C:/workspace/canonical',
      canonicalPath: 'C:/workspace/canonical',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const service = createProjectService({
      repository: {
        getProject: async () => ({ ...canonicalProject, name: 'Drifted Project' }),
      } as RuntimeRepository,
      workspaceId: 'local',
      canonicalizePath: async () => ({
        localPath: canonicalProject.localPath,
        canonicalPath: canonicalProject.canonicalPath,
        identityPath: 'c:/workspace/canonical',
        pathIdentityHash: 'c'.repeat(64),
      }),
      detectGitMetadata: async () => ({}),
    });

    await expect(service.reconcileCanonical([canonicalProject])).rejects.toMatchObject({
      code: 'CONFIG_RECONCILIATION_REQUIRED',
      statusCode: 503,
      details: { projectId: 'project-canonical' },
    });
  });

  it('leaves an identical canonical project projection unchanged', async () => {
    const canonicalProject = {
      id: 'project-canonical',
      name: 'Canonical Project',
      localPath: 'C:/workspace/canonical',
      canonicalPath: 'C:/workspace/canonical',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const service = createProjectService({
      repository: { getProject: async () => canonicalProject } as RuntimeRepository,
      workspaceId: 'local',
      canonicalizePath: async () => ({
        localPath: canonicalProject.localPath,
        canonicalPath: canonicalProject.canonicalPath,
        identityPath: 'c:/workspace/canonical',
        pathIdentityHash: 'c'.repeat(64),
      }),
      detectGitMetadata: async () => ({}),
    });

    await expect(service.reconcileCanonical([canonicalProject])).resolves.toEqual({
      rebuilt: 0,
      unchanged: 1,
    });
  });

  it('rejects canonical filesystem drift before consulting Redis', async () => {
    const getProject = vi.fn();
    const canonicalProject = {
      id: 'project-canonical',
      name: 'Canonical Project',
      localPath: 'C:/workspace/canonical',
      canonicalPath: 'C:/workspace/canonical',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const service = createProjectService({
      repository: { getProject } as unknown as RuntimeRepository,
      workspaceId: 'local',
      canonicalizePath: async () => ({
        localPath: canonicalProject.localPath,
        canonicalPath: 'C:/workspace/moved',
        identityPath: 'c:/workspace/moved',
        pathIdentityHash: 'd'.repeat(64),
      }),
      detectGitMetadata: async () => ({}),
    });

    await expect(service.reconcileCanonical([canonicalProject])).rejects.toMatchObject({
      code: 'CONFIG_RECONCILIATION_REQUIRED',
      details: { projectId: canonicalProject.id },
    });
    expect(getProject).not.toHaveBeenCalled();
  });

  it('rejects a path already owned by another runtime identity', async () => {
    const canonicalProject = {
      id: 'project-canonical',
      name: 'Canonical Project',
      localPath: 'C:/workspace/canonical',
      canonicalPath: 'C:/workspace/canonical',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const service = createProjectService({
      repository: {
        getProject: async () => null,
        registerProject: async () => ({ status: 'conflict', reason: 'hash_collision' }),
      } as unknown as RuntimeRepository,
      workspaceId: 'local',
      canonicalizePath: async () => ({
        localPath: canonicalProject.localPath,
        canonicalPath: canonicalProject.canonicalPath,
        identityPath: 'c:/workspace/canonical',
        pathIdentityHash: 'c'.repeat(64),
      }),
      detectGitMetadata: async () => ({}),
    });

    await expect(service.reconcileCanonical([canonicalProject])).rejects.toMatchObject({
      code: 'CONFIG_RECONCILIATION_REQUIRED',
      details: { projectId: canonicalProject.id },
    });
  });
});

describe('detected repository url hardening', () => {
  // Write-what-you-can-read: a detected remote that would fail the projection
  // schema must be dropped before it reaches Redis, not persisted into a
  // record the read path will refuse forever.
  it('keeps an scp-style detected remote now that the schema admits it', async () => {
    const registered: unknown[] = [];
    const service = createProjectService({
      workspaceId: 'w',
      repository: {
        registerProject: async (input: { project: { repositoryUrl?: string } }) => {
          registered.push(input.project);
          return {
            status: 'created',
            project: { ...input.project, createdAt: 'x', updatedAt: 'x' },
            event: {},
            globalStreamId: '1-1',
            projectStreamId: '1-1',
          };
        },
      } as never,
      canonicalizePath: async (localPath: string) => ({
        localPath,
        canonicalPath: localPath,
        identityPath: localPath.toLowerCase(),
        pathIdentityHash: 'h'.repeat(64),
      }),
      detectGitMetadata: async () => ({
        repositoryUrl: 'git@github.com:owner/luwi-press.git',
        defaultBranch: 'master',
      }),
      emit: async () => undefined,
    } as never);

    await service.register({ name: 'Press', localPath: 'C:/press' });
    expect(registered[0]).toMatchObject({
      repositoryUrl: 'git@github.com:owner/luwi-press.git',
    });
  });

  it('drops a detected remote the projection schema would refuse', async () => {
    const registered: Array<{ repositoryUrl?: string }> = [];
    const service = createProjectService({
      workspaceId: 'w',
      repository: {
        registerProject: async (input: { project: { repositoryUrl?: string } }) => {
          registered.push(input.project);
          return {
            status: 'created',
            project: { ...input.project, createdAt: 'x', updatedAt: 'x' },
            event: {},
            globalStreamId: '1-1',
            projectStreamId: '1-1',
          };
        },
      } as never,
      canonicalizePath: async (localPath: string) => ({
        localPath,
        canonicalPath: localPath,
        identityPath: localPath.toLowerCase(),
        pathIdentityHash: 'h'.repeat(64),
      }),
      detectGitMetadata: async () => ({ repositoryUrl: 'not a remote at all' }),
      emit: async () => undefined,
    } as never);

    await service.register({ name: 'Press', localPath: 'C:/press' });
    expect(registered[0]?.repositoryUrl).toBeUndefined();
  });
});

describe('project service update', () => {
  const stored = {
    id: 'project-1',
    name: 'Renamed',
    localPath: 'C:/workspace/luwi',
    canonicalPath: 'C:/workspace/real/luwi',
    defaultBranch: 'main',
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-09-11T12:00:00.000Z',
  };

  it('passes only the fields given, with null meaning clear, and returns the stored record', async () => {
    let updateInput: unknown;
    const repository: RuntimeRepository = {
      registerProject: async () => {
        throw new Error('unexpected');
      },
      updateProject: async (input) => {
        updateInput = input;
        return {
          status: 'updated',
          project: stored,
          event: {
            id: 'event-9',
            version: 1,
            type: 'project.updated',
            occurredAt: stored.updatedAt,
            workspaceId: 'local',
            projectId: 'project-1',
            payload: {},
          },
          globalStreamId: '3-0',
          projectStreamId: '4-0',
        };
      },
      getProject: async () => null,
      listProjects: async () => [],
    };
    const service = createProjectService({
      repository,
      workspaceId: 'local',
      createId: () => 'event-9',
    });

    const project = await service.update('project-1', { name: 'Renamed', repositoryUrl: null });

    expect(project).toEqual(stored);
    expect(updateInput).toEqual({
      projectId: 'project-1',
      patch: { name: 'Renamed', repositoryUrl: null },
      workspaceId: 'local',
      eventId: 'event-9',
    });
  });

  it('maps a project the runtime does not hold to a 404', async () => {
    const service = createProjectService({
      repository: {
        registerProject: async () => {
          throw new Error('unexpected');
        },
        updateProject: async () => ({ status: 'not_found' }),
        getProject: async () => null,
        listProjects: async () => [],
      },
      workspaceId: 'local',
    });

    await expect(service.update('missing', { name: 'x' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
    await expect(service.update('missing', { name: 'x' })).rejects.toBeInstanceOf(ApplicationError);
  });

  it('hands the updated project to onUpdated so the canonical manifest follows the projection', async () => {
    const stored = {
      id: 'project-1',
      name: 'Renamed',
      localPath: 'C:/workspace/luwi',
      canonicalPath: 'C:/workspace/real/luwi',
      repositoryUrl: 'https://example.test/luwi.git',
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-09-13T10:22:10.604Z',
    };
    const tracked: unknown[] = [];
    const service = createProjectService({
      repository: {
        registerProject: async () => {
          throw new Error('unexpected');
        },
        updateProject: async () => ({
          status: 'updated',
          project: stored,
          event: {
            id: 'event-9',
            version: 1,
            type: 'project.updated',
            occurredAt: stored.updatedAt,
            workspaceId: 'local',
            projectId: 'project-1',
            payload: {},
          },
          globalStreamId: '3-0',
          projectStreamId: '4-0',
        }),
        getProject: async () => null,
        listProjects: async () => [],
      },
      workspaceId: 'local',
      onUpdated: async (project) => {
        tracked.push(project);
      },
    });

    await expect(service.update('project-1', { name: 'Renamed' })).resolves.toEqual(stored);
    expect(tracked).toEqual([stored]);
  });

  it('surfaces a failed manifest write instead of leaving the projection ahead of the manifest', async () => {
    const stored = {
      id: 'project-1',
      name: 'Renamed',
      localPath: 'C:/workspace/luwi',
      canonicalPath: 'C:/workspace/real/luwi',
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-09-13T10:22:10.604Z',
    };
    const service = createProjectService({
      repository: {
        registerProject: async () => {
          throw new Error('unexpected');
        },
        updateProject: async () => ({ status: 'unchanged', project: stored }),
        getProject: async () => null,
        listProjects: async () => [],
      },
      workspaceId: 'local',
      onUpdated: async () => {
        throw new Error('disk full');
      },
    });

    await expect(service.update('project-1', { name: 'Renamed' })).rejects.toThrow('disk full');
  });
});

describe('project service unchanged update', () => {
  it('returns the stored record when the patch matches what is stored', async () => {
    const stored = {
      id: 'project-1',
      name: 'Same',
      localPath: 'C:/workspace/luwi',
      canonicalPath: 'C:/workspace/real/luwi',
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z',
    };
    const service = createProjectService({
      repository: {
        registerProject: async () => {
          throw new Error('unexpected');
        },
        updateProject: async () => ({ status: 'unchanged', project: stored }),
        getProject: async () => null,
        listProjects: async () => [],
      },
      workspaceId: 'local',
    });

    await expect(service.update('project-1', { name: 'Same' })).resolves.toEqual(stored);
  });
});
