import { createHash } from 'node:crypto';

import {
  contextContributionSchema,
  contextSummarySchema,
  type ContextContribution,
  type ContextLoadingMode,
  type ContextSource,
  type ContextSummary,
} from '@luwi/protocol';

export type StaticContributionOptions = {
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  assigned: boolean;
  effective: boolean;
};

function loadingMode(source: ContextSource): ContextLoadingMode {
  switch (source.loadingMode) {
    case 'automatic':
      return 'always';
    case 'conditional':
      return 'conditional';
    case 'manual':
      return 'on-demand';
    case 'unknown':
      return 'unknown';
  }
}

export function contextContributionFromStaticSource(
  source: ContextSource,
  options: StaticContributionOptions,
): ContextContribution {
  const projectId = source.projectId ?? options.projectId;
  const agentId = source.agentId ?? options.agentId;
  if (projectId === undefined || agentId === undefined) {
    throw new Error('Static context contribution requires project and agent identities.');
  }
  const identity = [projectId, agentId, options.sessionId ?? '', source.id, source.hash].join('\0');
  const id = `ctx-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
  return contextContributionSchema.parse({
    id,
    projectId,
    agentId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    contextSourceId: source.id,
    ...(source.capabilityId === undefined ? {} : { capabilityId: source.capabilityId }),
    loadingMode: loadingMode(source),
    assigned: options.assigned,
    effective: options.effective,
    loaded: 'unknown',
    invoked: 'unknown',
    estimatedBytes: source.byteCount,
    estimatedTokens: source.estimatedTokenCount,
    source: 'estimated',
    method: source.estimationMethod,
    confidence: 'medium',
    observedAt: source.measuredAt,
    evidenceIds: [source.id],
    metadata: { contextSourceHash: source.hash },
  });
}

function sumKnown(
  contributions: ContextContribution[],
  field: 'estimatedBytes' | 'estimatedTokens' | 'reportedTokens',
): number | undefined {
  const values = contributions
    .map((contribution) => contribution[field])
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

export function summarizeContextContributions(
  contributions: ContextContribution[],
): ContextSummary {
  if (contributions.length === 0) {
    throw new Error('At least one context contribution is required.');
  }
  const projectIds = new Set(contributions.map(({ projectId }) => projectId));
  const agentIds = new Set(contributions.map(({ agentId }) => agentId));
  if (projectIds.size !== 1 || agentIds.size !== 1) {
    throw new Error('Context summary requires one project and one agent.');
  }

  const sourceComposition = Object.fromEntries(
    [...new Set(contributions.map(({ source }) => source))].map((source) => [
      source,
      contributions.filter((contribution) => contribution.source === source).length,
    ]),
  );
  const result: Record<string, unknown> = {
    projectId: [...projectIds][0],
    agentId: [...agentIds][0],
    contributionCount: contributions.length,
    assignedCount: contributions.filter(({ assigned }) => assigned === true).length,
    effectiveCount: contributions.filter(({ effective }) => effective === true).length,
    observedLoadedCount: contributions.filter(({ loaded }) => loaded === true).length,
    observedInvokedCount: contributions.filter(({ invoked }) => invoked === true).length,
    unknownLoadedCount: contributions.filter(({ loaded }) => loaded === 'unknown').length,
    sourceComposition,
    measuredAt: contributions
      .map(({ observedAt }) => observedAt)
      .toSorted()
      .at(-1),
  };
  const staticEstimatedBytes = sumKnown(contributions, 'estimatedBytes');
  const staticEstimatedTokens = sumKnown(contributions, 'estimatedTokens');
  const reportedContextTokens = sumKnown(contributions, 'reportedTokens');
  if (staticEstimatedBytes !== undefined) result['staticEstimatedBytes'] = staticEstimatedBytes;
  if (staticEstimatedTokens !== undefined) result['staticEstimatedTokens'] = staticEstimatedTokens;
  if (reportedContextTokens !== undefined) result['reportedContextTokens'] = reportedContextTokens;
  return contextSummarySchema.parse(result);
}
