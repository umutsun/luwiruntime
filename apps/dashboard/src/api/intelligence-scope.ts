import {
  contextSourceCollectionSchema,
  graphSummarySchema,
  optimizationProposalCollectionSchema,
} from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient, ResourceResult } from './client.js';

/**
 * Global reads that only two routes need.
 *
 * They are loaded on demand rather than joining the Pulse snapshot, because
 * paying two extra requests on every page load to serve two routes would be a
 * cost the overview never recovers.
 */

const COLLECTION_LIMIT = 100;

export type ContextSource = {
  id: string;
  sourceType: string;
  path: string;
  loadingScope: 'global' | 'project' | 'agent';
  loadingMode: 'automatic' | 'conditional' | 'manual' | 'unknown';
  byteCount: number;
  lineCount: number;
  /**
   * Always a generic character estimate, never a measured token count.
   * AGENTS.md section 18 requires the estimate to be labelled as such, so the
   * method travels with the number rather than being dropped at the boundary.
   */
  estimatedTokenCount: number;
  estimationMethod: string;
};

export type OptimizationProposal = {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  state: string;
  confidence: 'high' | 'medium' | 'low';
  findingCount: number;
  actionCount: number;
  estimatedSavingTokens?: number;
  sessionCount: number;
  updatedAt: string;
};

export type KindCount = { kind: string; count: number };

/**
 * The bounded global graph answer from ADR 0013.
 *
 * `generation`, `nodeCount`, and `edgeCount` are absent together when the graph
 * has never been built. They are optional rather than zero-defaulted so the
 * view cannot render an unobserved graph as an empty one. Kinds are carried
 * verbatim; the dashboard owns no label map for them.
 */
export type GraphSummary = {
  observed: boolean;
  generation?: string;
  projectionHealth: 'healthy' | 'degraded';
  nodeCount?: number;
  edgeCount?: number;
  nodeCountsByKind: KindCount[];
  edgeCountsByKind: KindCount[];
  observedAt: string;
};

export type Bounded<T> = { items: T[]; truncated: boolean };

export type IntelligenceResources = {
  sources: ResourceState<Bounded<ContextSource>>;
  proposals: ResourceState<Bounded<OptimizationProposal>>;
  graph: ResourceState<GraphSummary>;
};

export type IntelligenceResourceKey = keyof IntelligenceResources;

export const intelligenceResourceKeys: readonly IntelligenceResourceKey[] = [
  'sources',
  'proposals',
  'graph',
];

type Entry = readonly [IntelligenceResourceKey, IntelligenceResources[IntelligenceResourceKey]];

function collected<T, U>(result: ResourceResult<T>, select: (data: T) => U): ResourceState<U> {
  return result.state === 'ready'
    ? { state: 'ready', data: select(result.data) }
    : { state: 'unavailable' };
}

/** Maps a runtime event type to the intelligence panels it invalidates. */
export function intelligenceResourcesForEvent(eventType: string): IntelligenceResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...intelligenceResourceKeys];
  if (eventType.startsWith('context.source.')) return ['sources'];
  if (eventType.startsWith('optimization.proposal.')) return ['proposals'];
  // Both projection and rebuild events change generation membership, which is
  // exactly what the summary counts.
  if (eventType.startsWith('graph.')) return ['graph'];
  return [];
}

export async function loadIntelligenceScope(
  client: DaemonClient,
  keys: readonly IntelligenceResourceKey[],
  options: { signal?: AbortSignal } = {},
): Promise<Partial<IntelligenceResources>> {
  const requested = new Set(keys);
  const get = options.signal === undefined ? {} : { signal: options.signal };
  const requests: Array<Promise<Entry>> = [];

  if (requested.has('sources')) {
    requests.push(
      client
        .get(
          `/api/v1/context/sources?limit=${COLLECTION_LIMIT}`,
          contextSourceCollectionSchema,
          get,
        )
        .then(
          (result) =>
            [
              'sources',
              collected(result, ({ sources, truncated }) => ({
                truncated,
                items: sources.map((source) => ({
                  id: source.id,
                  sourceType: source.sourceType,
                  path: source.path,
                  loadingScope: source.loadingScope,
                  loadingMode: source.loadingMode,
                  byteCount: source.byteCount,
                  lineCount: source.lineCount,
                  estimatedTokenCount: source.estimatedTokenCount,
                  estimationMethod: source.estimationMethod,
                })),
              })),
            ] as Entry,
        ),
    );
  }

  if (requested.has('proposals')) {
    requests.push(
      client
        .get(
          `/api/v1/optimization/proposals?limit=${COLLECTION_LIMIT}`,
          optimizationProposalCollectionSchema,
          get,
        )
        .then(
          (result) =>
            [
              'proposals',
              collected(result, ({ proposals, truncated }) => ({
                truncated,
                items: proposals.map((proposal) => ({
                  id: proposal.id,
                  projectId: proposal.projectId,
                  title: proposal.title,
                  summary: proposal.summary,
                  state: proposal.state,
                  confidence: proposal.confidence,
                  findingCount: proposal.findingIds.length,
                  actionCount: proposal.proposedActions.length,
                  ...(proposal.estimatedSavingTokens === undefined
                    ? {}
                    : { estimatedSavingTokens: proposal.estimatedSavingTokens }),
                  sessionCount: proposal.evidenceWindow.sessionCount,
                  updatedAt: proposal.updatedAt,
                })),
              })),
            ] as Entry,
        ),
    );
  }

  if (requested.has('graph')) {
    requests.push(
      client.get('/api/v1/graph/summary', graphSummarySchema, get).then(
        (result) =>
          [
            'graph',
            collected(result, (summary) => ({
              observed: summary.observed,
              ...(summary.generation === undefined ? {} : { generation: summary.generation }),
              projectionHealth: summary.projectionHealth,
              ...(summary.nodeCount === undefined ? {} : { nodeCount: summary.nodeCount }),
              ...(summary.edgeCount === undefined ? {} : { edgeCount: summary.edgeCount }),
              nodeCountsByKind: summary.nodeCountsByKind.map(({ kind, count }) => ({
                kind,
                count,
              })),
              edgeCountsByKind: summary.edgeCountsByKind.map(({ kind, count }) => ({
                kind,
                count,
              })),
              observedAt: summary.observedAt,
            })),
          ] as Entry,
      ),
    );
  }

  const entries = await Promise.all(requests);
  return Object.fromEntries(entries) as Partial<IntelligenceResources>;
}
