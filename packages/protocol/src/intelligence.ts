import { z } from 'zod';

import { configPlanSchema } from './control-plane.js';

export const INTELLIGENCE_DEFAULT_LIMIT = 100;
export const INTELLIGENCE_MAX_LIMIT = 1000;
export const GRAPH_DEFAULT_NEIGHBOR_LIMIT = 100;
export const GRAPH_MAX_NEIGHBOR_LIMIT = 1000;
export const GRAPH_DEFAULT_PATH_DEPTH = 3;
export const GRAPH_MAX_PATH_DEPTH = 6;
export const GRAPH_DEFAULT_SUBGRAPH_NODE_LIMIT = 250;
export const GRAPH_MAX_SUBGRAPH_NODE_LIMIT = 2000;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const timestampSchema = z.iso.datetime({ offset: false });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const commitShaSchema = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const pathSchema = z.string().trim().min(1).max(4096);
const boundedTextSchema = z.string().trim().min(1).max(2000);
const sensitiveMetadataKeys = new Set([
  'prompt',
  'completeprompt',
  'response',
  'completeresponse',
  'secret',
  'password',
  'credential',
  'credentials',
  'apikey',
  'accesstoken',
  'refreshtoken',
]);

function metadataViolation(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return 'Metadata nesting may not exceed 8 levels.';
  if (typeof value === 'string' && value.length > 2000) {
    return 'Metadata strings may not exceed 2000 characters.';
  }
  if (Array.isArray(value)) {
    if (value.length > 100) return 'Metadata arrays may contain at most 100 items.';
    for (const item of value) {
      const violation = metadataViolation(item, depth + 1);
      if (violation !== undefined) return violation;
    }
  } else if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > 100) return 'Metadata objects may contain at most 100 fields.';
    for (const [key, nested] of entries) {
      const normalizedKey = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
      if (sensitiveMetadataKeys.has(normalizedKey)) {
        return 'Metadata may not contain prompt, response, credential, or secret fields.';
      }
      const violation = metadataViolation(nested, depth + 1);
      if (violation !== undefined) return violation;
    }
  }
  return undefined;
}

const boundedMetadataSchema = z
  .record(z.string().max(128), z.json())
  .superRefine((value, context) => {
    const violation = metadataViolation(value);
    if (violation !== undefined) {
      context.addIssue({ code: 'custom', message: violation });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16_384) {
      context.addIssue({ code: 'custom', message: 'Metadata may not exceed 16384 UTF-8 bytes.' });
    }
  });
const evidenceIdsSchema = z.array(z.string().trim().min(1).max(256)).max(1000);
const tokenValueSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const intelligenceConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown']);
export const usageSourceSchema = z.enum([
  'agent-exact',
  'agent-reported',
  'adapter-extracted',
  'luwi-estimated',
  'unavailable',
]);
export const usageConfidenceSchema = z.enum(['exact', 'reported', 'estimated', 'unknown']);

const usageFields = {
  projectId: identifierSchema,
  agentId: identifierSchema,
  sessionId: identifierSchema,
  model: z.string().trim().min(1).max(256).optional(),
  provider: z.string().trim().min(1).max(256).optional(),
  inputTokens: tokenValueSchema.optional(),
  outputTokens: tokenValueSchema.optional(),
  cachedInputTokens: tokenValueSchema.optional(),
  cachedOutputTokens: tokenValueSchema.optional(),
  reasoningTokens: tokenValueSchema.optional(),
  totalTokens: tokenValueSchema.optional(),
  contextWindowTokens: tokenValueSchema.optional(),
  contextUsedTokens: tokenValueSchema.optional(),
  source: usageSourceSchema,
  confidence: usageConfidenceSchema,
  periodStartedAt: timestampSchema.optional(),
  periodEndedAt: timestampSchema.optional(),
  observedAt: timestampSchema,
  sourceEventId: z.string().trim().min(1).max(256).optional(),
  metadata: boundedMetadataSchema.default({}),
} as const;

