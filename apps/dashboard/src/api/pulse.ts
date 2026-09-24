import {
  agentDefinitionCollectionSchema,
  contextContributionCollectionSchema,
  coordinatorViewSchema,
  gitObservationSchema,
  healthResponseSchema,
  optimizationFindingCollectionSchema,
  projectAgentBindingCollectionSchema,
  projectCollectionResponseSchema,
  runtimeInfoResponseSchema,
  usageSummarySchema,
} from '@luwi/protocol/browser';
import { z } from 'zod';

import type {
  Availability,
  PulseBindingsEntry,
  PulseBindingsResource,
  PulseCoordinatorEntry,
  PulseCoordinatorResource,
  PulseGitEntry,
  PulseGitResource,
  PulseInput,
  PulseProject,
  PulseResources,
} from '../pulse/model.js';
import { dashboardEventMessageSchema, toDashboardEvent } from '../realtime/schema.js';
import type { DaemonClient, ResourceResult } from './client.js';

const sessionCollectionBrowserSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string().min(1),
      agentId: z.string().min(1),
      projectId: z.string().min(1),
      status: z.string().min(1),
      presence: z.enum(['online', 'offline']),
      startedAt: z.iso.datetime({ offset: false }),
      lastHeartbeatAt: z.iso.datetime({ offset: false }),
      branch: z.string().optional(),
      /**
       * What the session said it is doing, at registration. It is evidence the
       * session reported about itself — not a task the runtime assigned, and
       * not a task domain: AGENTS.md section 21 still prohibits orchestration.
       * The Active Work row labels it as reported for exactly that reason.
       */
      taskSummary: z.string().optional(),
      /** Free-form, as registered (e.g. `{ model }`). Declared so the parse keeps it. */
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const activityCollectionBrowserSchema = z.object({
  events: z.array(dashboardEventMessageSchema),
});

function availability<T, U>(result: ResourceResult<T>, select: (data: T) => U): Availability<U> {
  return result.state === 'ready'
    ? { state: 'ready', data: select(result.data) }
    : { state: 'unavailable' };
}

export type PulseLoaderOptions = {
  now?: () => Date;
  nowMs?: () => number;
  signal?: AbortSignal;
};

export type PulseResourceKey = keyof PulseResources;
type PulseResourceEntry = readonly [PulseResourceKey, PulseResources[PulseResourceKey]];

const pulseResourceKeys: PulseResourceKey[] = [
  'health',
  'projects',
  'sessions',
  'agents',
  'usage',
  'context',
  'activity',
  'findings',
  'runtime',
  'git',
  'coordinator',
  'bindings',
];

/**
 * The per-row read cost the redesign's Decision 4 accepted, bounded.
 *
 * One `GET /projects/:id/git` per registered project gives the Pulse its
 * Repository facts and the Projects table its HEAD column. The fan-out is
 * capped and the cap is disclosed as `truncated` — a project past it renders
 * `Unavailable`, never a silently missing row.
 */
const GIT_FANOUT_MAX = 12;

async function loadGitResource(
  client: DaemonClient,
  projects: Availability<PulseProject[]>,
  options: { signal?: AbortSignal },
): Promise<Availability<PulseGitResource>> {
  if (projects.state !== 'ready') return { state: 'unavailable' };
  const capped = projects.data.slice(0, GIT_FANOUT_MAX);
  const entries = await Promise.all(
    capped.map(async (project): Promise<PulseGitEntry> => {
      const result = await client.get(
        `/api/v1/projects/${encodeURIComponent(project.id)}/git`,
        gitObservationSchema,
        options,
      );
      if (result.state === 'ready') {
        return {
          projectId: project.id,
          git: {
            state: 'ready',
            data: {
              ...(result.data.branch === undefined ? {} : { branch: result.data.branch }),
              ...(result.data.headSha === undefined ? {} : { headSha: result.data.headSha }),
              clean: result.data.clean,
              untrackedCount: result.data.untrackedCount,
              tagCount: result.data.tags.length,
              // The observer captures only a bounded recent window (git log -n),
              // never a true total, so this is "recent observed", not the count.
              recentCommitCount: result.data.recentCommits.length,
              // `commitCount` is the true reachable-commit total (git rev-list
              // --count), which is what the registry shows as a size hint.
              ...(result.data.commitCount === undefined
                ? {}
                : { commitCount: result.data.commitCount }),
              observedAt: result.data.observedAt,
            },
          },
        };
      }
      // A 404 is the daemon's complete answer: no scan has been recorded for
      // this project. Reporting it as unavailable would claim a fault.
      if (result.httpStatus === 404)
        return { projectId: project.id, git: { state: 'not-observed' } };
      return { projectId: project.id, git: { state: 'unavailable' } };
    }),
  );
  return {
    state: 'ready',
    data: { truncated: projects.data.length > GIT_FANOUT_MAX, entries },
  };
}

/**
 * One `GET /projects/:id/coordinator` per project (same bounded fan-out as git),
 * so the sessions table can badge the holder and offer Make/Release without a
 * per-row read. The view always answers 200 (`{coordinator, live}`), so there is
 * no not-observed state — a failed read is `unavailable`.
 */
