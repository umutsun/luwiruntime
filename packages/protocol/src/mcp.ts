import { z } from 'zod';

import {
  INBOX_DEFAULT_BLOCK_MS,
  INBOX_DEFAULT_CLAIM_LIMIT,
  INBOX_DEFAULT_MIN_IDLE_MS,
  INBOX_MAX_CLAIM_LIMIT,
  MESSAGE_DEFAULT_TIMEOUT_MS,
  MESSAGE_MAX_TIMEOUT_MS,
  MESSAGE_MAX_WAIT_MS,
  agentMessageResponseSchema,
  agentMessageSchema,
  evidenceTypeSchema,
  inboxClaimResponseSchema,
  messageKindSchema,
  messageStateSchema,
} from './message.js';
import { projectSchema } from './project.js';
import { agentIdSchema } from './session.js';
import { sessionViewSchema } from './session.js';
import {
  agentDefinitionSchema,
  capabilityKindSchema,
  capabilityPackageSchema,
  configDriftSchema,
  contextFootprintSchema,
  effectiveAgentConfigurationSchema,
  projectAgentBindingSchema,
} from './control-plane.js';
import {
  attributionConfidenceSchema,
  contextContributionSchema,
  contextSummarySchema,
  gitCommitSchema,
  gitObservationSchema,
  graphEdgeKindSchema,
  graphEdgeSchema,
  graphNodeKindSchema,
  graphNodeSchema,
  intelligenceConfidenceSchema,
  optimizationAnalysisResponseSchema,
  optimizationFindingSchema,
  optimizationProposalSchema,
  packageRecordSchema,
  technologyRecordSchema,
  usageSummarySchema,
} from './intelligence.js';

export const MCP_MAX_COLLECTION_ITEMS = 100;

const identifierSchema = z.string().trim().min(1).max(128);
const bridgeInstanceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const mcpListProjectsInputSchema = z.strictObject({});
export const mcpListSessionsInputSchema = z.strictObject({
  online: z.boolean().default(false),
});
export const mcpGetSessionInputSchema = z.strictObject({
  sessionId: identifierSchema,
});
export const mcpGetProjectStateInputSchema = z.strictObject({});
export const mcpListAgentsInputSchema = z.strictObject({});
export const mcpGetAgentInputSchema = z.strictObject({ agentId: agentIdSchema });
export const mcpListProjectAgentsInputSchema = z.strictObject({});
export const mcpGetEffectiveConfigInputSchema = z.strictObject({
  agentId: agentIdSchema,
});
export const mcpListCapabilitiesInputSchema = z.strictObject({
  kind: capabilityKindSchema.optional(),
  agentId: agentIdSchema.optional(),
  enabled: z.boolean().optional(),
});
export const mcpGetCapabilityInputSchema = z.strictObject({
  capabilityId: identifierSchema,
});
export const mcpGetContextFootprintInputSchema = z.strictObject({
  agentId: agentIdSchema,
});
export const mcpGetConfigDriftInputSchema = z.strictObject({
  agentId: agentIdSchema.optional(),
});
export const mcpGetUsageSummaryInputSchema = z.strictObject({
  sessionOnly: z.boolean().default(true),
  from: z.iso.datetime({ offset: false }).optional(),
  to: z.iso.datetime({ offset: false }).optional(),
});
export const mcpGetContextIntelligenceInputSchema = z.strictObject({
  agentId: agentIdSchema.optional(),
});
export const mcpGetGitStatusInputSchema = z.strictObject({});
export const mcpGetRecentCommitsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(MCP_MAX_COLLECTION_ITEMS).default(20),
});
export const mcpGetPackageInventoryInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(MCP_MAX_COLLECTION_ITEMS).default(100),
});
export const mcpGetTechnologyInventoryInputSchema = mcpGetPackageInventoryInputSchema;
export const mcpGetGraphNeighborsInputSchema = z.strictObject({
  nodeKind: graphNodeKindSchema,
  nodeId: identifierSchema,
  direction: z.enum(['out', 'in']).default('out'),
  edgeKind: graphEdgeKindSchema.optional(),
  limit: z.number().int().min(1).max(MCP_MAX_COLLECTION_ITEMS).default(50),
});
export const mcpGetGraphPathInputSchema = z.strictObject({
  fromKind: graphNodeKindSchema,
  fromId: identifierSchema,
  toKind: graphNodeKindSchema,
  toId: identifierSchema,
  edgeKind: graphEdgeKindSchema.optional(),
  maxDepth: z.number().int().min(1).max(6).default(3),
});
export const mcpListOptimizationFindingsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(MCP_MAX_COLLECTION_ITEMS).default(100),
});
export const mcpGetOptimizationProposalInputSchema = z.strictObject({
  proposalId: identifierSchema,
});
export const mcpRequestOptimizationAnalysisInputSchema = z.strictObject({
  agentId: agentIdSchema.optional(),
  minimumSessions: z.number().int().min(1).max(10_000).optional(),
});