function validateUsage(
  value: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cachedInputTokens?: number | undefined;
    cachedOutputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    totalTokens?: number | undefined;
    contextWindowTokens?: number | undefined;
    contextUsedTokens?: number | undefined;
    periodStartedAt?: string | undefined;
    periodEndedAt?: string | undefined;
    source: z.infer<typeof usageSourceSchema>;
    confidence: z.infer<typeof usageConfidenceSchema>;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.inputTokens !== undefined &&
    value.outputTokens !== undefined &&
    value.totalTokens !== undefined &&
    value.totalTokens !== value.inputTokens + value.outputTokens
  ) {
    context.addIssue({
      code: 'custom',
      path: ['totalTokens'],
      message: 'totalTokens must equal inputTokens plus outputTokens when both are supplied.',
    });
  }
  if (
    value.cachedInputTokens !== undefined &&
    value.inputTokens !== undefined &&
    value.cachedInputTokens > value.inputTokens
  ) {
    context.addIssue({
      code: 'custom',
      path: ['cachedInputTokens'],
      message: 'cachedInputTokens cannot exceed inputTokens.',
    });
  }
  if (
    value.reasoningTokens !== undefined &&
    value.outputTokens !== undefined &&
    value.reasoningTokens > value.outputTokens
  ) {
    context.addIssue({
      code: 'custom',
      path: ['reasoningTokens'],
      message: 'reasoningTokens cannot exceed outputTokens.',
    });
  }
  if (
    value.contextUsedTokens !== undefined &&
    value.contextWindowTokens !== undefined &&
    value.contextUsedTokens > value.contextWindowTokens
  ) {
    context.addIssue({
      code: 'custom',
      path: ['contextUsedTokens'],
      message: 'contextUsedTokens cannot exceed contextWindowTokens.',
    });
  }
  if (
    value.periodStartedAt !== undefined &&
    value.periodEndedAt !== undefined &&
    Date.parse(value.periodStartedAt) > Date.parse(value.periodEndedAt)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['periodEndedAt'],
      message: 'periodEndedAt cannot precede periodStartedAt.',
    });
  }
  const expectedConfidence = {
    'agent-exact': 'exact',
    'agent-reported': 'reported',
    'adapter-extracted': 'reported',
    'luwi-estimated': 'estimated',
    unavailable: 'unknown',
  } as const;
  if (value.confidence !== expectedConfidence[value.source]) {
    context.addIssue({
      code: 'custom',
      path: ['confidence'],
      message: `confidence must be ${expectedConfidence[value.source]} for ${value.source}.`,
    });
  }
}

export const usageIngestRequestSchema = z
  .strictObject({
    id: identifierSchema.optional(),
    ...usageFields,
  })
  .superRefine(validateUsage);

export const usageRecordSchema = z
  .strictObject({
    id: identifierSchema,
    ...usageFields,
    createdAt: timestampSchema,
  })
  .superRefine(validateUsage);

export const usageListQuerySchema = z.strictObject({
  projectId: identifierSchema.optional(),
  agentId: identifierSchema.optional(),
  sessionId: identifierSchema.optional(),
  capabilityId: identifierSchema.optional(),
  source: usageSourceSchema.optional(),
  confidence: usageConfidenceSchema.optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(INTELLIGENCE_MAX_LIMIT)
    .default(INTELLIGENCE_DEFAULT_LIMIT),
});