async function loadCoordinatorResource(
  client: DaemonClient,
  projects: Availability<PulseProject[]>,
  options: { signal?: AbortSignal },
): Promise<Availability<PulseCoordinatorResource>> {
  if (projects.state !== 'ready') return { state: 'unavailable' };
  const capped = projects.data.slice(0, GIT_FANOUT_MAX);
  const entries = await Promise.all(
    capped.map(async (project): Promise<PulseCoordinatorEntry> => {
      const result = await client.get(
        `/api/v1/projects/${encodeURIComponent(project.id)}/coordinator`,
        coordinatorViewSchema,
        options,
      );
      if (result.state === 'ready') {
        return {
          projectId: project.id,
          coordinator: {
            state: 'ready',
            data: {
              sessionId: result.data.coordinator?.sessionId ?? null,
              live: result.data.live,
            },
          },
        };
      }
      return { projectId: project.id, coordinator: { state: 'unavailable' } };
    }),
  );
  return {
    state: 'ready',
    data: { truncated: projects.data.length > GIT_FANOUT_MAX, entries },
  };
}

/**
 * One `GET /projects/:id/agents` per project (the same bounded fan-out), kept
 * to what the overview states: which enabled agent holds which flow role (F5,
 * ADR 0036). The collection always answers 200 for a registered project, so a
 * failed read is `unavailable`, never an empty list.
 */
async function loadBindingsResource(
  client: DaemonClient,
  projects: Availability<PulseProject[]>,
  options: { signal?: AbortSignal },
): Promise<Availability<PulseBindingsResource>> {
  if (projects.state !== 'ready') return { state: 'unavailable' };
  const capped = projects.data.slice(0, GIT_FANOUT_MAX);
  const entries = await Promise.all(
    capped.map(async (project): Promise<PulseBindingsEntry> => {
      const result = await client.get(
        `/api/v1/projects/${encodeURIComponent(project.id)}/agents`,
        projectAgentBindingCollectionSchema,
        options,
      );
      if (result.state === 'ready') {
        return {
          projectId: project.id,
          bindings: {
            state: 'ready',
            data: result.data.bindings.map((binding) => ({
              agentId: binding.agentId,
              enabled: binding.enabled,
              flowRoles: binding.flowRoles ?? [],
            })),
          },
        };
      }
      return { projectId: project.id, bindings: { state: 'unavailable' } };
    }),
  );
  return {
    state: 'ready',
    data: { truncated: projects.data.length > GIT_FANOUT_MAX, entries },
  };
}

