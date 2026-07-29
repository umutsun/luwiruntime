import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Project, ProjectRegistrationRequest } from '@luwi/protocol';
import type { RuntimeRepository } from '@luwi/redis';
import { ApplicationError, canonicalizeProjectPath, type CanonicalPath } from '@luwi/runtime';

const execFileAsync = promisify(execFile);

export type GitMetadata = {
  repositoryUrl?: string;
  defaultBranch?: string;
};

export type ProjectService = {
  register(request: ProjectRegistrationRequest): Promise<Project>;
  get(projectId: string): Promise<Project | null>;
  list(): Promise<Project[]>;
};

export type ProjectServiceOptions = {
  repository: RuntimeRepository;
  workspaceId: string;
  createId?: () => string;
  canonicalizePath?: (input: string) => Promise<CanonicalPath>;
  detectGitMetadata?: (canonicalPath: string) => Promise<GitMetadata>;
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
    async register(request) {
      const canonical = await canonicalizePath(request.localPath);
      const detected = await inspectGit(canonical.canonicalPath);
      const repositoryUrl = request.repositoryUrl ?? detected.repositoryUrl;
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

    get: (projectId) => options.repository.getProject(projectId),
    list: () => options.repository.listProjects(),
  };
}
