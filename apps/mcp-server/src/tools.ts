import {
  MCP_MAX_COLLECTION_ITEMS,
  mcpAcknowledgeMessageInputSchema,
  mcpAcquireLeaseInputSchema,
  mcpLeaseIdInputSchema,
  mcpListLeasesInputSchema,
  mcpReleaseLeaseInputSchema,
  mcpAskAgentInputSchema,
  mcpAwaitResponseInputSchema,
  mcpFailMessageInputSchema,
  mcpGetMessageInputSchema,
  mcpGetProjectStateInputSchema,
  mcpGetSessionInputSchema,
  mcpListAgentsInputSchema,
  mcpGetAgentInputSchema,
  mcpListProjectAgentsInputSchema,
  mcpGetEffectiveConfigInputSchema,
  mcpListCapabilitiesInputSchema,
  mcpGetCapabilityInputSchema,
  mcpGetContextFootprintInputSchema,
  mcpGetConfigDriftInputSchema,
  mcpGetContextIntelligenceInputSchema,
  mcpGetGitStatusInputSchema,
  mcpGetGraphNeighborsInputSchema,
  mcpGetGraphPathInputSchema,
  mcpGetOptimizationProposalInputSchema,
  mcpGetPackageInventoryInputSchema,
  mcpGetRecentCommitsInputSchema,
  mcpGetTechnologyInventoryInputSchema,
  mcpGetUsageSummaryInputSchema,
  mcpInboxNextInputSchema,
  mcpJoinInputSchema,
  mcpListProjectsInputSchema,
  mcpListSessionsInputSchema,
  mcpListOptimizationFindingsInputSchema,
  mcpMarkMessageProcessingInputSchema,
  mcpRejectMessageInputSchema,
  mcpRespondToMessageInputSchema,
  mcpRequestOptimizationAnalysisInputSchema,
  type AgentMessage,
  type SessionView,
} from '@luwi/protocol';

import { McpDaemonError, type McpDaemonClient } from './daemon-client.js';

export type McpToolHandlers = {
  listProjects(input: unknown): Promise<unknown>;
  listSessions(input: unknown): Promise<unknown>;
  getSession(input: unknown): Promise<unknown>;
  join(input: unknown): Promise<unknown>;
  getProjectState(input: unknown): Promise<unknown>;
  acquireLease(input: unknown): Promise<unknown>;
  renewLease(input: unknown): Promise<unknown>;
  releaseLease(input: unknown): Promise<unknown>;
  listLeases(input: unknown): Promise<unknown>;
  askAgent(input: unknown): Promise<unknown>;
  awaitResponse(input: unknown): Promise<unknown>;
  getMessage(input: unknown): Promise<unknown>;
  inboxNext(input: unknown): Promise<unknown>;
  acknowledgeMessage(input: unknown): Promise<unknown>;
  markMessageProcessing(input: unknown): Promise<unknown>;
  respondToMessage(input: unknown): Promise<unknown>;
  rejectMessage(input: unknown): Promise<unknown>;
  failMessage(input: unknown): Promise<unknown>;
  listAgents(input: unknown): Promise<unknown>;
  getAgent(input: unknown): Promise<unknown>;
  listProjectAgents(input: unknown): Promise<unknown>;
  getEffectiveConfig(input: unknown): Promise<unknown>;
  listCapabilities(input: unknown): Promise<unknown>;
  getCapability(input: unknown): Promise<unknown>;
  getContextFootprint(input: unknown): Promise<unknown>;
  getConfigDrift(input: unknown): Promise<unknown>;
  getUsageSummary(input: unknown): Promise<unknown>;
  getContextIntelligence(input: unknown): Promise<unknown>;
  getGitStatus(input: unknown): Promise<unknown>;
  getRecentCommits(input: unknown): Promise<unknown>;
  getPackageInventory(input: unknown): Promise<unknown>;
  getTechnologyInventory(input: unknown): Promise<unknown>;
  getGraphNeighbors(input: unknown): Promise<unknown>;
  getGraphPath(input: unknown): Promise<unknown>;
  listOptimizationFindings(input: unknown): Promise<unknown>;
  getOptimizationProposal(input: unknown): Promise<unknown>;
  requestOptimizationAnalysis(input: unknown): Promise<unknown>;
};