export async function loadPulseResources(
  client: DaemonClient,
  keys: readonly PulseResourceKey[],
  options: Pick<PulseLoaderOptions, 'signal'> = {},
): Promise<Partial<PulseResources>> {
  const requested = new Set(keys);
  const entry = <T, U>(
    key: PulseResourceKey,
    request: Promise<ResourceResult<T>>,
    select: (data: T) => U,
  ): Promise<PulseResourceEntry> =>
    request.then((result) => [key, availability(result, select)] as PulseResourceEntry);
  const requests: Array<Promise<PulseResourceEntry>> = [];

  for (const key of pulseResourceKeys) {
    if (!requested.has(key)) continue;

    switch (key) {
      case 'health':
        requests.push(
          entry(
            key,
            client.get('/health', healthResponseSchema, {
              acceptValidatedErrorBody: true,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            }),
            ({ status, runtimeState, uptimeMs, redis }) => ({
              status,
              runtimeState,
              uptimeMs,
              redis,
            }),
          ),
        );
        break;
      case 'projects':
        requests.push(
          entry(
            key,
            client.get('/api/v1/projects', projectCollectionResponseSchema, options),
            ({ projects: values }) =>
              values.map(({ id, name, localPath, repositoryUrl, defaultBranch }) => ({
                id,
                name,
                localPath,
                ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
                ...(defaultBranch === undefined ? {} : { defaultBranch }),
              })),
          ),
        );
        break;
      case 'sessions':
        requests.push(
          entry(
            key,
            client.get('/api/v1/sessions', sessionCollectionBrowserSchema, options),
            ({ sessions: values }) =>
              values.map((session) => ({
                id: session.id,
                agentId: session.agentId,
                projectId: session.projectId,
                status: session.status,
                presence: session.presence,
                startedAt: session.startedAt,
                lastHeartbeatAt: session.lastHeartbeatAt,
                ...(session.branch === undefined ? {} : { branch: session.branch }),
                ...(session.taskSummary === undefined ? {} : { taskSummary: session.taskSummary }),
                ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
              })),
          ),
        );
        break;
      case 'agents':
        requests.push(
          entry(
            key,
            client.get('/api/v1/agents', agentDefinitionCollectionSchema, options),
            ({ agents: values }) =>
              values.map((agent) => ({
                id: agent.id,
                // Rendered verbatim; the dashboard never branches on vendor.
                kind: agent.kind,
                displayName: agent.displayName,
                adapterId: agent.adapterId,
                enabled: agent.enabled,
                ...(agent.detectedVersion === undefined
                  ? {}
                  : { detectedVersion: agent.detectedVersion }),
                updatedAt: agent.updatedAt,
              })),
          ),
        );
        break;
      case 'usage':
        requests.push(
          entry(
            key,
            client.get('/api/v1/usage/summary?limit=1000', usageSummarySchema, options),
            ({ sources }) =>
              sources.map(({ source, recordCount, totalTokens, inputTokens, outputTokens }) => {
                // Transcript-derived usage (adapter-extracted) stores input, output
                // and cache separately and carries no pre-summed `totalTokens`, so
                // the tile read empty on the live fleet though 18k records existed.
                // Derive the headline the same way the protocol defines it —
                // inputTokens + outputTokens, both fresh — never folding cache in
                // (cache-read dwarfs real work and is not new tokens).
                const derived =
                  totalTokens ??
                  (inputTokens !== undefined && outputTokens !== undefined
                    ? inputTokens + outputTokens
                    : undefined);
                return {
                  source,
                  recordCount,
                  ...(derived === undefined ? {} : { totalTokens: derived }),
                };
              }),
          ),
        );
        break;
      case 'context':
        requests.push(
          entry(
            key,
            client.get(
              '/api/v1/context/contributions?limit=1000',
              contextContributionCollectionSchema,
              options,
            ),
            ({ contributions }) => contributions,
          ),
        );
        break;
      case 'activity':
        requests.push(
          entry(
            key,
            client.get('/api/v1/events?limit=200', activityCollectionBrowserSchema, options),
            ({ events }) => events.map(toDashboardEvent),
          ),
        );
        break;
      case 'runtime':
        requests.push(
          entry(
            key,
            client.get('/api/v1/runtime', runtimeInfoResponseSchema, options),
            ({
              workspaceId,
              version,
              protocolVersion,
              runtimeState,
              runtimeInstanceId,
              startedAt,
              uptimeMs,
              host,
              port,
            }) => ({
              workspaceId,
              version,
              protocolVersion,
              runtimeState,
              runtimeInstanceId,
              startedAt,
              uptimeMs,
              host,
              port,
            }),
          ),
        );
        break;
      case 'git':
      case 'coordinator':
      case 'bindings':
        // Depend on the project list; resolved after the batch below.
        break;
      case 'findings':
        requests.push(
          entry(
            key,
            client.get(
              '/api/v1/optimization/findings?limit=100',
              optimizationFindingCollectionSchema,
              options,
            ),
            ({ findings: values }) =>
              values.map((finding) => ({
                id: finding.id,
                projectId: finding.projectId,
                kind: finding.kind,
                title: finding.title,
                summary: finding.summary,
                state: finding.state,
                confidence: finding.confidence,
                sessionCount: finding.evidenceWindow.sessionCount,
                observationCount: finding.evidenceWindow.observationCount,
                updatedAt: finding.updatedAt,
              })),
          ),
        );
        break;
    }
  }

  const entries = await Promise.all(requests);
  const resources = Object.fromEntries(entries) as Partial<PulseResources>;

  if (requested.has('git') || requested.has('coordinator') || requested.has('bindings')) {
    // The fan-outs need the project list. Reuse the one from this batch when it
    // was requested; a fan-out-only invalidation fetches it fresh once.
    const projects: Availability<PulseProject[]> =
      resources.projects ??
      (await client
        .get('/api/v1/projects', projectCollectionResponseSchema, options)
        .then((result) =>
          availability(result, ({ projects: values }) =>
            values.map(({ id, name, localPath, repositoryUrl, defaultBranch }) => ({
              id,
              name,
              localPath,
              ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
              ...(defaultBranch === undefined ? {} : { defaultBranch }),
            })),
          ),
        ));
    if (requested.has('git')) resources.git = await loadGitResource(client, projects, options);
    if (requested.has('coordinator')) {
      resources.coordinator = await loadCoordinatorResource(client, projects, options);
    }
    if (requested.has('bindings')) {
      resources.bindings = await loadBindingsResource(client, projects, options);
    }
  }

  return resources;
}

export async function loadPulseInput(
  client: DaemonClient,
  options: PulseLoaderOptions = {},
): Promise<PulseInput> {
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? (() => performance.now());
  const startedAt = nowMs();
  const resources = await loadPulseResources(client, pulseResourceKeys, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    snapshotAt: now().toISOString(),
    measuredLatencyMs: Math.max(0, Math.round(nowMs() - startedAt)),
    health: resources.health ?? { state: 'unavailable' },
    projects: resources.projects ?? { state: 'unavailable' },
    sessions: resources.sessions ?? { state: 'unavailable' },
    agents: resources.agents ?? { state: 'unavailable' },
    usage: resources.usage ?? { state: 'unavailable' },
    context: resources.context ?? { state: 'unavailable' },
    activity: resources.activity ?? { state: 'unavailable' },
    findings: resources.findings ?? { state: 'unavailable' },
    runtime: resources.runtime ?? { state: 'unavailable' },
    git: resources.git ?? { state: 'unavailable' },
    coordinator: resources.coordinator ?? { state: 'unavailable' },
    bindings: resources.bindings ?? { state: 'unavailable' },
  };
}
