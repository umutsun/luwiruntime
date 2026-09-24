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
  type SessionFileChangeObservation,
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
      // Only the holder can extend the lock; a stranger's renewal changes nothing.
      await expect(repository.renewGraphRebuildLock('rebuild-integration')).resolves.toBe(true);
      await expect(repository.renewGraphRebuildLock('rebuild-other')).resolves.toBe(false);
      await expect(
        repository.beginGraphRebuild(
          started,
          event('event-rebuild-twice', 'graph.rebuild.started'),
        ),
      ).rejects.toMatchObject({ code: 'GRAPH_REBUILD_IN_PROGRESS' });

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
      // Activation released the lock, so there is nothing left to renew.
      await expect(repository.renewGraphRebuildLock('rebuild-integration')).resolves.toBe(false);
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

    it('stores a session file change, reads it back, and overwrites it in place (B2)', async () => {
      const observation: SessionFileChangeObservation = {
        id: 'sfc-integration-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        relativePath: 'apps/daemon/src/app.ts',
        toolName: 'Edit',
        changeCount: 1,
        firstObservedAt: timestamp,
        observedAt: timestamp,
        evidenceIds: ['sfc-integration-1'],
      };

      await repository.putSessionFileChange(observation);

      expect(await repository.getSessionFileChange('sfc-integration-1')).toEqual(observation);
      expect(await repository.listSessionFileChanges('project-1')).toEqual([observation]);

      // The aggregate id is stable, so a second write overwrites in place rather
      // than adding a second record (the store is per session-file).
      await repository.putSessionFileChange({ ...observation, changeCount: 5 });
      expect(await repository.listSessionFileChanges('project-1')).toEqual([
        { ...observation, changeCount: 5 },
      ]);
    });

    it('projects a SESSION_CHANGED_FILE edge with both adjacency indexes, idempotently (B2)', async () => {
      // A fresh sub-namespace so this test owns its active generation rather than
      // inheriting one an earlier test left active.
      const repository = createIntelligenceRepository({
        client: commandClient,
        keys: createRedisKeys(`${namespace}:sfc`),
        functions: registry,
      });
      const generation = 'generation-sfc';
      const sessionNode: GraphNode = {
        id: 'node-session-sfc',
        kind: 'session',
        entityId: 'session-1',
        projectId: 'project-1',
        observedAt: timestamp,
        provenance: 'session-projection',
        confidence: 'high',
        evidenceIds: ['session-1'],
        metadata: {},
      };
      const fileNode: GraphNode = {
        id: 'node-file-sfc',
        kind: 'file',
        entityId: 'file-sfc-abc',
        projectId: 'project-1',
        observedAt: timestamp,
        provenance: 'transcript-observer@1',
        confidence: 'high',
        evidenceIds: ['sfc-integration-1'],
        metadata: { relativePath: 'apps/daemon/src/app.ts' },
      };
      const edge: GraphEdge = {
        id: 'edge-session-changed-file',
        source: { kind: 'session', id: 'session-1' },
        target: { kind: 'file', id: 'file-sfc-abc' },
        kind: 'SESSION_CHANGED_FILE',
        projectId: 'project-1',
        observedAt: timestamp,
        provenance: 'transcript-observer@1',
        confidence: 'high',
        evidenceIds: ['sfc-integration-1'],
        metadata: { changeCount: 3, toolName: 'Edit' },
      };

      await repository.setInitialGraphGeneration(generation);
      await repository.replaceGraphSnapshot(
        generation,
        [sessionNode, fileNode],
        [edge],
        event('event-sfc-projected', 'graph.node.projected'),
      );

      // Both adjacency indexes: the edge is reachable outgoing from the session
      // and incoming to the file.
      await expect(
        repository.getGraphNeighbors('session', 'session-1', 'out', { limit: 100 }),
      ).resolves.toMatchObject({ node: sessionNode, nodes: [fileNode], edges: [edge] });
      await expect(
        repository.getGraphNeighbors('file', 'file-sfc-abc', 'in', { limit: 100 }),
      ).resolves.toMatchObject({ node: fileNode, nodes: [sessionNode], edges: [edge] });

      await expect(repository.getGraphSummary()).resolves.toMatchObject({
        generation,
        edges: [{ kind: 'SESSION_CHANGED_FILE', count: 1 }],
      });

      // Re-projecting the same snapshot leaves the counts unchanged (E7).
      await repository.replaceGraphSnapshot(
        generation,
        [sessionNode, fileNode],
        [edge],
        event('event-sfc-reprojected', 'graph.node.projected'),
      );
      await expect(repository.getGraphSummary()).resolves.toMatchObject({
        generation,
        edges: [{ kind: 'SESSION_CHANGED_FILE', count: 1 }],
      });

      // A rescan that found nothing new differs only in its scan time, and that
      // is not a change: the record stays as it was first observed.
      const rescannedAt = '2026-09-01T00:05:00.000Z';
      await repository.replaceGraphSnapshot(
        generation,
        [sessionNode, { ...fileNode, observedAt: rescannedAt }],
        [{ ...edge, observedAt: rescannedAt }],
        event('event-sfc-rescanned', 'graph.node.projected'),
      );
      await expect(repository.getGraphNode('file', fileNode.entityId)).resolves.toEqual(fileNode);

      // A real difference is still written, with the time it was seen.
      const changed = { ...fileNode, observedAt: rescannedAt, evidenceIds: ['sfc-integration-2'] };
      await repository.replaceGraphSnapshot(
        generation,
        [sessionNode, changed],
        [edge],
        event('event-sfc-changed', 'graph.node.projected'),
      );
      await expect(repository.getGraphNode('file', fileNode.entityId)).resolves.toEqual(changed);
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

    describe('orphan graph generations', () => {
      const orphanNode = (id: string): GraphNode => ({
        id: `node-${id}`,
        kind: 'project',
        entityId: `project-${id}`,
        projectId: `project-${id}`,
        observedAt: timestamp,
        provenance: 'orphan-test',
        confidence: 'high',
        evidenceIds: [`event-${id}`],
        metadata: {},
      });
      const rebuild = (
        operationId: string,
        state: GraphRebuildOperation['state'],
      ): GraphRebuildOperation => ({
        id: operationId,
        state,
        shadowGeneration: `generation-${operationId}`,
        processedEvents: 0,
        nodeCount: 0,
        edgeCount: 0,
        failureCount: state === 'failed' ? 1 : 0,
        failureSummary: state === 'failed' ? ['The shadow graph counts did not match.'] : [],
        startedAt: timestamp,
      });
      /** A shadow of `nodes` node keys plus its kind index (n + 1 keys), left unindexed. */
      const shadow = async (
        operationId: string,
        state: GraphRebuildOperation['state'] | null,
        nodes = 1,
      ): Promise<string> => {
        const generation = `generation-${operationId}`;
        for (let index = 0; index < nodes; index += 1) {
          await repository.putGraphNode(generation, orphanNode(`${operationId}-${index}`));
        }
        await commandClient.sendCommand(['ZREM', keys.graphGenerationsIndex, generation]);
        if (state !== null) await repository.updateGraphRebuild(rebuild(operationId, state));
        return generation;
      };
      const keysOf = async (generation: string): Promise<string[]> => {
        const found: string[] = [];
        let cursor = '0';
        do {
          const reply = (await commandClient.sendCommand([
            'SCAN',
            cursor,
            'MATCH',
            `${namespace}:graph:generation:${generation}:*`,
            'COUNT',
            '1000',
          ])) as [string, string[]];
          cursor = reply[0];
          found.push(...reply[1]);
        } while (cursor !== '0');
        return found;
      };
      // Earlier tests in this namespace may leave eligible orphans; start each from none.
      const drain = () => repository.purgeOrphanGraphGenerations({ maxKeys: 100_000 });

      it('removes a failed or finished orphan and keeps every live generation', async () => {
        await drain();
        const failed = await shadow('orphan-failed', 'failed', 2);
        const finished = await shadow('orphan-finished', 'completed');
        const crashed = await shadow('orphan-crashed', 'running');
        const holding = await shadow('orphan-holding', 'running');
        const unrecorded = await shadow('orphan-unrecorded', null);
        const indexed = await shadow('orphan-indexed', 'failed');
        await commandClient.sendCommand(['ZADD', keys.graphGenerationsIndex, '1', indexed]);
        const active = await shadow('orphan-active', 'completed');
        const previousActive = await repository.getActiveGraphGeneration();
        await commandClient.sendCommand(['SET', keys.graphActiveGeneration, active]);
        await commandClient.sendCommand(['SET', keys.graphRebuildLock, 'orphan-holding']);
        const outside = [
          `${namespace}:unrelated:generation-orphan-failed:node`,
          `${namespace}:graph:rebuild:orphan-failed-copy`,
        ];
        for (const key of outside) await commandClient.sendCommand(['SET', key, 'keep']);

        try {
          const result = await repository.purgeOrphanGraphGenerations({ maxKeys: 10_000 });

          expect(result).toEqual({ generationsRemoved: 3, keysRemoved: 7, truncated: false });
          expect(await keysOf(failed)).toEqual([]);
          expect(await keysOf(finished)).toEqual([]);
          expect(await keysOf(crashed)).toEqual([]);
          expect(await keysOf(holding)).not.toEqual([]);
          expect(await keysOf(unrecorded)).not.toEqual([]);
          expect(await keysOf(indexed)).not.toEqual([]);
          expect(await keysOf(active)).not.toEqual([]);
          for (const key of outside) {
            await expect(commandClient.sendCommand(['GET', key])).resolves.toBe('keep');
          }
          // The rebuild record is history, not a generation key.
          await expect(repository.getGraphRebuild('orphan-failed')).resolves.not.toBeNull();
        } finally {
          await commandClient.sendCommand(['DEL', keys.graphRebuildLock, ...outside]);
          if (previousActive !== null) {
            await commandClient.sendCommand(['SET', keys.graphActiveGeneration, previousActive]);
          }
        }
      });

      it('keeps the shadow of the rebuild holding the lock through a retention run', async () => {
        // Shadow writes are scored by the records' own observedAt, so a shadow
        // of old records ranks below every newer generation in the index.
        const generation = await shadow('retention-in-flight', 'running', 2);
        await commandClient.sendCommand(['ZADD', keys.graphGenerationsIndex, '1', generation]);
        for (const newer of ['retention-newer-a', 'retention-newer-b']) {
          await repository.putGraphNode(`generation-${newer}`, {
            ...orphanNode(newer),
            observedAt: '2026-08-29T00:00:00.000Z',
          });
        }
        await commandClient.sendCommand(['SET', keys.graphRebuildLock, 'retention-in-flight']);
        const before = await keysOf(generation);

        try {
          await repository.runRetention({
            now: new Date('2026-08-30T00:00:00.000Z'),
            usageRetentionDays: 30,
            gitObservationRetentionCount: 1,
            graphGenerationRetentionCount: 1,
            maximumRecords: 1000,
          });

          // Proves retention trimmed at all: the older of the two newer ones goes.
          expect(await keysOf('generation-retention-newer-a')).toEqual([]);
          expect((await keysOf(generation)).toSorted()).toEqual(before.toSorted());
          await expect(
            commandClient.sendCommand(['ZSCORE', keys.graphGenerationsIndex, generation]),
          ).resolves.not.toBeNull();
        } finally {
          await commandClient.sendCommand(['DEL', keys.graphRebuildLock]);
          await repository.discardGraphGeneration(generation, 100);
          for (const newer of ['retention-newer-a', 'retention-newer-b']) {
            await repository.discardGraphGeneration(`generation-${newer}`, 100);
          }
        }
      });

      it('removes at most maxKeys per call and reports what is left', async () => {
        await drain();
        const generation = await shadow('orphan-bounded', 'failed', 3);

        const first = await repository.purgeOrphanGraphGenerations({ maxKeys: 2 });
        expect(first).toMatchObject({ keysRemoved: 2, truncated: true });
        expect(await keysOf(generation)).toHaveLength(2);

        const second = await repository.purgeOrphanGraphGenerations({ maxKeys: 2 });
        expect(second).toMatchObject({ keysRemoved: 2, truncated: false });
        expect(await keysOf(generation)).toEqual([]);
      });

      it("discards a failed rebuild's own shadow, bounded, but never the active one", async () => {
        const generation = await shadow('discard-own', 'failed', 2);
        await commandClient.sendCommand(['ZADD', keys.graphGenerationsIndex, '1', generation]);

        await expect(repository.discardGraphGeneration(generation, 2)).resolves.toEqual({
          keysRemoved: 2,
          truncated: true,
        });
        await expect(
          commandClient.sendCommand(['ZSCORE', keys.graphGenerationsIndex, generation]),
        ).resolves.toBeNull();
        await expect(repository.discardGraphGeneration(generation, 10)).resolves.toEqual({
          keysRemoved: 1,
          truncated: false,
        });
        expect(await keysOf(generation)).toEqual([]);

        const active = await repository.getActiveGraphGeneration();
        expect(active).not.toBeNull();
        const activeKeys = await keysOf(active ?? '');
        expect(activeKeys).not.toEqual([]);
        await expect(repository.discardGraphGeneration(active ?? '', 10)).resolves.toEqual({
          keysRemoved: 0,
          truncated: false,
        });
        expect(await keysOf(active ?? '')).toEqual(activeKeys);
      });
    });
  },
);
