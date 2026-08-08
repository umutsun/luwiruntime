import { describe, expect, it } from 'vitest';

import {
  attributionRecordSchema,
  contextContributionObservationRequestSchema,
  contextContributionSchema,
  gitObservationSchema,
  graphEdgeSchema,
  graphNeighborsQuerySchema,
  graphNodeSchema,
  graphPathQuerySchema,
  graphSummarySchema,
  optimizationEvaluationSchema,
  optimizationProposalSchema,
  packageScanResponseSchema,
  packageRecordSchema,
  technologyRecordSchema,
  usageIngestRequestSchema,
  usageRecordSchema,
} from './intelligence.js';

const timestamp = '2026-07-30T00:00:00.000Z';

describe('Phase 4 intelligence protocol', () => {
  it.each([
    'agent-exact',
    'agent-reported',
    'adapter-extracted',
    'luwi-estimated',
    'unavailable',
  ] as const)('accepts the %s usage source without inventing missing values', (source) => {
    const confidence = {
      'agent-exact': 'exact',
      'agent-reported': 'reported',
      'adapter-extracted': 'reported',
      'luwi-estimated': 'estimated',
      unavailable: 'unknown',
    } as const;
    const result = usageRecordSchema.parse({
      id: `usage-${source}`,
      projectId: 'project-1',
      agentId: 'codex',
      sessionId: 'session-1',
      source,
      confidence: confidence[source],
      observedAt: timestamp,
      createdAt: timestamp,
      metadata: {},
    });

    expect(result.source).toBe(source);
    expect(result.inputTokens).toBeUndefined();
    expect(result.totalTokens).toBeUndefined();
  });

  it('accepts consistent optional token fields and rejects inconsistent totals', () => {
    expect(
      usageIngestRequestSchema.parse({
        projectId: 'project-1',
        agentId: 'gemini',
        sessionId: 'session-1',
        source: 'agent-reported',
        confidence: 'reported',
        provider: 'fixture-provider',
        inputTokens: 100,
        outputTokens: 25,
        cachedOutputTokens: 5,
        totalTokens: 125,
        observedAt: timestamp,
        metadata: {},
      }).totalTokens,
    ).toBe(125);
    expect(() =>
      usageIngestRequestSchema.parse({
        projectId: 'project-1',
        agentId: 'gemini',
        sessionId: 'session-1',
        source: 'luwi-estimated',
        confidence: 'reported',
        observedAt: timestamp,
        metadata: {},
      }),
    ).toThrow();

    expect(() =>
      usageIngestRequestSchema.parse({
        projectId: 'project-1',
        agentId: 'gemini',
        sessionId: 'session-1',
        source: 'agent-reported',
        confidence: 'reported',
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 124,
        observedAt: timestamp,
        metadata: {},
      }),
    ).toThrow();
  });

  it('bounds intelligence metadata and rejects prompt, response, or secret-bearing fields', () => {
    const base = {
      projectId: 'project-1',
      agentId: 'gemini',
      sessionId: 'session-1',
      source: 'agent-reported' as const,
      confidence: 'reported' as const,
      observedAt: timestamp,
    };
    expect(() =>
      usageIngestRequestSchema.parse({
        ...base,
        metadata: { prompt: 'complete prompt must not be retained' },
      }),
    ).toThrow();
    expect(() =>
      usageIngestRequestSchema.parse({
        ...base,
        metadata: { nested: { apiKey: 'secret' } },
      }),
    ).toThrow();
    expect(() =>
      usageIngestRequestSchema.parse({
        ...base,
        metadata: { value: 'x'.repeat(17_000) },
      }),
    ).toThrow();
  });

  it('validates context contribution facts independently', () => {
    const value = contextContributionSchema.parse({
      id: 'contribution-1',
      projectId: 'project-1',
      agentId: 'codex',
      sessionId: 'session-1',
      contextSourceId: 'source-1',
      loadingMode: 'conditional',
      assigned: true,
      effective: true,
      loaded: 'unknown',
      invoked: false,
      source: 'session-reported',
      confidence: 'medium',
      observedAt: timestamp,
      evidenceIds: ['event-1'],
      metadata: {},
    });

    expect(value).toMatchObject({ assigned: true, loaded: 'unknown', invoked: false });
  });

  it('accepts only explicit adapter or session context observations', () => {
    const observation = contextContributionObservationRequestSchema.parse({
      projectId: 'project-1',
      agentId: 'codex',
      sessionId: 'session-1',
      contextSourceId: 'source-1',
      capabilityId: 'mcp-wide',
      loadingMode: 'conditional',
      loaded: true,
      invoked: true,
      source: 'session-reported',
      confidence: 'medium',
      observedAt: timestamp,
      evidenceIds: ['bridge-event-1'],
      metadata: { toolName: 'status' },
    });

    expect(observation).toMatchObject({ loaded: true, invoked: true });
    expect(() =>
      contextContributionObservationRequestSchema.parse({
        ...observation,
        source: 'effective-config',
      }),
    ).toThrow();
    expect(() =>
      contextContributionObservationRequestSchema.parse({
        ...observation,
        loaded: false,
        invoked: true,
      }),
    ).toThrow();
  });

  it('validates bounded Git, package, technology, and attribution records', () => {
    expect(
      gitObservationSchema.parse({
        id: 'git-1',
        projectId: 'project-1',
        repositoryRoot: 'C:/repo',
        branch: 'main',
        headSha: 'a'.repeat(40),
        clean: false,
        stagedCount: 1,
        unstagedCount: 2,
        untrackedCount: 3,
        ahead: 0,
        behind: 0,
        branches: ['main'],
        tags: ['v1'],
        worktrees: [{ path: 'C:/repo', headSha: 'a'.repeat(40), branch: 'main' }],
        recentCommits: [],
        observedAt: timestamp,
        repositoryStateHash: 'b'.repeat(64),
      }).untrackedCount,
    ).toBe(3);

    expect(
      packageRecordSchema.parse({
        id: 'npm:zod',
        projectId: 'project-1',
        ecosystem: 'node',
        packageName: 'zod',
        declaredVersion: '^4.0.0',
        dependencyType: 'production',
        direct: true,
        workspaceLocation: '.',
        manifestPath: 'package.json',
        detectedAt: timestamp,
        manifestHash: 'c'.repeat(64),
      }).direct,
    ).toBe(true);

    expect(
      technologyRecordSchema.parse({
        id: 'technology:typescript',
        projectId: 'project-1',
        name: 'TypeScript',
        category: 'language',
        confidence: 'high',
        evidence: [{ kind: 'file-pattern', value: '*.ts' }],
        detectedAt: timestamp,
      }).name,
    ).toBe('TypeScript');

    expect(
      attributionRecordSchema.parse({
        id: 'attribution-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        commitSha: 'd'.repeat(40),
        confidence: 'correlated',
        observedAt: timestamp,
        evidenceIds: ['git-1'],
        reasons: ['branch-and-time-window'],
      }).confidence,
    ).toBe('correlated');
  });

  it('requires package scans to disclose truncation and evidence scope', () => {
    expect(
      packageScanResponseSchema.parse({
        packages: [],
        technologies: [],
        scannedAt: timestamp,
        truncated: true,
        evidenceScope: 'git-tracked',
      }),
    ).toMatchObject({ truncated: true, evidenceScope: 'git-tracked' });
    expect(() =>
      packageScanResponseSchema.parse({
        packages: [],
        technologies: [],
        scannedAt: timestamp,
      }),
    ).toThrow();
  });

  it('requires graph provenance and enforces traversal bounds', () => {
    expect(
      graphNodeSchema.parse({
        id: 'project:project-1',
        kind: 'project',
        entityId: 'project-1',
        projectId: 'project-1',
        observedAt: timestamp,
        provenance: 'runtime-projection',
        confidence: 'high',
        evidenceIds: ['project-event'],
        metadata: {},
      }).kind,
    ).toBe('project');

    expect(
      graphEdgeSchema.parse({
        id: 'edge-1',
        source: { kind: 'project', id: 'project-1' },
        target: { kind: 'agent', id: 'codex' },
        kind: 'PROJECT_BOUND_AGENT',
        projectId: 'project-1',
        observedAt: timestamp,
        provenance: 'runtime-event',
        confidence: 'high',
        evidenceIds: ['binding-event'],
        metadata: {},
      }).kind,
    ).toBe('PROJECT_BOUND_AGENT');

    expect(graphNeighborsQuerySchema.parse({ limit: 1000 }).limit).toBe(1000);
    expect(() => graphNeighborsQuerySchema.parse({ limit: 1001 })).toThrow();
    expect(graphPathQuerySchema.parse({ toKind: 'session', toId: 's1' }).maxDepth).toBe(3);
    expect(() =>
      graphPathQuerySchema.parse({ toKind: 'session', toId: 's1', maxDepth: 7 }),
    ).toThrow();
  });

  it('carries structural edge kinds alongside the event-derived ones', () => {
    const structural = ['FILE_IMPORTS_FILE', 'MODULE_DEPENDS_ON_MODULE'] as const;

    for (const kind of structural) {
      const edge = graphEdgeSchema.parse({
        id: `edge-${kind}`,
        source: { kind: 'file', id: 'file-a' },
        target: { kind: 'file', id: 'file-b' },
        kind,
        projectId: 'project-1',
        observedAt: timestamp,
        // ADR 0012: provenance identifies the extractor and its version, so a
        // structural edge is distinguishable from an event-derived one.
        provenance: 'code-structure-observer@1',
        confidence: 'high',
        evidenceIds: ['src/a.ts:3'],
        metadata: {},
      });
      expect(edge.kind).toBe(kind);
    }

    // Structural confidence reuses the intelligence vocabulary and must not
    // borrow Git attribution's exact/correlated wording.
    expect(() =>
      graphEdgeSchema.parse({
        id: 'edge-bad-confidence',
        source: { kind: 'file', id: 'file-a' },
        target: { kind: 'file', id: 'file-b' },
        kind: 'FILE_IMPORTS_FILE',
        observedAt: timestamp,
        provenance: 'code-structure-observer@1',
        confidence: 'correlated',
        evidenceIds: ['src/a.ts:3'],
        metadata: {},
      }),
    ).toThrow();
  });

  it('keeps an unbuilt graph summary free of counts', () => {
    const unobserved = graphSummarySchema.parse({
      observed: false,
      projectionHealth: 'healthy',
      nodeCountsByKind: [],
      edgeCountsByKind: [],
      observedAt: timestamp,
    });

    // An absent generation is unknown, not zero. ADR 0013.
    expect(unobserved.nodeCount).toBeUndefined();
    expect(unobserved.edgeCount).toBeUndefined();
    expect(unobserved.generation).toBeUndefined();

    // A count without an observed generation is the fabricated claim the
    // schema exists to make unrepresentable.
    expect(() =>
      graphSummarySchema.parse({
        observed: false,
        projectionHealth: 'healthy',
        nodeCount: 0,
        edgeCount: 0,
        nodeCountsByKind: [],
        edgeCountsByKind: [],
        observedAt: timestamp,
      }),
    ).toThrow();

    // The inverse is equally wrong: an observed generation must carry totals.
    expect(() =>
      graphSummarySchema.parse({
        observed: true,
        generation: 'generation-1',
        projectionHealth: 'healthy',
        nodeCountsByKind: [],
        edgeCountsByKind: [],
        observedAt: timestamp,
      }),
    ).toThrow();
  });

  it('reports observed graph counts per kind within the schema bound', () => {
    const summary = graphSummarySchema.parse({
      observed: true,
      generation: 'generation-1',
      projectionHealth: 'degraded',
      nodeCount: 3,
      edgeCount: 1,
      nodeCountsByKind: [
        { kind: 'project', count: 2 },
        { kind: 'session', count: 1 },
      ],
      edgeCountsByKind: [{ kind: 'PROJECT_BOUND_AGENT', count: 1 }],
      observedAt: timestamp,
    });

    expect(summary.nodeCount).toBe(3);
    expect(summary.projectionHealth).toBe('degraded');
    expect(summary.nodeCountsByKind).toHaveLength(2);

    // Counts come from set cardinality, so the per-kind list can never be
    // longer than the kind enumeration itself.
    expect(() =>
      graphSummarySchema.parse({
        observed: true,
        generation: 'generation-1',
        projectionHealth: 'healthy',
        nodeCount: 0,
        edgeCount: 0,
        nodeCountsByKind: Array.from({ length: 30 }, () => ({ kind: 'project', count: 1 })),
        edgeCountsByKind: [],
        observedAt: timestamp,
      }),
    ).toThrow();
  });

  it('validates optimization proposals and non-causal evaluations', () => {
    const proposal = optimizationProposalSchema.parse({
      id: 'proposal-1',
      projectId: 'project-1',
      findingIds: ['finding-1'],
      title: 'Move project-only context',
      summary: 'Move an observed project-only assignment to project scope.',
      proposedActions: [
        {
          kind: 'move-capability-to-project',
          capabilityId: 'capability-1',
          projectId: 'project-1',
        },
      ],
      evidenceWindow: { startedAt: timestamp, endedAt: timestamp, sessionCount: 3 },
      confidence: 'medium',
      state: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(proposal.state).toBe('ready');

    const evaluation = optimizationEvaluationSchema.parse({
      id: 'evaluation-1',
      proposalId: 'proposal-1',
      projectId: 'project-1',
      state: 'verified',
      baseline: { sessionCount: 3, estimatedContextTokens: 5000 },
      postChange: { sessionCount: 3, estimatedContextTokens: 3500 },
      summary: 'Observed context footprint decreased after the change.',
      causalClaim: false,
      startedAt: timestamp,
      completedAt: timestamp,
    });
    expect(evaluation.causalClaim).toBe(false);
  });
});