export const usageCollectionSchema = z.strictObject({
  records: z.array(usageRecordSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
  earliestAvailableAt: timestampSchema.optional(),
});

export const usageSourceCompositionSchema = z.strictObject({
  source: usageSourceSchema,
  recordCount: z.number().int().nonnegative(),
  inputTokens: tokenValueSchema.optional(),
  outputTokens: tokenValueSchema.optional(),
  cachedInputTokens: tokenValueSchema.optional(),
  cachedOutputTokens: tokenValueSchema.optional(),
  reasoningTokens: tokenValueSchema.optional(),
  totalTokens: tokenValueSchema.optional(),
  contextUsedTokens: tokenValueSchema.optional(),
});

export const usageSummarySchema = z.strictObject({
  projectId: identifierSchema.optional(),
  agentId: identifierSchema.optional(),
  sessionId: identifierSchema.optional(),
  model: z.string().max(256).optional(),
  recordCount: z.number().int().nonnegative(),
  sources: z.array(usageSourceCompositionSchema).max(usageSourceSchema.options.length),
  observedFrom: timestampSchema.optional(),
  observedTo: timestampSchema.optional(),
  earliestAvailableAt: timestampSchema.optional(),
});

export const contextLoadingModeSchema = z.enum([
  'always',
  'session-start',
  'conditional',
  'on-demand',
  'reference-only',
  'unknown',
]);
export const observationBooleanSchema = z.union([z.boolean(), z.literal('unknown')]);
export const contextContributionSourceSchema = z.enum([
  'effective-config',
  'adapter-reported',
  'session-reported',
  'estimated',
]);

export const contextContributionSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  agentId: identifierSchema,
  sessionId: identifierSchema.optional(),
  contextSourceId: identifierSchema,
  capabilityId: identifierSchema.optional(),
  loadingMode: contextLoadingModeSchema,
  assigned: observationBooleanSchema,
  effective: observationBooleanSchema,
  loaded: observationBooleanSchema,
  invoked: observationBooleanSchema,
  estimatedBytes: tokenValueSchema.optional(),
  estimatedTokens: tokenValueSchema.optional(),
  reportedTokens: tokenValueSchema.optional(),
  source: contextContributionSourceSchema,
  method: z.string().trim().min(1).max(256).optional(),
  confidence: intelligenceConfidenceSchema,
  observedAt: timestampSchema,
  evidenceIds: evidenceIdsSchema,
  metadata: boundedMetadataSchema.default({}),
});

export const contextContributionObservationRequestSchema = z
  .strictObject({
    projectId: identifierSchema,
    agentId: identifierSchema,
    sessionId: identifierSchema,
    contextSourceId: identifierSchema,
    capabilityId: identifierSchema.optional(),
    loadingMode: contextLoadingModeSchema,
    loaded: observationBooleanSchema,
    invoked: observationBooleanSchema,
    reportedTokens: tokenValueSchema.optional(),
    source: z.enum(['adapter-reported', 'session-reported']),
    confidence: intelligenceConfidenceSchema,
    observedAt: timestampSchema,
    evidenceIds: evidenceIdsSchema.min(1),
    metadata: boundedMetadataSchema.default({}),
  })
  .superRefine((value, context) => {
    if (value.invoked === true && value.loaded === false) {
      context.addIssue({
        code: 'custom',
        path: ['loaded'],
        message: 'An invoked context source cannot be reported as not loaded.',
      });
    }
  });

export const contextContributionCollectionSchema = z.strictObject({
  contributions: z.array(contextContributionSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});

export const contextSummarySchema = z.strictObject({
  projectId: identifierSchema,
  agentId: identifierSchema,
  staticEstimatedBytes: tokenValueSchema.optional(),
  staticEstimatedTokens: tokenValueSchema.optional(),
  reportedContextTokens: tokenValueSchema.optional(),
  contributionCount: z.number().int().nonnegative(),
  assignedCount: z.number().int().nonnegative(),
  effectiveCount: z.number().int().nonnegative(),
  observedLoadedCount: z.number().int().nonnegative(),
  observedInvokedCount: z.number().int().nonnegative(),
  unknownLoadedCount: z.number().int().nonnegative(),
  sourceComposition: z.partialRecord(
    contextContributionSourceSchema,
    z.number().int().nonnegative(),
  ),
  measuredAt: timestampSchema,
});

export const gitWorktreeSchema = z.strictObject({
  path: pathSchema,
  headSha: commitShaSchema,
  branch: z.string().trim().min(1).max(512).optional(),
  detached: z.boolean().optional(),
  locked: z.boolean().optional(),
});

export const gitCommitSchema = z.strictObject({
  sha: commitShaSchema,
  parentShas: z.array(commitShaSchema).max(32),
  committedAt: timestampSchema,
  subject: z.string().max(500).optional(),
  authorIdentity: z.string().trim().min(1).max(256).optional(),
  changedPaths: z.array(pathSchema).max(5000),
  trailers: z.record(z.string().trim().min(1).max(128), z.string().max(1000)),
  merge: z.boolean(),
});

export const gitObservationSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  repositoryRoot: pathSchema,
  branch: z.string().trim().min(1).max(512).optional(),
  headSha: commitShaSchema.optional(),
  defaultBranch: z.string().trim().min(1).max(512).optional(),
  remoteUrl: z.string().trim().min(1).max(2048).optional(),
  clean: z.boolean(),
  stagedCount: z.number().int().nonnegative(),
  unstagedCount: z.number().int().nonnegative(),
  untrackedCount: z.number().int().nonnegative(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  branches: z.array(z.string().trim().min(1).max(512)).max(1000),
  tags: z.array(z.string().trim().min(1).max(512)).max(1000),
  worktrees: z.array(gitWorktreeSchema).max(1000),
  recentCommits: z.array(gitCommitSchema).max(1000),
  observedAt: timestampSchema,
  repositoryStateHash: sha256Schema,
});

