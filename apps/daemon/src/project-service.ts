import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { repositoryRemoteSchema } from '@luwi/protocol';
import type { Project, ProjectRegistrationRequest, ProjectUpdateRequest } from '@luwi/protocol';
import type { RuntimeRepository } from '@luwi/redis';
import { ApplicationError, canonicalizeProjectPath, type CanonicalPath } from '@luwi/runtime';

const execFileAsync = promisify(execFile);

export type GitMetadata = {
  repositoryUrl?: string;
  defaultBranch?: string;
};

export type ProjectService = {
  register(request: ProjectRegistrationRequest): Promise<Project>;
  /** Name, remote and default branch only; the path is identity and never changes. */
  update(projectId: string, request: ProjectUpdateRequest): Promise<Project>;
  reconcileCanonical(projects: readonly Project[]): Promise<{ rebuilt: number; unchanged: number }>;
  get(projectId: string): Promise<Project | null>;
  list(): Promise<Project[]>;
};

export type ProjectServiceOptions = {
  repository: RuntimeRepository;
  workspaceId: string;
  createId?: () => string;
  canonicalizePath?: (input: string) => Promise<CanonicalPath>;
  detectGitMetadata?: (canonicalPath: string) => Promise<GitMetadata>;
  onRegistered?: (project: Project) => void;
  /** Invoked after a successful update so the canonical manifest can follow the projection. */
  onUpdated?: (project: Project) => Promise<void> | void;
};

async function gitValue(canonicalPath: string, arguments_: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', canonicalPath, ...arguments_], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    });
    const value = stdout.trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

function sameProjectFacts(left: Project, right: Project): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.localPath === right.localPath &&
    left.canonicalPath === right.canonicalPath &&
    left.repositoryUrl === right.repositoryUrl &&
    left.defaultBranch === right.defaultBranch &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

export async function detectGitMetadata(canonicalPath: string): Promise<GitMetadata> {
  const [repositoryUrl, remoteHead] = await Promise.all([
    gitValue(canonicalPath, ['config', '--get', 'remote.origin.url']),
    gitValue(canonicalPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  const defaultBranch = remoteHead?.replace(/^origin\//, '');
  return {
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
  };
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const createId = options.createId ?? randomUUID;
  const canonicalizePath = options.canonicalizePath ?? canonicalizeProjectPath;
  const inspectGit = options.detectGitMetadata ?? detectGitMetadata;

  return {
    async reconcileCanonical(projects) {
      let rebuilt = 0;
      let unchanged = 0;
      for (const project of projects) {
        const canonical = await canonicalizePath(project.localPath);
        if (canonical.canonicalPath !== project.canonicalPath) {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'A canonical project path no longer matches the filesystem.',
            503,
            { projectId: project.id },
          );
        }
        const current = await options.repository.getProject(project.id);
        if (current !== null) {
          if (!sameProjectFacts(current, project)) {
            throw new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              'A canonical project conflicts with the runtime projection.',
              503,
              { projectId: project.id },
            );
          }
          unchanged += 1;
          continue;
        }
        const result = await options.repository.registerProject({
          project: {
            id: project.id,
            name: project.name,
            localPath: project.localPath,
            canonicalPath: project.canonicalPath,
            identityPath: canonical.identityPath,
            pathIdentityHash: canonical.pathIdentityHash,
            ...(project.repositoryUrl === undefined
              ? {}
              : { repositoryUrl: project.repositoryUrl }),
            ...(project.defaultBranch === undefined
              ? {}
              : { defaultBranch: project.defaultBranch }),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
          workspaceId: options.workspaceId,
          eventId: createId(),
        });
        if (result.status !== 'created') {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'A canonical project conflicts with the runtime projection.',
            503,
            { projectId: project.id },
          );
        }
        rebuilt += 1;
      }
      return { rebuilt, unchanged };
    },

    async register(request) {
      const canonical = await canonicalizePath(request.localPath);
      const detected = await inspectGit(canonical.canonicalPath);
      /*
       * Write-what-you-can-read: a detected remote that the projection schema
       * would refuse must be dropped here, not persisted into a record the
       * read path rejects forever — one such record turns the whole project
       * list into a server error (ADR 0015). The schema now admits scp-style
       * remotes; this guards whatever else `git config` may hand back.
       */
      const detectedUrl =
        detected.repositoryUrl !== undefined &&
        repositoryRemoteSchema.safeParse(detected.repositoryUrl).success
          ? detected.repositoryUrl
          : undefined;
      const repositoryUrl = request.repositoryUrl ?? detectedUrl;
      const defaultBranch = request.defaultBranch ?? detected.defaultBranch;
      const result = await options.repository.registerProject({
        project: {
          id: createId(),
          name: request.name,
          localPath: canonical.localPath,
          canonicalPath: canonical.canonicalPath,
          identityPath: canonical.identityPath,
          pathIdentityHash: canonical.pathIdentityHash,
          ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
          ...(defaultBranch === undefined ? {} : { defaultBranch }),
        },
        workspaceId: options.workspaceId,
        eventId: createId(),
      });

      if (result.status === 'created') {
        options.onRegistered?.(result.project);
        return result.project;
      }
      if (result.reason === 'duplicate') {
        throw new ApplicationError(
          'PROJECT_ALREADY_REGISTERED',
          'A project is already registered for this local path.',
          409,
          {
            existingProjectId: result.existingProjectId,
            canonicalLocalPath: result.canonicalPath,
          },
        );
      }
      throw new ApplicationError(
        'PROJECT_PATH_HASH_COLLISION',
        'The project path identity conflicts with an existing project.',
        409,
      );
    },

    async update(projectId, request) {
      const result = await options.repository.updateProject({
        projectId,
        patch: {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.repositoryUrl === undefined ? {} : { repositoryUrl: request.repositoryUrl }),
          ...(request.defaultBranch === undefined ? {} : { defaultBranch: request.defaultBranch }),
        },
        workspaceId: options.workspaceId,
        eventId: createId(),
      });
      if (result.status === 'not_found') {
        throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
      }
      /*
       * The canonical manifest (~/.luwi/manifest.json) is otherwise rewritten only by the
       * start-up reconcile, and that reconcile refuses to start the daemon when a canonical
       * project disagrees with its projection — so an update that reached Redis alone locked
       * the next restart out (2026-09-13). Await the tracker: a manifest write that failed
       * must surface here, not at the next start.
       */
      await options.onUpdated?.(result.project);
      return result.project;
    },

    get: (projectId) => options.repository.getProject(projectId),
    list: () => options.repository.listProjects(),
  };
}
