import { createHash } from 'node:crypto';

import {
  optimizationEvaluationSchema,
  optimizationFindingSchema,
  optimizationProposalSchema,
  type CapabilityPackage,
  type ContextContribution,
  type ContextSource,
  type OptimizationEvaluation,
  type OptimizationFinding,
  type OptimizationProposal,
  type OptimizationProposalState,
} from '@luwi/protocol';

function stableId(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

export type StructuralContextAnalysisInput = {
  projectId: string;
  agentId?: string;
  contextSources: ContextSource[];
  contributions: ContextContribution[];
  allContributions?: ContextContribution[];
  capabilities?: CapabilityPackage[];
  now: string;
  minimumSessions: number;
  oversizedTokenThreshold: number;
  maximumFindings?: number;
};

function evidenceWindow(
  contributions: ContextContribution[],
  now: string,
): OptimizationFinding['evidenceWindow'] {
  const observed = contributions.map(({ observedAt }) => observedAt).toSorted();
  return {
    startedAt: observed[0] ?? now,
    endedAt: observed.at(-1) ?? now,
    sessionCount: new Set(
      contributions
        .map(({ sessionId }) => sessionId)
        .filter((value): value is string => value !== undefined),
    ).size,
    observationCount: contributions.length,
  };
}

function finding(
  input: StructuralContextAnalysisInput,
  values: Omit<
    OptimizationFinding,
    'id' | 'projectId' | 'agentId' | 'state' | 'createdAt' | 'updatedAt'
  >,
): OptimizationFinding {
  return optimizationFindingSchema.parse({
    ...values,
    id: stableId('finding', [
      input.projectId,
      input.agentId ?? '',
      values.kind,
      values.contextSourceId ?? '',
      values.capabilityId ?? '',
      ...values.evidenceIds,
    ]),
    projectId: input.projectId,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    state: 'open',
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function analyzeStructuralContext(
  input: StructuralContextAnalysisInput,
): OptimizationFinding[] {
  const findings: OptimizationFinding[] = [];
  const window = evidenceWindow(input.contributions, input.now);
  const bySource = new Map<string, ContextContribution[]>();
  for (const contribution of input.contributions) {
    const values = bySource.get(contribution.contextSourceId) ?? [];
    values.push(contribution);
    bySource.set(contribution.contextSourceId, values);
  }

  for (const source of input.contextSources) {
    if (
      source.loadingMode === 'automatic' &&
      source.estimatedTokenCount >= input.oversizedTokenThreshold
    ) {
      findings.push(
        finding(input, {
          contextSourceId: source.id,
          kind: 'oversized-always-loaded-source',
          title: 'Oversized always-loaded context source',
          summary: `The always-loaded source is structurally estimated at ${source.estimatedTokenCount} tokens.`,
          evidenceWindow: window,
          confidence: 'high',
          evidenceIds: [source.id, source.hash],
        }),
      );
    }
    const observations = bySource.get(source.id) ?? [];
    if (window.sessionCount >= input.minimumSessions && observations.length > 0) {
      const loaded = observations.filter(({ loaded }) => loaded === true);
      const invoked = observations.filter(({ invoked }) => invoked === true);
      if (loaded.length > 0 && invoked.length === 0) {
        findings.push(
          finding(input, {
            contextSourceId: source.id,
            kind: 'capability-loaded-not-observed-invoked',
            title: 'Loaded capability invocation not observed',
            summary:
              'The source was observed as loaded, but invocation was not observed during the evidence window.',
            evidenceWindow: window,
            confidence: 'low',
            evidenceIds: observations.flatMap(({ evidenceIds }) => evidenceIds).slice(0, 1000),
          }),
        );
      }
      if (observations.some(({ loaded }) => loaded === false)) {
        findings.push(
          finding(input, {
            contextSourceId: source.id,
            kind: 'capability-not-observed-loaded',
            title: 'Assigned source not observed as loaded',
            summary:
              'The assigned source was explicitly reported as not loaded during part of the evidence window.',
            evidenceWindow: window,
            confidence: 'medium',
            evidenceIds: observations.flatMap(({ evidenceIds }) => evidenceIds).slice(0, 1000),
          }),
        );
      }
    }
  }

  const byHash = new Map<string, ContextSource[]>();
  for (const source of input.contextSources) {
    const values = byHash.get(source.hash) ?? [];
    values.push(source);
    byHash.set(source.hash, values);
  }
  for (const [hash, sources] of byHash) {
    if (sources.length < 2) continue;
    findings.push(
      finding(input, {
        contextSourceId: sources[0]?.id,
        kind: 'exact-duplicate-content',
        title: 'Exact duplicate context content',
        summary: `${sources.length} context sources have the same exact content hash.`,
        evidenceWindow: window,
        confidence: 'high',
        evidenceIds: [hash, ...sources.map(({ id }) => id)].slice(0, 1000),
      }),
    );
  }

  const allContributions = input.allContributions ?? input.contributions;
  for (const capability of input.capabilities ?? []) {
    const observations = allContributions.filter(
      ({ capabilityId }) => capabilityId === capability.id,
    );
    const explicit = observations.filter(
      ({ loaded, invoked }) => loaded !== 'unknown' || invoked !== 'unknown',
    );
    if (capability.scope === 'global' && explicit.length > 0) {
      const explicitlyObservedProjects = new Set(explicit.map(({ projectId }) => projectId));
      const usedProjects = new Set(
        explicit
          .filter(({ loaded, invoked }) => loaded === true || invoked === true)
          .map(({ projectId }) => projectId),
      );
      if (
        explicitlyObservedProjects.size >= 2 &&
        usedProjects.size === 1 &&
        usedProjects.has(input.projectId)
      ) {
        findings.push(
          finding(input, {
            capabilityId: capability.id,
            kind: 'global-source-single-project',
            title: 'Global capability observed in one project',
            summary:
              'Explicit observations recorded use in this project and explicit non-use observations in another project during the evidence window.',
            evidenceWindow: evidenceWindow(explicit, input.now),
            confidence: 'medium',
            evidenceIds: explicit.flatMap(({ evidenceIds }) => evidenceIds).slice(0, 1000),
          }),
        );
      }
    }

    const declaredTools = capability.manifest['tools'];
    const exposedToolCount = Array.isArray(declaredTools) ? declaredTools.length : 0;
    const invocationObservations = observations.filter(({ invoked }) => invoked !== 'unknown');
    const observedCalls = invocationObservations.filter(({ invoked }) => invoked === true).length;
    const observedSessions = new Set(
      invocationObservations
        .map(({ sessionId }) => sessionId)
        .filter((value): value is string => value !== undefined),
    ).size;
    if (
      capability.kind === 'mcp' &&
      exposedToolCount >= 20 &&
      observedSessions >= input.minimumSessions &&
      observedCalls <= Math.max(3, Math.floor(exposedToolCount / 10))
    ) {
      findings.push(
        finding(input, {
          capabilityId: capability.id,
          kind: 'mcp-broad-low-observed-use',
          title: 'Broad MCP surface with few observed calls',
          summary: `${exposedToolCount} tools are structurally declared and ${observedCalls} calls were explicitly observed during the evidence window.`,
          evidenceWindow: evidenceWindow(invocationObservations, input.now),
          confidence: 'medium',
          evidenceIds: invocationObservations
            .flatMap(({ evidenceIds }) => evidenceIds)
            .slice(0, 1000),
        }),
      );
    }
  }

  return findings
    .toSorted((left, right) => {
      const kind = left.kind.localeCompare(right.kind);
      return kind === 0 ? left.id.localeCompare(right.id) : kind;
    })
    .slice(0, input.maximumFindings ?? 100);
}

export function createOptimizationProposals(
  findings: OptimizationFinding[],
  now: string,
  maximumProposals = 25,
): OptimizationProposal[] {
  return findings
    .filter(
      (
        finding,
      ): finding is OptimizationFinding & {
        contextSourceId: string;
      } =>
        finding.kind === 'oversized-always-loaded-source' && finding.contextSourceId !== undefined,
    )
    .slice(0, maximumProposals)
    .map((finding) =>
      optimizationProposalSchema.parse({
        id: stableId('proposal', [finding.projectId, finding.id]),
        projectId: finding.projectId,
        ...(finding.agentId === undefined ? {} : { agentId: finding.agentId }),
        findingIds: [finding.id],
        title: 'Convert oversized context to reference-only loading',
        summary:
          'Propose a deterministic loading-mode change. Acceptance alone does not modify configuration.',
        proposedActions: [
          {
            kind: 'convert-source-to-reference-only',
            contextSourceId: finding.contextSourceId,
          },
        ],
        evidenceWindow: {
          startedAt: finding.evidenceWindow.startedAt,
          endedAt: finding.evidenceWindow.endedAt,
          sessionCount: finding.evidenceWindow.sessionCount,
        },
        confidence: finding.confidence === 'unknown' ? 'low' : finding.confidence,
        state: 'ready',
        createdAt: now,
        updatedAt: now,
      }),
    );
}

const allowedTransitions: Record<OptimizationProposalState, OptimizationProposalState[]> = {
  draft: ['ready', 'rejected'],
  ready: ['accepted', 'rejected'],
  accepted: ['applied', 'failed'],
  rejected: [],
  applied: ['evaluating', 'failed'],
  evaluating: ['verified', 'inconclusive', 'failed'],
  verified: [],
  inconclusive: [],
  failed: [],
};

export function transitionOptimizationProposal(
  proposal: OptimizationProposal,
  target: OptimizationProposalState,
  now: string,
  configPlanId?: string,
): OptimizationProposal {
  if (!allowedTransitions[proposal.state].includes(target)) {
    throw new Error(`Invalid optimization proposal transition: ${proposal.state} -> ${target}`);
  }
  return optimizationProposalSchema.parse({
    ...proposal,
    state: target,
    ...(configPlanId === undefined ? {} : { configPlanId }),
    updatedAt: now,
  });
}

type OptimizationMeasurement = OptimizationEvaluation['baseline'];

export type EvaluateOptimizationInput = {
  proposal: OptimizationProposal;
  baseline: OptimizationMeasurement;
  postChange: OptimizationMeasurement;
  minimumPostSessions: number;
  startedAt: string;
  completedAt: string;
};

export function evaluateOptimization(input: EvaluateOptimizationInput): OptimizationEvaluation {
  let state: OptimizationEvaluation['state'] = 'inconclusive';
  let summary = 'The post-change evidence window is insufficient for a conclusion.';
  if (input.postChange.sessionCount >= input.minimumPostSessions) {
    const before = input.baseline.estimatedContextTokens;
    const after = input.postChange.estimatedContextTokens;
    if (before !== undefined && after !== undefined && after < before) {
      state = 'verified';
      summary = 'Observed context footprint decreased after the change.';
    } else if (before !== undefined && after !== undefined && after > before) {
      state = 'failed';
      summary = 'Observed context footprint increased after the change.';
    } else {
      summary = 'Observed context footprint did not provide a conclusive change.';
    }
  }
  return optimizationEvaluationSchema.parse({
    id: stableId('evaluation', [input.proposal.id, input.completedAt]),
    proposalId: input.proposal.id,
    projectId: input.proposal.projectId,
    state,
    baseline: input.baseline,
    postChange: input.postChange,
    summary,
    causalClaim: false,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}