export const gitObservationCollectionSchema = z.strictObject({
  observations: z.array(gitObservationSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});
export const gitCommitCollectionSchema = z.strictObject({
  commits: z.array(gitCommitSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});
export const gitWorktreeCollectionSchema = z.strictObject({
  worktrees: z.array(gitWorktreeSchema).max(INTELLIGENCE_MAX_LIMIT),
});

export const packageEcosystemSchema = z.enum(['node', 'python', 'dart', 'php', 'rust', 'go']);
export const packageDependencyTypeSchema = z.enum([
  'production',
  'development',
  'optional',
  'peer',
  'build',
  'test',
  'unknown',
]);

export const packageRecordSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  ecosystem: packageEcosystemSchema,
  packageName: z.string().trim().min(1).max(512),
  declaredVersion: z.string().trim().min(1).max(512).optional(),
  dependencyType: packageDependencyTypeSchema,
  direct: z.boolean().optional(),
  workspaceLocation: pathSchema,
  manifestPath: pathSchema,
  detectedAt: timestampSchema,
  manifestHash: sha256Schema,
});

export const packageCollectionSchema = z.strictObject({
  packages: z.array(packageRecordSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});

export const technologyCategorySchema = z.enum([
  'language',
  'framework',
  'database',
  'build-tool',
  'test-tool',
  'deployment',
  'ci',
  'container',
  'package-manager',
]);
export const technologyEvidenceSchema = z.strictObject({
  kind: z.enum(['manifest', 'package', 'file-pattern']),
  value: z.string().trim().min(1).max(1024),
  path: pathSchema.optional(),
});
export const technologyRecordSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  name: z.string().trim().min(1).max(256),
  category: technologyCategorySchema,
  confidence: intelligenceConfidenceSchema,
  evidence: z.array(technologyEvidenceSchema).min(1).max(1000),
  detectedAt: timestampSchema,
});
export const technologyCollectionSchema = z.strictObject({
  technologies: z.array(technologyRecordSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});
export const packageScanResponseSchema = z.strictObject({
  packages: z.array(packageRecordSchema).max(INTELLIGENCE_MAX_LIMIT),
  technologies: z.array(technologyRecordSchema).max(INTELLIGENCE_MAX_LIMIT),
  scannedAt: timestampSchema,
  truncated: z.boolean(),
  evidenceScope: z.enum(['git-tracked', 'filesystem']),
});

export const attributionConfidenceSchema = z.enum(['exact', 'correlated', 'estimated', 'unknown']);
export const attributionRecordSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  sessionId: identifierSchema.optional(),
  agentId: identifierSchema.optional(),
  commitSha: commitShaSchema,
  confidence: attributionConfidenceSchema,
  observedAt: timestampSchema,
  evidenceIds: evidenceIdsSchema,
  reasons: z.array(z.string().trim().min(1).max(500)).max(100),
});
export const attributionCollectionSchema = z.strictObject({
  attributions: z.array(attributionRecordSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});

export const graphNodeKindSchema = z.enum([
  'developer',
  'project',
  'repository',
  'agent',
  'agent-definition',
  'project-agent-binding',
  'session',
  'message',
  'capability',
  'skill',
  'plugin',
  'hook',
  'mcp',
  'policy',
  'profile',
  'context-source',
  'file',
  'module',
  'commit',
  'branch',
  'worktree',
  'package',
  'technology',
  'usage-record',
  'optimization-proposal',
  'config-plan',
  'snapshot',
  'test-run',
  'build-run',
]);
export const graphEdgeKindSchema = z.enum([
  'DEVELOPER_USED_AGENT',
  'PROJECT_HAS_REPOSITORY',
  'PROJECT_BOUND_AGENT',
  'AGENT_RAN_SESSION',
  'SESSION_WORKED_ON_PROJECT',
  'SESSION_SENT_MESSAGE',
  'SESSION_RECEIVED_MESSAGE',
  'SESSION_USED_CAPABILITY',
  'SESSION_LOADED_CONTEXT',
  'SESSION_INVOKED_SKILL',
  'SESSION_CALLED_MCP',
  'SESSION_ASSOCIATED_WITH_COMMIT',
  'SESSION_CHANGED_FILE',
  'COMMIT_TOUCHES_FILE',
  'FILE_BELONGS_TO_MODULE',
  'PROJECT_USES_PACKAGE',
  'PROJECT_USES_TECHNOLOGY',
  'CAPABILITY_REQUIRES_CAPABILITY',
  'CAPABILITY_REQUIRES_MCP',
  'PROFILE_INCLUDES_CAPABILITY',
  'CONTEXT_SOURCE_CONTRIBUTED_TO_SESSION',
  'OPTIMIZATION_TARGETS_CONTEXT_SOURCE',
  'OPTIMIZATION_PRODUCED_CONFIG_PLAN',
  'CONFIG_PLAN_PRODUCED_SNAPSHOT',
]);
export const graphNodeReferenceSchema = z.strictObject({
  kind: graphNodeKindSchema,
  id: identifierSchema,
});
export const graphNodeSchema = z.strictObject({
  id: identifierSchema,
  kind: graphNodeKindSchema,
  entityId: identifierSchema,
  projectId: identifierSchema.optional(),
  observedAt: timestampSchema,
  provenance: z.string().trim().min(1).max(256),
  confidence: intelligenceConfidenceSchema,
  evidenceIds: evidenceIdsSchema,
  metadata: boundedMetadataSchema.default({}),
});
export const graphEdgeSchema = z.strictObject({
  id: identifierSchema,
  source: graphNodeReferenceSchema,
  target: graphNodeReferenceSchema,
  kind: graphEdgeKindSchema,
  projectId: identifierSchema.optional(),
  observedAt: timestampSchema,
  provenance: z.string().trim().min(1).max(256),
  confidence: intelligenceConfidenceSchema,
  evidenceIds: evidenceIdsSchema.min(1),
  metadata: boundedMetadataSchema.default({}),
});

export const graphNeighborsQuerySchema = z.strictObject({
  edgeKind: graphEdgeKindSchema.optional(),
  projectId: identifierSchema.optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(GRAPH_MAX_NEIGHBOR_LIMIT)
    .default(GRAPH_DEFAULT_NEIGHBOR_LIMIT),
});
export const graphPathQuerySchema = z.strictObject({
  toKind: graphNodeKindSchema,
  toId: identifierSchema,
  projectId: identifierSchema.optional(),
  edgeKind: graphEdgeKindSchema.optional(),
  maxDepth: z.coerce
    .number()
    .int()
    .min(1)
    .max(GRAPH_MAX_PATH_DEPTH)
    .default(GRAPH_DEFAULT_PATH_DEPTH),
});
export const graphSubgraphQuerySchema = z.strictObject({
  nodeKind: graphNodeKindSchema,
  nodeId: identifierSchema,
  projectId: identifierSchema.optional(),
  maxDepth: z.coerce.number().int().min(1).max(GRAPH_MAX_PATH_DEPTH).default(2),
  nodeLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(GRAPH_MAX_SUBGRAPH_NODE_LIMIT)
    .default(GRAPH_DEFAULT_SUBGRAPH_NODE_LIMIT),
});
export const graphNeighborsResponseSchema = z.strictObject({
  node: graphNodeSchema,
  edges: z.array(graphEdgeSchema).max(GRAPH_MAX_NEIGHBOR_LIMIT),
  nodes: z.array(graphNodeSchema).max(GRAPH_MAX_NEIGHBOR_LIMIT),
  truncated: z.boolean(),
});
export const graphPathResponseSchema = z.strictObject({
  found: z.boolean(),
  nodes: z.array(graphNodeSchema).max(GRAPH_MAX_SUBGRAPH_NODE_LIMIT),
  edges: z.array(graphEdgeSchema).max(GRAPH_MAX_SUBGRAPH_NODE_LIMIT),
});
export const graphSubgraphResponseSchema = z.strictObject({
  nodes: z.array(graphNodeSchema).max(GRAPH_MAX_SUBGRAPH_NODE_LIMIT),
  edges: z.array(graphEdgeSchema).max(GRAPH_MAX_SUBGRAPH_NODE_LIMIT * 4),
  truncated: z.boolean(),
});

export const graphRebuildStateSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export const graphRebuildOperationSchema = z.strictObject({
  id: identifierSchema,
  state: graphRebuildStateSchema,
  sourceStreamId: z
    .string()
    .regex(/^\d+-\d+$/)
    .optional(),
  shadowGeneration: identifierSchema,
  previousGeneration: identifierSchema.optional(),
  activeGeneration: identifierSchema.optional(),
  processedEvents: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  failureSummary: z.array(z.string().max(1000)).max(100),
  startedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
});

export const optimizationFindingKindSchema = z.enum([
  'oversized-always-loaded-source',
  'exact-duplicate-content',
  'duplicate-capability-id',
  'identical-instruction-content',
  'incompatible-capability',
  'capability-not-observed-loaded',
  'capability-loaded-not-observed-invoked',
  'mcp-broad-low-observed-use',
  'reference-loaded-always',
  'global-source-single-project',
  'stale-context-footprint',
  'conflicting-loading-mode',
  'missing-required-capability',
  'stale-path-reference',
  'native-config-context-drift',
]);
export const optimizationFindingStateSchema = z.enum(['open', 'dismissed', 'proposed', 'resolved']);
export const optimizationFindingSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  agentId: identifierSchema.optional(),
  contextSourceId: identifierSchema.optional(),
  capabilityId: identifierSchema.optional(),
  kind: optimizationFindingKindSchema,
  title: z.string().trim().min(1).max(500),
  summary: boundedTextSchema,
  state: optimizationFindingStateSchema,
  evidenceWindow: z.strictObject({
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    sessionCount: z.number().int().nonnegative(),
    observationCount: z.number().int().nonnegative(),
  }),
  confidence: intelligenceConfidenceSchema,
  evidenceIds: evidenceIdsSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const optimizationFindingCollectionSchema = z.strictObject({
  findings: z.array(optimizationFindingSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});

export const optimizationActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('change-loading-mode'),
    contextSourceId: identifierSchema,
    loadingMode: contextLoadingModeSchema,
  }),
  z.strictObject({
    kind: z.literal('move-capability-to-project'),
    capabilityId: identifierSchema,
    projectId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('disable-duplicate-assignment'),
    capabilityBindingId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('convert-source-to-reference-only'),
    contextSourceId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('remove-duplicate-capability-binding'),
    capabilityBindingId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('split-source-using-supplied-structure'),
    contextSourceId: identifierSchema,
    targetPaths: z.array(pathSchema).min(1).max(100),
  }),
]);
export const optimizationProposalStateSchema = z.enum([
  'draft',
  'ready',
  'accepted',
  'rejected',
  'applied',
  'evaluating',
  'verified',
  'inconclusive',
  'failed',
]);
export const optimizationBaselineSchema = z.strictObject({
  capturedAt: timestampSchema,
  effectiveConfigHash: sha256Schema,
  contextSourceHashes: z.array(sha256Schema).max(100_000),
  sessionIds: z.array(identifierSchema).max(100_000),
  usageSourceComposition: z
    .array(usageSourceCompositionSchema)
    .max(usageSourceSchema.options.length),
  estimatedContextTokens: tokenValueSchema.optional(),
  gitHead: commitShaSchema.optional(),
});
export const optimizationProposalSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  agentId: identifierSchema.optional(),
  findingIds: z.array(identifierSchema).min(1).max(100),
  title: z.string().trim().min(1).max(500),
  summary: boundedTextSchema,
  proposedActions: z.array(optimizationActionSchema).min(1).max(100),
  estimatedBeforeTokens: tokenValueSchema.optional(),
  estimatedAfterTokens: tokenValueSchema.optional(),
  estimatedSavingTokens: tokenValueSchema.optional(),
  evidenceWindow: z.strictObject({
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    sessionCount: z.number().int().nonnegative(),
  }),
  baseline: optimizationBaselineSchema.optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  state: optimizationProposalStateSchema,
  configPlanId: identifierSchema.optional(),
  appliedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const optimizationProposalCollectionSchema = z.strictObject({
  proposals: z.array(optimizationProposalSchema).max(INTELLIGENCE_MAX_LIMIT),
  truncated: z.boolean(),
});
export const contextIntelligenceSchema = z.strictObject({
  summary: contextSummarySchema,
  contributions: z.array(contextContributionSchema).max(INTELLIGENCE_MAX_LIMIT),
  findings: z.array(optimizationFindingSchema).max(INTELLIGENCE_MAX_LIMIT),
});
export const optimizationConfigPlanResponseSchema = z.strictObject({
  proposal: optimizationProposalSchema,
  plan: configPlanSchema,
});

