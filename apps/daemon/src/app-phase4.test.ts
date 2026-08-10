import type { Project, UsageRecord } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { IntelligenceService } from './intelligence-service.js';
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
const usage: UsageRecord = {
  id: 'usage-1',
  projectId: project.id,
  agentId: 'codex',
  sessionId: 'session-1',
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  source: 'agent-exact',
  confidence: 'exact',
  observedAt: timestamp,
  createdAt: timestamp,
  metadata: {},
};

class HealthyRedis implements RedisGateway {
  async connect(): Promise<boolean> {
    return true;
  }
  async checkHealth(): Promise<RedisHealth> {
    return { connected: true, status: 'connected', latencyMs: 1 };
  }
  async close(): Promise<void> {}
}

describe('Phase 4 HTTP routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  function createApp(intelligence: IntelligenceService) {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    app = buildDaemon({
      config: {
        host: '127.0.0.1',
        port: 80,
        redisUrl: 'redis://127.0.0.1:6379',
        logLevel: 'silent',
        workspaceId: 'local',
      },
      redis: new HealthyRedis(),
      logger: false,
      readiness,
      runtimeState: () => readiness.state,
      services: {
        projects: {
          register: async () => project,
          get: async () => project,
          list: async () => [project],
        } as ProjectService,
        sessions: { list: async () => [] } as unknown as SessionService,
        intelligence,
        listEvents: async () => [],
      },
    });
    return { app, readiness };
  }

  it('ingests usage and returns source-composed summaries without filling missing fields', async () => {
    const ingestUsage = vi.fn(async () => usage);
    const summarizeUsage = vi.fn(async () => ({
      projectId: project.id,
      recordCount: 1,
      sources: [
        {
          source: 'agent-exact' as const,
          recordCount: 1,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      ],
      observedFrom: timestamp,
      observedTo: timestamp,
    }));
    createApp({ ingestUsage, summarizeUsage } as unknown as IntelligenceService);

    const created = await app!.inject({
      method: 'POST',
      url: '/api/v1/usage',
      headers: { 'idempotency-key': 'bridge-observation-1' },
      payload: {
        projectId: project.id,
        agentId: 'codex',
        sessionId: 'session-1',
        source: 'agent-exact',
        confidence: 'exact',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        observedAt: timestamp,
        metadata: {},
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe('/api/v1/usage/usage-1');
    expect(ingestUsage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceEventId: 'bridge-observation-1' }),
    );

    const summary = await app!.inject({
      method: 'GET',
      url: '/api/v1/usage/summary?projectId=project-1',
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().sources[0]).toMatchObject({
      source: 'agent-exact',
      totalTokens: 120,
    });
    expect(summary.json()).not.toHaveProperty('cachedInputTokens');
  });

  it('accepts a validated context observation through the mutation boundary', async () => {
    const observeContextContribution = vi.fn(async (input) => ({
      id: 'observed-context-1',
      ...input,
      assigned: true,
      effective: true,
      metadata: input.metadata ?? {},
    }));
    createApp({ observeContextContribution } as unknown as IntelligenceService);

    const response = await app!.inject({
      method: 'POST',
      url: '/api/v1/context/contributions',
      payload: {
        projectId: project.id,
        agentId: 'codex',
        sessionId: 'session-1',
        contextSourceId: 'source-1',
        capabilityId: 'broad-mcp',
        loadingMode: 'conditional',
        loaded: true,
        invoked: true,
        source: 'session-reported',
        confidence: 'medium',
        observedAt: timestamp,
        evidenceIds: ['bridge-event-1'],
        metadata: { toolName: 'status' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(observeContextContribution).toHaveBeenCalledWith(
      expect.objectContaining({ loaded: true, invoked: true }),
    );
  });

  it('serves the global graph summary without touching a rebuild', async () => {
    const graphSummary = vi.fn(async () => ({
      observed: true,
      generation: 'generation-1',
      retainedGenerationCount: 2,
      projectionHealth: 'healthy' as const,
      nodeCount: 7,
      edgeCount: 4,
      nodeCountsByKind: [
        { kind: 'project' as const, count: 2 },
        { kind: 'session' as const, count: 5 },
      ],
      edgeCountsByKind: [{ kind: 'PROJECT_BOUND_AGENT' as const, count: 4 }],
      observedAt: timestamp,
    }));
    const rebuildGraph = vi.fn();
    createApp({ graphSummary, rebuildGraph } as unknown as IntelligenceService);

    const response = await app!.inject({ method: 'GET', url: '/api/v1/graph/summary' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      observed: true,
      generation: 'generation-1',
      nodeCount: 7,
      edgeCount: 4,
    });
    expect(graphSummary).toHaveBeenCalledTimes(1);
    // A read surface never provokes a projection. AGENTS.md section 12.
    expect(rebuildGraph).not.toHaveBeenCalled();
  });

  it('refuses to serve a summary that claims a generation without totals', async () => {
    // Violates the ADR 0013 refinement. The contradiction never reaches the client,
    // and per ADR 0015 the server's own output failing validation is a server error,
    // not a request error.
    const graphSummary = vi.fn(async () => ({
      observed: true,
      retainedGenerationCount: 0,
      projectionHealth: 'healthy' as const,
      nodeCountsByKind: [],
      edgeCountsByKind: [],
      observedAt: timestamp,
    }));
    createApp({ graphSummary } as unknown as IntelligenceService);

    const response = await app!.inject({ method: 'GET', url: '/api/v1/graph/summary' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty('observed');
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
  });

  it('maps bounded graph and optimization routes without direct apply', async () => {
    const graphPath = vi.fn(async () => ({ found: false, nodes: [], edges: [] }));
    const acceptProposal = vi.fn(async () => ({
      id: 'proposal-1',
      projectId: project.id,
      findingIds: ['finding-1'],
      title: 'Proposal',
      summary: 'Acceptance does not modify files.',
      proposedActions: [
        {
          kind: 'convert-source-to-reference-only' as const,
          contextSourceId: 'source-1',
        },
      ],
      evidenceWindow: { startedAt: timestamp, endedAt: timestamp, sessionCount: 3 },
      confidence: 'medium' as const,
      state: 'accepted' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    createApp({ graphPath, acceptProposal } as unknown as IntelligenceService);

    const path = await app!.inject({
      method: 'GET',
      url: '/api/v1/graph/path?fromKind=project&fromId=project-1&toKind=session&toId=session-1&maxDepth=3',
    });
    expect(path.statusCode).toBe(200);
    expect(graphPath).toHaveBeenCalledWith(
      'project',
      'project-1',
      expect.objectContaining({ toKind: 'session', maxDepth: 3 }),
    );

    const unbounded = await app!.inject({
      method: 'GET',
      url: '/api/v1/graph/path?fromKind=project&fromId=project-1&toKind=session&toId=session-1&maxDepth=7',
    });
    expect(unbounded.statusCode).toBe(400);

    const accepted = await app!.inject({
      method: 'POST',
      url: '/api/v1/optimization/proposals/proposal-1/accept',
      payload: { accepted: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().state).toBe('accepted');
    expect(accepted.json()).not.toHaveProperty('operationId');
  });

  it('exposes the remaining Phase 4 routes through validated bounded service calls', async () => {
    const contribution = {
      id: 'contribution-1',
      projectId: project.id,
      agentId: 'codex',
      contextSourceId: 'source-1',
      loadingMode: 'conditional' as const,
      assigned: true as const,
      effective: true as const,
      loaded: 'unknown' as const,
      invoked: 'unknown' as const,
      source: 'effective-config' as const,
      confidence: 'medium' as const,
      observedAt: timestamp,
      evidenceIds: ['config-1'],
      metadata: {},
    };
    const contextSummary = {
      projectId: project.id,
      agentId: 'codex',
      contributionCount: 1,
      assignedCount: 1,
      effectiveCount: 1,
      observedLoadedCount: 0,
      observedInvokedCount: 0,
      unknownLoadedCount: 1,
      sourceComposition: { 'effective-config': 1 },
      measuredAt: timestamp,
    };
    const gitObservation = {
      id: 'git-1',
      projectId: project.id,
      repositoryRoot: 'C:/sandbox',
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
    const node = {
      id: 'project:project-1',
      kind: 'project' as const,
      entityId: project.id,
      projectId: project.id,
      observedAt: timestamp,
      provenance: 'project.registered',
      confidence: 'high' as const,
      evidenceIds: ['project-1'],
      metadata: {},
    };
    const rebuild = {
      id: 'rebuild-1',
      state: 'completed' as const,
      shadowGeneration: 'generation-2',
      activeGeneration: 'generation-2',
      processedEvents: 1,
      nodeCount: 1,
      edgeCount: 0,
      failureCount: 0,
      failureSummary: [],
      startedAt: timestamp,
      completedAt: timestamp,
    };
    const finding = {
      id: 'finding-1',
      projectId: project.id,
      kind: 'oversized-always-loaded-source' as const,
      title: 'Oversized context',
      summary: 'The structural estimate exceeds the configured threshold.',
      state: 'open' as const,
      evidenceWindow: {
        startedAt: timestamp,
        endedAt: timestamp,
        sessionCount: 3,
        observationCount: 3,
      },
      confidence: 'medium' as const,
      evidenceIds: ['source-1'],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const proposal = {
      id: 'proposal-1',
      projectId: project.id,
      findingIds: [finding.id],
      title: 'Conditional context loading',
      summary: 'Use conditional loading after explicit approval.',
      proposedActions: [
        {
          kind: 'change-loading-mode' as const,
          contextSourceId: 'source-1',
          loadingMode: 'conditional' as const,
        },
      ],
      evidenceWindow: { startedAt: timestamp, endedAt: timestamp, sessionCount: 3 },
      confidence: 'medium' as const,
      state: 'ready' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const evaluation = {
      id: 'evaluation-1',
      proposalId: proposal.id,
      projectId: project.id,
      state: 'inconclusive' as const,
      baseline: { sessionCount: 3, estimatedContextTokens: 4000 },
      postChange: { sessionCount: 1, estimatedContextTokens: 3000 },
      summary: 'Observed evidence is not sufficient for a conclusion.',
      causalClaim: false as const,
      startedAt: timestamp,
      completedAt: timestamp,
    };
    const intelligence = {
      listUsage: vi.fn(async () => ({ records: [usage], truncated: false })),
      summarizeUsage: vi.fn(async () => ({
        projectId: project.id,
        recordCount: 1,
        sources: [{ source: usage.source, recordCount: 1, inputTokens: usage.inputTokens }],
        observedFrom: timestamp,
        observedTo: timestamp,
        earliestAvailableAt: timestamp,
      })),
      listContextContributions: vi.fn(async () => [contribution]),
      contextSummary: vi.fn(async () => contextSummary),
      analyzeContext: vi.fn(async () => ({
        summary: contextSummary,
        contributions: [contribution],
        findings: [finding],
      })),
      getContextIntelligence: vi.fn(async () => ({
        summary: contextSummary,
        contributions: [contribution],
        findings: [finding],
      })),
      scanGit: vi.fn(async () => gitObservation),
      getGit: vi.fn(async () => gitObservation),
      listGitCommits: vi.fn(async () => []),
      listGitWorktrees: vi.fn(async () => []),
      listAttributions: vi.fn(async () => []),
      scanPackages: vi.fn(async () => ({
        packages: [],
        technologies: [],
        scannedAt: timestamp,
      })),
      listPackages: vi.fn(async () => []),
      listTechnologies: vi.fn(async () => []),
      getGraphNode: vi.fn(async () => node),
      graphNeighbors: vi.fn(async () => ({
        node,
        nodes: [],
        edges: [],
        truncated: false,
      })),
      graphSubgraph: vi.fn(async () => ({ nodes: [node], edges: [], truncated: false })),
      rebuildGraph: vi.fn(async () => rebuild),
      getGraphRebuild: vi.fn(async () => rebuild),
      analyzeOptimization: vi.fn(async () => ({
        findings: [finding],
        proposals: [proposal],
        analyzedAt: timestamp,
      })),
      listFindings: vi.fn(async () => [finding]),
      listProposals: vi.fn(async () => [proposal]),
      getProposal: vi.fn(async () => proposal),
      rejectProposal: vi.fn(async () => ({ ...proposal, state: 'rejected' as const })),
      createConfigPlan: vi.fn(async () => ({
        proposal: { ...proposal, state: 'accepted' as const, configPlanId: 'plan-1' },
        plan: { id: 'plan-1' },
      })),
      evaluateProposal: vi.fn(async () => evaluation),
      getEvaluation: vi.fn(async () => evaluation),
    } as unknown as IntelligenceService;
    createApp(intelligence);

    const requests = [
      ['GET', '/api/v1/usage?projectId=project-1'],
      ['GET', '/api/v1/context/contributions?projectId=project-1'],
      ['GET', '/api/v1/context/summary?projectId=project-1&agentId=codex'],
      ['POST', '/api/v1/context/analyze', { projectId: project.id, agentId: 'codex' }],
      ['GET', '/api/v1/projects/project-1/agents/codex/context-intelligence'],
      ['POST', '/api/v1/projects/project-1/git/scan'],
      ['GET', '/api/v1/projects/project-1/git'],
      ['GET', '/api/v1/projects/project-1/git/commits?limit=10'],
      ['GET', '/api/v1/projects/project-1/git/worktrees'],
      ['GET', '/api/v1/projects/project-1/git/attributions?limit=10'],
      ['POST', '/api/v1/projects/project-1/packages/scan'],
      ['GET', '/api/v1/projects/project-1/packages?limit=10'],
      ['GET', '/api/v1/projects/project-1/technologies?limit=10'],
      ['GET', '/api/v1/graph/nodes/project/project-1'],
      ['GET', '/api/v1/graph/nodes/project/project-1/out?limit=10'],
      ['GET', '/api/v1/graph/nodes/project/project-1/in?limit=10'],
      ['GET', '/api/v1/graph/subgraph?nodeKind=project&nodeId=project-1'],
      ['POST', '/api/v1/graph/rebuild'],
      ['GET', '/api/v1/graph/rebuild/rebuild-1'],
      ['POST', '/api/v1/optimization/analyze', { projectId: project.id }],
      ['GET', '/api/v1/optimization/findings?projectId=project-1'],
      ['GET', '/api/v1/optimization/proposals?projectId=project-1'],
      ['GET', '/api/v1/optimization/proposals/proposal-1'],
      ['POST', '/api/v1/optimization/proposals/proposal-1/reject', { reason: 'fixture' }],
      ['POST', '/api/v1/optimization/proposals/proposal-1/create-config-plan', {}],
      ['POST', '/api/v1/optimization/proposals/proposal-1/evaluate', {}],
      ['GET', '/api/v1/optimization/evaluations/evaluation-1'],
    ] as const;
    for (const [method, url, payload] of requests) {
      const response = await app!.inject({
        method,
        url,
        // A state-changing request that carries no Origin must declare a JSON
        // media type, and `inject` only sets that header when a payload is
        // present. Every real caller sends `{}` rather than nothing for these,
        // which is what `scripts/seed-runtime.ts` does.
        ...(method === 'GET' ? {} : { payload: payload ?? {} }),
      });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
    }
    expect(intelligence.createConfigPlan).toHaveBeenCalledOnce();
    expect(intelligence.evaluateProposal).toHaveBeenCalledOnce();
  });
});
