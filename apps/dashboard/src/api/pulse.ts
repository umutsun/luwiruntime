import {
  agentDefinitionCollectionSchema,
  contextContributionCollectionSchema,
  healthResponseSchema,
  optimizationFindingCollectionSchema,
  projectCollectionResponseSchema,
  usageSummarySchema,
} from '@luwi/protocol/browser';
import { z } from 'zod';

import type { Availability, PulseInput, PulseResources } from '../pulse/model.js';
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
];

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
              values.map(({ id, name, localPath }) => ({ id, name, localPath })),
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
              })),
          ),
        );
        break;
      case 'agents':
        requests.push(
          entry(
            key,
            client.get('/api/v1/agents', agentDefinitionCollectionSchema, options),
            ({ agents: values }) => values,
          ),
        );
        break;
      case 'usage':
        requests.push(
          entry(
            key,
            client.get('/api/v1/usage/summary?limit=1000', usageSummarySchema, options),
            ({ sources }) =>
              sources.map(({ source, recordCount, totalTokens }) => ({
                source,
                recordCount,
                ...(totalTokens === undefined ? {} : { totalTokens }),
              })),
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
            client.get('/api/v1/events?limit=20', activityCollectionBrowserSchema, options),
            ({ events }) => events.map(toDashboardEvent),
          ),
        );
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
            ({ findings: values }) => values,
          ),
        );
        break;
    }
  }

  const entries = await Promise.all(requests);

  return Object.fromEntries(entries) as Partial<PulseResources>;
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
  };
}