const optimizationMeasurementSchema = z.strictObject({
  sessionCount: z.number().int().nonnegative(),
  usageRecordCount: z.number().int().nonnegative().optional(),
  estimatedContextTokens: tokenValueSchema.optional(),
  reportedContextTokens: tokenValueSchema.optional(),
  effectiveConfigHash: sha256Schema.optional(),
});
export const optimizationEvaluationSchema = z.strictObject({
  id: identifierSchema,
  proposalId: identifierSchema,
  projectId: identifierSchema,
  state: z.enum(['verified', 'inconclusive', 'failed']),
  baseline: optimizationMeasurementSchema,
  postChange: optimizationMeasurementSchema,
  summary: boundedTextSchema,
  causalClaim: z.literal(false),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
});

export const optimizationAnalysisRequestSchema = z.strictObject({
  projectId: identifierSchema,
  agentId: identifierSchema.optional(),
  minimumSessions: z.number().int().min(1).max(10000).optional(),
});
export const optimizationAnalysisResponseSchema = z.strictObject({
  findings: z.array(optimizationFindingSchema).max(100),
  proposals: z.array(optimizationProposalSchema).max(25),
  analyzedAt: timestampSchema,
});
export const optimizationAcceptRequestSchema = z.strictObject({
  accepted: z.literal(true),
});
export const optimizationRejectRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1000).optional(),
});
export const optimizationCreatePlanRequestSchema = z.strictObject({
  actionIndex: z.number().int().nonnegative().default(0),
});
export const optimizationEvaluateRequestSchema = z.strictObject({
  minimumPostSessions: z.number().int().min(1).max(10000).optional(),
  minimumObservationHours: z.number().nonnegative().max(8760).optional(),
});

