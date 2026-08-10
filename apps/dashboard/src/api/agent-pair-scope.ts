import {
  contextFootprintSchema,
  contextSummarySchema,
  effectiveAgentConfigurationSchema,
} from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient, ResourceResult } from './client.js';

/**
 * The reads that need both a project and an agent.
 *
 * The Projects route has shown `profileCount` and `capabilityCount` since Phase
 * 5C — two numbers whose contents could not be opened, which the 2026-08-09
 * audit called the one coverage gap with a concrete user-visible dead end.
 * These are the reads that open them, plus the pair-scoped context reads that
 * `docs/phase5-dashboard-capability-matrix.md` counted as in scope from the
 * start.
 *
 * Loaded only when a bound agent is selected, so a project with no selection
 * costs nothing extra.
 */

export type EffectiveConflict = {
  code: string;
  message: string;
  capabilityId?: string;
  relatedCapabilityId?: string;
};

export type NativeSupport = {
  capabilityId: string;
  capabilityKind: string;
  supportLevel: 'full' | 'partial' | 'read-only' | 'unsupported';
};

export type EffectiveCapability = {
  id: string;
  name: string;
  kind: string;
  scope: 'global' | 'project';
  enabled: boolean;
};

export type EffectiveConfig = {
  agentKind: string;
  valid: boolean;
  capabilities: EffectiveCapability[];
  profileIds: string[];
  conflicts: EffectiveConflict[];
  missingDependencies: string[];
  unsupportedCapabilities: string[];
  nativeCapabilitySupport: NativeSupport[];
  provenanceCount: number;
  estimatedTokens: number;
};

export type ContextCategory = {
  name: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  sourceCount: number;
};

export type ContextFootprint = {
  totalBytes: number;
  totalLines: number;
  estimatedTokens: number;
  categories: ContextCategory[];
  /** Groups of source ids with byte-identical content. Never a similarity score. */
  exactDuplicateGroups: string[][];
  measuredAt: string;
};

export type PairContextSummary = {
  contributionCount: number;
  assignedCount: number;
  effectiveCount: number;
  observedLoadedCount: number;
  observedInvokedCount: number;
  unknownLoadedCount: number;
  staticEstimatedTokens?: number;
  reportedContextTokens?: number;
  measuredAt: string;
};

export type AgentPairResources = {
  effectiveConfig: ResourceState<EffectiveConfig>;
  contextSummary: ResourceState<PairContextSummary>;
  contextFootprint: ResourceState<ContextFootprint>;
};

export type AgentPairResourceKey = keyof AgentPairResources;

export const agentPairResourceKeys: readonly AgentPairResourceKey[] = [
  'effectiveConfig',
  'contextSummary',
  'contextFootprint',
];

/** Maps a runtime event type to the pair panels it invalidates. */
export function agentPairResourcesForEvent(eventType: string): AgentPairResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...agentPairResourceKeys];
  // Anything that changes what is bound changes what is effective.
  if (
    eventType.startsWith('capability.') ||
    eventType.startsWith('profile.') ||
    eventType.startsWith('project.agent.') ||
    eventType.startsWith('agent.definition.')
  ) {
    return ['effectiveConfig'];
  }
  if (eventType.startsWith('context.')) return ['contextSummary', 'contextFootprint'];
  return [];
}

function mapped<T, U>(result: ResourceResult<T>, select: (data: T) => U): ResourceState<U> {
  return result.state === 'ready'
    ? { state: 'ready', data: select(result.data) }
    : { state: 'unavailable' };
}

