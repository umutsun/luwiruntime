import { describe, expect, it, vi } from 'vitest';

import type {
  ContextSource,
  GitObservation,
  OptimizationProposal,
  Project,
  SessionView,
  UsageRecord,
} from '@luwi/protocol';
import type { IntelligenceRepository } from '@luwi/redis';

import type { ConfigControlService } from './config-control-service.js';
import type { ControlPlaneService } from './control-plane-service.js';
import { createIntelligenceService } from './intelligence-service.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const timestamp = '2026-07-30T00:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Sandbox',
  localPath: 'C:/sandbox',
  canonicalPath: 'C:/sandbox',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const session: SessionView = {
  id: 'session-1',
  projectId: project.id,
  agentId: 'codex',
  status: 'idle',
  presence: 'online',
  workingDirectory: project.canonicalPath,
  branch: 'main',
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  metadata: {},
};
const contextSource: ContextSource = {
  id: 'context-source-1',
  projectId: project.id,
  agentId: 'codex',
  sourceType: 'instruction',
  path: 'C:/sandbox/AGENTS.md',
  byteCount: 16_000,
  lineCount: 300,
  hash: 'a'.repeat(64),
  loadingScope: 'project',
  loadingMode: 'automatic',
  managementMode: 'managed-file',
  estimatedTokenCount: 4000,
  estimationSource: 'estimated',
  estimationMethod: 'generic-character-estimate',
  measuredAt: timestamp,
};

function dependencies() {
  const usage = new Map<string, UsageRecord>();
  const proposals = new Map<string, OptimizationProposal>();
  const contributions: Awaited<ReturnType<IntelligenceRepository['listContextContributions']>> = [];
  const repository = {
    ingestUsage: vi.fn(async (record: UsageRecord) => {
      if (usage.has(record.id)) return { status: 'duplicate', existingUsageId: record.id } as const;
      usage.set(record.id, record);
      return {
        status: 'created',
        usage: record,
        event: {
          id: 'event',
          version: 1,
          type: 'usage.reported',
          occurredAt: timestamp,
          workspaceId: 'local',
          payload: {},
        },
      } as const;
    }),
    listUsage: vi.fn(async () => ({ records: [...usage.values()], truncated: false })),
    summarizeUsage: vi.fn(async () => ({
      recordCount: usage.size,
      sources: [],
    })),
    getEarliestUsageObservation: vi.fn(async () => null),
    putContextContribution: vi.fn(async (value) => {
      const index = contributions.findIndex(({ id }) => id === value.id);
      if (index === -1) contributions.push(value);
      else contributions[index] = value;
    }),
    listContextContributions: vi.fn(async () => contributions),
    putOptimizationFinding: vi.fn(async () => undefined),
    listOptimizationFindings: vi.fn(async () => []),
    putOptimizationProposal: vi.fn(async (value: OptimizationProposal) => {
      proposals.set(value.id, value);
    }),
    getOptimizationProposal: vi.fn(async (id: string) => proposals.get(id) ?? null),
    listOptimizationProposals: vi.fn(async () => [...proposals.values()]),
    putOptimizationEvaluation: vi.fn(async () => undefined),
    getOptimizationEvaluation: vi.fn(async () => null),
    getCurrentGitObservation: vi.fn(async () => null),
    getActiveGraphGeneration: vi.fn(async () => 'active'),
    putGraphNode: vi.fn(async () => undefined),
    putGraphEdge: vi.fn(async () => undefined),
    replaceGraphSnapshot: vi.fn(async () => undefined),
    recordGraphProjectionFailure: vi.fn(async () => undefined),
    readGraphGeneration: vi.fn(async () => ({ generation: 'active', nodes: [], edges: [] })),
    appendEvent: vi.fn(async () => undefined),
  } as unknown as IntelligenceRepository;
  const projects = {
    get: vi.fn(async (id: string) => (id === project.id ? project : null)),
    list: vi.fn(async () => [project]),
  } as unknown as ProjectService;
  const sessions = {
    get: vi.fn(async (id: string) => (id === session.id ? session : null)),
    list: vi.fn(async () => [session]),
  } as unknown as SessionService;
  const controlPlane = {
    listContextSources: vi.fn(async () => [contextSource]),
    listCapabilities: vi.fn(async () => []),
    getEffectiveConfiguration: vi.fn(async () => ({
      projectId: project.id,
      agentId: 'codex',
      agentKind: 'codex',
      valid: true,
      capabilities: [],
      profileIds: [],
      settings: {},
      provenance: [],
      conflicts: [],
      missingDependencies: [],
      unsupportedCapabilities: [],
      nativeCapabilitySupport: [],
      estimatedContextFootprint: {
        projectId: project.id,
        agentId: 'codex',
        source: 'estimated',
        method: 'generic-character-estimate',
        totalBytes: 16_000,
        totalLines: 300,
        estimatedTokens: 4000,
        categories: {},
        exactDuplicateGroups: [],
        measuredAt: timestamp,
      },
    })),
  } as unknown as ControlPlaneService;
  const createOptimizationPlan = vi.fn(async () => ({
    id: 'config-plan-1',
    projectId: project.id,
    agentId: 'codex',
    state: 'prepared',
    kind: 'optimization',
    changes: [
      {
        path: 'C:/sandbox/.luwi/manifest.json',
        operation: 'update',
        managementMode: 'managed-file',
        beforeHash: 'b'.repeat(64),
        afterHash: 'c'.repeat(64),
        redactedDiff: '{}',
        warnings: [],
      },
    ],
    preconditionHashes: { 'C:/sandbox/.luwi/manifest.json': 'b'.repeat(64) },
    createdAt: timestamp,
    expiresAt: '2026-07-30T01:00:00.000Z',
  }));
  const configControl = {
    createOptimizationPlan,
  } as unknown as ConfigControlService;
  return {
    repository,
    projects,
    sessions,
    controlPlane,
    configControl,
    createOptimizationPlan,
  };
}

