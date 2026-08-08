import {
  gitObservationSchema,
  packageCollectionSchema,
  projectAgentBindingCollectionSchema,
  technologyCollectionSchema,
} from '@luwi/protocol/browser';

import type { DaemonClient, ResourceResult } from './client.js';

/**
 * Project-scoped reads.
 *
 * Every resource here is project-scoped by necessity: the daemon exposes no
 * global Git, package, technology, or binding collection. This is the "bounded
 * join" that `docs/phase5-dashboard-capability-matrix.md` marks DERIVABLE.
 *
 * These loads are on demand rather than part of the Pulse snapshot, so
 * selecting a project costs four requests and selecting none costs zero.
 */

/** `INTELLIGENCE_MAX_LIMIT` allows more; the dashboard asks for a display-sized page. */
const COLLECTION_LIMIT = 100;

/**
 * `not-observed` is distinct from `unavailable` on purpose.
 *
 * `GET /api/v1/projects/:projectId/git` answers 404 `GIT_REPOSITORY_NOT_FOUND`
 * when no observation has been recorded. That is a complete, true answer — the
 * project simply has not been scanned. Rendering it as `unavailable` would
 * claim something is broken when nothing is.
 */
export type ProjectResourceState<T> =
  { state: 'ready'; data: T } | { state: 'not-observed' } | { state: 'unavailable' };

export type ProjectCommit = {
  sha: string;
  committedAt: string;
  subject?: string;
  authorIdentity?: string;
  changedPathCount: number;
  merge: boolean;
};

export type ProjectGit = {
  repositoryRoot: string;
  branch?: string;
  headSha?: string;
  defaultBranch?: string;
  remoteUrl?: string;
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  ahead?: number;
  behind?: number;
  worktreeCount: number;
  branchCount: number;
  tagCount: number;
  recentCommits: ProjectCommit[];
  observedAt: string;
};

export type ProjectPackage = {
  id: string;
  ecosystem: string;
  packageName: string;
  declaredVersion?: string;
  dependencyType: string;
  direct?: boolean;
  workspaceLocation: string;
};

export type ProjectTechnology = {
  id: string;
  name: string;
  category: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  evidenceCount: number;
};

export type ProjectBinding = {
  id: string;
  agentId: string;
  enabled: boolean;
  role?: string;
  profileCount: number;
  capabilityCount: number;
  updatedAt: string;
};

export type Bounded<T> = { items: T[]; truncated: boolean };

export type ProjectScopeResources = {
  git: ProjectResourceState<ProjectGit>;
  packages: ProjectResourceState<Bounded<ProjectPackage>>;
  technologies: ProjectResourceState<Bounded<ProjectTechnology>>;
  bindings: ProjectResourceState<ProjectBinding[]>;
};

export type ProjectScopeResourceKey = keyof ProjectScopeResources;

export const projectScopeResourceKeys: readonly ProjectScopeResourceKey[] = [
  'git',
  'packages',
  'technologies',
  'bindings',
];

type ScopeEntry = readonly [
  ProjectScopeResourceKey,
  ProjectScopeResources[ProjectScopeResourceKey],
];

/**
 * Maps a runtime event type to the project panels it invalidates.
 *
 * This is deliberately separate from `resourcesForEvent` in
 * `realtime/invalidation.ts`. That coordinator owns the global Pulse snapshot
 * and its key union; project scope is a different lifetime — it exists only
 * while a project is selected — so widening the Pulse union would couple two
 * independent refresh domains.
 *
 * `project.registered` and `project.updated` return nothing: they change the
 * global project list, which the Pulse coordinator already refreshes, and they
 * carry no evidence any project panel renders.
 */
export function projectResourcesForEvent(eventType: string): ProjectScopeResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...projectScopeResourceKeys];
  if (eventType.startsWith('git.')) return ['git'];
  if (eventType.startsWith('package.')) return ['packages'];
  if (eventType.startsWith('technology.')) return ['technologies'];
  if (eventType.startsWith('project.agent.')) return ['bindings'];
  return [];
}

/** Collections have no not-observed answer: an empty list is the empty answer. */
function collected<T, U>(
  result: ResourceResult<T>,
  select: (data: T) => U,
): ProjectResourceState<U> {
  return result.state === 'ready'
    ? { state: 'ready', data: select(result.data) }
    : { state: 'unavailable' };
}

function observed<T, U>(
  result: ResourceResult<T>,
  select: (data: T) => U,
): ProjectResourceState<U> {
  if (result.state === 'ready') return { state: 'ready', data: select(result.data) };
  return result.reason === 'http' && result.httpStatus === 404
    ? { state: 'not-observed' }
    : { state: 'unavailable' };
}