export const intelligenceErrorCodeSchema = z.enum([
  'USAGE_RECORD_INVALID',
  'USAGE_RECORD_DUPLICATE',
  'USAGE_SOURCE_UNSUPPORTED',
  'USAGE_SUMMARY_FILTER_UNSUPPORTED',
  'USAGE_VALUE_INCONSISTENT',
  'CONTEXT_OBSERVATION_INVALID',
  'GIT_REPOSITORY_NOT_FOUND',
  'GIT_COMMAND_TIMEOUT',
  'GIT_OBSERVATION_FAILED',
  'GIT_ATTRIBUTION_INSUFFICIENT',
  'PACKAGE_MANIFEST_UNSUPPORTED',
  'PACKAGE_MANIFEST_PARSE_FAILED',
  'PACKAGE_SCAN_FAILED',
  'GRAPH_NODE_NOT_FOUND',
  'GRAPH_EDGE_NOT_FOUND',
  'GRAPH_QUERY_LIMIT_EXCEEDED',
  'GRAPH_REBUILD_IN_PROGRESS',
  'GRAPH_REBUILD_FAILED',
  'GRAPH_PROJECTION_DEGRADED',
  'OPTIMIZATION_FINDING_NOT_FOUND',
  'OPTIMIZATION_PROPOSAL_NOT_FOUND',
  'OPTIMIZATION_PROPOSAL_INVALID',
  'OPTIMIZATION_EVIDENCE_INSUFFICIENT',
  'OPTIMIZATION_CONFIG_PLAN_FAILED',
  'OPTIMIZATION_EVALUATION_INSUFFICIENT',
]);

