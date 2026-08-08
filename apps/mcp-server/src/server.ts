import {
  mcpAcknowledgeMessageInputSchema,
  mcpAskAgentOutputSchema,
  mcpAskAgentInputSchema,
  mcpAwaitResponseInputSchema,
  mcpFailMessageInputSchema,
  mcpGetMessageInputSchema,
  mcpGetProjectStateInputSchema,
  mcpGetProjectStateOutputSchema,
  mcpGetSessionInputSchema,
  mcpGetSessionOutputSchema,
  mcpListAgentsInputSchema,
  mcpListAgentsOutputSchema,
  mcpGetAgentInputSchema,
  mcpGetAgentOutputSchema,
  mcpListProjectAgentsInputSchema,
  mcpListProjectAgentsOutputSchema,
  mcpGetEffectiveConfigInputSchema,
  mcpGetEffectiveConfigOutputSchema,
  mcpListCapabilitiesInputSchema,
  mcpListCapabilitiesOutputSchema,
  mcpGetCapabilityInputSchema,
  mcpGetCapabilityOutputSchema,
  mcpGetContextFootprintInputSchema,
  mcpGetContextFootprintOutputSchema,
  mcpGetConfigDriftInputSchema,
  mcpGetConfigDriftOutputSchema,
  mcpGetContextIntelligenceInputSchema,
  mcpGetContextIntelligenceOutputSchema,
  mcpGetGitStatusInputSchema,
  mcpGetGitStatusOutputSchema,
  mcpGetGraphNeighborsInputSchema,
  mcpGetGraphNeighborsOutputSchema,
  mcpGetGraphPathInputSchema,
  mcpGetGraphPathOutputSchema,
  mcpGetOptimizationProposalInputSchema,
  mcpGetOptimizationProposalOutputSchema,
  mcpGetPackageInventoryInputSchema,
  mcpGetPackageInventoryOutputSchema,
  mcpGetRecentCommitsInputSchema,
  mcpGetRecentCommitsOutputSchema,
  mcpGetTechnologyInventoryInputSchema,
  mcpGetTechnologyInventoryOutputSchema,
  mcpGetUsageSummaryInputSchema,
  mcpGetUsageSummaryOutputSchema,
  mcpInboxNextInputSchema,
  mcpInboxOutputSchema,
  mcpListProjectsInputSchema,
  mcpListProjectsOutputSchema,
  mcpListSessionsInputSchema,
  mcpListSessionsOutputSchema,
  mcpListOptimizationFindingsInputSchema,
  mcpListOptimizationFindingsOutputSchema,
  mcpMessageOutputSchema,
  mcpMarkMessageProcessingInputSchema,
  mcpRejectMessageInputSchema,
  mcpRespondToMessageInputSchema,
  mcpRequestOptimizationAnalysisInputSchema,
  mcpRequestOptimizationAnalysisOutputSchema,
} from '@luwi/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZodError } from 'zod';
import type { ZodType } from 'zod';

import { McpDaemonError } from './daemon-client.js';
import type { McpToolHandlers } from './tools.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const MAX_TOOL_SUMMARY_CHARACTERS = 384;
const MAX_ERROR_MESSAGE_CHARACTERS = 256;

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

async function toolResult<T extends object>(
  outputSchema: ZodType<T>,
  summarize: (value: T) => string,
  operation: () => Promise<unknown>,
): Promise<ToolResult> {
  try {
    const result = outputSchema.safeParse(await operation());
    if (!result.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: {
                code: 'TOOL_OUTPUT_INVALID',
                message: 'The MCP tool received an invalid daemon response.',
              },
            }),
          },
        ],
      };
    }
    return {
      structuredContent: result.data as Record<string, unknown>,
      content: [
        {
          type: 'text',
          text: boundedText(summarize(result.data), MAX_TOOL_SUMMARY_CHARACTERS),
        },
      ],
    };
  } catch (error) {
    const safe =
      error instanceof McpDaemonError
        ? {
            code: error.code,
            message: boundedText(error.message, MAX_ERROR_MESSAGE_CHARACTERS),
            statusCode: error.statusCode,
          }
        : error instanceof ZodError
          ? { code: 'TOOL_INPUT_INVALID', message: 'The MCP tool input is invalid.' }
          : { code: 'TOOL_FAILED', message: 'The MCP tool operation failed.' };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: safe }) }],
    };
  }
}

