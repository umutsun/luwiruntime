import {
  autopilotStatusResponseSchema,
  goalCollectionSchema,
  goalSchema,
  taskCollectionSchema,
  taskSchema,
  leaseAcquireResponseSchema,
  leaseCollectionSchema,
  workLeaseSchema,
  type LeaseAcquireResponse,
  type LeaseCollection,
  type WorkLease,
  agentDefinitionCollectionSchema,
  agentDefinitionSchema,
  capabilityCollectionSchema,
  capabilityPackageSchema,
  configDriftCollectionSchema,
  contextFootprintSchema,
  effectiveAgentConfigurationSchema,
  contextIntelligenceSchema,
  gitCommitCollectionSchema,
  gitObservationSchema,
  graphNeighborsResponseSchema,
  graphPathResponseSchema,
  heartbeatResponseSchema,
  inboxClaimResponseSchema,
  messageCreateResponseSchema,
  messageResponseSchema,
  projectCollectionResponseSchema,
  projectAgentBindingCollectionSchema,
  projectResponseSchema,
  optimizationAnalysisResponseSchema,
  optimizationFindingCollectionSchema,
  optimizationProposalSchema,
  packageCollectionSchema,
  publicErrorResponseSchema,
  sessionCollectionResponseSchema,
  sessionNativeRefResponseSchema,
  sessionResponseSchema,
  technologyCollectionSchema,
  usageSummarySchema,
  type AgentMessage,
  type AutopilotStatusResponse,
  type Goal,
  type GoalBudget,
  type GoalCollection,
  type GoalState,
  type Task,
  type TaskCollection,
  type TaskState,
  type AgentDefinition,
  type AgentMessageResponse,
  type InboxClaimRequest,
  type InboxClaimResponse,
  type CapabilityPackage,
  type ConfigDrift,
  type ContextFootprint,
  type EffectiveAgentConfiguration,
  type ContextIntelligence,
  type GitCommit,
  type GitObservation,
  type GraphNeighborsQuery,
  type GraphNeighborsResponse,
  type GraphNodeKind,
  type GraphPathQuery,
  type GraphPathResponse,
  type OptimizationAnalysisResponse,
  type OptimizationFinding,
  type OptimizationProposal,
  type PackageRecord,
  type MessageCreateRequest,
  type MessageCreateResponse,
  type Project,
  type NativeSessionRef,
  type SessionStatus,
  type ProjectAgentBinding,
  type ProjectCollectionResponse,
  type SessionCollectionResponse,
  type SessionView,
  type TechnologyRecord,
  type UsageSummary,
} from '@luwi/protocol';

export type McpFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type McpHttpResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type McpFetch = (url: string, init?: McpFetchInit) => Promise<McpHttpResponse>;

type Parser<Output> = {
  parse(value: unknown): Output;
};