export const mcpAskAgentInputSchema = z
  .strictObject({
    targetSessionId: identifierSchema.optional(),
    targetAgentId: agentIdSchema.optional(),
    kind: messageKindSchema,
    subject: z.string().trim().min(1).optional(),
    content: z.string().min(1),
    evidenceRequirements: z.array(evidenceTypeSchema).default([]),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MESSAGE_MAX_TIMEOUT_MS)
      .default(MESSAGE_DEFAULT_TIMEOUT_MS),
    idempotencyKey: z.string().min(1).max(128).optional(),
    waitMs: z.number().int().min(0).max(MESSAGE_MAX_WAIT_MS).default(0),
  })
  .superRefine((value, context) => {
    if ((value.targetSessionId === undefined) === (value.targetAgentId === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one target selector is required.',
        path: ['targetSessionId'],
      });
    }
  });

export const mcpAwaitResponseInputSchema = z.strictObject({
  correlationId: identifierSchema,
  waitMs: z.number().int().min(0).max(MESSAGE_MAX_WAIT_MS).default(0),
});

export const mcpGetMessageInputSchema = z.strictObject({
  correlationId: identifierSchema,
});

export const mcpInboxNextInputSchema = z.strictObject({
  bridgeInstanceId: bridgeInstanceIdSchema,
  limit: z.number().int().min(1).max(INBOX_MAX_CLAIM_LIMIT).default(INBOX_DEFAULT_CLAIM_LIMIT),
  blockMs: z.number().int().min(0).max(MESSAGE_MAX_WAIT_MS).default(INBOX_DEFAULT_BLOCK_MS),
  minIdleMs: z.number().int().min(0).max(MESSAGE_MAX_TIMEOUT_MS).default(INBOX_DEFAULT_MIN_IDLE_MS),
});

const mcpMessageIdentityInputSchema = z.strictObject({
  correlationId: identifierSchema,
});

export const mcpAcknowledgeMessageInputSchema = mcpMessageIdentityInputSchema;
export const mcpMarkMessageProcessingInputSchema = mcpMessageIdentityInputSchema;
export const mcpRejectMessageInputSchema = mcpMessageIdentityInputSchema.extend({
  response: agentMessageResponseSchema,
});
export const mcpFailMessageInputSchema = mcpMessageIdentityInputSchema.extend({
  response: agentMessageResponseSchema,
});
export const mcpRespondToMessageInputSchema = mcpMessageIdentityInputSchema.extend({
  response: agentMessageResponseSchema,
});