export type BoundSessionResolver = () => Promise<SessionView>;

function requireBoundMessage(message: AgentMessage, bound: SessionView): AgentMessage {
  if (
    message.projectId !== bound.projectId ||
    (message.sourceSessionId !== bound.id && message.targetSessionId !== bound.id)
  ) {
    throw new McpDaemonError(
      'BOUND_PROJECT_MISMATCH',
      'The requested resource is outside the bound LUWI session project.',
      403,
    );
  }
  return message;
}

export function createMcpToolHandlers(
  client: McpDaemonClient,
  boundSession: SessionView,
  resolveBoundSession: BoundSessionResolver = () => client.verifyBoundSession(boundSession.id),
  /**
   * Registers a successor for a dropped attach session and keeps it alive
   * (ADR 0034). Absent, a terminal bound session stays a terminal error.
   */
  reviveBoundSession?: BoundSessionResolver,
): McpToolHandlers {
  const requireCurrentBound = async (): Promise<SessionView> => {
    const current = await resolveBoundSession();
    if (current.projectId !== boundSession.projectId) {
      throw new McpDaemonError(
        'BOUND_PROJECT_MISMATCH',
        'The bound LUWI session project changed unexpectedly.',
        409,
      );
    }
    return current;
  };
  const getBoundMessage = async (correlationId: string): Promise<AgentMessage> => {
    const current = await requireCurrentBound();
    return requireBoundMessage(await client.getMessage(correlationId), current);
  };
  const boundBindings = async (snapshot?: SessionView) => {
    const current = snapshot ?? (await requireCurrentBound());
    return {
      current,
      bindings: await client.listProjectAgents(current.projectId),
    };
  };
  const requireBoundAgent = async (agentId: string, snapshot?: SessionView) => {
    const state = await boundBindings(snapshot);
    if (!state.bindings.some((binding) => binding.agentId === agentId)) {
      throw new McpDaemonError(
        'BOUND_PROJECT_MISMATCH',
        'The requested agent is not bound to the current LUWI project.',
        403,
      );
    }
    return state;
  };

  return {
    async listProjects(input) {
      mcpListProjectsInputSchema.parse(input);
      await requireCurrentBound();
      const result = await client.listProjects();
      return {
        projects: result.projects.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated: result.projects.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async listSessions(input) {
      const parsed = mcpListSessionsInputSchema.parse(input);
      const current = await requireCurrentBound();
      const result = await client.listProjectSessions(current.projectId);
      const matching = parsed.online
        ? result.sessions.filter(({ presence }) => presence === 'online')
        : result.sessions;
      return {
        sessions: matching.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated: matching.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async getSession(input) {
      const parsed = mcpGetSessionInputSchema.parse(input);
      const current = await requireCurrentBound();
      const session = await client.getSession(parsed.sessionId);
      if (session.projectId !== current.projectId) {
        throw new McpDaemonError(
          'BOUND_PROJECT_MISMATCH',
          'The requested session is outside the bound LUWI project.',
          403,
        );
      }
      return session;
    },
    async join(input) {
      mcpJoinInputSchema.parse(input);
      let current: SessionView;
      try {
        current = await requireCurrentBound();
      } catch (error) {
        if (
          reviveBoundSession === undefined ||
          !(error instanceof McpDaemonError) ||
          error.code !== 'BOUND_SESSION_TERMINAL'
        ) {
          throw error;
        }
        // The attach session was dropped — still `starting` past its grace, or
        // lost to a restart before any join. Joining is the reader binding, so
        // the reader registers the successor it will keep alive (ADR 0034).
        current = await reviveBoundSession();
        if (current.projectId !== boundSession.projectId) {
          throw new McpDaemonError(
            'BOUND_PROJECT_MISMATCH',
            'The revived LUWI session is outside the bound project.',
            409,
          );
        }
      }
      // Declare this session a ready worker for its own project (never from input),
      // then block briefly on its own inbox: one call = "join and listen for my next
      // task". A caller loops this to stay a continuous listener — an MCP tool cannot
      // run a background loop itself. Both the status transition and the claim reuse
      // existing endpoints and act only on the bound session.
      const session = await client.setSessionStatus(current.id, 'idle');
      const inbox = await client.claimInbox(current.id, {
        bridgeInstanceId: 'gui-join',
        limit: 10,
        blockMs: 25_000,
        minIdleMs: 15_000,
      });
      return { session, ready: session.status === 'idle', inbox };
    },
    async getProjectState(input) {
      mcpGetProjectStateInputSchema.parse(input);
      const current = await requireCurrentBound();
      const [project, sessions] = await Promise.all([
        client.getProject(current.projectId),
        client.listProjectSessions(current.projectId),
      ]);
      return {
        project,
        sessions: sessions.sessions.slice(0, MCP_MAX_COLLECTION_ITEMS),
        sessionsTruncated: sessions.sessions.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async acquireLease(input) {
      const parsed = mcpAcquireLeaseInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.acquireLease({
        projectId: current.projectId,
        sessionId: current.id,
        path: parsed.path,
        reason: parsed.reason,
        durationMs: parsed.durationMs,
      });
    },
    async renewLease(input) {
      const parsed = mcpLeaseIdInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.renewLease(parsed.leaseId, current.id, parsed.durationMs);
    },
    async releaseLease(input) {
      const parsed = mcpReleaseLeaseInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.releaseLease(parsed.leaseId, current.id);
    },
    async listLeases(input) {
      const parsed = mcpListLeasesInputSchema.parse(input);
      const current = await requireCurrentBound();
      // Either scope stays inside the bound session's project; there is no
      // form of this tool that reads another project's leases.
      return client.listLeases(
        parsed.mine ? { sessionId: current.id } : { projectId: current.projectId },
        parsed.limit,
      );
    },
    async askAgent(input) {
      const parsed = mcpAskAgentInputSchema.parse(input);
      const current = await requireCurrentBound();
      const created = await client.askAgent(
        {
          sourceSessionId: current.id,
          ...(parsed.targetSessionId === undefined
            ? {}
            : { targetSessionId: parsed.targetSessionId }),
          ...(parsed.targetAgentId === undefined ? {} : { targetAgentId: parsed.targetAgentId }),
          kind: parsed.kind,
          ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
          content: parsed.content,
          evidenceRequirements: parsed.evidenceRequirements,
          timeoutMs: parsed.timeoutMs,
        },
        parsed.idempotencyKey,
      );
      if (parsed.waitMs === 0) {
        return {
          correlationId: created.message.correlationId,
          selectedTargetSessionId: created.selectedTargetSessionId,
          selectedTargetAgentId: created.selectedTargetAgentId,
          state: created.message.state,
          idempotent: created.idempotent,
        };
      }
      const latest = requireBoundMessage(
        await client.waitForMessage(created.message.correlationId, parsed.waitMs),
        current,
      );
      return {
        correlationId: latest.correlationId,
        selectedTargetSessionId: created.selectedTargetSessionId,
        selectedTargetAgentId: created.selectedTargetAgentId,
        state: latest.state,
        idempotent: created.idempotent,
        ...(latest.response === undefined ? {} : { response: latest.response }),
      };
    },
    async awaitResponse(input) {
      const parsed = mcpAwaitResponseInputSchema.parse(input);
      const current = await requireCurrentBound();
      return requireBoundMessage(
        await client.waitForMessage(parsed.correlationId, parsed.waitMs),
        current,
      );
    },
    async getMessage(input) {
      const parsed = mcpGetMessageInputSchema.parse(input);
      return getBoundMessage(parsed.correlationId);
    },
    async inboxNext(input) {
      const parsed = mcpInboxNextInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.claimInbox(current.id, parsed);
    },
    async acknowledgeMessage(input) {
      const parsed = mcpAcknowledgeMessageInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.transitionMessage('acknowledge', parsed.correlationId, current.id);
    },
    async markMessageProcessing(input) {
      const parsed = mcpMarkMessageProcessingInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.transitionMessage('processing', parsed.correlationId, current.id);
    },
    async respondToMessage(input) {
      const parsed = mcpRespondToMessageInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.transitionMessage('respond', parsed.correlationId, current.id, parsed.response);
    },
    async rejectMessage(input) {
      const parsed = mcpRejectMessageInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.transitionMessage('reject', parsed.correlationId, current.id, parsed.response);
    },
    async failMessage(input) {
      const parsed = mcpFailMessageInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.transitionMessage('fail', parsed.correlationId, current.id, parsed.response);
    },
    async listAgents(input) {
      mcpListAgentsInputSchema.parse(input);
      const { bindings } = await boundBindings();
      const boundIds = new Set(bindings.map(({ agentId }) => agentId));
      const matching = (await client.listAgents()).filter(({ id }) => boundIds.has(id));
      return {
        agents: matching.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated: matching.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async getAgent(input) {
      const { agentId } = mcpGetAgentInputSchema.parse(input);
      await requireBoundAgent(agentId);
      return client.getAgent(agentId);
    },
    async listProjectAgents(input) {
      mcpListProjectAgentsInputSchema.parse(input);
      const { bindings } = await boundBindings();
      return {
        bindings: bindings.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated: bindings.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async getEffectiveConfig(input) {
      const { agentId } = mcpGetEffectiveConfigInputSchema.parse(input);
      const { current } = await requireBoundAgent(agentId);
      return client.getEffectiveConfig(current.projectId, agentId);
    },
    async listCapabilities(input) {
      const parsed = mcpListCapabilitiesInputSchema.parse(input);
      const { current, bindings } = await boundBindings();
      let agentKind: string | undefined;
      if (parsed.agentId !== undefined) {
        if (!bindings.some(({ agentId }) => agentId === parsed.agentId)) {
          throw new McpDaemonError(
            'BOUND_PROJECT_MISMATCH',
            'The requested agent is not bound to the current LUWI project.',
            403,
          );
        }
        agentKind = (await client.getAgent(parsed.agentId)).kind;
      }
      const matching = (await client.listCapabilities()).filter(
        (capability) =>
          (capability.scope === 'global' || capability.projectId === current.projectId) &&
          (parsed.kind === undefined || capability.kind === parsed.kind) &&
          (parsed.enabled === undefined || capability.enabled === parsed.enabled) &&
          (agentKind === undefined ||
            capability.compatibleAgentKinds.length === 0 ||
            capability.compatibleAgentKinds.includes(
              agentKind as (typeof capability.compatibleAgentKinds)[number],
            )),
      );
      return {
        capabilities: matching.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated: matching.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async getCapability(input) {
      const { capabilityId } = mcpGetCapabilityInputSchema.parse(input);
      const current = await requireCurrentBound();
      const capability = await client.getCapability(capabilityId);
      if (capability.scope === 'project' && capability.projectId !== current.projectId) {
        throw new McpDaemonError(
          'BOUND_PROJECT_MISMATCH',
          'The requested capability is outside the bound LUWI project.',
          403,
        );
      }
      return capability;
    },
    async getContextFootprint(input) {
      const { agentId } = mcpGetContextFootprintInputSchema.parse(input);
      const { current } = await requireBoundAgent(agentId);
      return client.getContextFootprint(current.projectId, agentId);
    },
    async getConfigDrift(input) {
      const parsed = mcpGetConfigDriftInputSchema.parse(input);
      const { current, bindings } = await boundBindings();
      const boundAgentIds = new Set(bindings.map(({ agentId }) => agentId));
      const matching = (await client.listConfigDrift()).filter(
        (drift) =>
          (drift.projectId === current.projectId ||
            (drift.projectId === undefined && boundAgentIds.has(drift.agentId))) &&
          (parsed.agentId === undefined || drift.agentId === parsed.agentId),
      );
      return {
        drifts: matching.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated: matching.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async getUsageSummary(input) {
      const parsed = mcpGetUsageSummaryInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.getUsageSummary(
        current.projectId,
        parsed.sessionOnly ? current.id : undefined,
        parsed.from,
        parsed.to,
      );
    },
    async getContextIntelligence(input) {
      const parsed = mcpGetContextIntelligenceInputSchema.parse(input);
      const current = await requireCurrentBound();
      const agentId = parsed.agentId ?? current.agentId;
      if (agentId !== current.agentId) await requireBoundAgent(agentId, current);
      const result = await client.getContextIntelligence(current.projectId, agentId);
      return {
        summary: result.summary,
        contributions: result.contributions.slice(0, MCP_MAX_COLLECTION_ITEMS),
        findings: result.findings.slice(0, MCP_MAX_COLLECTION_ITEMS),
        contributionsTruncated: result.contributions.length > MCP_MAX_COLLECTION_ITEMS,
        findingsTruncated: result.findings.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async getGitStatus(input) {
      mcpGetGitStatusInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.getGitStatus(current.projectId);
    },
    async getRecentCommits(input) {
      const { limit } = mcpGetRecentCommitsInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.getRecentCommits(current.projectId, limit);
    },
    async getPackageInventory(input) {
      const { limit } = mcpGetPackageInventoryInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.getPackageInventory(current.projectId, limit);
    },
    async getTechnologyInventory(input) {
      const { limit } = mcpGetTechnologyInventoryInputSchema.parse(input);
      const current = await requireCurrentBound();
      return client.getTechnologyInventory(current.projectId, limit);
    },
    async getGraphNeighbors(input) {
      const parsed = mcpGetGraphNeighborsInputSchema.parse(input);
      const current = await requireCurrentBound();
      const result = await client.getGraphNeighbors(
        parsed.nodeKind,
        parsed.nodeId,
        parsed.direction,
        {
          projectId: current.projectId,
          ...(parsed.edgeKind === undefined ? {} : { edgeKind: parsed.edgeKind }),
          limit: parsed.limit,
        },
      );
      if (
        (result.node.projectId !== undefined && result.node.projectId !== current.projectId) ||
        result.nodes.some(
          (node) => node.projectId !== undefined && node.projectId !== current.projectId,
        )
      ) {
        throw new McpDaemonError(
          'BOUND_PROJECT_MISMATCH',
          'The graph result is outside the bound LUWI project.',
          403,
        );
      }
      return {
        ...result,
        edges: result.edges.slice(0, MCP_MAX_COLLECTION_ITEMS),
        nodes: result.nodes.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated:
          result.truncated ||
          result.edges.length > MCP_MAX_COLLECTION_ITEMS ||
          result.nodes.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async getGraphPath(input) {
      const parsed = mcpGetGraphPathInputSchema.parse(input);
      const current = await requireCurrentBound();
      const result = await client.getGraphPath(parsed.fromKind, parsed.fromId, {
        toKind: parsed.toKind,
        toId: parsed.toId,
        projectId: current.projectId,
        ...(parsed.edgeKind === undefined ? {} : { edgeKind: parsed.edgeKind }),
        maxDepth: parsed.maxDepth,
      });
      if (
        result.nodes.some(
          (node) => node.projectId !== undefined && node.projectId !== current.projectId,
        )
      ) {
        throw new McpDaemonError(
          'BOUND_PROJECT_MISMATCH',
          'The graph path is outside the bound LUWI project.',
          403,
        );
      }
      return {
        found: result.found,
        nodes: result.nodes.slice(0, MCP_MAX_COLLECTION_ITEMS),
        edges: result.edges.slice(0, MCP_MAX_COLLECTION_ITEMS),
        truncated:
          result.nodes.length > MCP_MAX_COLLECTION_ITEMS ||
          result.edges.length > MCP_MAX_COLLECTION_ITEMS,
      };
    },
    async listOptimizationFindings(input) {
      const { limit } = mcpListOptimizationFindingsInputSchema.parse(input);
      const current = await requireCurrentBound();
      const result = await client.listOptimizationFindings(current.projectId, limit);
      return {
        findings: result.findings.slice(0, limit),
        truncated: result.truncated || result.findings.length > limit,
      };
    },
    async getOptimizationProposal(input) {
      const { proposalId } = mcpGetOptimizationProposalInputSchema.parse(input);
      const current = await requireCurrentBound();
      const proposal = await client.getOptimizationProposal(proposalId);
      if (proposal.projectId !== current.projectId) {
        throw new McpDaemonError(
          'BOUND_PROJECT_MISMATCH',
          'The optimization proposal is outside the bound LUWI project.',
          403,
        );
      }
      return proposal;
    },
    async requestOptimizationAnalysis(input) {
      const parsed = mcpRequestOptimizationAnalysisInputSchema.parse(input);
      const current = await requireCurrentBound();
      const agentId = parsed.agentId ?? current.agentId;
      if (agentId !== current.agentId) await requireBoundAgent(agentId, current);
      return client.requestOptimizationAnalysis({
        projectId: current.projectId,
        agentId,
        ...(parsed.minimumSessions === undefined
          ? {}
          : { minimumSessions: parsed.minimumSessions }),
      });
    },
  };
}