describe('daemon intelligence service', () => {
  it('sums per-kind graph cardinality into observed totals', async () => {
    const values = dependencies();
    const repository = values.repository as unknown as {
      getGraphSummary: ReturnType<typeof vi.fn>;
    };
    repository.getGraphSummary = vi.fn(async () => ({
      generation: 'generation-1',
      projectionHealth: 'degraded' as const,
      nodes: [
        { kind: 'project' as const, count: 2 },
        { kind: 'session' as const, count: 5 },
      ],
      edges: [{ kind: 'PROJECT_BOUND_AGENT' as const, count: 4 }],
    }));
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
    });

    const summary = await service.graphSummary();

    expect(summary).toEqual({
      observed: true,
      generation: 'generation-1',
      projectionHealth: 'degraded',
      nodeCount: 7,
      edgeCount: 4,
      nodeCountsByKind: [
        { kind: 'project', count: 2 },
        { kind: 'session', count: 5 },
      ],
      edgeCountsByKind: [{ kind: 'PROJECT_BOUND_AGENT', count: 4 }],
      observedAt: timestamp,
    });
  });

  it('reports an unbuilt graph without inventing totals', async () => {
    const values = dependencies();
    const repository = values.repository as unknown as {
      getGraphSummary: ReturnType<typeof vi.fn>;
    };
    repository.getGraphSummary = vi.fn(async () => ({
      generation: null,
      projectionHealth: 'healthy' as const,
      nodes: [],
      edges: [],
    }));
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
    });

    const summary = await service.graphSummary();

    expect(summary.observed).toBe(false);
    expect(summary).not.toHaveProperty('nodeCount');
    expect(summary).not.toHaveProperty('edgeCount');
    expect(summary).not.toHaveProperty('generation');
  });

  it('validates usage against the bound project/session and preserves unavailable fields', async () => {
    const values = dependencies();
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      createId: (() => {
        let id = 0;
        return () => `id-${String(++id)}`;
      })(),
      now: () => new Date(timestamp),
    });

    const ingested = await service.ingestUsage({
      projectId: project.id,
      agentId: 'codex',
      sessionId: session.id,
      source: 'unavailable',
      confidence: 'unknown',
      observedAt: timestamp,
      metadata: {},
    });
    expect(ingested).not.toHaveProperty('totalTokens');
    await expect(
      service.ingestUsage({
        projectId: project.id,
        agentId: 'gemini',
        sessionId: session.id,
        source: 'agent-reported',
        confidence: 'reported',
        observedAt: timestamp,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'USAGE_RECORD_INVALID' });
  });

  it('uses retained raw history for combined identity usage summaries', async () => {
    const values = dependencies();
    const matchingUsage: UsageRecord = {
      id: 'usage-combined',
      projectId: project.id,
      agentId: session.agentId,
      sessionId: session.id,
      inputTokens: 100,
      source: 'agent-exact',
      confidence: 'exact',
      observedAt: timestamp,
      createdAt: timestamp,
      metadata: {},
    };
    vi.mocked(values.repository.summarizeUsage).mockResolvedValue(null);
    vi.mocked(values.repository.listUsage).mockResolvedValue({
      records: [matchingUsage],
      truncated: false,
    });
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
    });

    await expect(
      service.summarizeUsage({
        projectId: project.id,
        agentId: session.agentId,
        sessionId: session.id,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      projectId: project.id,
      agentId: session.agentId,
      sessionId: session.id,
      recordCount: 1,
      sources: [{ source: 'agent-exact', recordCount: 1, inputTokens: 100 }],
    });
  });

  it('records explicit context observations only for the bound session and known source', async () => {
    const values = dependencies();
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      createId: () => 'observation-1',
      now: () => new Date(timestamp),
    });

    const observed = await service.observeContextContribution({
      projectId: project.id,
      agentId: 'codex',
      sessionId: session.id,
      contextSourceId: contextSource.id,
      loadingMode: 'always',
      loaded: true,
      invoked: false,
      source: 'session-reported',
      confidence: 'medium',
      observedAt: timestamp,
      evidenceIds: ['bridge-event-1'],
      metadata: {},
    });
    expect(observed).toMatchObject({
      assigned: true,
      effective: true,
      loaded: true,
      invoked: false,
    });

    await expect(
      service.observeContextContribution({
        projectId: project.id,
        agentId: 'gemini',
        sessionId: session.id,
        contextSourceId: contextSource.id,
        loadingMode: 'always',
        loaded: true,
        invoked: false,
        source: 'session-reported',
        confidence: 'medium',
        observedAt: timestamp,
        evidenceIds: ['bridge-event-2'],
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_OBSERVATION_INVALID' });
  });

  it('answers a context observation without waiting for the graph projection', async () => {
    // The projection is best-effort by construction: projectIncrementally
    // swallows every error and returns void, so awaiting it inside the request
    // buys the caller nothing and costs it a full reprojection — a TypeScript
    // scan of the whole project plus a read of every node and edge in the
    // active generation. On a real fixture that is minutes, and the response
    // never arrives.
    const values = dependencies();
    let releaseProjection: (() => void) | undefined;
    // Blocks the projection at its very first Redis call, which is the step a
    // real reprojection reaches before it starts rescanning and rewriting.
    let resolveStarted: (() => void) | undefined;
    const projectionStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    values.repository.getActiveGraphGeneration = vi.fn(async () => {
      resolveStarted?.();
      await new Promise<void>((resolveHeld) => {
        releaseProjection = resolveHeld;
      });
      return 'active';
    });
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      createId: () => 'observation-slow-projection',
      now: () => new Date(timestamp),
    });

    const observed = await service.observeContextContribution({
      projectId: project.id,
      agentId: 'codex',
      sessionId: session.id,
      contextSourceId: contextSource.id,
      loadingMode: 'always',
      loaded: true,
      invoked: false,
      source: 'session-reported',
      confidence: 'medium',
      observedAt: timestamp,
      evidenceIds: ['bridge-event-slow'],
      metadata: {},
    });

    // The observation is durable before the projection is even attempted.
    expect(observed.id).toBe('observation-slow-projection');
    expect(values.repository.putContextContribution).toHaveBeenCalled();

    // And the projection really was started, so this is deferral rather than
    // a silent drop.
    await projectionStarted;
    releaseProjection?.();
  }, 15_000);

  it('coalesces concurrent projections instead of stacking one per mutation', async () => {
    // Deferring the projection freed the request, but nothing bounded how many
    // could then run at once: on the live fixture 61 reprojections ran in
    // parallel, each rescanning the project and reading the whole generation,
    // until Redis gave out and the daemon died. One runs at a time, and work
    // arriving while it runs collapses into a single follow-up, because the
    // projection rebuilds from current state — a queue of them would all
    // produce the same answer.
    const values = dependencies();
    let active = 0;
    let peak = 0;
    const started: Array<() => void> = [];
    // Blocks at the projection's first Redis call, which every run reaches
    // before the snapshot work that a bare fake would fail on.
    values.repository.getActiveGraphGeneration = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        started.push(resolve);
      });
      active -= 1;
      return 'active';
    });
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
    });

    const observe = (id: string) =>
      service.observeContextContribution({
        projectId: project.id,
        agentId: 'codex',
        sessionId: session.id,
        contextSourceId: contextSource.id,
        loadingMode: 'always',
        loaded: true,
        invoked: false,
        source: 'session-reported',
        confidence: 'medium',
        observedAt: timestamp,
        evidenceIds: [id],
        metadata: {},
      });

    await observe('a');
    await observe('b');
    await observe('c');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(peak).toBe(1);
    for (const resolve of [...started]) resolve();
  });

  it('creates findings, accepts without applying, then delegates a plan to Phase 3', async () => {
    const values = dependencies();
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      createId: (() => {
        let id = 0;
        return () => `id-${String(++id)}`;
      })(),
      now: () => new Date(timestamp),
      optimizationMinimumBaselineSessions: 1,
      oversizedContextTokens: 3000,
    });

    await service.analyzeContext(project.id, 'codex');
    const analysis = await service.analyzeOptimization({
      projectId: project.id,
      agentId: 'codex',
      minimumSessions: 1,
    });
    const proposal = analysis.proposals[0]!;
    expect(proposal.state).toBe('ready');
    expect(proposal.baseline).toMatchObject({
      effectiveConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextSourceHashes: [contextSource.hash],
      sessionIds: [session.id],
    });

    const accepted = await service.acceptProposal(proposal.id);
    expect(accepted.state).toBe('accepted');
    expect(values.createOptimizationPlan).not.toHaveBeenCalled();

    const result = await service.createConfigPlan(proposal.id, 0);
    expect(result.plan.id).toBe('config-plan-1');
    expect(result.proposal.state).toBe('accepted');
    expect(result.proposal.configPlanId).toBe('config-plan-1');
    expect(values.createOptimizationPlan).toHaveBeenCalledOnce();

    await service.recordConfigPlanApplied('config-plan-1');
    await expect(service.getProposal(proposal.id)).resolves.toMatchObject({
      state: 'applied',
      appliedAt: timestamp,
    });
  });

  it('skips duplicate Git projections when repository state is unchanged', async () => {
    const values = dependencies();
    const current: GitObservation = {
      id: 'git-current',
      projectId: project.id,
      repositoryRoot: project.canonicalPath,
      branch: 'main',
      headSha: 'a'.repeat(40),
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      branches: ['main'],
      tags: [],
      worktrees: [],
      recentCommits: [],
      observedAt: timestamp,
      repositoryStateHash: 'b'.repeat(64),
    };
    values.repository.getCurrentGitObservation = vi.fn(async () => current);
    values.repository.putGitObservation = vi.fn(async () => undefined);
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      gitObserver: {
        listTrackedFiles: vi.fn(async () => []),
        observe: vi.fn(async () => ({
          ...current,
          id: 'git-new',
          observedAt: '2026-07-30T00:05:00.000Z',
        })),
      },
    });

    await expect(service.scanGit(project.id)).resolves.toEqual(current);
    expect(values.repository.putGitObservation).not.toHaveBeenCalled();
  });
});
