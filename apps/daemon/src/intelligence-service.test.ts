import { describe, expect, it, vi } from 'vitest';

import type {
  ContextSource,
  GitObservation,
  GraphEdge,
  GraphNode,
  OptimizationProposal,
  Project,
  SessionView,
  UsageRecord,
} from '@luwi/protocol';
import { graphEdgeKindSchema, graphNodeKindSchema } from '@luwi/protocol';
import type { IntelligenceRepository } from '@luwi/redis';

import type { CodeStructureObservation } from './code-structure-observer.js';
import type { ConfigControlService } from './config-control-service.js';
import type { ControlPlaneService } from './control-plane-service.js';
import { GRAPHIFY_PROVENANCE, type GraphifyObservation } from './graphify-observer.js';
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
  const sessionFileChanges = new Map<string, Record<string, unknown>>();
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
    getSessionFileChange: vi.fn(async (id: string) => sessionFileChanges.get(id) ?? null),
    putSessionFileChange: vi.fn(async (record: Record<string, unknown>) => {
      sessionFileChanges.set(record['id'] as string, record);
    }),
    listSessionFileChanges: vi.fn(async (projectId: string) =>
      [...sessionFileChanges.values()].filter((record) => record['projectId'] === projectId),
    ),
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

  it('reports why a projection failed instead of only that it did', async () => {
    // The failure record carries a constant code, and the catch kept nothing
    // else: on the live runtime 1008 projections failed in a row on the batch
    // operation limit and no log line ever said so.
    const values = dependencies();
    const reason = new Error('The intelligence transition exceeded its operation limit.');
    // The reads a projection makes before it writes, so the run gets as far as
    // the write that fails.
    Object.assign(values.repository, {
      listPackages: vi.fn(async () => []),
      listTechnologies: vi.fn(async () => []),
      listWorkspaceLocations: vi.fn(async () => []),
      listAttributions: vi.fn(async () => []),
      getCurrentGitObservation: vi.fn(async () => null),
      replaceGraphSnapshot: vi.fn(async () => {
        throw reason;
      }),
    });
    Object.assign(values.controlPlane, {
      listAgents: vi.fn(async () => []),
      listProjectAgentBindings: vi.fn(async () => []),
    });
    const onProjectionFailure = vi.fn();
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
      onProjectionFailure,
    });

    await service.observeContextContribution({
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
      evidenceIds: ['bridge-event-failing'],
      metadata: {},
    });

    await vi.waitFor(() =>
      expect(values.repository.recordGraphProjectionFailure).toHaveBeenCalled(),
    );
    expect(onProjectionFailure).toHaveBeenCalledWith(reason, 'context-observation');
  });

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

  it('stops projecting once the runtime says it is shutting down', async () => {
    // A reprojection is minutes of Redis work, and shutdown drains for five
    // seconds. Without a stop signal the drain gives up, the connection closes,
    // and the still-running projection logs REDIS_UNAVAILABLE against a Redis
    // that is perfectly healthy — noise that reads like a fault on every clean
    // shutdown. The follow-up run is what this actually cancels: the one in
    // flight is left to finish or fail on its own.
    const values = dependencies();
    let draining = false;
    let runs = 0;
    values.repository.getActiveGraphGeneration = vi.fn(async () => {
      runs += 1;
      return 'active';
    });
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
      projectionStopped: () => draining,
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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const before = runs;

    draining = true;
    await observe('b');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(runs).toBe(before);
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

describe('daemon intelligence service — session file changes (B2)', () => {
  const change = (observedAt: string) => ({
    projectId: project.id,
    sessionId: session.id,
    relativePath: 'apps/daemon/src/app.ts',
    toolName: 'Edit',
    observedAt,
  });

  const build = () => {
    const values = dependencies();
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
      // Persist without running the whole-graph reprojection in the unit test;
      // the real edge write is covered by the Redis integration test.
      deferProjection: () => {},
    });
    return { values, service };
  };

  it('persists one aggregate per session file change and reports it projected', async () => {
    const { values, service } = build();

    const projected = await service.projectSessionFileChanges([change('2026-07-30T00:00:01.000Z')]);

    expect(projected).toBe(1);
    const stored = await values.repository.listSessionFileChanges(project.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      projectId: project.id,
      sessionId: session.id,
      relativePath: 'apps/daemon/src/app.ts',
      toolName: 'Edit',
      changeCount: 1,
    });
  });

  it('aggregates repeated changes to one file as a single relationship (E5)', async () => {
    const { values, service } = build();

    await service.projectSessionFileChanges([
      change('2026-07-30T00:00:01.000Z'),
      change('2026-07-30T00:00:03.000Z'),
      change('2026-07-30T00:00:02.000Z'),
    ]);

    const stored = await values.repository.listSessionFileChanges(project.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      changeCount: 3,
      observedAt: '2026-07-30T00:00:03.000Z',
      firstObservedAt: '2026-07-30T00:00:01.000Z',
    });
  });

  it('re-projecting an unchanged observation writes nothing and re-counts nothing (E7)', async () => {
    const { values, service } = build();

    const first = await service.projectSessionFileChanges([change('2026-07-30T00:00:01.000Z')]);
    const again = await service.projectSessionFileChanges([change('2026-07-30T00:00:01.000Z')]);

    expect(first).toBe(1);
    expect(again).toBe(0);
    expect(values.repository.putSessionFileChange).toHaveBeenCalledTimes(1);
    const stored = await values.repository.listSessionFileChanges(project.id);
    expect(stored[0]).toMatchObject({ changeCount: 1 });
  });

  it('advances the count only on a strictly newer observation', async () => {
    const { values, service } = build();

    await service.projectSessionFileChanges([change('2026-07-30T00:00:01.000Z')]);
    await service.projectSessionFileChanges([change('2026-07-30T00:00:05.000Z')]);

    const stored = await values.repository.listSessionFileChanges(project.id);
    expect(stored[0]).toMatchObject({
      changeCount: 2,
      observedAt: '2026-07-30T00:00:05.000Z',
      firstObservedAt: '2026-07-30T00:00:01.000Z',
    });
  });

  it('reuses the existing SESSION_CHANGED_FILE edge kind and file node kind, adding none', () => {
    expect(graphEdgeKindSchema.options).toContain('SESSION_CHANGED_FILE');
    expect(graphNodeKindSchema.options).toContain('file');
  });
});