export class McpDaemonError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'McpDaemonError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type McpDaemonClient = {
  verifyBoundSession(sessionId: string): Promise<SessionView>;
  listProjects(): Promise<ProjectCollectionResponse>;
  listProjectSessions(projectId: string): Promise<SessionCollectionResponse>;
  getSession(sessionId: string): Promise<SessionView>;
  /** The native reference a session's binding holds, or undefined when none. */
  getSessionNative(sessionId: string): Promise<NativeSessionRef | undefined>;
  getProject(projectId: string): Promise<Project>;
  listAgents(): Promise<AgentDefinition[]>;
  getAgent(agentId: string): Promise<AgentDefinition>;
  listProjectAgents(projectId: string): Promise<ProjectAgentBinding[]>;
  getEffectiveConfig(projectId: string, agentId: string): Promise<EffectiveAgentConfiguration>;
  listCapabilities(): Promise<CapabilityPackage[]>;
  getCapability(capabilityId: string): Promise<CapabilityPackage>;
  getContextFootprint(projectId: string, agentId: string): Promise<ContextFootprint>;
  listConfigDrift(): Promise<ConfigDrift[]>;
  getUsageSummary(
    projectId: string,
    sessionId: string | undefined,
    from?: string,
    to?: string,
  ): Promise<UsageSummary>;
  getContextIntelligence(projectId: string, agentId: string): Promise<ContextIntelligence>;
  getGitStatus(projectId: string): Promise<GitObservation>;
  getRecentCommits(
    projectId: string,
    limit: number,
  ): Promise<{ commits: GitCommit[]; truncated: boolean }>;
  getPackageInventory(
    projectId: string,
    limit: number,
  ): Promise<{ packages: PackageRecord[]; truncated: boolean }>;
  getTechnologyInventory(
    projectId: string,
    limit: number,
  ): Promise<{ technologies: TechnologyRecord[]; truncated: boolean }>;
  getGraphNeighbors(
    kind: GraphNodeKind,
    nodeId: string,
    direction: 'out' | 'in',
    query: Pick<GraphNeighborsQuery, 'projectId' | 'edgeKind' | 'limit'>,
  ): Promise<GraphNeighborsResponse>;
  getGraphPath(
    kind: GraphNodeKind,
    nodeId: string,
    query: GraphPathQuery,
  ): Promise<GraphPathResponse>;
  listOptimizationFindings(
    projectId: string,
    limit: number,
  ): Promise<{ findings: OptimizationFinding[]; truncated: boolean }>;
  getOptimizationProposal(proposalId: string): Promise<OptimizationProposal>;
  requestOptimizationAnalysis(input: {
    projectId: string;
    agentId?: string;
    minimumSessions?: number;
  }): Promise<OptimizationAnalysisResponse>;
  acquireLease(request: {
    projectId: string;
    sessionId: string;
    path: string;
    reason: string;
    durationMs: number;
  }): Promise<LeaseAcquireResponse>;
  renewLease(leaseId: string, sessionId: string, durationMs: number): Promise<WorkLease>;
  releaseLease(leaseId: string, sessionId: string): Promise<WorkLease>;
  /** Autopilot, goals and tasks (ADR 0035); every call names the bound session as the actor. */
  getAutopilot(projectId: string): Promise<AutopilotStatusResponse>;
  listGoals(
    projectId: string,
    state: GoalState | undefined,
    limit: number,
  ): Promise<GoalCollection>;
  getGoal(goalId: string): Promise<Goal>;
  createGoal(
    projectId: string,
    body: {
      title: string;
      objective: string;
      acceptanceCriteria: string[];
      sessionId: string;
      budget?: Partial<{ [Key in keyof GoalBudget]: GoalBudget[Key] | undefined }>;
    },
  ): Promise<Goal>;
  approvePlan(goalId: string, sessionId: string, note?: string): Promise<Goal>;
  rejectPlan(goalId: string, sessionId: string, note?: string): Promise<Goal>;
  answerGoal(goalId: string, sessionId: string, text: string): Promise<Goal>;
  abandonGoal(goalId: string, sessionId: string, reason?: string): Promise<Goal>;
  listTasks(
    projectId: string,
    query: { goalId?: string; state?: TaskState; limit: number },
  ): Promise<TaskCollection>;
  getTask(taskId: string): Promise<Task>;
  listLeases(
    scope: { projectId?: string; sessionId?: string },
    limit: number,
  ): Promise<LeaseCollection>;
  askAgent(request: MessageCreateRequest, idempotencyKey?: string): Promise<MessageCreateResponse>;
  getMessage(correlationId: string): Promise<AgentMessage>;
  waitForMessage(correlationId: string, waitMs: number): Promise<AgentMessage>;
  claimInbox(sessionId: string, request: InboxClaimRequest): Promise<InboxClaimResponse>;
  transitionMessage(
    action: 'acknowledge' | 'processing' | 'respond' | 'reject' | 'fail',
    correlationId: string,
    responderSessionId: string,
    response?: AgentMessageResponse,
  ): Promise<AgentMessage>;
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<SessionView>;
  /**
   * The presence surface a reader needs to own a session itself (ADR 0034):
   * register a successor for a dropped attach session, keep it alive, close it.
   */
  registerSession(request: SessionRevivalRegistration): Promise<SessionView>;
  heartbeat(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<SessionView>;
};

/** What a revived registration carries: copied from the dropped session's own record. */
export type SessionRevivalRegistration = {
  projectId: string;
  agentId: string;
  workingDirectory: string;
  native?: NativeSessionRef;
  metadata?: Record<string, unknown>;
};

function endpoint(base: string, path: string): string {
  return new URL(path, `${base.replace(/\/+$/, '')}/`).toString();
}