export async function loadProjectScope(
  client: DaemonClient,
  projectId: string,
  keys: readonly ProjectScopeResourceKey[],
  options: { signal?: AbortSignal } = {},
): Promise<Partial<ProjectScopeResources>> {
  const requested = new Set(keys);
  // Encoding keeps an id containing `/` or `..` inside its own path segment.
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const get = options.signal === undefined ? {} : { signal: options.signal };

  const entry = <T, U>(
    key: ProjectScopeResourceKey,
    request: Promise<ResourceResult<T>>,
    map: (result: ResourceResult<T>) => ProjectResourceState<U>,
  ): Promise<ScopeEntry> => request.then((result) => [key, map(result)] as ScopeEntry);

  const requests: Array<Promise<ScopeEntry>> = [];

  for (const key of projectScopeResourceKeys) {
    if (!requested.has(key)) continue;

    switch (key) {
      case 'git':
        requests.push(
          entry(key, client.get(`${base}/git`, gitObservationSchema, get), (result) =>
            observed(result, (observation) => ({
              repositoryRoot: observation.repositoryRoot,
              ...(observation.branch === undefined ? {} : { branch: observation.branch }),
              ...(observation.headSha === undefined ? {} : { headSha: observation.headSha }),
              ...(observation.defaultBranch === undefined
                ? {}
                : { defaultBranch: observation.defaultBranch }),
              ...(observation.remoteUrl === undefined ? {} : { remoteUrl: observation.remoteUrl }),
              clean: observation.clean,
              stagedCount: observation.stagedCount,
              unstagedCount: observation.unstagedCount,
              untrackedCount: observation.untrackedCount,
              ...(observation.ahead === undefined ? {} : { ahead: observation.ahead }),
              ...(observation.behind === undefined ? {} : { behind: observation.behind }),
              worktreeCount: observation.worktrees.length,
              branchCount: observation.branches.length,
              tagCount: observation.tags.length,
              recentCommits: observation.recentCommits.map((commit) => ({
                sha: commit.sha,
                committedAt: commit.committedAt,
                ...(commit.subject === undefined ? {} : { subject: commit.subject }),
                ...(commit.authorIdentity === undefined
                  ? {}
                  : { authorIdentity: commit.authorIdentity }),
                // Reduced to a count: the dashboard never renders a full path list.
                changedPathCount: commit.changedPaths.length,
                merge: commit.merge,
              })),
              observedAt: observation.observedAt,
            })),
          ),
        );
        break;
      case 'packages':
        requests.push(
          entry(
            key,
            client.get(`${base}/packages?limit=${COLLECTION_LIMIT}`, packageCollectionSchema, get),
            (result) =>
              collected(result, ({ packages, truncated }) => ({
                truncated,
                items: packages.map((record) => ({
                  id: record.id,
                  ecosystem: record.ecosystem,
                  packageName: record.packageName,
                  ...(record.declaredVersion === undefined
                    ? {}
                    : { declaredVersion: record.declaredVersion }),
                  dependencyType: record.dependencyType,
                  ...(record.direct === undefined ? {} : { direct: record.direct }),
                  workspaceLocation: record.workspaceLocation,
                })),
              })),
          ),
        );
        break;
      case 'technologies':
        requests.push(
          entry(
            key,
            client.get(
              `${base}/technologies?limit=${COLLECTION_LIMIT}`,
              technologyCollectionSchema,
              get,
            ),
            (result) =>
              collected(result, ({ technologies, truncated }) => ({
                truncated,
                items: technologies.map((record) => ({
                  id: record.id,
                  name: record.name,
                  category: record.category,
                  confidence: record.confidence,
                  evidenceCount: record.evidence.length,
                })),
              })),
          ),
        );
        break;
      case 'bindings':
        requests.push(
          entry(
            key,
            client.get(`${base}/agents`, projectAgentBindingCollectionSchema, get),
            (result) =>
              collected(result, ({ bindings }) =>
                bindings.map((binding) => ({
                  id: binding.id,
                  agentId: binding.agentId,
                  enabled: binding.enabled,
                  ...(binding.role === undefined ? {} : { role: binding.role }),
                  profileCount: binding.profileIds.length,
                  capabilityCount: binding.capabilityBindingIds.length,
                  updatedAt: binding.updatedAt,
                })),
              ),
          ),
        );
        break;
    }
  }

  const entries = await Promise.all(requests);
  return Object.fromEntries(entries) as Partial<ProjectScopeResources>;
}
