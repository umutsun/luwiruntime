import { randomUUID } from 'node:crypto';

import {
  createRuntimeEvent,
  type GitObservation,
  type GraphEdge,
  type GraphNode,
  type GraphRebuildOperation,
  type OptimizationFinding,
  type OptimizationProposal,
  type PackageRecord,
  type TechnologyRecord,
  type UsageRecord,
} from '@luwi/protocol';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createIntelligenceRepository,
  createRedisKeys,
  type IntelligenceRepository,
  type RedisCommandClient,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';
const timestamp = '2026-07-30T00:00:00.000Z';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'Phase 4 Redis intelligence projections',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let repository: IntelligenceRepository;

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      repository = createIntelligenceRepository({
        client: commandClient,
        keys,
        functions: registry,
      });
    });

    afterAll(async () => {
      if (client?.isOpen) {
        let cursor = '0';
        do {
          const reply = (await commandClient.sendCommand([
            'SCAN',
            cursor,
            'MATCH',
            `${namespace}:*`,
            'COUNT',
            '100',
          ])) as [string, string[]];
          cursor = reply[0];
          if (reply[1].length > 0) await commandClient.sendCommand(['DEL', ...reply[1]]);
        } while (cursor !== '0');
        await commandClient.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]);
        await client.quit();
      }
    });

    const event = (
      id: string,
      type:
        | 'usage.reported'
        | 'git.observed'
        | 'package.inventory.updated'
        | 'attribution.recorded'
        | 'graph.rebuild.started'
        | 'graph.rebuild.completed'
        | 'graph.node.projected'
        | 'optimization.finding.detected'
        | 'optimization.proposal.created',
    ) =>
      createRuntimeEvent(
        {
          type,
          workspaceId: 'local',
          projectId: 'project-1',
          payload: { id },
        },
        { createId: () => id, now: () => new Date(timestamp) },
      );

    it('ingests usage idempotently and maintains source-separated indexes and aggregates', async () => {
      const usage: UsageRecord = {
        id: 'usage-integration-1',
        projectId: 'project-1',
        agentId: 'codex',
        sessionId: 'session-1',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        source: 'agent-exact',
        confidence: 'exact',
        observedAt: timestamp,
        sourceEventId: 'provider-event-1',
        createdAt: timestamp,
        metadata: {},
      };
      await expect(
        repository.ingestUsage(usage, event('event-usage-1', 'usage.reported')),
      ).resolves.toMatchObject({ status: 'created', usage });
      await expect(
        repository.ingestUsage(usage, event('event-usage-duplicate', 'usage.reported')),
      ).resolves.toEqual({ status: 'duplicate', existingUsageId: usage.id });
      await expect(
        repository.ingestUsage(
          { ...usage, id: 'usage-integration-2' },
          event('event-usage-source-duplicate', 'usage.reported'),
        ),
      ).resolves.toEqual({ status: 'duplicate', existingUsageId: usage.id });

      await expect(
        repository.listUsage({
          projectId: 'project-1',
          agentId: 'codex',
          sessionId: 'session-1',
          limit: 100,
        }),
      ).resolves.toEqual({ records: [usage], truncated: false });
      await expect(
        commandClient.sendCommand([
          'HGETALL',
          keys.usageMetric('project:project-1', 'agent-exact'),
        ]),
      ).resolves.toMatchObject({
        recordCount: '1',
        inputTokens: '100',
        totalTokens: '120',
      });
    });

    it('aggregates transcript cache counters and refuses a re-read of the same request', async () => {
      // The shape B1 actually writes: Claude's additive counters in their own
      // fields, with cachedInputTokens and totalTokens deliberately unset so
      // neither the subset invariant nor the total invariant can fire.
      const usage: UsageRecord = {
        id: 'usage-transcript-integration-1',
        projectId: 'project-1',
        agentId: 'claude-code',
        sessionId: 'session-1',
        model: 'claude-opus-5',
        inputTokens: 2,
        outputTokens: 738,
        cacheCreationInputTokens: 18549,
        cacheReadInputTokens: 22728,
        source: 'adapter-extracted',
        confidence: 'reported',
        observedAt: timestamp,
        sourceEventId: 'claude-code:fixture-claude-session-0001:req_transcript_1',
        createdAt: timestamp,
        metadata: {},
      };

      await expect(
        repository.ingestUsage(usage, event('event-usage-transcript-1', 'usage.reported')),
      ).resolves.toMatchObject({ status: 'created', usage });

      // Re-reading a whole transcript is the steady state, so a repeated
      // request must write nothing rather than double the aggregates.
      await expect(
        repository.ingestUsage(
          { ...usage, id: 'usage-transcript-integration-2' },
          event('event-usage-transcript-duplicate', 'usage.reported'),
        ),
      ).resolves.toEqual({ status: 'duplicate', existingUsageId: usage.id });

      await expect(
        commandClient.sendCommand([
          'HGETALL',
          keys.usageMetric('session:session-1', 'adapter-extracted'),
        ]),
      ).resolves.toMatchObject({
        recordCount: '1',
        inputTokens: '2',
        outputTokens: '738',
        cacheCreationInputTokens: '18549',
        cacheReadInputTokens: '22728',
      });
    });

    it('projects Git, package, technology, and attribution records without source content', async () => {
      const git: GitObservation = {
        id: 'git-integration-1',
        projectId: 'project-1',
        repositoryRoot: 'C:/sandbox',
        branch: 'main',
        headSha: 'a'.repeat(40),
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        branches: ['main'],
        tags: [],
        worktrees: [{ path: 'C:/sandbox', headSha: 'a'.repeat(40), branch: 'main' }],
        recentCommits: [
          {
            sha: 'a'.repeat(40),
            parentShas: [],
            committedAt: timestamp,
            subject: 'Bounded subject',
            changedPaths: ['src/index.ts'],
            trailers: { 'Luwi-Session': 'session-1' },
            merge: false,
          },
        ],
        observedAt: timestamp,
        repositoryStateHash: 'b'.repeat(64),
      };
      await repository.putGitObservation(git, event('event-git', 'git.observed'));
      await expect(repository.getCurrentGitObservation('project-1')).resolves.toEqual(git);

      const packageRecord: PackageRecord = {
        id: 'pkg-zod',
        projectId: 'project-1',
        ecosystem: 'node',
        packageName: 'zod',
        declaredVersion: '^4',
        dependencyType: 'production',
        direct: true,
        workspaceLocation: '.',
        manifestPath: 'package.json',
        detectedAt: timestamp,
        manifestHash: 'c'.repeat(64),
      };
      const technology: TechnologyRecord = {
        id: 'tech-typescript',
        projectId: 'project-1',
        name: 'TypeScript',
        category: 'language',
        confidence: 'high',
        evidence: [{ kind: 'file-pattern', value: '*.ts' }],
        detectedAt: timestamp,
      };
      await repository.replacePackageInventory(
        'project-1',
        [packageRecord],
        [technology],
        ['.', 'packages/bare'],
        event('event-packages', 'package.inventory.updated'),
      );
      await expect(repository.listPackages('project-1')).resolves.toEqual([packageRecord]);
      // ADR 0014: workspace locations replace atomically with the records they
      // describe, including one that declares no dependency.
      await expect(repository.listWorkspaceLocations('project-1')).resolves.toEqual([
        '.',
        'packages/bare',
      ]);
      await expect(repository.listTechnologies('project-1')).resolves.toEqual([technology]);

      const serialized = JSON.stringify([
        ...(await repository.listGitObservations('project-1')),
        ...(await repository.listPackages('project-1')),
        ...(await repository.listTechnologies('project-1')),
      ]);
      expect(serialized).not.toContain('const secret');
      expect(serialized).not.toContain('complete prompt');
    });

    it('writes a shadow graph and atomically changes only the generation pointer on completion', async () => {
      const node: GraphNode = {
        id: 'node-project',
        kind: 'project',
        entityId: 'project-1',
        projectId: 'project-1',
        observedAt: timestamp,
        provenance: 'project.registered',
        confidence: 'high',
        evidenceIds: ['event-project'],
        metadata: {},
      };
      const edge: GraphEdge = {
        id: 'edge-project-agent',
        source: { kind: 'project', id: 'project-1' },
        target: { kind: 'agent', id: 'codex' },
        kind: 'PROJECT_BOUND_AGENT',
        projectId: 'project-1',
        observedAt: timestamp,
        provenance: 'project.agent.bound',
        confidence: 'high',
        evidenceIds: ['event-binding'],
        metadata: {},
      };
      const agentNode: GraphNode = {
        id: 'node-agent',
        kind: 'agent',
        entityId: 'codex',
        observedAt: timestamp,
        provenance: 'agent.definition.registered',
        confidence: 'high',
        evidenceIds: ['event-agent'],
        metadata: {},
      };
      await repository.setInitialGraphGeneration('generation-active');
      await repository.putGraphNode('generation-shadow', node);
      await repository.putGraphNode('generation-shadow', agentNode);
      await repository.putGraphEdge('generation-shadow', edge);
      const started: GraphRebuildOperation = {
        id: 'rebuild-integration',
        state: 'running',
        shadowGeneration: 'generation-shadow',
        previousGeneration: 'generation-active',
        processedEvents: 1,
        nodeCount: 2,
        edgeCount: 1,
        failureCount: 0,
        failureSummary: [],
        startedAt: timestamp,
      };
      await repository.beginGraphRebuild(
        started,
        event('event-rebuild-started', 'graph.rebuild.started'),
      );
      expect(await repository.getActiveGraphGeneration()).toBe('generation-active');

      const completed: GraphRebuildOperation = {
        ...started,
        state: 'completed',
        activeGeneration: 'generation-shadow',
        completedAt: timestamp,
      };
      await repository.activateGraphGeneration(
        completed,
        event('event-rebuild-complete', 'graph.rebuild.completed'),
      );
      expect(await repository.getActiveGraphGeneration()).toBe('generation-shadow');
      await expect(repository.readGraphGeneration()).resolves.toMatchObject({
        generation: 'generation-shadow',
        nodes: expect.arrayContaining([node, agentNode]),
        edges: [edge],
      });
      await expect(
        repository.validateGraphGeneration('generation-shadow', 2, 1),
      ).resolves.toBeUndefined();
      await expect(
        repository.getGraphNeighbors('project', 'project-1', 'out', { limit: 100 }),
      ).resolves.toMatchObject({
        node,
        nodes: [agentNode],
        edges: [edge],
        truncated: false,
      });

      // ADR 0013 counts through SCARD/ZCARD. Only a real server proves the
      // reply type parses; the unit test's scripted client cannot.
      //
      // One retained generation, not two: the generations index is written by
      // node and edge projection, so `generation-active` never enters it —
      // only the pointer was set. The count is generations holding content.
      // Two generations indexed: 'generation-active' by the initial pointer and
      // 'generation-shadow' by the node/edge puts. Before ADR 0014 the pointer
      // recorded nothing, so this count could not be trusted.
      await expect(repository.getGraphSummary()).resolves.toEqual({
        generation: 'generation-shadow',
        retainedGenerationCount: 2,
        projectionHealth: 'healthy',
        nodes: [
          { kind: 'project', count: 1 },
          { kind: 'agent', count: 1 },
        ],
        edges: [{ kind: 'PROJECT_BOUND_AGENT', count: 1 }],
      });

      await repository.replaceGraphSnapshot(
        'generation-shadow',
        [node],
        [],
        event('event-graph-replaced', 'graph.node.projected'),
      );
      await expect(repository.readGraphGeneration()).resolves.toMatchObject({
        nodes: [node],
        edges: [],
      });
      await expect(
        repository.getGraphNeighbors('project', 'project-1', 'out', { limit: 100 }),
      ).resolves.toMatchObject({ nodes: [], edges: [], truncated: false });

      // Incremental replacement removes obsolete membership, so the counts
      // follow it down rather than accumulating until the next rebuild.
      await expect(repository.getGraphSummary()).resolves.toMatchObject({
        generation: 'generation-shadow',
        nodes: [{ kind: 'project', count: 1 }],
        edges: [],
      });
    });

    it('reports a namespace with no active generation as unbuilt rather than empty', async () => {
      const unbuilt = createIntelligenceRepository({
        client: commandClient,
        keys: createRedisKeys(`${namespace}:unbuilt`),
        functions: registry,
      });

      await expect(unbuilt.getGraphSummary()).resolves.toEqual({
        generation: null,
        retainedGenerationCount: 0,
        projectionHealth: 'healthy',
        nodes: [],
        edges: [],
      });
    });

    it('atomically records graph projection diagnostics and degraded health', async () => {
      await repository.recordGraphProjectionFailure({
        id: 'projection-failure-1',
        operation: 'integration-test',
        code: 'GRAPH_PROJECTION_DEGRADED',
        occurredAt: timestamp,
      });

      await expect(repository.getGraphProjectionHealth()).resolves.toBe('degraded');
      const failures = await commandClient.sendCommand([
        'XRANGE',
        keys.graphProjectionFailures,
        '-',
        '+',
      ]);
      expect(JSON.stringify(failures)).toContain('projection-failure-1');
    });

    it('stores optimization findings and proposals as bounded projections', async () => {
      const finding: OptimizationFinding = {
        id: 'finding-integration',
        projectId: 'project-1',
        kind: 'oversized-always-loaded-source',
        contextSourceId: 'source-1',
        title: 'Oversized source',
        summary: 'Structural estimate exceeds the configured threshold.',
        state: 'open',
        evidenceWindow: {
          startedAt: timestamp,
          endedAt: timestamp,
          sessionCount: 3,
          observationCount: 3,
        },
        confidence: 'high',
        evidenceIds: ['source-1'],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const proposal: OptimizationProposal = {
        id: 'proposal-integration',
        projectId: 'project-1',
        findingIds: [finding.id],
        title: 'Reference-only loading',
        summary: 'Acceptance does not apply this proposal.',
        proposedActions: [
          { kind: 'convert-source-to-reference-only', contextSourceId: 'source-1' },
        ],
        evidenceWindow: { startedAt: timestamp, endedAt: timestamp, sessionCount: 3 },
        confidence: 'high',
        state: 'ready',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await repository.putOptimizationFinding(
        finding,
        event('event-finding', 'optimization.finding.detected'),
      );
      await repository.putOptimizationProposal(
        proposal,
        event('event-proposal', 'optimization.proposal.created'),
      );
      await expect(repository.listOptimizationFindings('project-1')).resolves.toEqual([finding]);
      await expect(repository.getOptimizationProposal(proposal.id)).resolves.toEqual(proposal);
    });

    it('does not partially persist an atomic Git projection when batch preflight fails', async () => {
      const observation: GitObservation = {
        id: 'git-atomic-failure',
        projectId: 'project-atomic-failure',
        repositoryRoot: 'C:/sandbox',
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        branches: [],
        tags: [],
        worktrees: [],
        recentCommits: [],
        observedAt: timestamp,
        repositoryStateHash: 'f'.repeat(64),
      };
      await commandClient.sendCommand(['SET', keys.gitObservationsIndex, 'wrong-type']);
      const streamLength = await commandClient.sendCommand(['XLEN', keys.globalEvents]);

      await expect(
        repository.putGitObservation(
          observation,
          event('event-git-atomic-failure', 'git.observed'),
        ),
      ).rejects.toMatchObject({ code: 'REDIS_DATA_INVALID' });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.gitObservation(observation.id)]),
      ).resolves.toBe(0);
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        streamLength,
      );
      await commandClient.sendCommand(['DEL', keys.gitObservationsIndex]);
    });

    it('bounds raw intelligence projections while preserving streams, aggregates, and active graph state', async () => {
      const oldTimestamp = '2026-07-01T00:00:00.000Z';
      const oldUsage: UsageRecord = {
        id: 'usage-retention-old',
        projectId: 'project-retention',
        agentId: 'codex',
        sessionId: 'session-retention',
        totalTokens: 50,
        source: 'agent-reported',
        confidence: 'reported',
        observedAt: oldTimestamp,
        sourceEventId: 'provider-retention-old',
        createdAt: oldTimestamp,
        metadata: {},
      };
      await repository.ingestUsage(
        oldUsage,
        createRuntimeEvent(
          {
            type: 'usage.reported',
            workspaceId: 'local',
            projectId: oldUsage.projectId,
            agentId: oldUsage.agentId,
            sessionId: oldUsage.sessionId,
            payload: { usageId: oldUsage.id, source: oldUsage.source },
          },
          {
            createId: () => 'event-retention-usage',
            now: () => new Date(oldTimestamp),
          },
        ),
      );
      const oldObservation: GitObservation = {
        id: 'git-retention-old',
        projectId: 'project-retention',
        repositoryRoot: 'C:/sandbox',
        branch: 'main',
        headSha: 'c'.repeat(40),
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        branches: ['main'],
        tags: [],
        worktrees: [],
        recentCommits: [],
        observedAt: oldTimestamp,
        repositoryStateHash: 'd'.repeat(64),
      };
      const currentObservation: GitObservation = {
        ...oldObservation,
        id: 'git-retention-current',
        observedAt: timestamp,
        repositoryStateHash: 'e'.repeat(64),
      };
      await repository.putGitObservation(
        oldObservation,
        event('event-retention-git-old', 'git.observed'),
      );
      await repository.putGitObservation(
        currentObservation,
        event('event-retention-git-current', 'git.observed'),
      );
      await repository.putGraphNode('generation-retention-old', {
        id: 'node-retention-old',
        kind: 'project',
        entityId: 'project-retention',
        projectId: 'project-retention',
        observedAt: oldTimestamp,
        provenance: 'project.registered',
        confidence: 'high',
        evidenceIds: ['event-retention-project'],
        metadata: {},
      });
      const rejectedProposal: OptimizationProposal = {
        id: 'proposal-retention-rejected',
        projectId: 'project-retention',
        findingIds: ['finding-retention'],
        title: 'Rejected old proposal',
        summary: 'This rejected projection may age out while its event remains.',
        proposedActions: [
          { kind: 'convert-source-to-reference-only', contextSourceId: 'source-retention' },
        ],
        evidenceWindow: {
          startedAt: oldTimestamp,
          endedAt: oldTimestamp,
          sessionCount: 3,
        },
        confidence: 'medium',
        state: 'rejected',
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
      };
      await repository.putOptimizationProposal(
        rejectedProposal,
        event('event-retention-proposal', 'optimization.proposal.created'),
      );
      const streamLengthBefore = Number(
        await commandClient.sendCommand(['XLEN', keys.globalEvents]),
      );

      const result = await repository.runRetention({
        now: new Date('2026-08-30T00:00:00.000Z'),
        usageRetentionDays: 30,
        gitObservationRetentionCount: 1,
        graphGenerationRetentionCount: 1,
        graphRebuildRetentionCount: 100,
        rejectedProposalRetentionDays: 7,
      });

      expect(result).toMatchObject({
        gitObservationsRemoved: 1,
        // Two, not one: ADR 0014 made the initial pointer record its generation,
        // so retention can finally see and reclaim a superseded generation that
        // it was previously blind to.
        graphGenerationsRemoved: 2,
        rejectedProposalsRemoved: 1,
        truncated: false,
      });
      expect(result.usageRecordsRemoved).toBeGreaterThanOrEqual(1);
      await expect(repository.getUsage(oldUsage.id)).resolves.toBeNull();
      await expect(
        repository.ingestUsage(
          { ...oldUsage, id: 'usage-retention-retry' },
          createRuntimeEvent(
            {
              type: 'usage.reported',
              workspaceId: 'local',
              projectId: oldUsage.projectId,
              payload: { usageId: 'usage-retention-retry', source: oldUsage.source },
            },
            { createId: () => 'event-retention-retry', now: () => new Date(timestamp) },
          ),
        ),
      ).resolves.toEqual({
        status: 'duplicate',
        existingUsageId: oldUsage.id,
      });
      await expect(
        commandClient.sendCommand([
          'HGET',
          keys.usageMetric('project:project-retention', 'agent-reported'),
          'recordCount',
        ]),
      ).resolves.toBe('1');
      await expect(
        repository.summarizeUsage({ projectId: 'project-retention', limit: 100 }),
      ).resolves.toMatchObject({
        projectId: 'project-retention',
        recordCount: 1,
        sources: [{ source: 'agent-reported', recordCount: 1, totalTokens: 50 }],
      });
      await expect(repository.listGitObservations('project-retention')).resolves.toEqual([
        currentObservation,
      ]);
      expect(await repository.getActiveGraphGeneration()).toBe('generation-shadow');
      await expect(repository.getOptimizationProposal(rejectedProposal.id)).resolves.toBeNull();
      expect(
        Number(await commandClient.sendCommand(['XLEN', keys.globalEvents])),
      ).toBeGreaterThanOrEqual(streamLengthBefore);
    });

    it('makes bounded forward progress while deleting a large stale graph generation', async () => {
      for (let index = 0; index < 3; index += 1) {
        await repository.putGraphNode('generation-cleanup-old', {
          id: `node-cleanup-${index}`,
          kind: 'project',
          entityId: `project-cleanup-${index}`,
          projectId: `project-cleanup-${index}`,
          observedAt: timestamp,
          provenance: 'retention-test',
          confidence: 'high',
          evidenceIds: [`event-cleanup-${index}`],
          metadata: {},
        });
      }
      await repository.putGraphNode('generation-cleanup-new', {
        id: 'node-cleanup-new',
        kind: 'project',
        entityId: 'project-cleanup-new',
        projectId: 'project-cleanup-new',
        observedAt: timestamp,
        provenance: 'retention-test',
        confidence: 'high',
        evidenceIds: ['event-cleanup-new'],
        metadata: {},
      });

      for (let pass = 0; pass < 5; pass += 1) {
        await repository.runRetention({
          now: new Date('2026-08-30T00:00:00.000Z'),
          usageRetentionDays: 30,
          gitObservationRetentionCount: 1,
          graphGenerationRetentionCount: 1,
          maximumRecords: 1,
        });
      }

      await expect(
        commandClient.sendCommand(['ZSCORE', keys.graphGenerationsIndex, 'generation-cleanup-old']),
      ).resolves.toBeNull();
    });
  },
);
