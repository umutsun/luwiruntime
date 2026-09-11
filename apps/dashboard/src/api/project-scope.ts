import {
  attributionCollectionSchema,
  capabilityCollectionSchema,
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
 * selecting a project costs seven requests and selecting none costs zero.
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

export type ProjectWorktree = {
  path: string;
  headSha: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
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
  /**
   * Carried whole rather than as counts.
   *
   * The observation already delivers these arrays and the schema bounds each at
   * 1000, so reducing them to `.length` at this boundary discarded every name
   * the daemon had observed in exchange for nothing.
   */
  branches: string[];
  tags: string[];
  worktrees: ProjectWorktree[];
  recentCommits: ProjectCommit[];
  observedAt: string;
};

/**
 * One commit the runtime tried to tie to a session.
 *
 * `sessionId` and `agentId` are absent together when no correlation was found.
 * They stay optional rather than being defaulted, because an unattributed
 * commit is an observation — the runtime looked and could not tell — and
 * `reasons` is where it says why.
 */
export type ProjectAttribution = {
  id: string;
  commitSha: string;
  sessionId?: string;
  agentId?: string;
  confidence: 'exact' | 'correlated' | 'estimated' | 'unknown';
  reasons: string[];
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

/**
 * A capability package the runtime registered for this project: its skills,
 * instructions, hooks and MCP definitions as scanned from the project tree.
 * `path` is where the file lives, so the owner can go and edit it; nothing
 * here executes or rewrites it (AGENTS.md §12, §18).
 */
export type ProjectCapability = {
  id: string;
  kind: string;
  name: string;
  version?: string;
  /** The project's own package, or a global one every project's agents may load. */
  scope: 'global' | 'project';
  source: string;
  path?: string;
  enabled: boolean;
  /** Registered by observation of the project tree rather than declared by hand. */
  observed: boolean;
  updatedAt: string;
};

export type Bounded<T> = { items: T[]; truncated: boolean };

export type ProjectScopeResources = {
  git: ProjectResourceState<ProjectGit>;
  attributions: ProjectResourceState<Bounded<ProjectAttribution>>;
  packages: ProjectResourceState<Bounded<ProjectPackage>>;
  technologies: ProjectResourceState<Bounded<ProjectTechnology>>;
  bindings: ProjectResourceState<ProjectBinding[]>;
  capabilities: ProjectResourceState<Bounded<ProjectCapability>>;
};

export type ProjectScopeResourceKey = keyof ProjectScopeResources;

export const projectScopeResourceKeys: readonly ProjectScopeResourceKey[] = [
  'git',
  'attributions',
  'packages',
  'technologies',
  'bindings',
  'capabilities',
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
 *
 * `git.` deliberately does not also refresh attributions. A git scan emits one
 * `attribution.recorded` per record it writes, so the precise prefix already
 * covers everything a scan produces and mapping both would refresh the same
 * panel twice for a single cause.
 */
export function projectResourcesForEvent(eventType: string): ProjectScopeResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...projectScopeResourceKeys];
  if (eventType.startsWith('git.')) return ['git'];
  if (eventType.startsWith('attribution.')) return ['attributions'];
  if (eventType.startsWith('package.')) return ['packages'];
  if (eventType.startsWith('technology.')) return ['technologies'];
  if (eventType.startsWith('project.agent.')) return ['bindings'];
  // Exact prefix on purpose: `context.capability.*` records an agent loading a
  // skill, which changes no row of the project's own inventory.
  if (eventType.startsWith('capability.')) return ['capabilities'];
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
      case 'capabilities': {
        // Two bounded reads, filtered server-side: the project's own packages and
        // the global ones its agents may load. Each carries its own truncation
        // flag; either cut is disclosed rather than hidden behind the other.
        const scoped = (query: string) =>
          client.get(
            `/api/v1/capabilities?${query}&limit=${COLLECTION_LIMIT}`,
            capabilityCollectionSchema,
            get,
          );
        requests.push(
          Promise.all([
            scoped(`scope=project&projectId=${encodeURIComponent(projectId)}`),
            scoped('scope=global'),
          ]).then(([own, global]): ScopeEntry => {
            if (own.state !== 'ready' || global.state !== 'ready') {
              return [key, { state: 'unavailable' }];
            }
            const items = [...own.data.capabilities, ...global.data.capabilities].map((record) => ({
              id: record.id,
              kind: record.kind,
              name: record.name,
              ...(record.version === undefined ? {} : { version: record.version }),
              scope: record.scope,
              source: record.source,
              ...(record.path === undefined ? {} : { path: record.path }),
              enabled: record.enabled,
              observed:
                record.manifest['managementMode'] === 'observed' &&
                typeof record.manifest['observation'] === 'object' &&
                record.manifest['observation'] !== null,
              updatedAt: record.updatedAt,
            }));
            return [
              key,
              {
                state: 'ready',
                data: { items, truncated: own.data.truncated || global.data.truncated },
              },
            ];
          }),
        );
        break;
      }
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
              branches: [...observation.branches],
              tags: [...observation.tags],
              worktrees: observation.worktrees.map((worktree) => ({
                path: worktree.path,
                headSha: worktree.headSha,
                ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
                // An absent flag is not a false one: git reports these only when
                // they hold, and defaulting would assert a state never observed.
                ...(worktree.detached === undefined ? {} : { detached: worktree.detached }),
                ...(worktree.locked === undefined ? {} : { locked: worktree.locked }),
              })),
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
      case 'attributions':
        requests.push(
          entry(
            key,
            client.get(
              `${base}/git/attributions?limit=${COLLECTION_LIMIT}`,
              attributionCollectionSchema,
              get,
            ),
            (result) =>
              // `collected`, not `observed`: this endpoint answers with an empty
              // collection when nothing has been recorded, so it has no 404 and
              // therefore no not-observed answer to distinguish.
              collected(result, ({ attributions, truncated }) => ({
                truncated,
                items: attributions.map((record) => ({
                  id: record.id,
                  commitSha: record.commitSha,
                  ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
                  ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
                  confidence: record.confidence,
                  reasons: [...record.reasons],
                  observedAt: record.observedAt,
                })),
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