export function createDaemonClient(options: {
  daemonUrl: string;
  requestTimeoutMs: number;
  fetch?: McpFetch;
}): McpDaemonClient {
  const fetchImplementation: McpFetch =
    options.fetch ?? ((url, init) => fetch(url, init as RequestInit) as Promise<McpHttpResponse>);

  const request = async <Output>(
    path: string,
    parser: Parser<Output>,
    init?: Omit<McpFetchInit, 'signal'>,
    timeoutMs = options.requestTimeoutMs,
  ): Promise<Output> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(endpoint(options.daemonUrl, path), {
        ...init,
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) {
        const safe = publicErrorResponseSchema.safeParse(body);
        if (safe.success) {
          throw new McpDaemonError(safe.data.error.code, safe.data.error.message, response.status);
        }
        throw new McpDaemonError(
          'DAEMON_REQUEST_FAILED',
          `LUWI daemon request failed with status ${response.status}.`,
          response.status,
        );
      }
      return parser.parse(body);
    } catch (error) {
      if (error instanceof McpDaemonError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new McpDaemonError(
          'DAEMON_REQUEST_TIMEOUT',
          'The LUWI daemon request timed out.',
          504,
        );
      }
      throw new McpDaemonError('DAEMON_UNAVAILABLE', 'The LUWI daemon is unavailable.', 503);
    } finally {
      clearTimeout(timer);
    }
  };

  const post = <Output>(
    path: string,
    parser: Parser<Output>,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Output> =>
    request(path, parser, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const getSession = (sessionId: string): Promise<SessionView> =>
    request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, sessionResponseSchema);

  return {
    async verifyBoundSession(sessionId) {
      const session = await getSession(sessionId);
      if (session.status === 'completed' || session.status === 'disconnected') {
        throw new McpDaemonError(
          'BOUND_SESSION_TERMINAL',
          'The bound LUWI session is terminal.',
          409,
        );
      }
      if (session.presence !== 'online') {
        throw new McpDaemonError(
          'BOUND_SESSION_OFFLINE',
          'The bound LUWI session is offline.',
          409,
        );
      }
      return session;
    },
    listProjects: () => request('/api/v1/projects', projectCollectionResponseSchema),
    listProjectSessions: (projectId) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/sessions`,
        sessionCollectionResponseSchema,
      ),
    getSession,
    getSessionNative: async (sessionId) =>
      (
        await request(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/native`,
          sessionNativeRefResponseSchema,
        )
      ).native ?? undefined,
    setSessionStatus: (sessionId, status) =>
      post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, sessionResponseSchema, {
        status,
      }),
    registerSession: (request) => post('/api/v1/sessions', sessionResponseSchema, request),
    heartbeat: async (sessionId) => {
      await post(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        heartbeatResponseSchema,
        {},
      );
    },
    closeSession: (sessionId) =>
      post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, sessionResponseSchema, {}),
    getProject: (projectId) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}`, projectResponseSchema),
    listAgents: async () =>
      (await request('/api/v1/agents', agentDefinitionCollectionSchema)).agents,
    getAgent: (agentId) =>
      request(`/api/v1/agents/${encodeURIComponent(agentId)}`, agentDefinitionSchema),
    listProjectAgents: async (projectId) =>
      (
        await request(
          `/api/v1/projects/${encodeURIComponent(projectId)}/agents`,
          projectAgentBindingCollectionSchema,
        )
      ).bindings,
    getEffectiveConfig: (projectId, agentId) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/effective-config`,
        effectiveAgentConfigurationSchema,
      ),
    listCapabilities: async () =>
      (await request('/api/v1/capabilities', capabilityCollectionSchema)).capabilities,
    getCapability: (capabilityId) =>
      request(`/api/v1/capabilities/${encodeURIComponent(capabilityId)}`, capabilityPackageSchema),
    getContextFootprint: (projectId, agentId) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/context-footprint`,
        contextFootprintSchema,
      ),
    listConfigDrift: async () =>
      (await request('/api/v1/config/drift', configDriftCollectionSchema)).drifts,
    getUsageSummary: (projectId, sessionId, from, to) => {
      const query = new URLSearchParams({
        projectId,
        limit: '1000',
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
      return request(`/api/v1/usage/summary?${query.toString()}`, usageSummarySchema);
    },
    getContextIntelligence: (projectId, agentId) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/context-intelligence`,
        contextIntelligenceSchema,
      ),
    getGitStatus: (projectId) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/git`, gitObservationSchema),
    getRecentCommits: (projectId, limit) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/git/commits?limit=${encodeURIComponent(String(limit))}`,
        gitCommitCollectionSchema,
      ),
    getPackageInventory: (projectId, limit) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/packages?limit=${encodeURIComponent(String(limit))}`,
        packageCollectionSchema,
      ),
    getTechnologyInventory: (projectId, limit) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/technologies?limit=${encodeURIComponent(String(limit))}`,
        technologyCollectionSchema,
      ),
    getGraphNeighbors: (kind, nodeId, direction, query) => {
      const parameters = new URLSearchParams({
        projectId: query.projectId ?? '',
        limit: String(query.limit),
        ...(query.edgeKind === undefined ? {} : { edgeKind: query.edgeKind }),
      });
      parameters.delete('projectId');
      if (query.projectId !== undefined) parameters.set('projectId', query.projectId);
      return request(
        `/api/v1/graph/nodes/${encodeURIComponent(kind)}/${encodeURIComponent(nodeId)}/${direction}?${parameters.toString()}`,
        graphNeighborsResponseSchema,
      );
    },
    getGraphPath: (kind, nodeId, query) => {
      const parameters = new URLSearchParams({
        fromKind: kind,
        fromId: nodeId,
        toKind: query.toKind,
        toId: query.toId,
        maxDepth: String(query.maxDepth),
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.edgeKind === undefined ? {} : { edgeKind: query.edgeKind }),
      });
      return request(`/api/v1/graph/path?${parameters.toString()}`, graphPathResponseSchema);
    },
    listOptimizationFindings: (projectId, limit) =>
      request(
        `/api/v1/optimization/findings?projectId=${encodeURIComponent(projectId)}&limit=${encodeURIComponent(String(limit))}`,
        optimizationFindingCollectionSchema,
      ),
    getOptimizationProposal: (proposalId) =>
      request(
        `/api/v1/optimization/proposals/${encodeURIComponent(proposalId)}`,
        optimizationProposalSchema,
      ),
    requestOptimizationAnalysis: (body) =>
      post('/api/v1/optimization/analyze', optimizationAnalysisResponseSchema, body),
    acquireLease: (body) => post('/api/v1/leases', leaseAcquireResponseSchema, body),
    renewLease: (leaseId, sessionId, durationMs) =>
      post(`/api/v1/leases/${encodeURIComponent(leaseId)}/renew`, workLeaseSchema, {
        sessionId,
        durationMs,
      }),
    releaseLease: (leaseId, sessionId) =>
      post(`/api/v1/leases/${encodeURIComponent(leaseId)}/release`, workLeaseSchema, {
        sessionId,
      }),
    getAutopilot: (projectId) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/autopilot`,
        autopilotStatusResponseSchema,
      ),
    listGoals: (projectId, state, limit) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (state !== undefined) query.set('state', state);
      return request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/goals?${query.toString()}`,
        goalCollectionSchema,
      );
    },
    getGoal: (goalId) => request(`/api/v1/goals/${encodeURIComponent(goalId)}`, goalSchema),
    createGoal: (projectId, body) =>
      post(`/api/v1/projects/${encodeURIComponent(projectId)}/goals`, goalSchema, body),
    approvePlan: (goalId, sessionId, note) =>
      post(`/api/v1/goals/${encodeURIComponent(goalId)}/plan/approve`, goalSchema, {
        sessionId,
        ...(note === undefined ? {} : { note }),
      }),
    rejectPlan: (goalId, sessionId, note) =>
      post(`/api/v1/goals/${encodeURIComponent(goalId)}/plan/reject`, goalSchema, {
        sessionId,
        ...(note === undefined ? {} : { note }),
      }),
    answerGoal: (goalId, sessionId, text) =>
      post(`/api/v1/goals/${encodeURIComponent(goalId)}/answer`, goalSchema, { sessionId, text }),
    abandonGoal: (goalId, sessionId, reason) =>
      post(`/api/v1/goals/${encodeURIComponent(goalId)}/abandon`, goalSchema, {
        sessionId,
        ...(reason === undefined ? {} : { reason }),
      }),
    listTasks: (projectId, query) => {
      const parameters = new URLSearchParams({ limit: String(query.limit) });
      if (query.goalId !== undefined) parameters.set('goalId', query.goalId);
      if (query.state !== undefined) parameters.set('state', query.state);
      return request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/tasks?${parameters.toString()}`,
        taskCollectionSchema,
      );
    },
    getTask: (taskId) => request(`/api/v1/tasks/${encodeURIComponent(taskId)}`, taskSchema),
    listLeases: (scope, limit) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (scope.sessionId !== undefined) query.set('sessionId', scope.sessionId);
      else if (scope.projectId !== undefined) query.set('projectId', scope.projectId);
      return request(`/api/v1/leases?${query.toString()}`, leaseCollectionSchema);
    },
    askAgent: (body, idempotencyKey) =>
      post(
        '/api/v1/messages',
        messageCreateResponseSchema,
        body,
        idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey },
      ),
    getMessage: (correlationId) =>
      request(`/api/v1/messages/${encodeURIComponent(correlationId)}`, messageResponseSchema),
    waitForMessage: (correlationId, waitMs) =>
      request(
        `/api/v1/messages/${encodeURIComponent(correlationId)}/wait?waitMs=${encodeURIComponent(String(waitMs))}`,
        messageResponseSchema,
        undefined,
        Math.max(options.requestTimeoutMs, waitMs + 1_000),
      ),
    claimInbox: (sessionId, body) =>
      post(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/inbox/claim`,
        inboxClaimResponseSchema,
        body,
      ),
    transitionMessage: (action, correlationId, responderSessionId, response) =>
      post(
        `/api/v1/messages/${encodeURIComponent(correlationId)}/${action}`,
        messageResponseSchema,
        {
          responderSessionId,
          ...(response === undefined ? {} : { response }),
        },
      ),
  };
}