describe('daemon intelligence service — graphify layer (ADR 0029)', () => {
  const structure: CodeStructureObservation = {
    files: ['src/a.ts', 'src/b.ts'],
    imports: [
      {
        fromPath: 'src/a.ts',
        toPath: 'src/b.ts',
        specifier: './b.js',
        confidence: 'high',
        dynamic: false,
        line: 1,
      },
    ],
    exports: [{ path: 'src/a.ts', symbol: 'a', line: 1 }],
    observedAt: timestamp,
    evidenceScope: 'filesystem',
    truncated: false,
    skippedFileCount: 0,
    externalImportCount: 0,
  };
  const graphify: GraphifyObservation = {
    files: [
      { relativePath: 'src/a.ts', symbolCount: 3, communityCount: 1, community: 'core' },
      { relativePath: 'lib/legacy.php', symbolCount: 2, communityCount: 1, community: 'legacy' },
    ],
    imports: [
      { fromPath: 'src/a.ts', toPath: 'src/b.ts', confidence: 'medium', line: 1 },
      { fromPath: 'lib/legacy.php', toPath: 'src/a.ts', confidence: 'low', line: 4 },
    ],
    builtAtCommit: 'c'.repeat(40),
    observedAt: '2026-07-29T00:00:00.000Z',
    truncated: false,
    skippedNodeCount: 0,
    skippedLinkCount: 0,
    externalImportCount: 0,
    otherRelationCount: 0,
  };
  const commitTouching = (...changedPaths: string[]): GitObservation =>
    ({
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
      recentCommits: [{ sha: 'd'.repeat(40), committedAt: timestamp, changedPaths, merge: false }],
      observedAt: timestamp,
      repositoryStateHash: 'b'.repeat(64),
    }) as unknown as GitObservation;

  /** The real service over the shared fakes plus the rebuild path's own repository calls. */
  const harness = (
    overrides: {
      git?: GitObservation;
      observe?: () => Promise<GraphifyObservation | null>;
      repository?: Record<string, unknown>;
      renewIntervalMs?: number;
      gitObserver?: NonNullable<Parameters<typeof createIntelligenceService>[0]['gitObserver']>;
    } = {},
  ) => {
    const values = dependencies();
    Object.assign(values.repository, {
      listPackages: vi.fn(async () => []),
      listTechnologies: vi.fn(async () => []),
      listWorkspaceLocations: vi.fn(async () => []),
      listAttributions: vi.fn(async () => []),
      getCurrentGitObservation: vi.fn(async () => overrides.git ?? null),
      beginGraphRebuild: vi.fn(async () => undefined),
      updateGraphRebuild: vi.fn(async () => undefined),
      validateGraphGeneration: vi.fn(async () => undefined),
      activateGraphGeneration: vi.fn(async () => undefined),
      failGraphRebuild: vi.fn(async () => undefined),
      renewGraphRebuildLock: vi.fn(async () => true),
      ...overrides.repository,
    });
    Object.assign(values.controlPlane, {
      listAgents: vi.fn(async () => []),
      listProjectAgentBindings: vi.fn(async () => []),
    });
    const scan = vi.fn(async () => structure);
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
      codeStructureObserver: { scan },
      graphifyObserver: { observe: overrides.observe ?? vi.fn(async () => graphify) },
      ...(overrides.gitObserver === undefined ? {} : { gitObserver: overrides.gitObserver }),
      ...(overrides.renewIntervalMs === undefined
        ? {}
        : { graphRebuildRenewIntervalMs: overrides.renewIntervalMs }),
    });
    return { service, values, scan };
  };

  /** Runs the real rebuild path and hands back what it wrote. */
  const rebuild = async (overrides: Parameters<typeof harness>[0] = {}) => {
    const { service, values } = harness(overrides);
    const operation = await service.rebuildGraph();
    const nodes = vi.mocked(values.repository.putGraphNode).mock.calls.map(([, node]) => node);
    const edges = vi.mocked(values.repository.putGraphEdge).mock.calls.map(([, edge]) => edge);
    const file = (relativePath: string): GraphNode => {
      const found = nodes.find(
        (node) => node.kind === 'file' && node.metadata['relativePath'] === relativePath,
      );
      if (found === undefined) throw new Error(`no file node for ${relativePath}`);
      return found;
    };
    const importsBetween = (from: GraphNode, to: GraphNode): GraphEdge[] =>
      edges.filter(
        (edge) =>
          edge.kind === 'FILE_IMPORTS_FILE' &&
          edge.source.id === from.entityId &&
          edge.target.id === to.entityId,
      );
    return { operation, nodes, edges, file, importsBetween, values };
  };

  it('scans the structure of the git-tracked files only, as the package inventory does', async () => {
    // A filesystem walk follows untracked worktree copies and build output: on
    // one registered project it read 20 000 files for 350 s where git tracks
    // 250, and the projection that waits on it never finished inside a tick.
    const { service, scan } = harness({
      gitObserver: {
        observe: vi.fn(),
        listTrackedFiles: vi.fn(async () => ['src/a.ts', 'src/b.ts']),
      },
    });

    await service.rebuildGraph();

    expect(scan).toHaveBeenCalledWith({
      localPath: project.canonicalPath,
      trackedPaths: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('walks the filesystem when the tracked files cannot be listed', async () => {
    const { service, scan } = harness({
      gitObserver: {
        observe: vi.fn(),
        listTrackedFiles: vi.fn(async () => {
          throw new Error('not a repository');
        }),
      },
    });

    await service.rebuildGraph();

    expect(scan).toHaveBeenCalledWith({ localPath: project.canonicalPath });
  });

  it('reuses a project structure scan while its git state hash is unchanged', async () => {
    // The whole-fleet reprojection fires on any one project's git flip, but a
    // project whose repositoryStateHash did not change must not re-parse its
    // tracked files (the ~31s loop-blocking TS scan) every time.
    const { service, scan } = harness({
      git: commitTouching('src/a.ts'),
      gitObserver: {
        observe: vi.fn(),
        listTrackedFiles: vi.fn(async () => ['src/a.ts', 'src/b.ts']),
      },
    });

    await service.rebuildGraph();
    await service.rebuildGraph();

    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('re-scans a project structure when its git state hash changes', async () => {
    const changed = {
      ...commitTouching('src/a.ts'),
      repositoryStateHash: 'e'.repeat(64),
    } as unknown as GitObservation;
    const getCurrentGitObservation = vi
      .fn()
      .mockResolvedValueOnce(commitTouching('src/a.ts'))
      .mockResolvedValue(changed);
    const { service, scan } = harness({
      gitObserver: {
        observe: vi.fn(),
        listTrackedFiles: vi.fn(async () => ['src/a.ts', 'src/b.ts']),
      },
      repository: { getCurrentGitObservation },
    });

    await service.rebuildGraph();
    await service.rebuildGraph();

    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('adds the files the structural observer could not see, with provenance and bounded metadata', async () => {
    const { operation, file, importsBetween } = await rebuild();

    expect(operation.state).toBe('completed');
    const legacy = file('lib/legacy.php');
    expect(legacy).toMatchObject({
      provenance: GRAPHIFY_PROVENANCE,
      confidence: 'high',
      observedAt: graphify.observedAt,
      evidenceIds: ['lib/legacy.php'],
      metadata: {
        relativePath: 'lib/legacy.php',
        symbolCount: 2,
        communityCount: 1,
        community: 'legacy',
        builtAtCommit: 'c'.repeat(40),
      },
    });
    expect(importsBetween(legacy, file('src/a.ts'))).toEqual([
      expect.objectContaining({
        provenance: GRAPHIFY_PROVENANCE,
        confidence: 'low',
        evidenceIds: ['lib/legacy.php:4'],
      }),
    ]);
  });

  it('fills without replacing: the structural observer keeps its file and its import', async () => {
    const { file, importsBetween } = await rebuild();

    const a = file('src/a.ts');
    expect(a).toMatchObject({
      provenance: 'code-structure-observer@1',
      metadata: { exportCount: 1 },
    });
    expect(a.metadata).not.toHaveProperty('symbolCount');
    expect(importsBetween(a, file('src/b.ts'))).toEqual([
      expect.objectContaining({ provenance: 'code-structure-observer@1', confidence: 'high' }),
    ]);
  });

  it('lets a commit path prove a file no observer saw, without replacing one they did', async () => {
    const { file } = await rebuild({
      git: commitTouching('src/a.ts', 'lib/legacy.php', 'docs/notes.md'),
    });

    expect(file('src/a.ts').provenance).toBe('code-structure-observer@1');
    expect(file('lib/legacy.php').provenance).toBe(GRAPHIFY_PROVENANCE);
    expect(file('docs/notes.md').provenance).toBe('git-commit-path');
  });

  it('leaves the layer out when there is no output or the read fails; the rebuild still completes', async () => {
    const unreadable = async (): Promise<GraphifyObservation | null> => {
      throw new Error('unreadable');
    };
    for (const observe of [async () => null, unreadable]) {
      const { operation, nodes, file } = await rebuild({ observe });

      expect(operation.state).toBe('completed');
      expect(nodes.some((node) => node.provenance === GRAPHIFY_PROVENANCE)).toBe(false);
      expect(file('src/a.ts').provenance).toBe('code-structure-observer@1');
    }
  });
});

describe('daemon intelligence service — rebuild lock and failure reasons', () => {
  const structure: CodeStructureObservation = {
    files: ['src/a.ts'],
    imports: [],
    exports: [],
    observedAt: timestamp,
    evidenceScope: 'filesystem',
    truncated: false,
    skippedFileCount: 0,
    externalImportCount: 0,
  };
  /** A graphify read slow enough for the renewal timer to fire several times. */
  const slow = async (): Promise<GraphifyObservation | null> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return null;
  };
  const harness = (
    overrides: { repository?: Record<string, unknown>; renewIntervalMs?: number } = {},
  ) => {
    const values = dependencies();
    Object.assign(values.repository, {
      listPackages: vi.fn(async () => []),
      listTechnologies: vi.fn(async () => []),
      listWorkspaceLocations: vi.fn(async () => []),
      listAttributions: vi.fn(async () => []),
      beginGraphRebuild: vi.fn(async () => undefined),
      updateGraphRebuild: vi.fn(async () => undefined),
      validateGraphGeneration: vi.fn(async () => undefined),
      activateGraphGeneration: vi.fn(async () => undefined),
      failGraphRebuild: vi.fn(async () => undefined),
      renewGraphRebuildLock: vi.fn(async () => true),
      ...overrides.repository,
    });
    Object.assign(values.controlPlane, {
      listAgents: vi.fn(async () => []),
      listProjectAgentBindings: vi.fn(async () => []),
    });
    const service = createIntelligenceService({
      ...values,
      workspaceId: 'local',
      now: () => new Date(timestamp),
      codeStructureObserver: { scan: vi.fn(async () => structure) },
      graphifyObserver: { observe: slow },
      ...(overrides.renewIntervalMs === undefined
        ? {}
        : { graphRebuildRenewIntervalMs: overrides.renewIntervalMs }),
    });
    return { service, values };
  };

  it('renews the lock for as long as the rebuild runs, and not after', async () => {
    const { service, values } = harness({ renewIntervalMs: 5 });

    const operation = await service.rebuildGraph();

    const renew = vi.mocked(values.repository.renewGraphRebuildLock);
    expect(operation.state).toBe('completed');
    expect(renew.mock.calls.length).toBeGreaterThan(0);
    expect(renew).toHaveBeenCalledWith(operation.id);
    const renewals = renew.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(renew.mock.calls.length).toBe(renewals);
  });

  it('stops before writing a generation it could not activate, and says why', async () => {
    const { service, values } = harness({
      renewIntervalMs: 5,
      repository: { renewGraphRebuildLock: vi.fn(async () => false) },
    });

    await expect(service.rebuildGraph()).rejects.toMatchObject({
      code: 'GRAPH_REBUILD_FAILED',
      message: expect.stringContaining('lock was lost') as string,
    });
    expect(values.repository.putGraphNode).not.toHaveBeenCalled();
    const [failed] = vi.mocked(values.repository.failGraphRebuild).mock.calls[0] ?? [];
    expect(failed?.failureSummary[0]).toContain('lock was lost');
  });

  it('records the real reason for a failed rebuild instead of a constant', async () => {
    const { service, values } = harness({
      repository: {
        validateGraphGeneration: vi.fn(async () => {
          throw new Error('The shadow graph counts did not match the rebuild result.');
        }),
      },
    });

    await expect(service.rebuildGraph()).rejects.toMatchObject({
      message:
        'The graph rebuild failed: The shadow graph counts did not match the rebuild result.',
    });
    const [failed] = vi.mocked(values.repository.failGraphRebuild).mock.calls[0] ?? [];
    expect(failed).toMatchObject({
      state: 'failed',
      failureSummary: ['The shadow graph counts did not match the rebuild result.'],
    });
  });

  it('keeps the original reason when the failure itself cannot be recorded', async () => {
    const { service } = harness({
      repository: {
        validateGraphGeneration: vi.fn(async () => {
          throw new Error('counts did not match');
        }),
        failGraphRebuild: vi.fn(async () => {
          throw new Error('Redis rejected the graph rebuild transition.');
        }),
      },
    });

    await expect(service.rebuildGraph()).rejects.toMatchObject({
      message:
        'The graph rebuild failed: counts did not match (recording the failure was refused: Redis rejected the graph rebuild transition.)',
    });
  });
});
