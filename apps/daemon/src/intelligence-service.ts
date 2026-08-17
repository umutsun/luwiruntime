import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalJsonStringify,
  contextContributionSchema,
  contextLoadingModeSchema,
  createRuntimeEvent,
  graphRebuildOperationSchema,
  optimizationProposalSchema,
  usageSummarySchema,
  type AttributionRecord,
  type CanonicalJsonValue,
  type ContextContribution,
  type ContextContributionObservationRequest,
  type ContextSummary,
  type GitCommit,
  type GitObservation,
  type GitWorktree,
  type GraphEdge,
  type GraphNeighborsQuery,
  type GraphNeighborsResponse,
  type GraphNode,
  type GraphNodeKind,
  type GraphPathQuery,
  type GraphPathResponse,
  type GraphRebuildOperation,
  type GraphSubgraphQuery,
  type GraphSubgraphResponse,
  type GraphSummary,
  type OptimizationAnalysisRequest,
  type OptimizationEvaluation,
  type OptimizationFinding,
  type OptimizationProposal,
  type PackageRecord,
  type RuntimeEvent,
  type RealtimeEventMessage,
  type TechnologyRecord,
  type UsageIngestRequest,
  type UsageListQuery,
  type UsageRecord,
  type UsageSummary,
} from '@luwi/protocol';
import type { IntelligenceRepository, UsageListResult } from '@luwi/redis';
import {
  ApplicationError,
  analyzeStructuralContext,
  attributeGitObservation,
  contextContributionFromStaticSource,
  createFileIdentity,
  createGraphEdge,
  createGraphNode,
  createOptimizationProposals,
  evaluateOptimization,
  mapFileToModule,
  normalizeUsageRecord,
  summarizeContextContributions,
  summarizeUsageRecords,
  transitionOptimizationProposal,
  type ModuleRoot,
} from '@luwi/runtime';

import type { ConfigControlService } from './config-control-service.js';
import type { ControlPlaneService } from './control-plane-service.js';
import {
  CODE_STRUCTURE_PROVENANCE,
  createCodeStructureObserver,
  moduleDependencyPairs,
  type CodeStructureObservation,
  type CodeStructureObserver,
} from './code-structure-observer.js';
import { createGitObserver, GitObservationError, type GitObserver } from './git-observer.js';
import {
  createPackageInventoryScanner,
  PackageInventoryError,
  type PackageInventoryScanner,
} from './package-inventory.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const DEFAULT_MINIMUM_BASELINE_SESSIONS = 3;
const DEFAULT_MINIMUM_POST_SESSIONS = 3;
const DEFAULT_MINIMUM_OBSERVATION_HOURS = 24;
const DEFAULT_MAX_FINDINGS = 100;
const DEFAULT_MAX_PROPOSALS = 25;
const DEFAULT_OVERSIZED_CONTEXT_TOKENS = 8_000;
const GRAPH_REBUILD_MAX_INPUTS = 100_000;

export type IntelligenceServiceOptions = {
  repository: IntelligenceRepository;
  projects: ProjectService;
  sessions: SessionService;
  controlPlane: ControlPlaneService;
  configControl: ConfigControlService;
  workspaceId: string;
  gitObserver?: GitObserver;
  packageScanner?: PackageInventoryScanner;
  codeStructureObserver?: CodeStructureObserver;
  createId?: () => string;
  now?: () => Date;
  optimizationMinimumBaselineSessions?: number;
  optimizationMinimumPostSessions?: number;
  optimizationMinimumObservationHours?: number;
  optimizationMaximumFindings?: number;
  optimizationMaximumProposals?: number;
  oversizedContextTokens?: number;
  readRebuildEvents?: () => Promise<RealtimeEventMessage[]>;
  /**
   * Runs the operational-graph reprojection that follows a mutation.
   *
   * The reprojection rescans the project's TypeScript and rewrites the active
   * generation, which is minutes of work on a real repository — far too much to
   * hold an HTTP response open for. It is also best-effort by construction: it
   * swallows every failure into a projection-failure record and returns
   * nothing, so a caller that awaits it learns nothing it could act on.
   *
   * The daemon passes its background-work tracker here, so the projection is
   * still tracked, still logged, and still drained at shutdown. The default
   * runs inline, which keeps every existing test deterministic.
   */
  deferProjection?: (run: () => Promise<void>) => void;
};

export type ContextIntelligence = {
  summary: ContextSummary;
  contributions: ContextContribution[];
  findings: OptimizationFinding[];
};