export const mcpListProjectsOutputSchema = z.strictObject({
  projects: z.array(projectSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpListSessionsOutputSchema = z.strictObject({
  sessions: z.array(sessionViewSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetSessionOutputSchema = sessionViewSchema;
export const mcpGetProjectStateOutputSchema = z.strictObject({
  project: projectSchema,
  sessions: z.array(sessionViewSchema).max(MCP_MAX_COLLECTION_ITEMS),
  sessionsTruncated: z.boolean(),
});
export const mcpAskAgentOutputSchema = z.strictObject({
  correlationId: identifierSchema,
  selectedTargetSessionId: identifierSchema,
  selectedTargetAgentId: agentIdSchema,
  state: messageStateSchema,
  idempotent: z.boolean(),
  response: agentMessageResponseSchema.optional(),
});
export const mcpMessageOutputSchema = agentMessageSchema;
export const mcpInboxOutputSchema = inboxClaimResponseSchema;
export const mcpListAgentsOutputSchema = z.strictObject({
  agents: z.array(agentDefinitionSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetAgentOutputSchema = agentDefinitionSchema;
export const mcpListProjectAgentsOutputSchema = z.strictObject({
  bindings: z.array(projectAgentBindingSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetEffectiveConfigOutputSchema = effectiveAgentConfigurationSchema;
export const mcpListCapabilitiesOutputSchema = z.strictObject({
  capabilities: z.array(capabilityPackageSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetCapabilityOutputSchema = capabilityPackageSchema;
export const mcpGetContextFootprintOutputSchema = contextFootprintSchema;
export const mcpGetConfigDriftOutputSchema = z.strictObject({
  drifts: z.array(configDriftSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetUsageSummaryOutputSchema = usageSummarySchema;
export const mcpGetContextIntelligenceOutputSchema = z.strictObject({
  summary: contextSummarySchema,
  contributions: z.array(contextContributionSchema).max(MCP_MAX_COLLECTION_ITEMS),
  findings: z.array(optimizationFindingSchema).max(MCP_MAX_COLLECTION_ITEMS),
  contributionsTruncated: z.boolean(),
  findingsTruncated: z.boolean(),
});
export const mcpGetGitStatusOutputSchema = gitObservationSchema;
export const mcpGetRecentCommitsOutputSchema = z.strictObject({
  commits: z.array(gitCommitSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetPackageInventoryOutputSchema = z.strictObject({
  packages: z.array(packageRecordSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetTechnologyInventoryOutputSchema = z.strictObject({
  technologies: z.array(technologyRecordSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetGraphNeighborsOutputSchema = z.strictObject({
  node: graphNodeSchema,
  edges: z.array(graphEdgeSchema).max(MCP_MAX_COLLECTION_ITEMS),
  nodes: z.array(graphNodeSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetGraphPathOutputSchema = z.strictObject({
  found: z.boolean(),
  nodes: z.array(graphNodeSchema).max(MCP_MAX_COLLECTION_ITEMS),
  edges: z.array(graphEdgeSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpListOptimizationFindingsOutputSchema = z.strictObject({
  findings: z.array(optimizationFindingSchema).max(MCP_MAX_COLLECTION_ITEMS),
  truncated: z.boolean(),
});
export const mcpGetOptimizationProposalOutputSchema = optimizationProposalSchema;
export const mcpRequestOptimizationAnalysisOutputSchema = optimizationAnalysisResponseSchema;

// Exported labels let MCP clients present evidence quality without inferring certainty.
export const mcpIntelligenceDisplayLabelsSchema = z.strictObject({
  measurement: z.enum(['exact', 'reported', 'estimated', 'unknown', 'simulated']),
  attribution: attributionConfidenceSchema,
  confidence: intelligenceConfidenceSchema,
});

export type McpAskAgentInput = z.infer<typeof mcpAskAgentInputSchema>;
export type McpListProjectsInput = z.infer<typeof mcpListProjectsInputSchema>;
export type McpListSessionsInput = z.infer<typeof mcpListSessionsInputSchema>;
export type McpGetSessionInput = z.infer<typeof mcpGetSessionInputSchema>;
export type McpGetProjectStateInput = z.infer<typeof mcpGetProjectStateInputSchema>;
export type McpAwaitResponseInput = z.infer<typeof mcpAwaitResponseInputSchema>;
export type McpGetMessageInput = z.infer<typeof mcpGetMessageInputSchema>;
export type McpInboxNextInput = z.infer<typeof mcpInboxNextInputSchema>;
export type McpAcknowledgeMessageInput = z.infer<typeof mcpAcknowledgeMessageInputSchema>;
export type McpMarkMessageProcessingInput = z.infer<typeof mcpMarkMessageProcessingInputSchema>;
export type McpRespondToMessageInput = z.infer<typeof mcpRespondToMessageInputSchema>;
export type McpRejectMessageInput = z.infer<typeof mcpRejectMessageInputSchema>;
export type McpFailMessageInput = z.infer<typeof mcpFailMessageInputSchema>;
export type McpListProjectsOutput = z.infer<typeof mcpListProjectsOutputSchema>;
export type McpListSessionsOutput = z.infer<typeof mcpListSessionsOutputSchema>;
export type McpGetSessionOutput = z.infer<typeof mcpGetSessionOutputSchema>;
export type McpGetProjectStateOutput = z.infer<typeof mcpGetProjectStateOutputSchema>;
export type McpAskAgentOutput = z.infer<typeof mcpAskAgentOutputSchema>;
export type McpMessageOutput = z.infer<typeof mcpMessageOutputSchema>;
export type McpInboxOutput = z.infer<typeof mcpInboxOutputSchema>;
export type McpListAgentsInput = z.infer<typeof mcpListAgentsInputSchema>;
export type McpGetAgentInput = z.infer<typeof mcpGetAgentInputSchema>;
export type McpListProjectAgentsInput = z.infer<typeof mcpListProjectAgentsInputSchema>;
export type McpGetEffectiveConfigInput = z.infer<typeof mcpGetEffectiveConfigInputSchema>;
export type McpListCapabilitiesInput = z.infer<typeof mcpListCapabilitiesInputSchema>;
export type McpGetCapabilityInput = z.infer<typeof mcpGetCapabilityInputSchema>;
export type McpGetContextFootprintInput = z.infer<typeof mcpGetContextFootprintInputSchema>;
export type McpGetConfigDriftInput = z.infer<typeof mcpGetConfigDriftInputSchema>;
