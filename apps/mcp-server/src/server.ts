import {
  mcpAcknowledgeMessageInputSchema,
  mcpAskAgentOutputSchema,
  mcpAcquireLeaseInputSchema,
  mcpAskAgentInputSchema,
  mcpLeaseIdInputSchema,
  mcpListLeasesInputSchema,
  mcpGetAutopilotInputSchema,
  mcpGetAutopilotOutputSchema,
  mcpListGoalsInputSchema,
  mcpGoalIdInputSchema,
  mcpCreateGoalInputSchema,
  mcpGoalNoteInputSchema,
  mcpAnswerGoalInputSchema,
  mcpAbandonGoalInputSchema,
  mcpGoalOutputSchema,
  mcpGoalCollectionOutputSchema,
  mcpListTasksInputSchema,
  mcpTaskIdInputSchema,
  mcpTaskOutputSchema,
  mcpTaskCollectionOutputSchema,
  mcpReleaseLeaseInputSchema,
  mcpAcquireLeaseOutputSchema,
  mcpLeaseCollectionOutputSchema,
  workLeaseSchema,
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
  mcpJoinInputSchema,
  mcpJoinOutputSchema,
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
  LUWI_RUNTIME_VERSION,
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
const MAX_MESSAGE_SUMMARY_CHARACTERS = 65_536;
const MAX_ERROR_MESSAGE_CHARACTERS = 256;

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

async function toolResult<T extends object>(
  outputSchema: ZodType<T>,
  summarize: (value: T) => string,
  operation: () => Promise<unknown>,
  maximumSummaryCharacters = MAX_TOOL_SUMMARY_CHARACTERS,
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
          text: boundedText(summarize(result.data), maximumSummaryCharacters),
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
    version: LUWI_RUNTIME_VERSION,
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
    'luwi_acquire_lease',
    {
      description:
        'Take an advisory work lease over a project-relative path before editing it. A refusal names the session that already holds an overlapping path; it is an answer, not an error.',
      inputSchema: mcpAcquireLeaseInputSchema,
      outputSchema: mcpAcquireLeaseOutputSchema,
    },
    (input) =>
      toolResult(
        mcpAcquireLeaseOutputSchema,
        // The schema's refinement guarantees the arm matching `status` is
        // present; the fallbacks exist because the object shape MCP requires
        // cannot express that to the type system.
        (result) =>
          result.status === 'granted'
            ? `Lease ${result.lease?.id ?? 'unknown'} granted over ${result.lease?.path ?? 'unknown'} until ${result.lease?.expiresAt ?? 'unknown'}.`
            : `Refused: session ${result.conflict?.sessionId ?? 'unknown'} (${result.conflict?.agentId ?? 'unknown'}) holds ${result.conflict?.path ?? 'unknown'} until ${result.conflict?.expiresAt ?? 'unknown'} — ${result.conflict?.reason ?? 'no reason recorded'}.`,
        () => handlers.acquireLease(input),
      ),
  );
  server.registerTool(
    'luwi_renew_lease',
    {
      description: 'Extend a work lease this session holds.',
      inputSchema: mcpLeaseIdInputSchema,
      outputSchema: workLeaseSchema,
    },
    (input) =>
      toolResult(
        workLeaseSchema,
        (lease) => `Lease ${lease.id} over ${lease.path} now expires at ${lease.expiresAt}.`,
        () => handlers.renewLease(input),
      ),
  );
  server.registerTool(
    'luwi_release_lease',
    {
      description: 'Release a work lease this session holds, freeing the path for others.',
      inputSchema: mcpReleaseLeaseInputSchema,
      outputSchema: workLeaseSchema,
    },
    (input) =>
      toolResult(
        workLeaseSchema,
        (lease) => `Lease ${lease.id} over ${lease.path} is released.`,
        () => handlers.releaseLease(input),
      ),
  );
  server.registerTool(
    'luwi_list_leases',
    {
      description:
        'List held work leases in the bound project, or only this session’s with mine=true.',
      inputSchema: mcpListLeasesInputSchema,
      outputSchema: mcpLeaseCollectionOutputSchema,
    },
    (input) =>
      toolResult(
        mcpLeaseCollectionOutputSchema,
        ({ leases, truncated }) =>
          `${leases.length} held leases returned${truncated ? ' (result truncated)' : ''}.`,
        () => handlers.listLeases(input),
      ),
  );
  server.registerTool(
    'luwi_get_autopilot',
    {
      description:
        'The bound project’s autopilot: mode, policy and whether a coordinator session is online. The mode and the policy are the operator’s and cannot be changed from here.',
      inputSchema: mcpGetAutopilotInputSchema,
      outputSchema: mcpGetAutopilotOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGetAutopilotOutputSchema,
        ({ record, coordinatorOnline }) =>
          record === null
            ? 'No autopilot policy is declared for this project.'
            : `Autopilot ${record.mode}; coordinator ${record.policy?.coordinatorAgentId ?? 'unset'} is ${coordinatorOnline ? 'online' : 'absent'}.`,
        () => handlers.getAutopilot(input),
      ),
  );
  server.registerTool(
    'luwi_list_goals',
    {
      description: 'List autopilot goals of the bound project, newest first, optionally by state.',
      inputSchema: mcpListGoalsInputSchema,
      outputSchema: mcpGoalCollectionOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGoalCollectionOutputSchema,
        ({ goals, truncated }) =>
          `${goals.length} goals returned${truncated ? ' (result truncated)' : ''}: ${goals
            .slice(0, 5)
            .map((goal) => `${goal.id} [${goal.state}] ${goal.title}`)
            .join('; ')}`,
        () => handlers.listGoals(input),
      ),
  );
  server.registerTool(
    'luwi_get_goal',
    {
      description:
        'One goal of the bound project: objective, plan, budget, usage, and the question it is waiting on when blocked.',
      inputSchema: mcpGoalIdInputSchema,
      outputSchema: mcpGoalOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGoalOutputSchema,
        (goal) =>
          `Goal ${goal.id} [${goal.state}] ${goal.title}; ${goal.taskIds.length} planned tasks${goal.escalation === undefined ? '' : `; waiting on: ${goal.escalation.question}`}.`,
        () => handlers.getGoal(input),
      ),
  );
  server.registerTool(
    'luwi_create_goal',
    {
      description:
        'Create an autopilot goal in the bound project on the operator’s behalf: an objective in their words, acceptance criteria, and optionally a lower budget. The orchestrator plans it; in supervised mode the operator approves the plan.',
      inputSchema: mcpCreateGoalInputSchema,
      outputSchema: mcpGoalOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGoalOutputSchema,
        (goal) => `Goal ${goal.id} created (${goal.state}): ${goal.title}.`,
        () => handlers.createGoal(input),
      ),
  );
  server.registerTool(
    'luwi_approve_plan',
    {
      description:
        'Approve the plan under review for a goal, on the operator’s behalf. Refused unless this session’s agent is an operator proxy in the project’s autopilot policy.',
      inputSchema: mcpGoalNoteInputSchema,
      outputSchema: mcpGoalOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGoalOutputSchema,
        (goal) => `Plan approved; goal ${goal.id} is ${goal.state}.`,
        () => handlers.approvePlan(input),
      ),
  );
  server.registerTool(
    'luwi_reject_plan',
    {
      description:
        'Reject the plan under review for a goal, on the operator’s behalf; the note guides the next plan. Refused unless this session is an operator proxy.',
      inputSchema: mcpGoalNoteInputSchema,
      outputSchema: mcpGoalOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGoalOutputSchema,
        (goal) => `Plan rejected; goal ${goal.id} is ${goal.state}.`,
        () => handlers.rejectPlan(input),
      ),
  );
  server.registerTool(
    'luwi_answer_goal',
    {
      description:
        'Answer the question a blocked goal is waiting on, on the operator’s behalf. Refused unless this session is an operator proxy.',
      inputSchema: mcpAnswerGoalInputSchema,
      outputSchema: mcpGoalOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGoalOutputSchema,
        (goal) => `Answer recorded; goal ${goal.id} is ${goal.state}.`,
        () => handlers.answerGoal(input),
      ),
  );
  server.registerTool(
    'luwi_abandon_goal',
    {
      description:
        'Abandon a goal on the operator’s behalf. Refused unless this session is an operator proxy.',
      inputSchema: mcpAbandonGoalInputSchema,
      outputSchema: mcpGoalOutputSchema,
    },
    (input) =>
      toolResult(
        mcpGoalOutputSchema,
        (goal) => `Goal ${goal.id} abandoned.`,
        () => handlers.abandonGoal(input),
      ),
  );
  server.registerTool(
    'luwi_list_tasks',
    {
      description:
        'List autopilot tasks of the bound project, optionally of one goal or in one state.',
      inputSchema: mcpListTasksInputSchema,
      outputSchema: mcpTaskCollectionOutputSchema,
    },
    (input) =>
      toolResult(
        mcpTaskCollectionOutputSchema,
        ({ tasks, truncated }) =>
          `${tasks.length} tasks returned${truncated ? ' (result truncated)' : ''}: ${tasks
            .slice(0, 5)
            .map((task) => `${task.id} [${task.state}] ${task.title}`)
            .join('; ')}`,
        () => handlers.listTasks(input),
      ),
  );
  server.registerTool(
    'luwi_get_task',
    {
      description:
        'One autopilot task of the bound project: brief, paths, state, outcome and verification.',
      inputSchema: mcpTaskIdInputSchema,
      outputSchema: mcpTaskOutputSchema,
    },
    (input) =>
      toolResult(
        mcpTaskOutputSchema,
        (task) =>
          `Task ${task.id} [${task.state}] ${task.title}${task.verification?.verdict === undefined ? '' : `; verdict ${task.verification.verdict}`}.`,
        () => handlers.getTask(input),
      ),
  );
  server.registerTool(
    'luwi_ask_agent',
    {
      description:
        'Persist a request to a session in the bound project. `delivery` reports how the reply comes back: `live` when the target continuously reads its inbox (a bridge worker), or `deferred` when it is a turn-based GUI that only reads on its next turn. A deferred ask returns immediately without waiting — collect the reply later with luwi_await_response rather than treating the absence of an immediate answer as a timeout.',
      inputSchema: mcpAskAgentInputSchema,
      outputSchema: mcpAskAgentOutputSchema,
    },
    (input) =>
      toolResult(
        mcpAskAgentOutputSchema,
        ({ correlationId, selectedTargetSessionId, delivery, state, idempotent, response }) => {
          const base = `Message ${correlationId} is ${state}; selected target ${selectedTargetSessionId} (${delivery} delivery)${
            idempotent ? ' (idempotent retry)' : ''
          }.`;
          if (response) return `${base}\nResponse (${response.status}): ${response.answer}`;
          return delivery === 'deferred'
            ? `${base}\nDeferred: the target reads its inbox on its next turn — call luwi_await_response to collect the reply.`
            : base;
        },
        () => handlers.askAgent(input),
        MAX_MESSAGE_SUMMARY_CHARACTERS,
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
        (message) => {
          const base = `Message ${message.correlationId} is ${message.state}.`;
          return message.response
            ? `${base}\nResponse (${message.response.status}): ${message.response.answer}`
            : base;
        },
        () => handlers.awaitResponse(input),
        MAX_MESSAGE_SUMMARY_CHARACTERS,
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
        (message) => {
          const base = `Message ${message.correlationId} is ${message.state}. Kind: ${message.kind}, Source: ${message.sourceSessionId}, Target: ${message.targetSessionId ?? 'unassigned'}.`;
          const content = `\nSubject: ${message.subject ?? '(no subject)'}\nContent: ${message.content}`;
          const response = message.response
            ? `\nResponse (${message.response.status}): ${message.response.answer}`
            : '';
          return `${base}${content}${response}`;
        },
        () => handlers.getMessage(input),
        MAX_MESSAGE_SUMMARY_CHARACTERS,
      ),
  );
  server.registerTool(
    'luwi_join',
    {
      description:
        "Join the bound session's own project as a ready worker and wait briefly for its next task. Call it again after handling each task to keep listening — an MCP tool cannot loop on its own.",
      inputSchema: mcpJoinInputSchema,
      outputSchema: mcpJoinOutputSchema,
    },
    (input) =>
      toolResult(
        mcpJoinOutputSchema,
        ({ session, inbox }) => {
          if (inbox.items.length === 0) {
            return `Joined project ${session.projectId} as a ready worker; no task yet — call luwi_join again to keep listening.`;
          }
          const itemsText = inbox.items
            .map((item) =>
              item.itemKind === 'request'
                ? `Task [correlationId: ${item.correlationId}, source: ${item.sourceSessionId}]:\nSubject: ${item.payload.subject ?? '(no subject)'}\nContent: ${item.payload.content}`
                : item.itemKind === 'notice'
                  ? `Autopilot notice: ${item.payload.kind}${item.payload.goalId === undefined ? '' : ` (goal ${item.payload.goalId})`} — read the goals and tasks and act on what the store says.`
                  : `Response [correlationId: ${item.correlationId}, source: ${item.sourceSessionId}]:\nState: ${item.payload.state}${item.payload.response ? `\nAnswer: ${item.payload.response.answer}` : ''}`,
            )
            .join('\n\n');
          return `Joined project ${session.projectId}; claimed ${String(inbox.items.length)} inbox item(s) to handle:\n\n${itemsText}`;
        },
        () => handlers.join(input),
        MAX_MESSAGE_SUMMARY_CHARACTERS,
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
        ({ items }) => {
          if (items.length === 0) {
            return '0 inbox items claimed.';
          }
          const itemsText = items
            .map((item) =>
              item.itemKind === 'request'
                ? `Task [correlationId: ${item.correlationId}, source: ${item.sourceSessionId}]:\nSubject: ${item.payload.subject ?? '(no subject)'}\nContent: ${item.payload.content}`
                : item.itemKind === 'notice'
                  ? `Autopilot notice: ${item.payload.kind}${item.payload.goalId === undefined ? '' : ` (goal ${item.payload.goalId})`} — read the goals and tasks and act on what the store says.`
                  : `Response [correlationId: ${item.correlationId}, source: ${item.sourceSessionId}]:\nState: ${item.payload.state}${item.payload.response ? `\nAnswer: ${item.payload.response.answer}` : ''}`,
            )
            .join('\n\n');
          return `${String(items.length)} inbox item(s) claimed:\n\n${itemsText}`;
        },
        () => handlers.inboxNext(input),
        MAX_MESSAGE_SUMMARY_CHARACTERS,
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
