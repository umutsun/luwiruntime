import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createRuntimeEvent,
  type GraphEdge,
  type GraphNode,
  type GraphRebuildOperation,
  type UsageRecord,
} from '@luwi/protocol';

import {
  createFunctionRegistry,
  createIntelligenceRepository,
  createRedisKeys,
  type RedisCommandClient,
} from './index.js';

class RecordingClient implements RedisCommandClient {
  commands: string[][] = [];
  replies: unknown[] = [];

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    return this.replies.shift() ?? null;
  }
}

/**
 * Answers by command rather than by call order, so a read that issues one
 * command per schema kind stays readable and does not depend on the order the
 * implementation happens to iterate.
 */
class ScriptedClient implements RedisCommandClient {
  commands: string[][] = [];

  constructor(private readonly reply: (command: string[]) => unknown) {}

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    const command = [...arguments_];
    this.commands.push(command);
    return this.reply(command);
  }
}

const timestamp = '2026-07-30T00:00:00.000Z';
const usage: UsageRecord = {
  id: 'usage-1',
  projectId: 'project-1',
  agentId: 'codex',
  sessionId: 'session-1',
  inputTokens: 100,
  source: 'agent-exact',
  confidence: 'exact',
  observedAt: timestamp,
  sourceEventId: 'provider-event-1',
  createdAt: timestamp,
  metadata: {},
};
const usageEvent = createRuntimeEvent(
  {
    type: 'usage.reported',
    workspaceId: 'local',
    projectId: 'project-1',
    agentId: 'codex',
    sessionId: 'session-1',
    payload: { usageId: 'usage-1', source: 'agent-exact' },
  },
  { createId: () => 'event-1', now: () => new Date(timestamp) },
);