export async function loadAgentPairScope(
  client: DaemonClient,
  projectId: string,
  agentId: string,
  keys: readonly AgentPairResourceKey[],
  options: { signal?: AbortSignal } = {},
): Promise<Partial<AgentPairResources>> {
  const requested = new Set(keys);
  const project = encodeURIComponent(projectId);
  const agent = encodeURIComponent(agentId);
  const get = options.signal === undefined ? {} : { signal: options.signal };
  const entries: Array<Promise<[AgentPairResourceKey, AgentPairResources[AgentPairResourceKey]]>> =
    [];

  if (requested.has('effectiveConfig')) {
    entries.push(
      client
        .get(
          `/api/v1/projects/${project}/agents/${agent}/effective-config`,
          effectiveAgentConfigurationSchema,
          get,
        )
        .then(
          (result) =>
            [
              'effectiveConfig',
              mapped(result, (config) => ({
                agentKind: config.agentKind,
                valid: config.valid,
                capabilities: config.capabilities.map((capability) => ({
                  id: capability.id,
                  name: capability.name,
                  kind: capability.kind,
                  scope: capability.scope,
                  enabled: capability.enabled,
                })),
                profileIds: [...config.profileIds],
                conflicts: config.conflicts.map((conflict) => ({
                  code: conflict.code,
                  message: conflict.message,
                  ...(conflict.capabilityId === undefined
                    ? {}
                    : { capabilityId: conflict.capabilityId }),
                  ...(conflict.relatedCapabilityId === undefined
                    ? {}
                    : { relatedCapabilityId: conflict.relatedCapabilityId }),
                })),
                missingDependencies: [...config.missingDependencies],
                unsupportedCapabilities: [...config.unsupportedCapabilities],
                nativeCapabilitySupport: config.nativeCapabilitySupport.map((support) => ({
                  capabilityId: support.capabilityId,
                  capabilityKind: support.capabilityKind,
                  supportLevel: support.supportLevel,
                })),
                // Reduced to a count: provenance can carry thousands of entries
                // and the route renders none of them individually.
                provenanceCount: config.provenance.length,
                estimatedTokens: config.estimatedContextFootprint.estimatedTokens,
              })),
            ] as [AgentPairResourceKey, AgentPairResources[AgentPairResourceKey]],
        ),
    );
  }

  if (requested.has('contextSummary')) {
    entries.push(
      client
        .get(
          `/api/v1/context/summary?projectId=${project}&agentId=${agent}`,
          contextSummarySchema,
          get,
        )
        .then(
          (result) =>
            [
              'contextSummary',
              mapped(result, (summary) => ({
                contributionCount: summary.contributionCount,
                assignedCount: summary.assignedCount,
                effectiveCount: summary.effectiveCount,
                observedLoadedCount: summary.observedLoadedCount,
                observedInvokedCount: summary.observedInvokedCount,
                unknownLoadedCount: summary.unknownLoadedCount,
                ...(summary.staticEstimatedTokens === undefined
                  ? {}
                  : { staticEstimatedTokens: summary.staticEstimatedTokens }),
                ...(summary.reportedContextTokens === undefined
                  ? {}
                  : { reportedContextTokens: summary.reportedContextTokens }),
                measuredAt: summary.measuredAt,
              })),
            ] as [AgentPairResourceKey, AgentPairResources[AgentPairResourceKey]],
        ),
    );
  }

  if (requested.has('contextFootprint')) {
    entries.push(
      client
        .get(
          `/api/v1/projects/${project}/agents/${agent}/context-footprint`,
          contextFootprintSchema,
          get,
        )
        .then(
          (result) =>
            [
              'contextFootprint',
              mapped(result, (footprint) => ({
                totalBytes: footprint.totalBytes,
                totalLines: footprint.totalLines,
                estimatedTokens: footprint.estimatedTokens,
                categories: Object.entries(footprint.categories)
                  .map(([name, category]) => ({
                    name,
                    bytes: category.bytes,
                    lines: category.lines,
                    estimatedTokens: category.estimatedTokens,
                    sourceCount: category.sourceCount,
                  }))
                  .sort((left, right) => right.estimatedTokens - left.estimatedTokens),
                exactDuplicateGroups: footprint.exactDuplicateGroups.map((group) => [...group]),
                measuredAt: footprint.measuredAt,
              })),
            ] as [AgentPairResourceKey, AgentPairResources[AgentPairResourceKey]],
        ),
    );
  }

  return Object.fromEntries(await Promise.all(entries)) as Partial<AgentPairResources>;
}