export function createLuwiMcpServer(handlers: McpToolHandlers): McpServer {
  const server = new McpServer({
    name: 'luwi-runtime',
    version: '0.1.0',
  });

  server.registerTool(
    'luwi_list_projects',
    {
      description: 'List projects registered in the local LUWI Runtime.',
      inputSchema: mcpListProjectsInputSchema,
      outputSchema: mcpListProjectsOutputSchema,
    },
    (input) =>
      toolResult(
        mcpListProjectsOutputSchema,
        ({ projects, truncated }) =>
          `${projects.length} projects returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.listProjects(input),
      ),
  );
  server.registerTool(
    'luwi_list_sessions',
    {
      description: 'List sessions in the bound LUWI project.',
      inputSchema: mcpListSessionsInputSchema,
      outputSchema: mcpListSessionsOutputSchema,
    },
    (input) =>
      toolResult(
        mcpListSessionsOutputSchema,
        ({ sessions, truncated }) =>
          `${sessions.length} sessions returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.listSessions(input),
      ),
  );
  server.registerTool(
    'luwi_get_session',
    {
      description: 'Get a session in the bound LUWI project.',
      inputSchema: mcpGetSessionInputSchema,
      outputSchema: mcpGetSessionOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetSessionOutputSchema,
        ({ id, status, presence }) => `Session ${id} is ${status} and ${presence}.`,
        () => handlers.getSession(input),
      ),
  );
  server.registerTool(
    'luwi_get_project_state',
    {
      description: 'Get the bound project and its current LUWI session projection.',
      inputSchema: mcpGetProjectStateInputSchema,
      outputSchema: mcpGetProjectStateOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetProjectStateOutputSchema,
        ({ project, sessions, sessionsTruncated }) =>
          `Project ${project.id} returned with ${sessions.length} sessions${
            sessionsTruncated ? ' (session result truncated)' : ''
          }.`,
        () => handlers.getProjectState(input),
      ),
  );
  server.registerTool(
    'luwi_list_agents',
    {
      description: 'List agent definitions bound to the current LUWI project.',
      inputSchema: mcpListAgentsInputSchema,
      outputSchema: mcpListAgentsOutputSchema,
    },
    (input) =>
      toolResult(
        mcpListAgentsOutputSchema,
        ({ agents, truncated }) =>
          `${agents.length} agent definitions returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.listAgents(input),
      ),
  );
  server.registerTool(
    'luwi_get_agent',
    {
      description: 'Get an agent definition bound to the current LUWI project.',
      inputSchema: mcpGetAgentInputSchema,
      outputSchema: mcpGetAgentOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetAgentOutputSchema,
        ({ id, kind, enabled }) =>
          `Agent ${id} is ${kind} and ${enabled ? 'enabled' : 'disabled'}.`,
        () => handlers.getAgent(input),
      ),
  );
  server.registerTool(
    'luwi_list_project_agents',
    {
      description: 'List agent bindings for the current LUWI project.',
      inputSchema: mcpListProjectAgentsInputSchema,
      outputSchema: mcpListProjectAgentsOutputSchema,
    },
    (input) =>
      toolResult(
        mcpListProjectAgentsOutputSchema,
        ({ bindings, truncated }) =>
          `${bindings.length} project-agent bindings returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.listProjectAgents(input),
      ),
  );
  server.registerTool(
    'luwi_get_effective_config',
    {
      description: 'Preview validated effective config for a bound project agent.',
      inputSchema: mcpGetEffectiveConfigInputSchema,
      outputSchema: mcpGetEffectiveConfigOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetEffectiveConfigOutputSchema,
        ({ agentId, valid, capabilities }) =>
          `Effective config for ${agentId} is ${valid ? 'valid' : 'invalid'} with ${capabilities.length} capabilities.`,
        () => handlers.getEffectiveConfig(input),
      ),
  );
  server.registerTool(
    'luwi_list_capabilities',
    {
      description: 'List capabilities visible to the current LUWI project.',
      inputSchema: mcpListCapabilitiesInputSchema,
      outputSchema: mcpListCapabilitiesOutputSchema,
    },
    (input) =>
      toolResult(
        mcpListCapabilitiesOutputSchema,
        ({ capabilities, truncated }) =>
          `${capabilities.length} capabilities returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.listCapabilities(input),
      ),
  );
  server.registerTool(
    'luwi_get_capability',
    {
      description: 'Get a global or current-project capability definition.',
      inputSchema: mcpGetCapabilityInputSchema,
      outputSchema: mcpGetCapabilityOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetCapabilityOutputSchema,
        ({ id, kind, enabled }) =>
          `Capability ${id} is ${kind} and ${enabled ? 'enabled' : 'disabled'}.`,
        () => handlers.getCapability(input),
      ),
  );
  server.registerTool(
    'luwi_get_context_footprint',
    {
      description: 'Get the static estimated context footprint for a bound project agent.',
      inputSchema: mcpGetContextFootprintInputSchema,
      outputSchema: mcpGetContextFootprintOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetContextFootprintOutputSchema,
        ({ agentId, estimatedTokens, method }) =>
          `Context for ${agentId ?? 'agent'} is estimated at ${estimatedTokens} tokens using ${method}.`,
        () => handlers.getContextFootprint(input),
      ),
  );
  server.registerTool(
    'luwi_get_config_drift',
    {
      description: 'List native-config drift visible to the current LUWI project.',
      inputSchema: mcpGetConfigDriftInputSchema,
      outputSchema: mcpGetConfigDriftOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetConfigDriftOutputSchema,
        ({ drifts, truncated }) =>
          `${drifts.length} drift records returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.getConfigDrift(input),
      ),
  );
  server.registerTool(
    'luwi_get_usage_summary',
    {
      description: 'Get source-separated usage intelligence for the bound session or project.',
      inputSchema: mcpGetUsageSummaryInputSchema,
      outputSchema: mcpGetUsageSummaryOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetUsageSummaryOutputSchema,
        ({ recordCount, sources }) =>
          `${recordCount} usage records across ${sources.length} labelled sources.`,
        () => handlers.getUsageSummary(input),
      ),
  );
  server.registerTool(
    'luwi_get_context_intelligence',
    {
      description:
        'Get assigned, effective, loaded and invoked context evidence for a bound project agent.',
      inputSchema: mcpGetContextIntelligenceInputSchema,
      outputSchema: mcpGetContextIntelligenceOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetContextIntelligenceOutputSchema,
        ({ contributions, findings }) =>
          `${contributions.length} context contributions and ${findings.length} structural findings returned.`,
        () => handlers.getContextIntelligence(input),
      ),
  );
  server.registerTool(
    'luwi_get_git_status',
    {
      description: 'Get the latest read-only local Git observation for the bound project.',
      inputSchema: mcpGetGitStatusInputSchema,
      outputSchema: mcpGetGitStatusOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetGitStatusOutputSchema,
        ({ branch, clean, headSha }) =>
          `Git ${branch ?? 'detached'} at ${headSha ?? 'unknown'} is ${clean ? 'clean' : 'dirty'}.`,
        () => handlers.getGitStatus(input),
      ),
  );
  server.registerTool(
    'luwi_get_recent_commits',
    {
      description: 'Get bounded recent commits from the bound local project.',
      inputSchema: mcpGetRecentCommitsInputSchema,
      outputSchema: mcpGetRecentCommitsOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetRecentCommitsOutputSchema,
        ({ commits, truncated }) =>
          `${commits.length} commits returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.getRecentCommits(input),
      ),
  );
  server.registerTool(
    'luwi_get_package_inventory',
    {
      description: 'Get declared packages from locally parsed manifests in the bound project.',
      inputSchema: mcpGetPackageInventoryInputSchema,
      outputSchema: mcpGetPackageInventoryOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetPackageInventoryOutputSchema,
        ({ packages, truncated }) =>
          `${packages.length} packages returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.getPackageInventory(input),
      ),
  );
  server.registerTool(
    'luwi_get_technology_inventory',
    {
      description: 'Get evidence-backed detected technologies for the bound project.',
      inputSchema: mcpGetTechnologyInventoryInputSchema,
      outputSchema: mcpGetTechnologyInventoryOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetTechnologyInventoryOutputSchema,
        ({ technologies, truncated }) =>
          `${technologies.length} technologies returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.getTechnologyInventory(input),
      ),
  );
  server.registerTool(
    'luwi_get_graph_neighbors',
    {
      description: 'Query bounded operational-graph neighbors in the bound project.',
      inputSchema: mcpGetGraphNeighborsInputSchema,
      outputSchema: mcpGetGraphNeighborsOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetGraphNeighborsOutputSchema,
        ({ node, nodes, truncated }) =>
          `${nodes.length} neighbors for ${node.kind}:${node.entityId}${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.getGraphNeighbors(input),
      ),
  );
  server.registerTool(
    'luwi_get_graph_path',
    {
      description: 'Find a bounded operational-graph path in the bound project.',
      inputSchema: mcpGetGraphPathInputSchema,
      outputSchema: mcpGetGraphPathOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetGraphPathOutputSchema,
        ({ found, nodes, truncated }) =>
          `${found ? 'Path found' : 'No path found'} with ${nodes.length} nodes${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.getGraphPath(input),
      ),
  );
  server.registerTool(
    'luwi_list_optimization_findings',
    {
      description: 'List evidence-backed structural optimization findings for the bound project.',
      inputSchema: mcpListOptimizationFindingsInputSchema,
      outputSchema: mcpListOptimizationFindingsOutputSchema,
    },
    (input) =>
      toolResult(
        mcpListOptimizationFindingsOutputSchema,
        ({ findings, truncated }) =>
          `${findings.length} findings returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.listOptimizationFindings(input),
      ),
  );
  server.registerTool(
    'luwi_get_optimization_proposal',
    {
      description: 'Get one structural optimization proposal in the bound project.',
      inputSchema: mcpGetOptimizationProposalInputSchema,
      outputSchema: mcpGetOptimizationProposalOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetOptimizationProposalOutputSchema,
        ({ id, state, confidence }) => `Proposal ${id} is ${state} with ${confidence} confidence.`,
        () => handlers.getOptimizationProposal(input),
      ),
  );
  server.registerTool(
    'luwi_request_optimization_analysis',
    {
      description:
        'Request evidence analysis for the bound project; this does not accept or apply changes.',
      inputSchema: mcpRequestOptimizationAnalysisInputSchema,
      outputSchema: mcpRequestOptimizationAnalysisOutputSchema,
    },
    (input) =>
      toolResult(
        mcpRequestOptimizationAnalysisOutputSchema,
        ({ findings, proposals }) =>
          `Analysis produced ${findings.length} findings and ${proposals.length} proposals; no configuration was applied.`,
        () => handlers.requestOptimizationAnalysis(input),
      ),
  );
  server.registerTool(
    'luwi_ask_agent',
    {
      description: 'Persist a request to an online session in the bound project.',
      inputSchema: mcpAskAgentInputSchema,
      outputSchema: mcpAskAgentOutputSchema,
    },
    (input) =>
      toolResult(
        mcpAskAgentOutputSchema,
        ({ correlationId, selectedTargetSessionId, state, idempotent }) =>
          `Message ${correlationId} is ${state}; selected target ${selectedTargetSessionId}${
            idempotent ? ' (idempotent retry)' : ''
          }.`,
        () => handlers.askAgent(input),
      ),
  );
  server.registerTool(
    'luwi_await_response',
    {
      description: 'Wait for a bounded interval and return the latest message projection.',
      inputSchema: mcpAwaitResponseInputSchema,
      outputSchema: mcpMessageOutputSchema,
    },
    (input) =>
      toolResult(
        mcpMessageOutputSchema,
        ({ correlationId, state }) => `Message ${correlationId} is ${state}.`,
        () => handlers.awaitResponse(input),
      ),
  );
  server.registerTool(
    'luwi_get_message',
    {
      description: 'Get a message involving the bound LUWI session.',
      inputSchema: mcpGetMessageInputSchema,
      outputSchema: mcpMessageOutputSchema,
    },
    (input) =>
      toolResult(
        mcpMessageOutputSchema,
        ({ correlationId, state }) => `Message ${correlationId} is ${state}.`,
        () => handlers.getMessage(input),
      ),
  );
  server.registerTool(
    'luwi_inbox_next',
    {
      description: 'Recover pending work, then claim new durable inbox work for the bound session.',
      inputSchema: mcpInboxNextInputSchema,
      outputSchema: mcpInboxOutputSchema,
    },
    (input) =>
      toolResult(
        mcpInboxOutputSchema,
        ({ items }) => `${items.length} inbox items claimed.`,
        () => handlers.inboxNext(input),
      ),
  );
  server.registerTool(
    'luwi_acknowledge_message',
    {
      description: 'Acknowledge delivery as the bound target session.',
      inputSchema: mcpAcknowledgeMessageInputSchema,
      outputSchema: mcpMessageOutputSchema,
    },
    (input) =>
      toolResult(
        mcpMessageOutputSchema,
        ({ correlationId, state }) => `Message ${correlationId} is ${state}.`,
        () => handlers.acknowledgeMessage(input),
      ),
  );
  server.registerTool(
    'luwi_mark_message_processing',
    {
      description: 'Mark a message processing as the bound target session.',
      inputSchema: mcpMarkMessageProcessingInputSchema,
      outputSchema: mcpMessageOutputSchema,
    },
    (input) =>
      toolResult(
        mcpMessageOutputSchema,
        ({ correlationId, state }) => `Message ${correlationId} is ${state}.`,
        () => handlers.markMessageProcessing(input),
      ),
  );
  server.registerTool(
    'luwi_respond_to_message',
    {
      description: 'Return a structured response as the bound target session.',
      inputSchema: mcpRespondToMessageInputSchema,
      outputSchema: mcpMessageOutputSchema,
    },
    (input) =>
      toolResult(
        mcpMessageOutputSchema,
        ({ correlationId, state }) => `Message ${correlationId} is ${state}.`,
        () => handlers.respondToMessage(input),
      ),
  );
  server.registerTool(
    'luwi_reject_message',
    {
      description: 'Reject a message as the bound target session.',
      inputSchema: mcpRejectMessageInputSchema,
      outputSchema: mcpMessageOutputSchema,
    },
    (input) =>
      toolResult(
        mcpMessageOutputSchema,
        ({ correlationId, state }) => `Message ${correlationId} is ${state}.`,
        () => handlers.rejectMessage(input),
      ),
  );
  server.registerTool(
    'luwi_fail_message',
    {
      description: 'Fail message processing as the bound target session.',
      inputSchema: mcpFailMessageInputSchema,
      outputSchema: mcpMessageOutputSchema,
    },
    (input) =>
      toolResult(
        mcpMessageOutputSchema,
        ({ correlationId, state }) => `Message ${correlationId} is ${state}.`,
        () => handlers.failMessage(input),
      ),
  );

  return server;
}