export interface IntelligenceService {
  ingestUsage(input: UsageIngestRequest): Promise<UsageRecord>;
  listUsage(query: UsageListQuery): Promise<UsageListResult>;
  summarizeUsage(query: UsageListQuery): Promise<UsageSummary>;
  listContextContributions(filters?: {
    projectId?: string;
    agentId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<ContextContribution[]>;
  observeContextContribution(
    input: ContextContributionObservationRequest,
  ): Promise<ContextContribution>;
  contextSummary(projectId: string, agentId: string): Promise<ContextSummary>;
  analyzeContext(projectId: string, agentId: string): Promise<ContextIntelligence>;
  getContextIntelligence(projectId: string, agentId: string): Promise<ContextIntelligence>;
  scanGit(projectId: string): Promise<GitObservation>;
  getGit(projectId: string): Promise<GitObservation>;
  listGitCommits(projectId: string, limit?: number): Promise<GitCommit[]>;
  listGitWorktrees(projectId: string): Promise<GitWorktree[]>;
  listAttributions(projectId: string, limit?: number): Promise<AttributionRecord[]>;
  scanPackages(projectId: string): Promise<{
    packages: PackageRecord[];
    technologies: TechnologyRecord[];
    scannedAt: string;
    truncated: boolean;
    evidenceScope: 'git-tracked' | 'filesystem';
  }>;
  listPackages(projectId: string, limit?: number): Promise<PackageRecord[]>;
  listTechnologies(projectId: string, limit?: number): Promise<TechnologyRecord[]>;
  getGraphNode(kind: GraphNodeKind, id: string): Promise<GraphNode>;
  graphNeighbors(
    kind: GraphNodeKind,
    id: string,
    direction: 'out' | 'in',
    query: GraphNeighborsQuery,
  ): Promise<GraphNeighborsResponse>;
  graphPath(kind: GraphNodeKind, id: string, query: GraphPathQuery): Promise<GraphPathResponse>;
  graphSubgraph(query: GraphSubgraphQuery): Promise<GraphSubgraphResponse>;
  graphSummary(): Promise<GraphSummary>;
  rebuildGraph(): Promise<GraphRebuildOperation>;
  getGraphRebuild(operationId: string): Promise<GraphRebuildOperation>;
  analyzeOptimization(input: OptimizationAnalysisRequest): Promise<{
    findings: OptimizationFinding[];
    proposals: OptimizationProposal[];
    analyzedAt: string;
  }>;
  listFindings(projectId?: string, limit?: number): Promise<OptimizationFinding[]>;
  listProposals(projectId?: string, limit?: number): Promise<OptimizationProposal[]>;
  getProposal(proposalId: string): Promise<OptimizationProposal>;
  acceptProposal(proposalId: string): Promise<OptimizationProposal>;
  rejectProposal(proposalId: string): Promise<OptimizationProposal>;
  createConfigPlan(
    proposalId: string,
    actionIndex: number,
  ): Promise<{
    proposal: OptimizationProposal;
    plan: Awaited<ReturnType<ConfigControlService['getPlan']>>;
  }>;
  recordConfigPlanApplied(configPlanId: string): Promise<void>;
  evaluateProposal(
    proposalId: string,
    options?: { minimumPostSessions?: number; minimumObservationHours?: number },
  ): Promise<OptimizationEvaluation>;
  getEvaluation(evaluationId: string): Promise<OptimizationEvaluation>;
}

function moduleId(projectId: string, path: string): string {
  return `module-${createHash('sha256').update(`${projectId}\0${path}`).digest('hex').slice(0, 32)}`;
}

function scopedGraphEntityId(projectId: string, entityId: string): string {
  return `scoped-${createHash('sha256')
    .update(`${projectId}\0${entityId}`)
    .digest('hex')
    .slice(0, 40)}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function structuralHash(value: unknown): string {
  const json = JSON.parse(JSON.stringify(value)) as CanonicalJsonValue;
  return createHash('sha256').update(canonicalJsonStringify(json)).digest('hex');
}

export function createIntelligenceService(
  options: IntelligenceServiceOptions,
): IntelligenceService {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const gitObserver = options.gitObserver ?? createGitObserver();
  const packageScanner = options.packageScanner ?? createPackageInventoryScanner();
  const codeStructureObserver = options.codeStructureObserver ?? createCodeStructureObserver();
  /**
   * Structure is scanned during rebuild rather than persisted as its own record
   * type: it derives from canonical filesystem state, so it is rebuildable at
   * any time and needs no second source of truth. A project whose path is gone
   * simply contributes no structural layer.
   */
  const observeCodeStructure = async (
    localPath: string,
  ): Promise<CodeStructureObservation | null> => {
    try {
      return await codeStructureObserver.scan({ localPath });
    } catch {
      return null;
    }
  };
  const minimumBaselineSessions =
    options.optimizationMinimumBaselineSessions ?? DEFAULT_MINIMUM_BASELINE_SESSIONS;
  const minimumPostSessions =
    options.optimizationMinimumPostSessions ?? DEFAULT_MINIMUM_POST_SESSIONS;
  const minimumObservationHours =
    options.optimizationMinimumObservationHours ?? DEFAULT_MINIMUM_OBSERVATION_HOURS;
  const maximumFindings = options.optimizationMaximumFindings ?? DEFAULT_MAX_FINDINGS;
  const maximumProposals = options.optimizationMaximumProposals ?? DEFAULT_MAX_PROPOSALS;
  const oversizedContextTokens = options.oversizedContextTokens ?? DEFAULT_OVERSIZED_CONTEXT_TOKENS;
  const completeGraphInputs = <Value>(values: Value[], description: string): Value[] => {
    if (values.length > GRAPH_REBUILD_MAX_INPUTS) {
      throw new ApplicationError(
        'GRAPH_REBUILD_FAILED',
        `The ${description} input exceeds the bounded graph rebuild limit.`,
        409,
      );
    }
    return values;
  };

  const event = (
    type: RuntimeEvent['type'],
    scope: { projectId?: string; agentId?: string; sessionId?: string },
    payload: Record<string, unknown>,
  ): RuntimeEvent =>
    createRuntimeEvent(
      {
        type,
        workspaceId: options.workspaceId,
        ...scope,
        payload,
      },
      { createId, now },
    );

  const requireProject = async (projectId: string) => {
    const project = await options.projects.get(projectId);
    if (project === null) {
      throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
    }
    return project;
  };

  const requireProposal = async (proposalId: string): Promise<OptimizationProposal> => {
    const proposal = await options.repository.getOptimizationProposal(proposalId);
    if (proposal === null) {
      throw new ApplicationError(
        'OPTIMIZATION_PROPOSAL_NOT_FOUND',
        'The optimization proposal was not found.',
        404,
      );
    }
    return proposal;
  };

  const contextSources = async (projectId: string, agentId: string) =>
    (await options.controlPlane.listContextSources()).filter(
      (source) =>
        (source.projectId === undefined || source.projectId === projectId) &&
        (source.agentId === undefined || source.agentId === agentId),
    );

  const effectiveContext = async (projectId: string, agentId: string) => {
    const [sources, effective, sessions] = await Promise.all([
      contextSources(projectId, agentId),
      options.controlPlane.getEffectiveConfiguration(projectId, agentId),
      options.sessions.list(projectId),
    ]);
    const matchingSessions = sessions.filter((session) => session.agentId === agentId);
    const loadingModesValue = effective.settings['contextLoadingModes'];
    const loadingModes =
      typeof loadingModesValue === 'object' &&
      loadingModesValue !== null &&
      !Array.isArray(loadingModesValue)
        ? (loadingModesValue as Record<string, unknown>)
        : {};
    const targets = matchingSessions.length === 0 ? [undefined] : matchingSessions;
    const contributions: ContextContribution[] = [];
    for (const source of sources) {
      for (const session of targets) {
        const base = contextContributionFromStaticSource(source, {
          projectId,
          agentId,
          ...(session === undefined ? {} : { sessionId: session.id }),
          assigned: true,
          effective: true,
        });
        const override = contextLoadingModeSchema.safeParse(loadingModes[source.id]);
        contributions.push(
          contextContributionSchema.parse({
            ...base,
            ...(override.success ? { loadingMode: override.data } : {}),
            observedAt: now().toISOString(),
          }),
        );
      }
    }
    return { sources, effective, contributions };
  };

  const projectGraphSnapshot = async (
    retainedEvents: readonly RealtimeEventMessage[] = [],
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> => {
    const nodeMap = new Map<string, GraphNode>();
    const edgeMap = new Map<string, GraphEdge>();
    const addNode = (node: GraphNode): void => {
      nodeMap.set(`${node.kind}\0${node.entityId}`, node);
    };
    const addEdge = (edge: GraphEdge): void => {
      edgeMap.set(edge.id, edge);
    };
    const observedAt = now().toISOString();
    addNode(
      createGraphNode({
        kind: 'developer',
        entityId: 'local-developer',
        observedAt,
        provenance: 'single-user-local-runtime',
        confidence: 'high',
        evidenceIds: ['local-runtime'],
        metadata: { scope: 'single-user-local' },
      }),
    );
    const projects = completeGraphInputs(await options.projects.list(), 'project');
    const agents = completeGraphInputs(await options.controlPlane.listAgents(), 'agent');
    for (const agent of agents) {
      addNode(
        createGraphNode({
          kind: 'agent',
          entityId: agent.id,
          observedAt,
          provenance: 'agent-definition-projection',
          confidence: 'high',
          evidenceIds: [agent.id],
          metadata: { kind: agent.kind, enabled: agent.enabled },
        }),
      );
      addNode(
        createGraphNode({
          kind: 'agent-definition',
          entityId: agent.id,
          observedAt,
          provenance: 'canonical-agent-manifest',
          confidence: 'high',
          evidenceIds: [agent.id],
          metadata: { kind: agent.kind },
        }),
      );
    }
    const capabilities = completeGraphInputs(
      await options.controlPlane.listCapabilities({ limit: GRAPH_REBUILD_MAX_INPUTS + 1 }),
      'capability',
    );
    const capabilityNodeKinds = new Map<string, GraphNodeKind>();
    for (const capability of capabilities) {
      const nodeKind =
        capability.kind === 'instruction' || capability.kind === 'profile'
          ? 'capability'
          : capability.kind;
      capabilityNodeKinds.set(capability.id, nodeKind);
      addNode(
        createGraphNode({
          kind: nodeKind,
          entityId: capability.id,
          ...(capability.projectId === undefined ? {} : { projectId: capability.projectId }),
          observedAt,
          provenance: 'canonical-capability-manifest',
          confidence: 'high',
          evidenceIds: [capability.id, capability.checksum],
          metadata: { name: capability.name, kind: capability.kind },
        }),
      );
      for (const required of capability.requiredCapabilityIds) {
        addEdge(
          createGraphEdge({
            source: { kind: nodeKind, id: capability.id },
            target: { kind: 'capability', id: required },
            kind: 'CAPABILITY_REQUIRES_CAPABILITY',
            ...(capability.projectId === undefined ? {} : { projectId: capability.projectId }),
            observedAt,
            provenance: 'canonical-capability-manifest',
            confidence: 'high',
            evidenceIds: [capability.id],
          }),
        );
      }
      for (const required of capability.requiredMcpIds) {
        addEdge(
          createGraphEdge({
            source: { kind: nodeKind, id: capability.id },
            target: { kind: 'mcp', id: required },
            kind: 'CAPABILITY_REQUIRES_MCP',
            ...(capability.projectId === undefined ? {} : { projectId: capability.projectId }),
            observedAt,
            provenance: 'canonical-capability-manifest',
            confidence: 'high',
            evidenceIds: [capability.id],
          }),
        );
      }
    }

    for (const project of projects) {
      addNode(
        createGraphNode({
          kind: 'project',
          entityId: project.id,
          projectId: project.id,
          observedAt,
          provenance: 'project-projection',
          confidence: 'high',
          evidenceIds: [project.id],
          metadata: { name: project.name },
        }),
      );
      const repositoryId = `repository-${project.id}`;
      addNode(
        createGraphNode({
          kind: 'repository',
          entityId: repositoryId,
          projectId: project.id,
          observedAt,
          provenance: 'project-canonical-path',
          confidence: 'high',
          evidenceIds: [project.id],
          metadata: {},
        }),
      );
      addEdge(
        createGraphEdge({
          source: { kind: 'project', id: project.id },
          target: { kind: 'repository', id: repositoryId },
          kind: 'PROJECT_HAS_REPOSITORY',
          projectId: project.id,
          observedAt,
          provenance: 'project-projection',
          confidence: 'high',
          evidenceIds: [project.id],
        }),
      );
      for (const binding of await options.controlPlane.listProjectAgentBindings(project.id)) {
        addNode(
          createGraphNode({
            kind: 'project-agent-binding',
            entityId: binding.id,
            projectId: project.id,
            observedAt,
            provenance: 'canonical-project-agent-binding',
            confidence: 'high',
            evidenceIds: [binding.id],
            metadata: { enabled: binding.enabled },
          }),
        );
        addEdge(
          createGraphEdge({
            source: { kind: 'project', id: project.id },
            target: { kind: 'agent', id: binding.agentId },
            kind: 'PROJECT_BOUND_AGENT',
            projectId: project.id,
            observedAt,
            provenance: 'canonical-project-agent-binding',
            confidence: 'high',
            evidenceIds: [binding.id],
          }),
        );
      }
      const sessions = completeGraphInputs(await options.sessions.list(project.id), 'session');
      for (const session of sessions) {
        if (!nodeMap.has(`agent\0${session.agentId}`)) {
          addNode(
            createGraphNode({
              kind: 'agent',
              entityId: session.agentId,
              observedAt,
              provenance: 'session-projection',
              confidence: 'high',
              evidenceIds: [session.id],
              metadata: {},
            }),
          );
        }
        addNode(
          createGraphNode({
            kind: 'session',
            entityId: session.id,
            projectId: project.id,
            observedAt,
            provenance: 'session-projection',
            confidence: 'high',
            evidenceIds: [session.id],
            metadata: { status: session.status, presence: session.presence },
          }),
        );
        addEdge(
          createGraphEdge({
            source: { kind: 'agent', id: session.agentId },
            target: { kind: 'session', id: session.id },
            kind: 'AGENT_RAN_SESSION',
            projectId: project.id,
            observedAt,
            provenance: 'session-projection',
            confidence: 'high',
            evidenceIds: [session.id],
          }),
        );
        addEdge(
          createGraphEdge({
            source: { kind: 'session', id: session.id },
            target: { kind: 'project', id: project.id },
            kind: 'SESSION_WORKED_ON_PROJECT',
            projectId: project.id,
            observedAt,
            provenance: 'session-projection',
            confidence: 'high',
            evidenceIds: [session.id],
          }),
        );
      }
      for (const agentId of new Set(sessions.map(({ agentId }) => agentId))) {
        const evidenceIds = sessions
          .filter((session) => session.agentId === agentId)
          .map(({ id }) => id)
          .slice(0, 1000);
        addEdge(
          createGraphEdge({
            source: { kind: 'developer', id: 'local-developer' },
            target: { kind: 'agent', id: agentId },
            kind: 'DEVELOPER_USED_AGENT',
            projectId: project.id,
            observedAt,
            provenance: 'session-projection',
            confidence: 'high',
            evidenceIds,
          }),
        );
      }

      const contributions = completeGraphInputs(
        await options.repository.listContextContributions({
          projectId: project.id,
          limit: GRAPH_REBUILD_MAX_INPUTS + 1,
        }),
        'context contribution',
      );
      for (const contribution of contributions) {
        const contextGraphId = scopedGraphEntityId(project.id, contribution.contextSourceId);
        addNode(
          createGraphNode({
            kind: 'context-source',
            entityId: contextGraphId,
            projectId: project.id,
            observedAt: contribution.observedAt,
            provenance: contribution.source,
            confidence: contribution.confidence,
            evidenceIds:
              contribution.evidenceIds.length === 0 ? [contribution.id] : contribution.evidenceIds,
            metadata: {
              loadingMode: contribution.loadingMode,
              contextSourceId: contribution.contextSourceId,
            },
          }),
        );
        if (contribution.sessionId !== undefined) {
          addEdge(
            createGraphEdge({
              source: { kind: 'context-source', id: contextGraphId },
              target: { kind: 'session', id: contribution.sessionId },
              kind: 'CONTEXT_SOURCE_CONTRIBUTED_TO_SESSION',
              projectId: project.id,
              observedAt: contribution.observedAt,
              provenance: contribution.source,
              confidence: contribution.confidence,
              evidenceIds:
                contribution.evidenceIds.length === 0
                  ? [contribution.id]
                  : contribution.evidenceIds,
            }),
          );
          if (contribution.loaded === true) {
            addEdge(
              createGraphEdge({
                source: { kind: 'session', id: contribution.sessionId },
                target: { kind: 'context-source', id: contextGraphId },
                kind: 'SESSION_LOADED_CONTEXT',
                projectId: project.id,
                observedAt: contribution.observedAt,
                provenance: contribution.source,
                confidence: contribution.confidence,
                evidenceIds:
                  contribution.evidenceIds.length === 0
                    ? [contribution.id]
                    : contribution.evidenceIds,
              }),
            );
          }
          if (
            contribution.capabilityId !== undefined &&
            (contribution.loaded === true || contribution.invoked === true)
          ) {
            const capabilityKind =
              capabilityNodeKinds.get(contribution.capabilityId) ?? 'capability';
            addEdge(
              createGraphEdge({
                source: { kind: 'session', id: contribution.sessionId },
                target: { kind: capabilityKind, id: contribution.capabilityId },
                kind: 'SESSION_USED_CAPABILITY',
                projectId: project.id,
                observedAt: contribution.observedAt,
                provenance: contribution.source,
                confidence: contribution.confidence,
                evidenceIds:
                  contribution.evidenceIds.length === 0
                    ? [contribution.id]
                    : contribution.evidenceIds,
              }),
            );
            if (
              contribution.invoked === true &&
              (capabilityKind === 'skill' || capabilityKind === 'mcp')
            ) {
              addEdge(
                createGraphEdge({
                  source: { kind: 'session', id: contribution.sessionId },
                  target: { kind: capabilityKind, id: contribution.capabilityId },
                  kind: capabilityKind === 'mcp' ? 'SESSION_CALLED_MCP' : 'SESSION_INVOKED_SKILL',
                  projectId: project.id,
                  observedAt: contribution.observedAt,
                  provenance: contribution.source,
                  confidence: contribution.confidence,
                  evidenceIds:
                    contribution.evidenceIds.length === 0
                      ? [contribution.id]
                      : contribution.evidenceIds,
                }),
              );
            }
          }
        }
      }

      const packages = completeGraphInputs(
        await options.repository.listPackages(project.id, GRAPH_REBUILD_MAX_INPUTS + 1),
        'package',
      );
      const technologies = completeGraphInputs(
        await options.repository.listTechnologies(project.id, GRAPH_REBUILD_MAX_INPUTS + 1),
        'technology',
      );
      // ADR 0014: workspace locations come from every parsed manifest, not from
      // dependency records, so a package that declares nothing is still a module
      // and its files are not misattributed to the enclosing one. The package
      // locations remain in the union for inventories written before that fix.
      const workspaceLocations = await options.repository.listWorkspaceLocations(project.id);
      const moduleRoots: ModuleRoot[] = [
        { id: moduleId(project.id, '.'), path: '.' },
        ...[...workspaceLocations, ...packages.map(({ workspaceLocation }) => workspaceLocation)]
          .filter((path, index, values) => path !== '.' && values.indexOf(path) === index)
          .toSorted()
          .map((path) => ({ id: moduleId(project.id, path), path })),
      ];
      for (const root of moduleRoots) {
        addNode(
          createGraphNode({
            kind: 'module',
            entityId: root.id,
            projectId: project.id,
            observedAt,
            provenance: 'package-workspace-structure',
            confidence: 'high',
            evidenceIds: [project.id],
            metadata: { path: root.path },
          }),
        );
      }
      for (const packageRecord of packages) {
        addNode(
          createGraphNode({
            kind: 'package',
            entityId: packageRecord.id,
            projectId: project.id,
            observedAt: packageRecord.detectedAt,
            provenance: 'package-manifest',
            confidence: 'high',
            evidenceIds: [packageRecord.manifestHash],
            metadata: {
              ecosystem: packageRecord.ecosystem,
              packageName: packageRecord.packageName,
            },
          }),
        );
        addEdge(
          createGraphEdge({
            source: { kind: 'project', id: project.id },
            target: { kind: 'package', id: packageRecord.id },
            kind: 'PROJECT_USES_PACKAGE',
            projectId: project.id,
            observedAt: packageRecord.detectedAt,
            provenance: 'package-manifest',
            confidence: 'high',
            evidenceIds: [packageRecord.manifestHash],
          }),
        );
      }
      for (const technology of technologies) {
        addNode(
          createGraphNode({
            kind: 'technology',
            entityId: technology.id,
            projectId: project.id,
            observedAt: technology.detectedAt,
            provenance: 'technology-inventory',
            confidence: technology.confidence,
            evidenceIds: technology.evidence.map(({ value }) => value).slice(0, 1000),
            metadata: { name: technology.name, category: technology.category },
          }),
        );
        addEdge(
          createGraphEdge({
            source: { kind: 'project', id: project.id },
            target: { kind: 'technology', id: technology.id },
            kind: 'PROJECT_USES_TECHNOLOGY',
            projectId: project.id,
            observedAt: technology.detectedAt,
            provenance: 'technology-inventory',
            confidence: technology.confidence,
            evidenceIds: technology.evidence.map(({ value }) => value).slice(0, 1000),
          }),
        );
      }

      // Structural projection (ADR 0012). A failed or absent scan leaves the
      // structural layer out entirely rather than degrading the operational
      // one — the graph is allowed to be incomplete, never wrong.
      const structure = await observeCodeStructure(project.localPath);
      if (structure !== null) {
        const structuralFiles = new Map<string, string>();
        for (const relativePath of structure.files) {
          const file = createFileIdentity(project.id, relativePath);
          structuralFiles.set(relativePath, file.id);
          const exportCount = structure.exports.filter(
            (value) => value.path === relativePath,
          ).length;
          addNode(
            createGraphNode({
              kind: 'file',
              entityId: file.id,
              projectId: project.id,
              observedAt: structure.observedAt,
              provenance: CODE_STRUCTURE_PROVENANCE,
              confidence: 'high',
              evidenceIds: [relativePath],
              metadata: { relativePath: file.relativePath, exportCount },
            }),
          );
          const module = mapFileToModule(relativePath, moduleRoots);
          if (module !== null) {
            addEdge(
              createGraphEdge({
                source: { kind: 'file', id: file.id },
                target: { kind: 'module', id: module.id },
                kind: 'FILE_BELONGS_TO_MODULE',
                projectId: project.id,
                observedAt: structure.observedAt,
                provenance: CODE_STRUCTURE_PROVENANCE,
                confidence: 'high',
                evidenceIds: [relativePath],
              }),
            );
          }
        }
        for (const value of structure.imports) {
          // An unresolved import names no target, so it cannot be an edge.
          // It is counted below rather than pointed at a guess.
          if (value.toPath === undefined) continue;
          const source = structuralFiles.get(value.fromPath);
          const target = structuralFiles.get(value.toPath) ?? null;
          if (source === undefined || target === null) continue;
          addEdge(
            createGraphEdge({
              source: { kind: 'file', id: source },
              target: { kind: 'file', id: target },
              kind: 'FILE_IMPORTS_FILE',
              projectId: project.id,
              observedAt: structure.observedAt,
              provenance: CODE_STRUCTURE_PROVENANCE,
              confidence: value.confidence,
              evidenceIds: [`${value.fromPath}:${String(value.line)}`],
            }),
          );
        }
        const moduleOf = (path: string): string | null =>
          mapFileToModule(path, moduleRoots)?.id ?? null;
        for (const pair of moduleDependencyPairs(structure.imports, moduleOf)) {
          addEdge(
            createGraphEdge({
              source: { kind: 'module', id: pair.from },
              target: { kind: 'module', id: pair.to },
              kind: 'MODULE_DEPENDS_ON_MODULE',
              projectId: project.id,
              observedAt: structure.observedAt,
              provenance: CODE_STRUCTURE_PROVENANCE,
              confidence: pair.confidence,
              evidenceIds: [pair.from, pair.to],
            }),
          );
        }
      }

      const git = await options.repository.getCurrentGitObservation(project.id);
      if (git !== null) {
        for (const worktree of git.worktrees) {
          const worktreeId = `worktree-${createHash('sha256')
            .update(`${project.id}\0${worktree.path}`)
            .digest('hex')
            .slice(0, 32)}`;
          addNode(
            createGraphNode({
              kind: 'worktree',
              entityId: worktreeId,
              projectId: project.id,
              observedAt: git.observedAt,
              provenance: 'git-observation',
              confidence: 'high',
              evidenceIds: [git.id],
              metadata: { branch: worktree.branch ?? null },
            }),
          );
        }
        for (const commit of git.recentCommits) {
          const commitGraphId = scopedGraphEntityId(project.id, commit.sha);
          addNode(
            createGraphNode({
              kind: 'commit',
              entityId: commitGraphId,
              projectId: project.id,
              observedAt: commit.committedAt,
              provenance: 'git-observation',
              confidence: 'high',
              evidenceIds: [git.id, commit.sha],
              metadata: { merge: commit.merge, commitSha: commit.sha },
            }),
          );
          for (const path of commit.changedPaths) {
            const file = createFileIdentity(project.id, path);
            addNode(
              createGraphNode({
                kind: 'file',
                entityId: file.id,
                projectId: project.id,
                observedAt: commit.committedAt,
                provenance: 'git-commit-path',
                confidence: 'high',
                evidenceIds: [commit.sha],
                metadata: { relativePath: file.relativePath },
              }),
            );
            addEdge(
              createGraphEdge({
                source: { kind: 'commit', id: commitGraphId },
                target: { kind: 'file', id: file.id },
                kind: 'COMMIT_TOUCHES_FILE',
                projectId: project.id,
                observedAt: commit.committedAt,
                provenance: 'git-commit-path',
                confidence: 'high',
                evidenceIds: [git.id, commit.sha],
              }),
            );
            const module = mapFileToModule(path, moduleRoots);
            if (module !== null) {
              addEdge(
                createGraphEdge({
                  source: { kind: 'file', id: file.id },
                  target: { kind: 'module', id: module.id },
                  kind: 'FILE_BELONGS_TO_MODULE',
                  projectId: project.id,
                  observedAt: commit.committedAt,
                  provenance: 'deterministic-module-mapping',
                  confidence: 'high',
                  evidenceIds: [commit.sha],
                }),
              );
            }
          }
        }
      }
      for (const attribution of completeGraphInputs(
        await options.repository.listAttributions(project.id, GRAPH_REBUILD_MAX_INPUTS + 1),
        'attribution',
      )) {
        if (attribution.sessionId === undefined) continue;
        addEdge(
          createGraphEdge({
            source: { kind: 'session', id: attribution.sessionId },
            target: {
              kind: 'commit',
              id: scopedGraphEntityId(project.id, attribution.commitSha),
            },
            kind: 'SESSION_ASSOCIATED_WITH_COMMIT',
            projectId: project.id,
            observedAt: attribution.observedAt,
            provenance: `git-attribution:${attribution.confidence}`,
            confidence:
              attribution.confidence === 'exact'
                ? 'high'
                : attribution.confidence === 'correlated'
                  ? 'medium'
                  : 'low',
            evidenceIds: attribution.evidenceIds,
            metadata: { attributionConfidence: attribution.confidence },
          }),
        );
      }
      const usagePage = await options.repository.listUsage({
        projectId: project.id,
        limit: GRAPH_REBUILD_MAX_INPUTS + 1,
      });
      if (usagePage.truncated) {
        throw new ApplicationError(
          'GRAPH_REBUILD_FAILED',
          'The usage projection exceeded the bounded graph rebuild input.',
          409,
        );
      }
      for (const usage of completeGraphInputs(usagePage.records, 'usage')) {
        addNode(
          createGraphNode({
            kind: 'usage-record',
            entityId: usage.id,
            projectId: project.id,
            observedAt: usage.observedAt,
            provenance: usage.source,
            confidence:
              usage.confidence === 'exact'
                ? 'high'
                : usage.confidence === 'reported'
                  ? 'medium'
                  : usage.confidence === 'estimated'
                    ? 'low'
                    : 'unknown',
            evidenceIds: [usage.sourceEventId ?? usage.id],
            metadata: { source: usage.source },
          }),
        );
      }
    }
    for (const proposal of completeGraphInputs(
      await options.repository.listOptimizationProposals(undefined, GRAPH_REBUILD_MAX_INPUTS + 1),
      'optimization proposal',
    )) {
      addNode(
        createGraphNode({
          kind: 'optimization-proposal',
          entityId: proposal.id,
          projectId: proposal.projectId,
          observedAt: proposal.updatedAt,
          provenance: 'optimization-projection',
          confidence: proposal.confidence,
          evidenceIds: proposal.findingIds,
          metadata: { state: proposal.state },
        }),
      );
      for (const action of proposal.proposedActions) {
        if ('contextSourceId' in action) {
          addEdge(
            createGraphEdge({
              source: { kind: 'optimization-proposal', id: proposal.id },
              target: {
                kind: 'context-source',
                id: scopedGraphEntityId(proposal.projectId, action.contextSourceId),
              },
              kind: 'OPTIMIZATION_TARGETS_CONTEXT_SOURCE',
              projectId: proposal.projectId,
              observedAt: proposal.updatedAt,
              provenance: 'optimization-proposal',
              confidence: proposal.confidence,
              evidenceIds: proposal.findingIds,
            }),
          );
        }
      }
      if (proposal.configPlanId !== undefined) {
        addNode(
          createGraphNode({
            kind: 'config-plan',
            entityId: proposal.configPlanId,
            projectId: proposal.projectId,
            observedAt: proposal.updatedAt,
            provenance: 'phase3-config-plan',
            confidence: 'high',
            evidenceIds: [proposal.id],
            metadata: {},
          }),
        );
        addEdge(
          createGraphEdge({
            source: { kind: 'optimization-proposal', id: proposal.id },
            target: { kind: 'config-plan', id: proposal.configPlanId },
            kind: 'OPTIMIZATION_PRODUCED_CONFIG_PLAN',
            projectId: proposal.projectId,
            observedAt: proposal.updatedAt,
            provenance: 'phase3-config-plan',
            confidence: 'high',
            evidenceIds: [proposal.id, proposal.configPlanId],
          }),
        );
      }
    }
    for (const { event: retainedEvent } of retainedEvents) {
      if (retainedEvent.type !== 'message.requested') continue;
      const payload = recordValue(retainedEvent.payload);
      const messageId = payload?.['messageId'];
      const sourceSessionId = payload?.['sourceSessionId'];
      const targetSessionId = payload?.['targetSessionId'];
      if (
        typeof messageId !== 'string' ||
        typeof sourceSessionId !== 'string' ||
        typeof targetSessionId !== 'string' ||
        retainedEvent.projectId === undefined
      ) {
        continue;
      }
      addNode(
        createGraphNode({
          kind: 'message',
          entityId: messageId,
          projectId: retainedEvent.projectId,
          observedAt: retainedEvent.occurredAt,
          provenance: retainedEvent.type,
          confidence: 'high',
          evidenceIds: [retainedEvent.id],
          metadata: {},
        }),
      );
      for (const [sessionId, kind] of [
        [sourceSessionId, 'SESSION_SENT_MESSAGE'],
        [targetSessionId, 'SESSION_RECEIVED_MESSAGE'],
      ] as const) {
        addEdge(
          createGraphEdge({
            source: { kind: 'session', id: sessionId },
            target: { kind: 'message', id: messageId },
            kind,
            projectId: retainedEvent.projectId,
            observedAt: retainedEvent.occurredAt,
            provenance: retainedEvent.type,
            confidence: 'high',
            evidenceIds: [retainedEvent.id],
          }),
        );
      }
    }
    for (const edge of edgeMap.values()) {
      for (const endpoint of [edge.source, edge.target]) {
        if (nodeMap.has(`${endpoint.kind}\0${endpoint.id}`)) continue;
        addNode(
          createGraphNode({
            kind: endpoint.kind,
            entityId: endpoint.id,
            ...(edge.projectId === undefined ? {} : { projectId: edge.projectId }),
            observedAt: edge.observedAt,
            provenance: `edge-endpoint:${edge.provenance}`,
            confidence: edge.confidence,
            evidenceIds: edge.evidenceIds,
            metadata: { projectedFromEdge: edge.id },
          }),
        );
      }
    }
    return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
  };

  const runProjection = async (operation: string, evidenceId: string): Promise<void> => {
    try {
      const generation =
        (await options.repository.getActiveGraphGeneration()) ??
        (await options.repository.setInitialGraphGeneration('initial'));
      const snapshot = await projectGraphSnapshot();
      await options.repository.replaceGraphSnapshot(
        generation,
        snapshot.nodes,
        snapshot.edges,
        event(
          'graph.node.projected',
          {},
          {
            operation,
            evidenceId,
            generation,
            nodeCount: snapshot.nodes.length,
            edgeCount: snapshot.edges.length,
          },
        ),
      );
    } catch {
      await options.repository.recordGraphProjectionFailure({
        id: createId(),
        operation,
        code: 'GRAPH_PROJECTION_DEGRADED',
        occurredAt: now().toISOString(),
        evidenceId,
      });
    }
  };

  /**
   * Hands the reprojection to the caller-supplied runner and returns.
   *
   * A mutation's durable state is already written by the time this is reached,
   * and the projection reports its own failures, so the response does not wait
   * on it. Defaults to running inline.
   *
   * **Coalesced, not queued.** Each run rebuilds the whole projection from
   * current state, so N runs for N mutations all compute the same answer at
   * N times the cost — and because each one rescans the project and reads every
   * node and edge, letting them stack exhausted Redis and killed the daemon
   * once a busy fixture produced 61 at once. At most one runs; anything that
   * arrives while it runs sets a single follow-up, which then sees all of that
   * work at once.
   */
  let projectionRunning = false;
  let projectionPending: { operation: string; evidenceId: string } | undefined;

  const drainProjections = async (operation: string, evidenceId: string): Promise<void> => {
    projectionRunning = true;
    try {
      let next: { operation: string; evidenceId: string } | undefined = { operation, evidenceId };
      while (next !== undefined) {
        await runProjection(next.operation, next.evidenceId);
        next = projectionPending;
        projectionPending = undefined;
      }
    } finally {
      projectionRunning = false;
    }
  };

  const projectIncrementally = (operation: string, evidenceId: string): void => {
    if (projectionRunning) {
      // The newest evidence id wins: it is the one a reader would look for,
      // and the run it triggers covers every change that preceded it.
      projectionPending = { operation, evidenceId };
      return;
    }
    const defer = options.deferProjection;
    if (defer === undefined) {
      void drainProjections(operation, evidenceId);
      return;
    }
    defer(() => drainProjections(operation, evidenceId));
  };

  return {
    async ingestUsage(input) {
      await requireProject(input.projectId);
      const session = await options.sessions.get(input.sessionId);
      if (
        session === null ||
        session.projectId !== input.projectId ||
        session.agentId !== input.agentId
      ) {
        throw new ApplicationError(
          'USAGE_RECORD_INVALID',
          'Usage must reference the matching registered project, agent, and session.',
          400,
        );
      }
      const record = normalizeUsageRecord(input, { createId, now });
      const type = record.source === 'luwi-estimated' ? 'usage.estimated' : 'usage.reported';
      const persisted = await options.repository.ingestUsage(
        record,
        event(
          type,
          {
            projectId: record.projectId,
            agentId: record.agentId,
            sessionId: record.sessionId,
          },
          {
            usageId: record.id,
            source: record.source,
            confidence: record.confidence,
            suppliedFields: [
              'inputTokens',
              'outputTokens',
              'cachedInputTokens',
              'cachedOutputTokens',
              'cacheCreationInputTokens',
              'cacheReadInputTokens',
              'reasoningTokens',
              'totalTokens',
              'contextWindowTokens',
              'contextUsedTokens',
            ].filter((field) => record[field as keyof UsageRecord] !== undefined),
          },
        ),
      );
      if (persisted.status === 'duplicate') {
        throw new ApplicationError(
          'USAGE_RECORD_DUPLICATE',
          'The usage record or source event was already ingested.',
          409,
          { existingUsageId: persisted.existingUsageId },
        );
      }
      projectIncrementally('usage-ingest', record.id);
      return persisted.usage;
    },
    listUsage: (query) => options.repository.listUsage(query),
    async summarizeUsage(query) {
      const aggregate = await options.repository.summarizeUsage(query);
      const summary =
        aggregate ??
        (await (async () => {
          const page = await options.repository.listUsage({ ...query, limit: 1001 });
          if (page.truncated || page.records.length > 1000) {
            throw new ApplicationError(
              'USAGE_SUMMARY_FILTER_UNSUPPORTED',
              'This usage-summary filter exceeds the bounded retained-raw-history query.',
              400,
            );
          }
          return summarizeUsageRecords(page.records);
        })());
      const retainedEarliest = await options.repository.getEarliestUsageObservation();
      return usageSummarySchema.parse({
        ...summary,
        ...(retainedEarliest === null && summary.observedFrom === undefined
          ? {}
          : { earliestAvailableAt: retainedEarliest ?? summary.observedFrom }),
      });
    },
    listContextContributions: (filters) => options.repository.listContextContributions(filters),
    async observeContextContribution(input) {
      await requireProject(input.projectId);
      const session = await options.sessions.get(input.sessionId);
      if (
        session === null ||
        session.projectId !== input.projectId ||
        session.agentId !== input.agentId
      ) {
        throw new ApplicationError(
          'CONTEXT_OBSERVATION_INVALID',
          'The context observation does not match the registered session.',
          400,
        );
      }
      const source = (await options.controlPlane.listContextSources()).find(
        ({ id }) => id === input.contextSourceId,
      );
      if (
        source === undefined ||
        (source.projectId !== undefined && source.projectId !== input.projectId) ||
        (source.agentId !== undefined && source.agentId !== input.agentId) ||
        (input.capabilityId !== undefined && source.capabilityId !== input.capabilityId)
      ) {
        throw new ApplicationError(
          'CONTEXT_OBSERVATION_INVALID',
          'The context source is not available to the registered session.',
          400,
        );
      }
      const contribution = contextContributionSchema.parse({
        id: createId(),
        ...input,
        ...(source.capabilityId === undefined ? {} : { capabilityId: source.capabilityId }),
        assigned: true,
        effective: true,
      });
      await options.repository.putContextContribution(
        contribution,
        event(
          'context.contribution.observed',
          {
            projectId: input.projectId,
            agentId: input.agentId,
            sessionId: input.sessionId,
          },
          {
            contributionId: contribution.id,
            contextSourceId: input.contextSourceId,
            ...(contribution.capabilityId === undefined
              ? {}
              : { capabilityId: contribution.capabilityId }),
            loaded: input.loaded,
            invoked: input.invoked,
            source: input.source,
          },
        ),
      );
      if (input.loaded === true) {
        await options.repository.appendEvent(
          event(
            'context.capability.loaded',
            {
              projectId: input.projectId,
              agentId: input.agentId,
              sessionId: input.sessionId,
            },
            {
              contributionId: contribution.id,
              contextSourceId: input.contextSourceId,
              ...(contribution.capabilityId === undefined
                ? {}
                : { capabilityId: contribution.capabilityId }),
            },
          ),
        );
      }
      if (input.invoked === true) {
        const capability =
          contribution.capabilityId === undefined
            ? undefined
            : await options.controlPlane.getCapability(contribution.capabilityId);
        await options.repository.appendEvent(
          event(
            capability?.kind === 'mcp' ? 'context.mcp.tool.called' : 'context.capability.invoked',
            {
              projectId: input.projectId,
              agentId: input.agentId,
              sessionId: input.sessionId,
            },
            {
              contributionId: contribution.id,
              contextSourceId: input.contextSourceId,
              ...(contribution.capabilityId === undefined
                ? {}
                : { capabilityId: contribution.capabilityId }),
              ...(typeof input.metadata['toolName'] === 'string'
                ? { toolName: input.metadata['toolName'] }
                : {}),
            },
          ),
        );
      }
      projectIncrementally('context-observation', contribution.id);
      return contribution;
    },
    async contextSummary(projectId, agentId) {
      const contributions = await options.repository.listContextContributions({
        projectId,
        agentId,
        limit: 1000,
      });
      if (contributions.length === 0) {
        return (await this.analyzeContext(projectId, agentId)).summary;
      }
      return summarizeContextContributions(contributions);
    },
    async analyzeContext(projectId, agentId) {
      await requireProject(projectId);
      const { sources, contributions } = await effectiveContext(projectId, agentId);
      for (const contribution of contributions) {
        await options.repository.putContextContribution(
          contribution,
          event(
            'context.contribution.observed',
            {
              projectId,
              agentId,
              ...(contribution.sessionId === undefined
                ? {}
                : { sessionId: contribution.sessionId }),
            },
            {
              contributionId: contribution.id,
              contextSourceId: contribution.contextSourceId,
              loadingMode: contribution.loadingMode,
              source: contribution.source,
            },
          ),
        );
      }
      const mergedContributions = await options.repository.listContextContributions({
        projectId,
        agentId,
        limit: 1000,
      });
      const summary = summarizeContextContributions(mergedContributions);
      const findings = analyzeStructuralContext({
        projectId,
        agentId,
        contextSources: sources,
        contributions: mergedContributions,
        now: now().toISOString(),
        minimumSessions: minimumBaselineSessions,
        oversizedTokenThreshold: oversizedContextTokens,
        maximumFindings,
      });
      projectIncrementally('context-analysis', `${projectId}:${agentId}`);
      return { summary, contributions: mergedContributions, findings };
    },
    async getContextIntelligence(projectId, agentId) {
      const contributions = await options.repository.listContextContributions({
        projectId,
        agentId,
        limit: 1000,
      });
      if (contributions.length === 0) return this.analyzeContext(projectId, agentId);
      const findings = (await options.repository.listOptimizationFindings(projectId, 1000)).filter(
        (finding) => finding.agentId === undefined || finding.agentId === agentId,
      );
      return {
        summary: summarizeContextContributions(contributions),
        contributions,
        findings,
      };
    },
    async scanGit(projectId) {
      const project = await requireProject(projectId);
      let observation: GitObservation;
      try {
        observation = await gitObserver.observe({
          projectId,
          localPath: project.canonicalPath,
        });
      } catch (error) {
        if (error instanceof GitObservationError) {
          throw new ApplicationError(
            error.code,
            error.message,
            error.code === 'GIT_REPOSITORY_NOT_FOUND' ? 404 : 409,
          );
        }
        throw error;
      }
      const currentObservation = await options.repository.getCurrentGitObservation(projectId);
      if (
        currentObservation !== null &&
        currentObservation.repositoryStateHash === observation.repositoryStateHash
      ) {
        return currentObservation;
      }
      await options.repository.putGitObservation(
        observation,
        event(
          'git.observed',
          { projectId },
          {
            observationId: observation.id,
            headSha: observation.headSha ?? null,
            branch: observation.branch ?? null,
            clean: observation.clean,
            commitCount: observation.recentCommits.length,
            worktreeCount: observation.worktrees.length,
          },
        ),
      );
      const attributions = attributeGitObservation(
        observation,
        await options.sessions.list(projectId),
      );
      if (attributions.length > 0) {
        await options.repository.putAttributions(
          attributions,
          event(
            'attribution.recorded',
            { projectId },
            {
              observationId: observation.id,
              attributionCount: attributions.length,
              confidenceComposition: Object.fromEntries(
                ['exact', 'correlated', 'estimated', 'unknown'].map((confidence) => [
                  confidence,
                  attributions.filter((value) => value.confidence === confidence).length,
                ]),
              ),
            },
          ),
        );
      }
      projectIncrementally('git-scan', observation.id);
      return observation;
    },
    async getGit(projectId) {
      await requireProject(projectId);
      const observation = await options.repository.getCurrentGitObservation(projectId);
      if (observation === null) {
        throw new ApplicationError(
          'GIT_REPOSITORY_NOT_FOUND',
          'No Git observation is available for the project.',
          404,
        );
      }
      return observation;
    },
    listGitCommits: (projectId, limit) => options.repository.listGitCommits(projectId, limit),
    async listGitWorktrees(projectId) {
      return (await this.getGit(projectId)).worktrees;
    },
    listAttributions: (projectId, limit) => options.repository.listAttributions(projectId, limit),
    async scanPackages(projectId) {
      const project = await requireProject(projectId);
      try {
        const trackedPaths = await gitObserver
          .listTrackedFiles(project.canonicalPath)
          .catch((error: unknown) => {
            if (error instanceof GitObservationError && error.code === 'GIT_REPOSITORY_NOT_FOUND') {
              return undefined;
            }
            throw error;
          });
        const result = await packageScanner.scan({
          projectId,
          localPath: project.canonicalPath,
          ...(trackedPaths === undefined ? {} : { trackedPaths }),
        });
        await options.repository.replacePackageInventory(
          projectId,
          result.packages,
          result.technologies,
          result.workspaceLocations,
          event(
            'package.inventory.updated',
            { projectId },
            {
              packageCount: result.packages.length,
              technologyCount: result.technologies.length,
              manifestCount: result.manifestCount,
              truncated: result.truncated,
              evidenceScope: result.evidenceScope,
            },
          ),
        );
        projectIncrementally('package-scan', projectId);
        return {
          packages: result.packages,
          technologies: result.technologies,
          scannedAt: result.scannedAt,
          truncated: result.truncated,
          evidenceScope: result.evidenceScope,
        };
      } catch (error) {
        if (error instanceof PackageInventoryError) {
          throw new ApplicationError(error.code, error.message, 409);
        }
        throw error;
      }
    },
    listPackages: (projectId, limit) => options.repository.listPackages(projectId, limit),
    listTechnologies: (projectId, limit) => options.repository.listTechnologies(projectId, limit),
    async getGraphNode(kind, id) {
      const node = await options.repository.getGraphNode(kind, id);
      if (node === null) {
        throw new ApplicationError('GRAPH_NODE_NOT_FOUND', 'The graph node was not found.', 404);
      }
      return node;
    },
    async graphNeighbors(kind, id, direction, query) {
      const result = await options.repository.getGraphNeighbors(kind, id, direction, query);
      if (result === null) {
        throw new ApplicationError('GRAPH_NODE_NOT_FOUND', 'The graph node was not found.', 404);
      }
      return {
        node: result.node,
        nodes: result.nodes,
        edges: result.edges,
        truncated: result.truncated,
      };
    },
    async graphSummary() {
      const projection = await options.repository.getGraphSummary();
      const total = (counts: ReadonlyArray<{ count: number }>): number =>
        counts.reduce((sum, { count }) => sum + count, 0);
      // ADR 0013: an absent generation yields no totals at all. Summing the
      // empty lists here would publish a zero that was never observed.
      const observed =
        projection.generation === null
          ? {}
          : {
              generation: projection.generation,
              nodeCount: total(projection.nodes),
              edgeCount: total(projection.edges),
            };
      return {
        observed: projection.generation !== null,
        ...observed,
        retainedGenerationCount: projection.retainedGenerationCount,
        projectionHealth: projection.projectionHealth,
        nodeCountsByKind: projection.nodes,
        edgeCountsByKind: projection.edges,
        observedAt: now().toISOString(),
      };
    },
    async graphPath(kind, id, query) {
      const start = await options.repository.getGraphNode(kind, id);
      if (start === null) {
        throw new ApplicationError('GRAPH_NODE_NOT_FOUND', 'The graph node was not found.', 404);
      }
      if (start.kind === query.toKind && start.entityId === query.toId) {
        return { found: true, nodes: [start], edges: [] };
      }
      const queue: Array<{ node: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] }> = [
        { node: start, nodes: [start], edges: [] },
      ];
      const visited = new Set([`${start.kind}\0${start.entityId}`]);
      let examinedEdges = 0;
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.edges.length >= query.maxDepth) continue;
        const neighbors = await options.repository.getGraphNeighbors(
          current.node.kind,
          current.node.entityId,
          'out',
          {
            ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
            ...(query.edgeKind === undefined ? {} : { edgeKind: query.edgeKind }),
            limit: 1000,
          },
        );
        if (neighbors?.truncated === true) {
          throw new ApplicationError(
            'GRAPH_QUERY_LIMIT_EXCEEDED',
            'The graph path search exceeded the neighbor limit.',
            400,
          );
        }
        examinedEdges += neighbors?.examinedEdges ?? 0;
        if (examinedEdges > 10_000) {
          throw new ApplicationError(
            'GRAPH_QUERY_LIMIT_EXCEEDED',
            'The graph path search exceeded the examined-edge budget.',
            400,
          );
        }
        for (let index = 0; index < (neighbors?.nodes.length ?? 0); index += 1) {
          const next = neighbors!.nodes[index]!;
          const edge = neighbors!.edges[index]!;
          const reference = `${next.kind}\0${next.entityId}`;
          if (visited.has(reference)) continue;
          const nodes = [...current.nodes, next];
          const edges = [...current.edges, edge];
          if (next.kind === query.toKind && next.entityId === query.toId) {
            return { found: true, nodes, edges };
          }
          visited.add(reference);
          if (visited.size > 2000) {
            throw new ApplicationError(
              'GRAPH_QUERY_LIMIT_EXCEEDED',
              'The graph path search exceeded the node limit.',
              400,
            );
          }
          queue.push({ node: next, nodes, edges });
        }
      }
      return { found: false, nodes: [], edges: [] };
    },
    async graphSubgraph(query) {
      const start = await options.repository.getGraphNode(query.nodeKind, query.nodeId);
      if (start === null) {
        throw new ApplicationError('GRAPH_NODE_NOT_FOUND', 'The graph node was not found.', 404);
      }
      const nodes: GraphNode[] = [start];
      const edges: GraphEdge[] = [];
      const visited = new Set([`${start.kind}\0${start.entityId}`]);
      let frontier = [start];
      let truncated = false;
      let examinedEdges = 0;
      let budgetExhausted = false;
      for (let depth = 0; depth < query.maxDepth && frontier.length > 0; depth += 1) {
        const nextFrontier: GraphNode[] = [];
        for (const current of frontier) {
          const neighbors = await options.repository.getGraphNeighbors(
            current.kind,
            current.entityId,
            'out',
            {
              ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
              limit: 1000,
            },
          );
          truncated ||= neighbors?.truncated ?? false;
          examinedEdges += neighbors?.examinedEdges ?? 0;
          if (examinedEdges > 10_000) {
            truncated = true;
            budgetExhausted = true;
            break;
          }
          for (let index = 0; index < (neighbors?.nodes.length ?? 0); index += 1) {
            const next = neighbors!.nodes[index]!;
            const edge = neighbors!.edges[index]!;
            const reference = `${next.kind}\0${next.entityId}`;
            if (visited.has(reference)) continue;
            if (nodes.length >= query.nodeLimit) {
              truncated = true;
              continue;
            }
            visited.add(reference);
            nodes.push(next);
            edges.push(edge);
            nextFrontier.push(next);
          }
        }
        if (budgetExhausted) break;
        frontier = nextFrontier;
      }
      return { nodes, edges, truncated };
    },
    async rebuildGraph() {
      const previousGeneration = await options.repository.getActiveGraphGeneration();
      const operationId = createId();
      const shadowGeneration = `generation-${operationId}`;
      const startedAt = now().toISOString();
      let operation = graphRebuildOperationSchema.parse({
        id: operationId,
        state: 'running',
        shadowGeneration,
        ...(previousGeneration === null ? {} : { previousGeneration }),
        processedEvents: 0,
        nodeCount: 0,
        edgeCount: 0,
        failureCount: 0,
        failureSummary: [],
        startedAt,
      });
      await options.repository.beginGraphRebuild(
        operation,
        event('graph.rebuild.started', {}, { operationId, shadowGeneration }),
      );
      try {
        const retainedEvents = (await options.readRebuildEvents?.()) ?? [];
        const sourceStreamId = retainedEvents.at(-1)?.streamId;
        operation = graphRebuildOperationSchema.parse({
          ...operation,
          ...(sourceStreamId === undefined ? {} : { sourceStreamId }),
          processedEvents: retainedEvents.length,
        });
        await options.repository.updateGraphRebuild(operation);
        const snapshot = await projectGraphSnapshot(retainedEvents);
        for (const node of snapshot.nodes) {
          await options.repository.putGraphNode(shadowGeneration, node);
        }
        for (const edge of snapshot.edges) {
          await options.repository.putGraphEdge(shadowGeneration, edge);
        }
        operation = graphRebuildOperationSchema.parse({
          ...operation,
          state: 'completed',
          activeGeneration: shadowGeneration,
          nodeCount: snapshot.nodes.length,
          edgeCount: snapshot.edges.length,
          completedAt: now().toISOString(),
        });
        await options.repository.validateGraphGeneration(
          shadowGeneration,
          snapshot.nodes.length,
          snapshot.edges.length,
        );
        await options.repository.activateGraphGeneration(
          operation,
          event(
            'graph.rebuild.completed',
            {},
            {
              operationId,
              shadowGeneration,
              nodeCount: snapshot.nodes.length,
              edgeCount: snapshot.edges.length,
            },
          ),
        );
        return operation;
      } catch {
        const failed = graphRebuildOperationSchema.parse({
          ...operation,
          state: 'failed',
          failureCount: 1,
          failureSummary: ['Graph rebuild failed.'],
          completedAt: now().toISOString(),
        });
        await options.repository.failGraphRebuild(
          failed,
          event('graph.rebuild.failed', {}, { operationId, failureCount: 1 }),
        );
        throw new ApplicationError('GRAPH_REBUILD_FAILED', 'The graph rebuild failed.', 503);
      }
    },
    async getGraphRebuild(operationId) {
      const operation = await options.repository.getGraphRebuild(operationId);
      if (operation === null) {
        throw new ApplicationError(
          'GRAPH_REBUILD_FAILED',
          'The graph rebuild operation was not found.',
          404,
        );
      }
      return operation;
    },
    async analyzeOptimization(input) {
      await requireProject(input.projectId);
      const agentId =
        input.agentId ??
        (() => {
          throw new ApplicationError(
            'OPTIMIZATION_PROPOSAL_INVALID',
            'Phase 4 optimization analysis requires agentId.',
            400,
          );
        })();
      const intelligence = await this.analyzeContext(input.projectId, agentId);
      const sources = await contextSources(input.projectId, agentId);
      const [capabilities, allContributions, effective, sessions, usage, git] = await Promise.all([
        options.controlPlane.listCapabilities({ limit: 1000 }),
        options.repository.listContextContributions({ limit: 1000 }),
        options.controlPlane.getEffectiveConfiguration(input.projectId, agentId),
        options.sessions.list(input.projectId),
        this.summarizeUsage({ projectId: input.projectId, agentId, limit: 1000 }),
        options.repository.getCurrentGitObservation(input.projectId),
      ]);
      const findings = analyzeStructuralContext({
        projectId: input.projectId,
        agentId,
        contextSources: sources,
        contributions: intelligence.contributions,
        allContributions,
        capabilities,
        now: now().toISOString(),
        minimumSessions: input.minimumSessions ?? minimumBaselineSessions,
        oversizedTokenThreshold: oversizedContextTokens,
        maximumFindings,
      });
      const staticTotal = intelligence.summary.staticEstimatedTokens;
      const proposals = createOptimizationProposals(
        findings,
        now().toISOString(),
        maximumProposals,
      ).map((proposal) => {
        const action = proposal.proposedActions[0];
        const target =
          action !== undefined && 'contextSourceId' in action
            ? sources.find(({ id }) => id === action.contextSourceId)
            : undefined;
        return optimizationProposalSchema.parse({
          ...proposal,
          baseline: {
            capturedAt: now().toISOString(),
            effectiveConfigHash: structuralHash(effective),
            contextSourceHashes: [...new Set(sources.map(({ hash }) => hash))].toSorted(),
            sessionIds: sessions
              .filter((value) => value.agentId === agentId)
              .map(({ id }) => id)
              .toSorted(),
            usageSourceComposition: usage.sources,
            ...(staticTotal === undefined ? {} : { estimatedContextTokens: staticTotal }),
            ...(git?.headSha === undefined ? {} : { gitHead: git.headSha }),
          },
          ...(staticTotal === undefined ? {} : { estimatedBeforeTokens: staticTotal }),
          ...(staticTotal === undefined || target === undefined
            ? {}
            : {
                estimatedAfterTokens: Math.max(0, staticTotal - target.estimatedTokenCount),
                estimatedSavingTokens: Math.min(staticTotal, target.estimatedTokenCount),
              }),
        });
      });
      for (const finding of findings) {
        await options.repository.putOptimizationFinding(
          finding,
          event(
            'optimization.finding.detected',
            {
              projectId: finding.projectId,
              ...(finding.agentId === undefined ? {} : { agentId: finding.agentId }),
            },
            {
              findingId: finding.id,
              kind: finding.kind,
              confidence: finding.confidence,
              observationCount: finding.evidenceWindow.observationCount,
            },
          ),
        );
      }
      for (const proposal of proposals) {
        await options.repository.putOptimizationProposal(
          proposal,
          event(
            'optimization.proposal.created',
            {
              projectId: proposal.projectId,
              ...(proposal.agentId === undefined ? {} : { agentId: proposal.agentId }),
            },
            {
              proposalId: proposal.id,
              findingIds: proposal.findingIds,
              confidence: proposal.confidence,
            },
          ),
        );
      }
      const analyzedAt = now().toISOString();
      await options.repository.appendEvent(
        event(
          'optimization.analysis.completed',
          { projectId: input.projectId, agentId },
          {
            findingCount: findings.length,
            proposalCount: proposals.length,
            analyzedAt,
          },
        ),
      );
      projectIncrementally('optimization-analysis', input.projectId);
      return { findings, proposals, analyzedAt };
    },
    listFindings: (projectId, limit) =>
      options.repository.listOptimizationFindings(projectId, limit),
    listProposals: (projectId, limit) =>
      options.repository.listOptimizationProposals(projectId, limit),
    getProposal: requireProposal,
    async acceptProposal(proposalId) {
      const proposal = await requireProposal(proposalId);
      const accepted = transitionOptimizationProposal(proposal, 'accepted', now().toISOString());
      await options.repository.putOptimizationProposal(
        accepted,
        event(
          'optimization.proposal.accepted',
          {
            projectId: accepted.projectId,
            ...(accepted.agentId === undefined ? {} : { agentId: accepted.agentId }),
          },
          { proposalId: accepted.id },
        ),
      );
      return accepted;
    },
    async rejectProposal(proposalId) {
      const proposal = await requireProposal(proposalId);
      const rejected = transitionOptimizationProposal(proposal, 'rejected', now().toISOString());
      await options.repository.putOptimizationProposal(
        rejected,
        event(
          'optimization.proposal.rejected',
          {
            projectId: rejected.projectId,
            ...(rejected.agentId === undefined ? {} : { agentId: rejected.agentId }),
          },
          { proposalId: rejected.id },
        ),
      );
      return rejected;
    },
    async createConfigPlan(proposalId, actionIndex) {
      const proposal = await requireProposal(proposalId);
      if (proposal.state !== 'accepted') {
        throw new ApplicationError(
          'OPTIMIZATION_PROPOSAL_INVALID',
          'Only an accepted proposal can create a ConfigPlan.',
          409,
        );
      }
      const action = proposal.proposedActions[actionIndex];
      if (
        action === undefined ||
        (action.kind !== 'convert-source-to-reference-only' &&
          action.kind !== 'change-loading-mode')
      ) {
        throw new ApplicationError(
          'OPTIMIZATION_CONFIG_PLAN_FAILED',
          'The selected optimization action cannot be expressed as a deterministic ConfigPlan.',
          409,
        );
      }
      if (proposal.agentId === undefined) {
        throw new ApplicationError(
          'OPTIMIZATION_CONFIG_PLAN_FAILED',
          'The proposal has no target agent.',
          409,
        );
      }
      const plan = await options.configControl.createOptimizationPlan({
        proposalId,
        projectId: proposal.projectId,
        agentId: proposal.agentId,
        contextSourceId: action.contextSourceId,
        loadingMode:
          action.kind === 'convert-source-to-reference-only'
            ? 'reference-only'
            : action.loadingMode,
      });
      const linked = optimizationProposalSchema.parse({
        ...proposal,
        configPlanId: plan.id,
        updatedAt: now().toISOString(),
      });
      await options.repository.putOptimizationProposal(
        linked,
        event(
          'optimization.plan.created',
          {
            projectId: linked.projectId,
            ...(linked.agentId === undefined ? {} : { agentId: linked.agentId }),
          },
          { proposalId: linked.id, configPlanId: plan.id },
        ),
      );
      return { proposal: linked, plan };
    },
    async recordConfigPlanApplied(configPlanId) {
      const proposal = (
        await options.repository.listOptimizationProposals(undefined, GRAPH_REBUILD_MAX_INPUTS + 1)
      ).find((value) => value.configPlanId === configPlanId);
      if (proposal === undefined || proposal.state !== 'accepted') return;
      const appliedAt = now().toISOString();
      const applied = optimizationProposalSchema.parse({
        ...transitionOptimizationProposal(proposal, 'applied', appliedAt),
        appliedAt,
      });
      await options.repository.putOptimizationProposal(
        applied,
        event(
          'optimization.applied',
          {
            projectId: applied.projectId,
            ...(applied.agentId === undefined ? {} : { agentId: applied.agentId }),
          },
          { proposalId: applied.id, configPlanId },
        ),
      );
    },
    async evaluateProposal(proposalId, overrides = {}) {
      let proposal = await requireProposal(proposalId);
      if (proposal.configPlanId === undefined) {
        throw new ApplicationError(
          'OPTIMIZATION_EVALUATION_INSUFFICIENT',
          'The proposal has no Phase 3 ConfigPlan.',
          409,
        );
      }
      const plan = await options.configControl.getPlan(proposal.configPlanId);
      if (plan.state !== 'applied') {
        throw new ApplicationError(
          'OPTIMIZATION_EVALUATION_INSUFFICIENT',
          'The Phase 3 ConfigPlan has not been applied.',
          409,
        );
      }
      if (proposal.state === 'accepted') {
        const appliedAt = now().toISOString();
        proposal = optimizationProposalSchema.parse({
          ...transitionOptimizationProposal(proposal, 'applied', appliedAt),
          appliedAt,
        });
        await options.repository.putOptimizationProposal(
          proposal,
          event(
            'optimization.applied',
            {
              projectId: proposal.projectId,
              ...(proposal.agentId === undefined ? {} : { agentId: proposal.agentId }),
            },
            {
              proposalId: proposal.id,
              configPlanId: plan.id,
            },
          ),
        );
      }
      if (proposal.state === 'applied') {
        proposal = transitionOptimizationProposal(proposal, 'evaluating', now().toISOString());
        await options.repository.putOptimizationProposal(
          proposal,
          event(
            'optimization.evaluation.started',
            {
              projectId: proposal.projectId,
              ...(proposal.agentId === undefined ? {} : { agentId: proposal.agentId }),
            },
            {
              proposalId: proposal.id,
            },
          ),
        );
      }
      if (proposal.agentId === undefined || proposal.state !== 'evaluating') {
        throw new ApplicationError(
          'OPTIMIZATION_EVALUATION_INSUFFICIENT',
          'The proposal is not ready for evaluation.',
          409,
        );
      }
      if (proposal.baseline === undefined || proposal.appliedAt === undefined) {
        throw new ApplicationError(
          'OPTIMIZATION_EVALUATION_INSUFFICIENT',
          'The proposal has no immutable pre-change baseline or apply timestamp.',
          409,
        );
      }
      const current = await this.analyzeContext(proposal.projectId, proposal.agentId);
      const postContributions = current.contributions.filter(
        ({ observedAt, source }) =>
          observedAt > proposal.appliedAt! &&
          (source === 'adapter-reported' || source === 'session-reported'),
      );
      const postSessions = new Set(
        postContributions
          .map(({ sessionId }) => sessionId)
          .filter((value): value is string => value !== undefined),
      ).size;
      const uniqueAlwaysLoaded = new Map<string, number>();
      for (const contribution of current.contributions) {
        if (
          contribution.loadingMode !== 'reference-only' &&
          contribution.estimatedTokens !== undefined
        ) {
          uniqueAlwaysLoaded.set(contribution.contextSourceId, contribution.estimatedTokens);
        }
      }
      const postTokens = [...uniqueAlwaysLoaded.values()].reduce((sum, value) => sum + value, 0);
      const postUsage = await options.repository.listUsage({
        projectId: proposal.projectId,
        agentId: proposal.agentId,
        from: proposal.appliedAt,
        limit: 1000,
      });
      const currentEffective = await options.controlPlane.getEffectiveConfiguration(
        proposal.projectId,
        proposal.agentId,
      );
      const completedAt = now().toISOString();
      const evaluation = evaluateOptimization({
        proposal,
        baseline: {
          sessionCount: proposal.baseline.sessionIds.length,
          usageRecordCount: proposal.baseline.usageSourceComposition.reduce(
            (total, source) => total + source.recordCount,
            0,
          ),
          effectiveConfigHash: proposal.baseline.effectiveConfigHash,
          ...(proposal.baseline.estimatedContextTokens === undefined
            ? {}
            : { estimatedContextTokens: proposal.baseline.estimatedContextTokens }),
        },
        postChange: {
          sessionCount: postSessions,
          usageRecordCount: postUsage.records.length,
          estimatedContextTokens: postTokens,
          effectiveConfigHash: structuralHash(currentEffective),
          ...(postContributions.some(({ reportedTokens }) => reportedTokens !== undefined)
            ? {
                reportedContextTokens: postContributions.reduce(
                  (total, value) => total + (value.reportedTokens ?? 0),
                  0,
                ),
              }
            : {}),
        },
        minimumPostSessions: overrides.minimumPostSessions ?? minimumPostSessions,
        startedAt: proposal.appliedAt,
        completedAt,
      });
      const requiredHours = overrides.minimumObservationHours ?? minimumObservationHours;
      const elapsedHours = (Date.parse(completedAt) - Date.parse(proposal.appliedAt)) / 3_600_000;
      const boundedEvaluation =
        elapsedHours < requiredHours
          ? {
              ...evaluation,
              state: 'inconclusive' as const,
              summary: 'The post-change observation duration is insufficient for a conclusion.',
            }
          : evaluation;
      const completedProposal = transitionOptimizationProposal(
        proposal,
        boundedEvaluation.state,
        completedAt,
      );
      await options.repository.completeOptimizationEvaluation(
        boundedEvaluation,
        completedProposal,
        event(
          'optimization.evaluation.completed',
          { projectId: proposal.projectId, agentId: proposal.agentId },
          {
            proposalId: proposal.id,
            evaluationId: boundedEvaluation.id,
            state: boundedEvaluation.state,
            causalClaim: false,
          },
        ),
      );
      return boundedEvaluation;
    },
    async getEvaluation(evaluationId) {
      const evaluation = await options.repository.getOptimizationEvaluation(evaluationId);
      if (evaluation === null) {
        throw new ApplicationError(
          'OPTIMIZATION_EVALUATION_INSUFFICIENT',
          'The optimization evaluation was not found.',
          404,
        );
      }
      return evaluation;
    },
  };
}