export type IntelligenceConfidence = z.infer<typeof intelligenceConfidenceSchema>;
export type UsageSource = z.infer<typeof usageSourceSchema>;
export type UsageConfidence = z.infer<typeof usageConfidenceSchema>;
export type UsageIngestRequest = z.infer<typeof usageIngestRequestSchema>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;
export type UsageListQuery = z.infer<typeof usageListQuerySchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type UsageSourceComposition = z.infer<typeof usageSourceCompositionSchema>;
export type ContextLoadingMode = z.infer<typeof contextLoadingModeSchema>;
export type ContextContribution = z.infer<typeof contextContributionSchema>;
export type ContextContributionObservationRequest = z.infer<
  typeof contextContributionObservationRequestSchema
>;
export type ContextSummary = z.infer<typeof contextSummarySchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitWorktree = z.infer<typeof gitWorktreeSchema>;
export type GitObservation = z.infer<typeof gitObservationSchema>;
export type PackageEcosystem = z.infer<typeof packageEcosystemSchema>;
export type PackageDependencyType = z.infer<typeof packageDependencyTypeSchema>;
export type PackageRecord = z.infer<typeof packageRecordSchema>;
export type TechnologyRecord = z.infer<typeof technologyRecordSchema>;
export type AttributionConfidence = z.infer<typeof attributionConfidenceSchema>;
export type AttributionRecord = z.infer<typeof attributionRecordSchema>;
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;
export type GraphEdgeKind = z.infer<typeof graphEdgeKindSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphNeighborsQuery = z.infer<typeof graphNeighborsQuerySchema>;
export type GraphPathQuery = z.infer<typeof graphPathQuerySchema>;
export type GraphSubgraphQuery = z.infer<typeof graphSubgraphQuerySchema>;
export type GraphRebuildOperation = z.infer<typeof graphRebuildOperationSchema>;
export type GraphNeighborsResponse = z.infer<typeof graphNeighborsResponseSchema>;
export type GraphPathResponse = z.infer<typeof graphPathResponseSchema>;
export type GraphSubgraphResponse = z.infer<typeof graphSubgraphResponseSchema>;
export type OptimizationFinding = z.infer<typeof optimizationFindingSchema>;
export type OptimizationAction = z.infer<typeof optimizationActionSchema>;
export type OptimizationProposalState = z.infer<typeof optimizationProposalStateSchema>;
export type OptimizationProposal = z.infer<typeof optimizationProposalSchema>;
export type OptimizationEvaluation = z.infer<typeof optimizationEvaluationSchema>;
export type OptimizationAnalysisRequest = z.infer<typeof optimizationAnalysisRequestSchema>;
export type OptimizationAnalysisResponse = z.infer<typeof optimizationAnalysisResponseSchema>;
export type ContextIntelligence = z.infer<typeof contextIntelligenceSchema>;
export type OptimizationEvaluateRequest = z.infer<typeof optimizationEvaluateRequestSchema>;
export type IntelligenceErrorCode = z.infer<typeof intelligenceErrorCodeSchema>;