describe('Redis intelligence repository', () => {
  it('calls the atomic usage Function with record, indexes, source aggregates, and streams', async () => {
    const client = new RecordingClient();
    client.replies.push(JSON.stringify({ status: 'created', usage, event: usageEvent }));
    const keys = createRedisKeys('luwi:test:intelligence:v1');
    const functions = createFunctionRegistry('intelligence');
    const repository = createIntelligenceRepository({ client, keys, functions });

    await expect(repository.ingestUsage(usage, usageEvent)).resolves.toMatchObject({
      status: 'created',
      usage,
    });

    const command = client.commands[0]!;
    expect(command.slice(0, 3)).toEqual(['FCALL', functions.functions.usageIngest, '16']);
    expect(command).toEqual(
      expect.arrayContaining([
        keys.usage('usage-1'),
        keys.projectUsage('project-1'),
        keys.agentUsage('codex'),
        keys.sessionUsage('session-1'),
        keys.usageSourceEvent(createHash('sha256').update('provider-event-1').digest('hex')),
        keys.usageMetric('global', 'agent-exact'),
        keys.usageMetric('project:project-1', 'agent-exact'),
        keys.usageMetric('day:2026-07-30:project:project-1', 'agent-exact'),
        keys.globalEvents,
        keys.projectEvents('project-1'),
      ]),
    );
    expect(command.at(-1)).toBe('{"inputTokens":100}');
  });

  it('filters usage before applying the response limit', async () => {
    const client = new RecordingClient();
    const keys = createRedisKeys('luwi:test:usage-list:v1');
    const repository = createIntelligenceRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });
    const estimated = {
      ...usage,
      id: 'usage-estimated',
      source: 'luwi-estimated' as const,
      confidence: 'estimated' as const,
    };
    client.replies.push(
      ['0', ['usage-1', 'usage-estimated']],
      JSON.stringify(usage),
      JSON.stringify(estimated),
    );

    await expect(repository.listUsage({ source: 'luwi-estimated', limit: 1 })).resolves.toEqual({
      records: [estimated],
      truncated: false,
    });
    expect(client.commands[0]?.slice(0, 2)).toEqual(['SSCAN', keys.usageIndex]);
    expect(client.commands.some(([command]) => command === 'SMEMBERS')).toBe(false);
  });

  it('reads source-separated usage summaries from preserved aggregate hashes', async () => {
    const client = new RecordingClient();
    const keys = createRedisKeys('luwi:test:usage-summary:v1');
    const repository = createIntelligenceRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });
    client.replies.push(
      [
        'recordCount',
        '125',
        'inputTokens',
        '1000',
        'observedFrom',
        timestamp,
        'observedTo',
        timestamp,
      ],
      [],
      [],
      [],
      [],
    );

    await expect(
      repository.summarizeUsage({ projectId: 'project-1', limit: 100 }),
    ).resolves.toMatchObject({
      projectId: 'project-1',
      recordCount: 125,
      sources: [{ source: 'agent-exact', recordCount: 125, inputTokens: 1000 }],
    });
    expect(client.commands[0]).toEqual([
      'HGETALL',
      keys.usageMetric('project:project-1', 'agent-exact'),
    ]);
  });

  it('does not use a single-scope aggregate for combined identity filters', async () => {
    const client = new RecordingClient();
    const repository = createIntelligenceRepository({
      client,
      keys: createRedisKeys('luwi:test:usage-summary-scope:v1'),
      functions: createFunctionRegistry(),
    });

    await expect(
      repository.summarizeUsage({
        projectId: 'project-other',
        agentId: 'agent-other',
        sessionId: 'session-1',
        limit: 100,
      }),
    ).resolves.toBeNull();
    expect(client.commands).toEqual([]);
  });

  it('surfaces duplicate usage without updating any projection', async () => {
    const client = new RecordingClient();
    client.replies.push(JSON.stringify({ status: 'duplicate', existingUsageId: 'usage-existing' }));
    const repository = createIntelligenceRepository({
      client,
      keys: createRedisKeys(),
      functions: createFunctionRegistry(),
    });

    await expect(repository.ingestUsage(usage, usageEvent)).resolves.toEqual({
      status: 'duplicate',
      existingUsageId: 'usage-existing',
    });
    expect(client.commands).toHaveLength(1);
  });

  it('projects graph nodes and edges into generation-scoped hashes and adjacency sets', async () => {
    const client = new RecordingClient();
    const repository = createIntelligenceRepository({
      client,
      keys: createRedisKeys('luwi:test:graph:v1'),
      functions: createFunctionRegistry(),
    });
    const node: GraphNode = {
      id: 'node-1',
      kind: 'project',
      entityId: 'project-1',
      projectId: 'project-1',
      observedAt: timestamp,
      provenance: 'project.registered',
      confidence: 'high',
      evidenceIds: ['event-1'],
      metadata: {},
    };
    const edge: GraphEdge = {
      id: 'edge-1',
      source: { kind: 'project', id: 'project-1' },
      target: { kind: 'agent', id: 'codex' },
      kind: 'PROJECT_BOUND_AGENT',
      projectId: 'project-1',
      observedAt: timestamp,
      provenance: 'project.agent.bound',
      confidence: 'high',
      evidenceIds: ['event-2'],
      metadata: {},
    };

    await repository.putGraphNode('generation-1', node);
    await repository.putGraphEdge('generation-1', edge);

    expect(client.commands.map((command) => command[0])).toEqual([
      'ZADD',
      'HSET',
      'SADD',
      'ZADD',
      'HSET',
      'SADD',
      'SADD',
      'SADD',
    ]);
    expect(client.commands.some((command) => command.includes('edge-1'))).toBe(true);
  });

  it('activates a completed shadow generation through one ownership-checked Function', async () => {
    const client = new RecordingClient();
    client.replies.push(JSON.stringify({ status: 'updated' }));
    const keys = createRedisKeys('luwi:test:graph-transition:v1');
    const functions = createFunctionRegistry();
    const repository = createIntelligenceRepository({ client, keys, functions });
    const operation: GraphRebuildOperation = {
      id: 'rebuild-1',
      state: 'completed',
      shadowGeneration: 'generation-shadow',
      activeGeneration: 'generation-shadow',
      processedEvents: 1,
      nodeCount: 1,
      edgeCount: 0,
      failureCount: 0,
      failureSummary: [],
      startedAt: timestamp,
      completedAt: timestamp,
    };
    const event = createRuntimeEvent(
      {
        type: 'graph.rebuild.completed',
        workspaceId: 'local',
        payload: { operationId: operation.id },
      },
      { createId: () => 'event-rebuild-1', now: () => new Date(timestamp) },
    );

    await repository.activateGraphGeneration(operation, event);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]?.slice(0, 4)).toEqual([
      'FCALL',
      functions.functions.graphRebuildTransition,
      '6',
      keys.graphActiveGeneration,
    ]);
    expect(client.commands[0]).toEqual(
      expect.arrayContaining([
        keys.graphRebuildLock,
        keys.graphProjectionHealth,
        keys.globalEvents,
        operation.id,
      ]),
    );
  });

  it('summarizes the active graph generation from index cardinality alone', async () => {
    const keys = createRedisKeys('luwi:test:graph-summary:v1');
    const cardinalities = new Map<string, number>([
      [keys.graphNodesByKind('generation-1', 'project'), 2],
      [keys.graphNodesByKind('generation-1', 'session'), 3],
      [keys.graphEdgesByKind('generation-1', 'PROJECT_BOUND_AGENT'), 4],
    ]);
    const client = new ScriptedClient((command) => {
      const [name, key] = command;
      if (name === 'GET' && key === keys.graphActiveGeneration) return 'generation-1';
      if (name === 'GET' && key === keys.graphProjectionHealth) return 'degraded';
      if (name === 'SCARD') return cardinalities.get(key!) ?? 0;
      throw new Error(`unexpected command ${command.join(' ')}`);
    });
    const repository = createIntelligenceRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });

    const summary = await repository.getGraphSummary();

    expect(summary.generation).toBe('generation-1');
    expect(summary.projectionHealth).toBe('degraded');
    // Only kinds with members are carried; the rest are an observed zero.
    expect(summary.nodes).toEqual([
      { kind: 'project', count: 2 },
      { kind: 'session', count: 3 },
    ]);
    expect(summary.edges).toEqual([{ kind: 'PROJECT_BOUND_AGENT', count: 4 }]);

    // ADR 0013: cardinality only. Any scan or hydration here would make an
    // overview the most expensive read in the daemon.
    const issued = client.commands.map(([name]) => name);
    expect(issued).not.toContain('SSCAN');
    expect(issued).not.toContain('SMEMBERS');
    expect(issued.filter((name) => name === 'SCARD')).toHaveLength(55);
    // GET generation + GET health + 55 per-kind SCARD. No ZCARD: the
    // generations index is not maintained by every write path, so counting
    // it would publish a number that contradicts the totals. ADR 0013.
    expect(client.commands).toHaveLength(57);
    expect(issued).not.toContain('ZCARD');
  });

  it('reports a graph that was never built as unobserved rather than empty', async () => {
    const keys = createRedisKeys('luwi:test:graph-unbuilt:v1');
    const client = new ScriptedClient((command) => {
      const [name, key] = command;
      if (name === 'GET' && key === keys.graphActiveGeneration) return null;
      if (name === 'GET' && key === keys.graphProjectionHealth) return null;
      throw new Error(`unexpected command ${command.join(' ')}`);
    });
    const repository = createIntelligenceRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });

    const summary = await repository.getGraphSummary();

    expect(summary.generation).toBeNull();
    expect(summary.nodes).toEqual([]);
    expect(summary.edges).toEqual([]);
    // Absent failure state is healthy, which is the existing Phase 4 contract.
    expect(summary.projectionHealth).toBe('healthy');
    // No generation means nothing to count, so no per-kind read is issued.
    expect(client.commands.map(([name]) => name)).not.toContain('SCARD');
  });

  it.each([['not-a-number'], [''], [-1], [1.5], [null]])(
    'rejects the cardinality reply %p rather than reporting it as zero',
    async (reply) => {
      const keys = createRedisKeys('luwi:test:graph-invalid:v1');
      const client = new ScriptedClient((command) => {
        const [name, key] = command;
        if (name === 'GET' && key === keys.graphActiveGeneration) return 'generation-1';
        if (name === 'GET' && key === keys.graphProjectionHealth) return null;
        if (name === 'SCARD') return reply;
        throw new Error(`unexpected command ${command.join(' ')}`);
      });
      const repository = createIntelligenceRepository({
        client,
        keys,
        functions: createFunctionRegistry(),
      });

      await expect(repository.getGraphSummary()).rejects.toThrow(/invalid/i);
    },
  );

  it('records graph projection failure and degraded health through one Function', async () => {
    const client = new RecordingClient();
    client.replies.push(JSON.stringify({ status: 'updated', streamId: '1-0' }));
    const keys = createRedisKeys('luwi:test:graph-failure:v1');
    const functions = createFunctionRegistry();
    const repository = createIntelligenceRepository({ client, keys, functions });

    await repository.recordGraphProjectionFailure({
      id: 'failure-1',
      operation: 'incremental',
      code: 'GRAPH_PROJECTION_DEGRADED',
      occurredAt: timestamp,
    });

    expect(client.commands).toEqual([
      expect.arrayContaining([
        'FCALL',
        functions.functions.graphProjectionFailure,
        '2',
        keys.graphProjectionFailures,
        keys.graphProjectionHealth,
      ]),
    ]);
  });
});
