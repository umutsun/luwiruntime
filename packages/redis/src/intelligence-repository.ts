import { createHash } from 'node:crypto';

import {
  attributionRecordSchema,
  contextContributionSchema,
  gitCommitSchema,
  gitObservationSchema,
  graphEdgeKindSchema,
  graphEdgeSchema,
  graphNodeKindSchema,
  graphNodeSchema,
  graphRebuildOperationSchema,
  optimizationEvaluationSchema,
  optimizationFindingSchema,
  optimizationProposalSchema,
  packageRecordSchema,
  runtimeEventSchema,
  technologyRecordSchema,
  usageRecordSchema,
  usageSourceSchema,
  usageSummarySchema,
  type AttributionRecord,
  type ContextContribution,
  type GitCommit,
  type GitObservation,
  type GraphEdge,
  type GraphEdgeKindCount,
  type GraphNeighborsQuery,
  type GraphNode,
  type GraphNodeKind,
  type GraphNodeKindCount,
  type GraphProjectionHealth,
  type GraphRebuildOperation,
  type OptimizationEvaluation,
  type OptimizationFinding,
  type OptimizationProposal,
  type PackageRecord,
  type RuntimeEvent,
  type TechnologyRecord,
  type UsageListQuery,
  type UsageRecord,
  type UsageSource,
  type UsageSourceComposition,
  type UsageSummary,
} from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

type Schema<Value> = {
  safeParse(value: unknown): { success: true; data: Value } | { success: false };
};

export type IntelligenceRepositoryDependencies = {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
};

export type UsageIngestResult =
  | { status: 'created'; usage: UsageRecord; event: RuntimeEvent }
  | { status: 'duplicate'; existingUsageId: string };

export type GraphProjectionFailure = {
  id: string;
  operation: string;
  code: string;
  occurredAt: string;
  evidenceId?: string;
};

/**
 * The raw counting answer behind ADR 0013.
 *
 * `generation` is null when the graph has never been built. The per-kind lists
 * then stay empty, and it is the caller's job to keep that distinct from a
 * generation that exists and holds nothing. No total is computed here: summing
 * an empty list would produce the zero this projection must not assert.
 */
export type GraphSummaryProjection = {
  generation: string | null;
  retainedGenerationCount: number;
  projectionHealth: GraphProjectionHealth;
  nodes: GraphNodeKindCount[];
  edges: GraphEdgeKindCount[];
};

type IntelligenceBatchOperation =
  | { kind: 'hash_json'; key: string; id: string; value: unknown }
  | { kind: 'set_add' | 'set_remove'; key: string; member: string }
  | { kind: 'delete'; key: string };

export type IntelligenceRetentionOptions = {
  now: Date;
  usageRetentionDays: number;
  gitObservationRetentionCount: number;
  graphGenerationRetentionCount: number;
  graphRebuildRetentionCount?: number;
  rejectedProposalRetentionDays?: number;
  maximumRecords?: number;
};

export type IntelligenceRetentionResult = {
  usageRecordsRemoved: number;
  gitObservationsRemoved: number;
  graphGenerationsRemoved: number;
  graphRebuildsRemoved: number;
  rejectedProposalsRemoved: number;
  earliestUsageObservation?: string;
  truncated: boolean;
};

export type UsageListResult = {
  records: UsageRecord[];
  truncated: boolean;
  earliestAvailableAt?: string;
};

export interface IntelligenceRepository {
  appendEvent(event: RuntimeEvent): Promise<void>;
  ingestUsage(record: UsageRecord, event: RuntimeEvent): Promise<UsageIngestResult>;
  getUsage(usageId: string): Promise<UsageRecord | null>;
  listUsage(query: UsageListQuery): Promise<UsageListResult>;
  summarizeUsage(query: UsageListQuery): Promise<UsageSummary | null>;
  getEarliestUsageObservation(): Promise<string | null>;
  putContextContribution(contribution: ContextContribution, event?: RuntimeEvent): Promise<void>;
  listContextContributions(filters?: {
    projectId?: string;
    agentId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<ContextContribution[]>;
  putGitObservation(observation: GitObservation, event: RuntimeEvent): Promise<void>;
  getCurrentGitObservation(projectId: string): Promise<GitObservation | null>;
  listGitObservations(projectId: string, limit?: number): Promise<GitObservation[]>;
  listGitCommits(projectId: string, limit?: number): Promise<GitCommit[]>;
  replacePackageInventory(
    projectId: string,
    packages: PackageRecord[],
    technologies: TechnologyRecord[],
    workspaceLocations: string[],
    event: RuntimeEvent,
  ): Promise<void>;
  listPackages(projectId: string, limit?: number): Promise<PackageRecord[]>;
  listWorkspaceLocations(projectId: string): Promise<string[]>;
  listTechnologies(projectId: string, limit?: number): Promise<TechnologyRecord[]>;
  putAttributions(attributions: AttributionRecord[], event: RuntimeEvent): Promise<void>;
  listAttributions(projectId: string, limit?: number): Promise<AttributionRecord[]>;
  putGraphNode(generation: string, node: GraphNode): Promise<void>;
  putGraphEdge(generation: string, edge: GraphEdge): Promise<void>;
  replaceGraphSnapshot(
    generation: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    event: RuntimeEvent,
  ): Promise<void>;
  getActiveGraphGeneration(): Promise<string | null>;
  setInitialGraphGeneration(generation: string): Promise<string>;
  readGraphGeneration(
    generation?: string,
    maximumNodes?: number,
    maximumEdges?: number,
  ): Promise<{ generation: string; nodes: GraphNode[]; edges: GraphEdge[] }>;
  getGraphNode(kind: GraphNodeKind, id: string): Promise<GraphNode | null>;
  getGraphNeighbors(
    kind: GraphNodeKind,
    id: string,
    direction: 'out' | 'in',
    query: GraphNeighborsQuery,
  ): Promise<{
    node: GraphNode;
    nodes: GraphNode[];
    edges: GraphEdge[];
    truncated: boolean;
    examinedEdges: number;
  } | null>;
  validateGraphGeneration(
    generation: string,
    expectedNodeCount: number,
    expectedEdgeCount: number,
  ): Promise<void>;
  recordGraphProjectionFailure(failure: GraphProjectionFailure): Promise<void>;
  getGraphProjectionHealth(): Promise<'healthy' | 'degraded'>;
  getGraphSummary(): Promise<GraphSummaryProjection>;
  beginGraphRebuild(operation: GraphRebuildOperation, event: RuntimeEvent): Promise<void>;
  updateGraphRebuild(operation: GraphRebuildOperation): Promise<void>;
  activateGraphGeneration(operation: GraphRebuildOperation, event: RuntimeEvent): Promise<void>;
  failGraphRebuild(operation: GraphRebuildOperation, event: RuntimeEvent): Promise<void>;
  getGraphRebuild(operationId: string): Promise<GraphRebuildOperation | null>;
  putOptimizationFinding(finding: OptimizationFinding, event?: RuntimeEvent): Promise<void>;
  listOptimizationFindings(projectId?: string, limit?: number): Promise<OptimizationFinding[]>;
  putOptimizationProposal(proposal: OptimizationProposal, event?: RuntimeEvent): Promise<void>;
  getOptimizationProposal(proposalId: string): Promise<OptimizationProposal | null>;
  listOptimizationProposals(projectId?: string, limit?: number): Promise<OptimizationProposal[]>;
  putOptimizationEvaluation(
    evaluation: OptimizationEvaluation,
    event?: RuntimeEvent,
  ): Promise<void>;
  completeOptimizationEvaluation(
    evaluation: OptimizationEvaluation,
    proposal: OptimizationProposal,
    event: RuntimeEvent,
  ): Promise<void>;
  getOptimizationEvaluation(evaluationId: string): Promise<OptimizationEvaluation | null>;
  runRetention(options: IntelligenceRetentionOptions): Promise<IntelligenceRetentionResult>;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid value.');
}

/**
 * A set or sorted-set cardinality reply.
 *
 * Redis data is untrusted on read (sections 7 and 14). Coercing an unexpected
 * reply would turn it into `0`, which this surface must never assert, so an
 * unparseable cardinality is a failure rather than an empty answer.
 */
function cardinality(value: unknown): number {
  const raw = typeof value === 'number' ? value : text(value);
  // `Number('')` is 0, so an empty reply would become the zero this must not
  // assert. Anything that is not digits is rejected outright.
  const numeric =
    typeof raw === 'number' ? raw : raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid cardinality.');
  }
  return numeric;
}

function decode(value: unknown): unknown {
  const valueText = text(value);
  if (valueText === null) return null;
  try {
    return JSON.parse(valueText) as unknown;
  } catch {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned malformed JSON.');
  }
}

function parse<Value>(value: unknown, schema: Schema<Value>, description: string): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      `Redis returned an incompatible ${description} projection.`,
    );
  }
  return parsed.data;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (value === null) return [];
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid index.');
  }
  return value.map((item) => {
    const itemText = text(item);
    if (itemText === null) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid index.');
    }
    return itemText;
  });
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null) return {};
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid hash.');
    }
    const result: Record<string, string> = {};
    for (let index = 0; index < value.length; index += 2) {
      const key = text(value[index]);
      const entry = text(value[index + 1]);
      if (key === null || entry === null) {
        throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid hash.');
      }
      result[key] = entry;
    }
    return result;
  }
  if (typeof value === 'object') {
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      const entryText = text(entry);
      if (entryText !== null) result[key] = entryText;
    }
    return result;
  }
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid hash.');
}

function numericDeltas(record: UsageRecord): Record<string, number> {
  const result: Record<string, number> = {};
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cachedOutputTokens',
    'reasoningTokens',
    'totalTokens',
    'contextUsedTokens',
  ] as const) {
    const value = record[field];
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function day(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function sourceEventIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scanPage(value: unknown): { cursor: string; members: string[] } {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid scan page.');
  }
  const cursor = text(value[0]);
  if (cursor === null) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid scan cursor.');
  }
  return { cursor, members: stringArray(value[1]) };
}

export function createIntelligenceRepository(
  dependencies: IntelligenceRepositoryDependencies,
): IntelligenceRepository {
  const { client, keys, functions } = dependencies;

  const read = async <Value>(
    key: string,
    schema: Schema<Value>,
    description: string,
  ): Promise<Value | null> => {
    const value = decode(await client.sendCommand(['HGET', key, 'json']));
    return value === null ? null : parse(value, schema, description);
  };

  const put = async (
    key: string,
    index: string,
    id: string,
    value: unknown,
    secondaryIndexes: string[] = [],
  ): Promise<void> => {
    await client.sendCommand(['HSET', key, 'id', id, 'json', JSON.stringify(value)]);
    await client.sendCommand(['SADD', index, id]);
    for (const secondary of secondaryIndexes) {
      await client.sendCommand(['SADD', secondary, id]);
    }
  };

  const putWithEvent = async (
    key: string,
    index: string,
    id: string,
    value: unknown,
    event: RuntimeEvent,
    secondaryIndexes: string[] = [],
  ): Promise<void> => {
    const projectStream =
      event.projectId === undefined ? keys.globalEvents : keys.projectEvents(event.projectId);
    const functionKeys = [key, index, keys.globalEvents, projectStream, ...secondaryIndexes];
    const result = decode(
      await client.sendCommand([
        'FCALL',
        functions.functions.controlUpsert,
        String(functionKeys.length),
        ...functionKeys,
        'upsert',
        JSON.stringify(value),
        JSON.stringify(event),
        id,
      ]),
    );
    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      !['created', 'updated'].includes(String((result as Record<string, unknown>)['status']))
    ) {
      throw new RedisRepositoryError(
        'REDIS_DATA_INVALID',
        'Redis rejected the atomic intelligence projection transition.',
      );
    }
  };

  const transitionWithEvent = async (
    operations: IntelligenceBatchOperation[],
    event: RuntimeEvent,
  ): Promise<void> => {
    if (operations.length > 100_000) {
      throw new RedisRepositoryError(
        'REDIS_ARGUMENT_INVALID',
        'The intelligence transition exceeded its operation limit.',
      );
    }
    const projectStream =
      event.projectId === undefined ? keys.globalEvents : keys.projectEvents(event.projectId);
    const operationKeys = [...new Set(operations.map(({ key }) => key))];
    const encoded = operations.map((operation) => ({
      ...operation,
      key: operationKeys.indexOf(operation.key) + 3,
      ...('value' in operation ? { json: JSON.stringify(operation.value), value: undefined } : {}),
    }));
    const result = decode(
      await client.sendCommand([
        'FCALL',
        functions.functions.intelligenceBatchTransition,
        String(operationKeys.length + 2),
        keys.globalEvents,
        projectStream,
        ...operationKeys,
        JSON.stringify(encoded),
        JSON.stringify(event),
      ]),
    );
    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      (result as Record<string, unknown>)['status'] !== 'updated'
    ) {
      throw new RedisRepositoryError(
        'REDIS_DATA_INVALID',
        'Redis rejected the atomic intelligence batch transition.',
      );
    }
  };

  const list = async <Value>(
    index: string,
    keyForId: (id: string) => string,
    schema: Schema<Value>,
    description: string,
    limit = 1000,
  ): Promise<Value[]> => {
    const ids = (await scanSet(index, limit)).members.toSorted();
    const values: Value[] = [];
    for (const id of ids) {
      const value = await read(keyForId(id), schema, description);
      if (value !== null) values.push(value);
    }
    return values;
  };

  const appendEvent = async (event: RuntimeEvent): Promise<void> => {
    const eventJson = JSON.stringify(event);
    await client.sendCommand(['XADD', keys.globalEvents, '*', 'event', eventJson]);
    if (event.projectId !== undefined) {
      await client.sendCommand([
        'XADD',
        keys.projectEvents(event.projectId),
        '*',
        'event',
        eventJson,
      ]);
    }
  };

  const putRebuild = async (operation: GraphRebuildOperation): Promise<void> =>
    put(keys.graphRebuild(operation.id), keys.graphRebuildsIndex, operation.id, operation);

  const transitionGraphRebuild = async (
    operation: GraphRebuildOperation,
    event: RuntimeEvent,
  ): Promise<void> => {
    const functionKeys = [
      keys.graphActiveGeneration,
      keys.graphRebuild(operation.id),
      keys.graphRebuildsIndex,
      keys.graphRebuildLock,
      keys.graphProjectionHealth,
      keys.globalEvents,
      ...(event.projectId === undefined ? [] : [keys.projectEvents(event.projectId)]),
    ];
    const result = decode(
      await client.sendCommand([
        'FCALL',
        functions.functions.graphRebuildTransition,
        String(functionKeys.length),
        ...functionKeys,
        JSON.stringify(operation),
        JSON.stringify(event),
        operation.id,
      ]),
    );
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new RedisRepositoryError(
        'REDIS_DATA_INVALID',
        'Redis returned an invalid graph rebuild transition.',
      );
    }
    const value = result as Record<string, unknown>;
    if (value['status'] !== 'updated') {
      const code = typeof value['code'] === 'string' ? value['code'] : 'GRAPH_REBUILD_FAILED';
      throw new RedisRepositoryError(code, 'Redis rejected the graph rebuild transition.');
    }
  };

  /**
   * Adds a generation to the retention index. Scored by observation time so the
   * index stays ordered oldest-first, which is what retention's tail slice
   * assumes. Re-adding an existing generation refreshes nothing it should not:
   * `ZADD` without flags updates the score, and a generation that is still
   * being written is legitimately more recent.
   */
  const recordGeneration = async (generation: string, at: Date = new Date()): Promise<void> => {
    await client.sendCommand([
      'ZADD',
      keys.graphGenerationsIndex,
      String(at.getTime()),
      generation,
    ]);
  };

  const scanSet = async (
    key: string,
    maximum: number,
  ): Promise<{ members: string[]; truncated: boolean }> => {
    const members: string[] = [];
    let cursor = '0';
    do {
      const page = scanPage(await client.sendCommand(['SSCAN', key, cursor, 'COUNT', '500']));
      cursor = page.cursor;
      for (const member of page.members) {
        if (members.length >= maximum) {
          return { members, truncated: true };
        }
        members.push(member);
      }
    } while (cursor !== '0');
    return { members, truncated: false };
  };

  const removeGraphGeneration = async (generation: string, maximum: number): Promise<boolean> => {
    let truncated = false;
    for (const kind of graphEdgeKindSchema.options) {
      const edgeIndex = keys.graphEdgesByKind(generation, kind);
      const page = await scanSet(edgeIndex, maximum);
      truncated ||= page.truncated;
      for (const edgeId of page.members) {
        const edge = await read(keys.graphEdge(generation, edgeId), graphEdgeSchema, 'graph edge');
        if (edge !== null) {
          await client.sendCommand([
            'DEL',
            keys.graphOutgoing(generation, edge.source.kind, edge.source.id),
            keys.graphIncoming(generation, edge.target.kind, edge.target.id),
          ]);
        }
        await client.sendCommand(['DEL', keys.graphEdge(generation, edgeId)]);
        await client.sendCommand(['SREM', edgeIndex, edgeId]);
      }
      if (!page.truncated) await client.sendCommand(['DEL', edgeIndex]);
    }
    for (const kind of graphNodeKindSchema.options) {
      const nodeIndex = keys.graphNodesByKind(generation, kind);
      const page = await scanSet(nodeIndex, maximum);
      truncated ||= page.truncated;
      for (const nodeId of page.members) {
        await client.sendCommand(['DEL', keys.graphNode(generation, kind, nodeId)]);
        await client.sendCommand(['SREM', nodeIndex, nodeId]);
      }
      if (!page.truncated) await client.sendCommand(['DEL', nodeIndex]);
    }
    if (!truncated) {
      await client.sendCommand(['ZREM', keys.graphGenerationsIndex, generation]);
    }
    return truncated;
  };

  return {
    appendEvent,
    async ingestUsage(record, event) {
      const scopes = [
        'global',
        `project:${record.projectId}`,
        `agent:${record.agentId}`,
        `session:${record.sessionId}`,
        `day:${day(record.observedAt)}`,
        `day:${day(record.observedAt)}:project:${record.projectId}`,
        `day:${day(record.observedAt)}:agent:${record.agentId}`,
        `day:${day(record.observedAt)}:session:${record.sessionId}`,
      ];
      const result = decode(
        await client.sendCommand([
          'FCALL',
          functions.functions.usageIngest,
          '16',
          keys.usage(record.id),
          keys.usageIndex,
          keys.projectUsage(record.projectId),
          keys.agentUsage(record.agentId),
          keys.sessionUsage(record.sessionId),
          keys.usageSourceEvent(sourceEventIdentity(record.sourceEventId ?? record.id)),
          ...scopes.map((scope) => keys.usageMetric(scope, record.source)),
          keys.globalEvents,
          keys.projectEvents(record.projectId),
          JSON.stringify(record),
          JSON.stringify(event),
          record.id,
          record.sourceEventId ?? '',
          record.observedAt,
          JSON.stringify(numericDeltas(record)),
        ]),
      );
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          'Redis returned an invalid usage transition.',
        );
      }
      const value = result as Record<string, unknown>;
      if (value['status'] === 'duplicate' && typeof value['existingUsageId'] === 'string') {
        return { status: 'duplicate', existingUsageId: value['existingUsageId'] };
      }
      if (value['status'] === 'created') {
        return {
          status: 'created',
          usage: parse(value['usage'], usageRecordSchema, 'usage'),
          event: parse(value['event'], runtimeEventSchema, 'event'),
        };
      }
      const code = typeof value['code'] === 'string' ? value['code'] : 'REDIS_DATA_INVALID';
      throw new RedisRepositoryError(code, 'Redis rejected usage ingestion.');
    },
    getUsage: (usageId) => read(keys.usage(usageId), usageRecordSchema, 'usage'),
    getEarliestUsageObservation: async () =>
      text(await client.sendCommand(['GET', keys.intelligenceEarliestObservation])),
    async listUsage(query) {
      const index =
        query.sessionId !== undefined
          ? keys.sessionUsage(query.sessionId)
          : query.agentId !== undefined
            ? keys.agentUsage(query.agentId)
            : query.projectId !== undefined
              ? keys.projectUsage(query.projectId)
              : keys.usageIndex;
      const maximumExamined = Math.min(20_000, Math.max(1000, query.limit * 20));
      const page = await scanSet(index, maximumExamined);
      const records: UsageRecord[] = [];
      for (const id of page.members) {
        const record = await read(keys.usage(id), usageRecordSchema, 'usage');
        if (record !== null) records.push(record);
      }
      const matching = records
        .filter(
          (record) =>
            (query.projectId === undefined || record.projectId === query.projectId) &&
            (query.agentId === undefined || record.agentId === query.agentId) &&
            (query.sessionId === undefined || record.sessionId === query.sessionId) &&
            (query.source === undefined || record.source === query.source) &&
            (query.confidence === undefined || record.confidence === query.confidence) &&
            (query.from === undefined || record.observedAt >= query.from) &&
            (query.to === undefined || record.observedAt <= query.to) &&
            (query.capabilityId === undefined ||
              record.metadata['capabilityId'] === query.capabilityId),
        )
        .toSorted((left, right) => {
          const time = right.observedAt.localeCompare(left.observedAt);
          return time === 0 ? left.id.localeCompare(right.id) : time;
        });
      const earliestAvailableAt = text(
        await client.sendCommand(['GET', keys.intelligenceEarliestObservation]),
      );
      return {
        records: matching.slice(0, query.limit),
        truncated: page.truncated || matching.length > query.limit,
        ...(earliestAvailableAt === null ? {} : { earliestAvailableAt }),
      };
    },
    async summarizeUsage(query) {
      const identityFilterCount = [
        query.projectId !== undefined,
        query.agentId !== undefined,
        query.sessionId !== undefined,
      ].filter(Boolean).length;
      if (
        query.capabilityId !== undefined ||
        query.from !== undefined ||
        query.to !== undefined ||
        identityFilterCount > 1
      ) {
        return null;
      }
      const scope =
        query.sessionId !== undefined
          ? `session:${query.sessionId}`
          : query.agentId !== undefined
            ? `agent:${query.agentId}`
            : query.projectId !== undefined
              ? `project:${query.projectId}`
              : 'global';
      const confidenceSources: Record<string, UsageSource[]> = {
        exact: ['agent-exact'],
        reported: ['agent-reported', 'adapter-extracted'],
        estimated: ['luwi-estimated'],
        unknown: ['unavailable'],
      };
      const sources =
        query.source === undefined
          ? query.confidence === undefined
            ? usageSourceSchema.options
            : confidenceSources[query.confidence]!
          : query.confidence === undefined ||
              confidenceSources[query.confidence]?.includes(query.source)
            ? [query.source]
            : [];
      const numericFields = [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cachedOutputTokens',
        'reasoningTokens',
        'totalTokens',
        'contextUsedTokens',
      ] as const;
      const compositions: UsageSourceComposition[] = [];
      let observedFrom: string | undefined;
      let observedTo: string | undefined;
      for (const source of sources) {
        const values = stringRecord(
          await client.sendCommand(['HGETALL', keys.usageMetric(scope, source)]),
        );
        const recordCount = Number(values['recordCount'] ?? 0);
        if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
          throw new RedisRepositoryError(
            'REDIS_DATA_INVALID',
            'Redis returned invalid usage aggregate counts.',
          );
        }
        if (recordCount === 0) continue;
        const composition: Record<string, unknown> = { source, recordCount };
        for (const field of numericFields) {
          const raw = values[field];
          if (raw === undefined) continue;
          const numeric = Number(raw);
          if (!Number.isSafeInteger(numeric) || numeric < 0) {
            throw new RedisRepositoryError(
              'REDIS_DATA_INVALID',
              'Redis returned invalid usage aggregate values.',
            );
          }
          composition[field] = numeric;
        }
        compositions.push(composition as UsageSourceComposition);
        const sourceFrom = values['observedFrom'];
        const sourceTo = values['observedTo'];
        if (sourceFrom !== undefined && (observedFrom === undefined || sourceFrom < observedFrom)) {
          observedFrom = sourceFrom;
        }
        if (sourceTo !== undefined && (observedTo === undefined || sourceTo > observedTo)) {
          observedTo = sourceTo;
        }
      }
      return usageSummarySchema.parse({
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
        ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
        recordCount: compositions.reduce((total, value) => total + value.recordCount, 0),
        sources: compositions,
        ...(observedFrom === undefined ? {} : { observedFrom }),
        ...(observedTo === undefined ? {} : { observedTo }),
      });
    },
    async putContextContribution(contribution, event) {
      const secondaryIndexes = [
        keys.projectContextContributions(contribution.projectId),
        keys.agentContextContributions(contribution.agentId),
        ...(contribution.sessionId === undefined
          ? []
          : [keys.sessionContextContributions(contribution.sessionId)]),
      ];
      if (event === undefined) {
        await put(
          keys.contextContribution(contribution.id),
          keys.contextContributionsIndex,
          contribution.id,
          contribution,
          secondaryIndexes,
        );
      } else {
        await putWithEvent(
          keys.contextContribution(contribution.id),
          keys.contextContributionsIndex,
          contribution.id,
          contribution,
          event,
          secondaryIndexes,
        );
      }
    },
    async listContextContributions(filters = {}) {
      const index =
        filters.sessionId !== undefined
          ? keys.sessionContextContributions(filters.sessionId)
          : filters.agentId !== undefined
            ? keys.agentContextContributions(filters.agentId)
            : filters.projectId !== undefined
              ? keys.projectContextContributions(filters.projectId)
              : keys.contextContributionsIndex;
      const values = await list(
        index,
        keys.contextContribution,
        contextContributionSchema,
        'context contribution',
        filters.limit ?? 1000,
      );
      return values.filter(
        (value) =>
          (filters.projectId === undefined || value.projectId === filters.projectId) &&
          (filters.agentId === undefined || value.agentId === filters.agentId) &&
          (filters.sessionId === undefined || value.sessionId === filters.sessionId),
      );
    },
    async putGitObservation(observation, event) {
      const operations: IntelligenceBatchOperation[] = [
        {
          kind: 'hash_json',
          key: keys.gitObservation(observation.id),
          id: observation.id,
          value: observation,
        },
        { kind: 'set_add', key: keys.gitObservationsIndex, member: observation.id },
        {
          kind: 'set_add',
          key: keys.projectGitObservations(observation.projectId),
          member: observation.id,
        },
        {
          kind: 'hash_json',
          key: keys.projectGitCurrent(observation.projectId),
          id: observation.id,
          value: observation,
        },
      ];
      for (const commit of observation.recentCommits) {
        operations.push(
          {
            kind: 'hash_json',
            key: keys.gitCommit(observation.projectId, commit.sha),
            id: commit.sha,
            value: commit,
          },
          {
            kind: 'set_add',
            key: keys.projectCommits(observation.projectId),
            member: commit.sha,
          },
        );
      }
      await transitionWithEvent(operations, event);
    },
    getCurrentGitObservation: (projectId) =>
      read(keys.projectGitCurrent(projectId), gitObservationSchema, 'Git observation'),
    listGitObservations: (projectId, limit) =>
      list(
        keys.projectGitObservations(projectId),
        keys.gitObservation,
        gitObservationSchema,
        'Git observation',
        limit,
      ),
    listGitCommits: (projectId, limit) =>
      list(
        keys.projectCommits(projectId),
        (sha) => keys.gitCommit(projectId, sha),
        gitCommitSchema,
        'Git commit',
        limit,
      ),
    async replacePackageInventory(projectId, packages, technologies, workspaceLocations, event) {
      const previousPackages = stringArray(
        await client.sendCommand(['SMEMBERS', keys.projectPackages(projectId)]),
      );
      const operations: IntelligenceBatchOperation[] = [];
      for (const member of previousPackages) {
        const separator = member.indexOf(':');
        if (separator > 0) {
          operations.push({
            kind: 'delete',
            key: keys.package(projectId, member.slice(0, separator), member.slice(separator + 1)),
          });
        }
      }
      const previousTechnologies = stringArray(
        await client.sendCommand(['SMEMBERS', keys.projectTechnologies(projectId)]),
      );
      for (const id of previousTechnologies) {
        operations.push({ kind: 'delete', key: keys.technology(projectId, id) });
      }
      operations.push(
        { kind: 'delete', key: keys.projectPackages(projectId) },
        { kind: 'delete', key: keys.projectTechnologies(projectId) },
        // Replaced in the same atomic transition as the records it describes,
        // so it cannot drift from the scan that produced it. ADR 0014.
        { kind: 'delete', key: keys.projectWorkspaceLocations(projectId) },
      );
      for (const location of workspaceLocations) {
        operations.push({
          kind: 'set_add',
          key: keys.projectWorkspaceLocations(projectId),
          member: location,
        });
      }
      for (const packageRecord of packages) {
        const member = `${packageRecord.ecosystem}:${packageRecord.id}`;
        operations.push(
          {
            kind: 'hash_json',
            key: keys.package(projectId, packageRecord.ecosystem, packageRecord.id),
            id: packageRecord.id,
            value: packageRecord,
          },
          { kind: 'set_add', key: keys.projectPackages(projectId), member },
        );
      }
      for (const technology of technologies) {
        operations.push(
          {
            kind: 'hash_json',
            key: keys.technology(projectId, technology.id),
            id: technology.id,
            value: technology,
          },
          {
            kind: 'set_add',
            key: keys.projectTechnologies(projectId),
            member: technology.id,
          },
        );
      }
      await transitionWithEvent(operations, event);
    },
    async listWorkspaceLocations(projectId) {
      return stringArray(
        await client.sendCommand(['SMEMBERS', keys.projectWorkspaceLocations(projectId)]),
      ).toSorted();
    },
    async listPackages(projectId, limit = 1000) {
      const members = stringArray(
        await client.sendCommand(['SMEMBERS', keys.projectPackages(projectId)]),
      )
        .toSorted()
        .slice(0, limit);
      const values: PackageRecord[] = [];
      for (const member of members) {
        const separator = member.indexOf(':');
        if (separator < 1) continue;
        const value = await read(
          keys.package(projectId, member.slice(0, separator), member.slice(separator + 1)),
          packageRecordSchema,
          'package',
        );
        if (value !== null) values.push(value);
      }
      return values;
    },
    listTechnologies: (projectId, limit) =>
      list(
        keys.projectTechnologies(projectId),
        (id) => keys.technology(projectId, id),
        technologyRecordSchema,
        'technology',
        limit,
      ),
    async putAttributions(attributions, event) {
      const operations: IntelligenceBatchOperation[] = [];
      for (const attribution of attributions) {
        operations.push(
          {
            kind: 'hash_json',
            key: keys.attribution(attribution.id),
            id: attribution.id,
            value: attribution,
          },
          { kind: 'set_add', key: keys.attributionsIndex, member: attribution.id },
          {
            kind: 'set_add',
            key: keys.projectAttributions(attribution.projectId),
            member: attribution.id,
          },
        );
        if (attribution.sessionId !== undefined) {
          operations.push({
            kind: 'set_add',
            key: keys.sessionCommits(attribution.sessionId),
            member: attribution.commitSha,
          });
        }
      }
      await transitionWithEvent(operations, event);
    },
    listAttributions: (projectId, limit) =>
      list(
        keys.projectAttributions(projectId),
        keys.attribution,
        attributionRecordSchema,
        'attribution',
        limit,
      ),
    async putGraphNode(generation, node) {
      await client.sendCommand([
        'ZADD',
        keys.graphGenerationsIndex,
        String(Date.parse(node.observedAt)),
        generation,
      ]);
      await client.sendCommand([
        'HSET',
        keys.graphNode(generation, node.kind, node.entityId),
        'id',
        node.id,
        'json',
        JSON.stringify(node),
      ]);
      await client.sendCommand([
        'SADD',
        keys.graphNodesByKind(generation, node.kind),
        node.entityId,
      ]);
    },
    async putGraphEdge(generation, edge) {
      await client.sendCommand([
        'ZADD',
        keys.graphGenerationsIndex,
        String(Date.parse(edge.observedAt)),
        generation,
      ]);
      await client.sendCommand([
        'HSET',
        keys.graphEdge(generation, edge.id),
        'id',
        edge.id,
        'json',
        JSON.stringify(edge),
      ]);
      await client.sendCommand(['SADD', keys.graphEdgesByKind(generation, edge.kind), edge.id]);
      await client.sendCommand([
        'SADD',
        keys.graphOutgoing(generation, edge.source.kind, edge.source.id),
        edge.id,
      ]);
      await client.sendCommand([
        'SADD',
        keys.graphIncoming(generation, edge.target.kind, edge.target.id),
        edge.id,
      ]);
    },
    async replaceGraphSnapshot(generation, nodes, edges, event) {
      const current = await this.readGraphGeneration(generation, 100_001, 100_001);
      if (current.nodes.length > 100_000 || current.edges.length > 100_000) {
        throw new RedisRepositoryError(
          'GRAPH_QUERY_LIMIT_EXCEEDED',
          'The active graph exceeded the atomic replacement bound.',
        );
      }
      const currentNodes = new Map(
        current.nodes.map((node) => [`${node.kind}\0${node.entityId}`, node]),
      );
      const nextNodes = new Map(nodes.map((node) => [`${node.kind}\0${node.entityId}`, node]));
      const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));
      const nextEdges = new Map(edges.map((edge) => [edge.id, edge]));
      const operations: IntelligenceBatchOperation[] = [];
      const removeEdge = (edge: GraphEdge): void => {
        operations.push(
          { kind: 'delete', key: keys.graphEdge(generation, edge.id) },
          {
            kind: 'set_remove',
            key: keys.graphEdgesByKind(generation, edge.kind),
            member: edge.id,
          },
          {
            kind: 'set_remove',
            key: keys.graphOutgoing(generation, edge.source.kind, edge.source.id),
            member: edge.id,
          },
          {
            kind: 'set_remove',
            key: keys.graphIncoming(generation, edge.target.kind, edge.target.id),
            member: edge.id,
          },
        );
      };
      const putEdge = (edge: GraphEdge): void => {
        operations.push(
          {
            kind: 'hash_json',
            key: keys.graphEdge(generation, edge.id),
            id: edge.id,
            value: edge,
          },
          {
            kind: 'set_add',
            key: keys.graphEdgesByKind(generation, edge.kind),
            member: edge.id,
          },
          {
            kind: 'set_add',
            key: keys.graphOutgoing(generation, edge.source.kind, edge.source.id),
            member: edge.id,
          },
          {
            kind: 'set_add',
            key: keys.graphIncoming(generation, edge.target.kind, edge.target.id),
            member: edge.id,
          },
        );
      };
      for (const [id, existing] of currentEdges) {
        const replacement = nextEdges.get(id);
        if (replacement === undefined) {
          removeEdge(existing);
        } else if (JSON.stringify(existing) !== JSON.stringify(replacement)) {
          removeEdge(existing);
          putEdge(replacement);
        }
      }
      for (const [id, edge] of nextEdges) {
        if (!currentEdges.has(id)) putEdge(edge);
      }
      for (const [reference, existing] of currentNodes) {
        if (nextNodes.has(reference)) continue;
        operations.push(
          { kind: 'delete', key: keys.graphNode(generation, existing.kind, existing.entityId) },
          {
            kind: 'set_remove',
            key: keys.graphNodesByKind(generation, existing.kind),
            member: existing.entityId,
          },
          { kind: 'delete', key: keys.graphOutgoing(generation, existing.kind, existing.entityId) },
          { kind: 'delete', key: keys.graphIncoming(generation, existing.kind, existing.entityId) },
        );
      }
      for (const [reference, node] of nextNodes) {
        const existing = currentNodes.get(reference);
        if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(node)) continue;
        operations.push(
          {
            kind: 'hash_json',
            key: keys.graphNode(generation, node.kind, node.entityId),
            id: node.id,
            value: node,
          },
          {
            kind: 'set_add',
            key: keys.graphNodesByKind(generation, node.kind),
            member: node.entityId,
          },
        );
      }
      if (operations.length === 0) return;
      await transitionWithEvent(operations, event);
      // ADR 0014: this is the path the running daemon actually uses, and it was
      // the reason the index sat empty beside a populated generation.
      await recordGeneration(generation);
    },
    async getActiveGraphGeneration() {
      return text(await client.sendCommand(['GET', keys.graphActiveGeneration]));
    },
    async setInitialGraphGeneration(generation) {
      await client.sendCommand(['SET', keys.graphActiveGeneration, generation, 'NX']);
      const active = text(await client.sendCommand(['GET', keys.graphActiveGeneration]));
      // ADR 0014: every write path records its generation. Retention decides
      // what it is responsible for from this index, and the summary counts it.
      await recordGeneration(active ?? generation);
      return active ?? generation;
    },
    async readGraphGeneration(generation, maximumNodes = 2000, maximumEdges = 8000) {
      const selectedGeneration = generation ?? (await this.getActiveGraphGeneration()) ?? 'initial';
      const nodes: GraphNode[] = [];
      for (const kind of graphNodeKindSchema.options) {
        const remaining = maximumNodes - nodes.length;
        if (remaining <= 0) break;
        const ids = (
          await scanSet(keys.graphNodesByKind(selectedGeneration, kind), remaining)
        ).members.toSorted();
        for (const id of ids) {
          if (nodes.length >= maximumNodes) break;
          const value = await read(
            keys.graphNode(selectedGeneration, kind, id),
            graphNodeSchema,
            'graph node',
          );
          if (value !== null) nodes.push(value);
        }
        if (nodes.length >= maximumNodes) break;
      }
      const edges: GraphEdge[] = [];
      for (const kind of graphEdgeKindSchema.options) {
        const remaining = maximumEdges - edges.length;
        if (remaining <= 0) break;
        const ids = (
          await scanSet(keys.graphEdgesByKind(selectedGeneration, kind), remaining)
        ).members.toSorted();
        for (const id of ids) {
          if (edges.length >= maximumEdges) break;
          const value = await read(
            keys.graphEdge(selectedGeneration, id),
            graphEdgeSchema,
            'graph edge',
          );
          if (value !== null) edges.push(value);
        }
        if (edges.length >= maximumEdges) break;
      }
      return { generation: selectedGeneration, nodes, edges };
    },
    async getGraphNode(kind, id) {
      const generation = text(await client.sendCommand(['GET', keys.graphActiveGeneration]));
      if (generation === null) return null;
      return read(keys.graphNode(generation, kind, id), graphNodeSchema, 'graph node');
    },
    async getGraphNeighbors(kind, id, direction, query) {
      const generation = text(await client.sendCommand(['GET', keys.graphActiveGeneration]));
      if (generation === null) return null;
      const node = await read(keys.graphNode(generation, kind, id), graphNodeSchema, 'graph node');
      if (node === null) return null;
      const adjacency =
        direction === 'out'
          ? keys.graphOutgoing(generation, kind, id)
          : keys.graphIncoming(generation, kind, id);
      const matching: GraphEdge[] = [];
      const maximumExamined = Math.min(10_000, Math.max(1000, query.limit * 10));
      const page = await scanSet(adjacency, maximumExamined);
      for (const edgeId of page.members) {
        const edge = await read(keys.graphEdge(generation, edgeId), graphEdgeSchema, 'graph edge');
        if (edge === null) continue;
        if (query.edgeKind !== undefined && edge.kind !== query.edgeKind) continue;
        if (query.projectId !== undefined && edge.projectId !== query.projectId) continue;
        if (query.from !== undefined && edge.observedAt < query.from) continue;
        if (query.to !== undefined && edge.observedAt > query.to) continue;
        matching.push(edge);
      }
      matching.sort((left, right) => left.id.localeCompare(right.id));
      const selected = matching.slice(0, query.limit);
      const nodes: GraphNode[] = [];
      for (const edge of selected) {
        const reference = direction === 'out' ? edge.target : edge.source;
        const related = await read(
          keys.graphNode(generation, reference.kind, reference.id),
          graphNodeSchema,
          'graph node',
        );
        if (related === null) {
          throw new RedisRepositoryError(
            'GRAPH_PROJECTION_DEGRADED',
            'A graph edge references a missing node.',
          );
        }
        nodes.push(related);
      }
      return {
        node,
        nodes,
        edges: selected,
        truncated: page.truncated || matching.length > selected.length,
        examinedEdges: page.members.length,
      };
    },
    async validateGraphGeneration(generation, expectedNodeCount, expectedEdgeCount) {
      const snapshot = await this.readGraphGeneration(
        generation,
        expectedNodeCount + 1,
        expectedEdgeCount + 1,
      );
      if (
        snapshot.nodes.length !== expectedNodeCount ||
        snapshot.edges.length !== expectedEdgeCount
      ) {
        throw new RedisRepositoryError(
          'GRAPH_REBUILD_FAILED',
          'The shadow graph counts did not match the rebuild result.',
        );
      }
      const nodes = new Set(snapshot.nodes.map((node) => `${node.kind}\0${node.entityId}`));
      for (const edge of snapshot.edges) {
        if (
          !nodes.has(`${edge.source.kind}\0${edge.source.id}`) ||
          !nodes.has(`${edge.target.kind}\0${edge.target.id}`)
        ) {
          throw new RedisRepositoryError(
            'GRAPH_REBUILD_FAILED',
            'The shadow graph contains an edge with a missing endpoint.',
          );
        }
      }
    },
    async recordGraphProjectionFailure(failure) {
      const result = decode(
        await client.sendCommand([
          'FCALL',
          functions.functions.graphProjectionFailure,
          '2',
          keys.graphProjectionFailures,
          keys.graphProjectionHealth,
          JSON.stringify(failure),
        ]),
      );
      if (
        typeof result !== 'object' ||
        result === null ||
        Array.isArray(result) ||
        (result as Record<string, unknown>)['status'] !== 'updated'
      ) {
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          'Redis rejected the atomic graph projection failure transition.',
        );
      }
    },
    async getGraphProjectionHealth() {
      return (await client.sendCommand(['GET', keys.graphProjectionHealth])) === 'degraded'
        ? 'degraded'
        : 'healthy';
    },
    async getGraphSummary() {
      const generation = text(await client.sendCommand(['GET', keys.graphActiveGeneration]));
      const projectionHealth = await this.getGraphProjectionHealth();
      // ADR 0013 withheld this because the index was written by only one path.
      // ADR 0014 fixed that, so counting it is honest again.
      const retainedGenerationCount = cardinality(
        await client.sendCommand(['ZCARD', keys.graphGenerationsIndex]),
      );

      // Without an active generation there is nothing to count, and issuing the
      // per-kind reads anyway would return zeros that mean "unknown".
      if (generation === null) {
        return {
          generation: null,
          retainedGenerationCount,
          projectionHealth,
          nodes: [],
          edges: [],
        };
      }

      const nodes: GraphNodeKindCount[] = [];
      for (const kind of graphNodeKindSchema.options) {
        const count = cardinality(
          await client.sendCommand(['SCARD', keys.graphNodesByKind(generation, kind)]),
        );
        if (count > 0) nodes.push({ kind, count });
      }
      const edges: GraphEdgeKindCount[] = [];
      for (const kind of graphEdgeKindSchema.options) {
        const count = cardinality(
          await client.sendCommand(['SCARD', keys.graphEdgesByKind(generation, kind)]),
        );
        if (count > 0) edges.push({ kind, count });
      }
      return { generation, retainedGenerationCount, projectionHealth, nodes, edges };
    },
    async beginGraphRebuild(operation, event) {
      const lock = await client.sendCommand([
        'SET',
        keys.graphRebuildLock,
        operation.id,
        'NX',
        'PX',
        '300000',
      ]);
      if (lock === null) {
        throw new RedisRepositoryError(
          'GRAPH_REBUILD_IN_PROGRESS',
          'A graph rebuild is already running.',
        );
      }
      await putWithEvent(
        keys.graphRebuild(operation.id),
        keys.graphRebuildsIndex,
        operation.id,
        operation,
        event,
      );
    },
    updateGraphRebuild: putRebuild,
    async activateGraphGeneration(operation, event) {
      if (operation.state !== 'completed') {
        throw new RedisRepositoryError(
          'GRAPH_REBUILD_FAILED',
          'Only a completed graph generation can become active.',
        );
      }
      await transitionGraphRebuild(operation, event);
    },
    async failGraphRebuild(operation, event) {
      await transitionGraphRebuild(operation, event);
    },
    getGraphRebuild: (operationId) =>
      read(keys.graphRebuild(operationId), graphRebuildOperationSchema, 'graph rebuild'),
    async putOptimizationFinding(finding, event) {
      if (event === undefined) {
        await put(
          keys.optimizationFinding(finding.id),
          keys.optimizationFindingsIndex,
          finding.id,
          finding,
          [keys.projectOptimizationFindings(finding.projectId)],
        );
      } else {
        await putWithEvent(
          keys.optimizationFinding(finding.id),
          keys.optimizationFindingsIndex,
          finding.id,
          finding,
          event,
          [keys.projectOptimizationFindings(finding.projectId)],
        );
      }
    },
    async listOptimizationFindings(projectId, limit = 1000) {
      return list(
        projectId === undefined
          ? keys.optimizationFindingsIndex
          : keys.projectOptimizationFindings(projectId),
        keys.optimizationFinding,
        optimizationFindingSchema,
        'optimization finding',
        limit,
      );
    },
    async putOptimizationProposal(proposal, event) {
      if (event === undefined) {
        await put(
          keys.optimizationProposal(proposal.id),
          keys.optimizationProposalsIndex,
          proposal.id,
          proposal,
          [keys.projectOptimizationProposals(proposal.projectId)],
        );
      } else {
        await putWithEvent(
          keys.optimizationProposal(proposal.id),
          keys.optimizationProposalsIndex,
          proposal.id,
          proposal,
          event,
          [keys.projectOptimizationProposals(proposal.projectId)],
        );
      }
    },
    getOptimizationProposal: (proposalId) =>
      read(
        keys.optimizationProposal(proposalId),
        optimizationProposalSchema,
        'optimization proposal',
      ),
    async listOptimizationProposals(projectId, limit = 1000) {
      return list(
        projectId === undefined
          ? keys.optimizationProposalsIndex
          : keys.projectOptimizationProposals(projectId),
        keys.optimizationProposal,
        optimizationProposalSchema,
        'optimization proposal',
        limit,
      );
    },
    async putOptimizationEvaluation(evaluation, event) {
      if (event === undefined) {
        await put(
          keys.optimizationEvaluation(evaluation.id),
          keys.optimizationEvaluationsIndex,
          evaluation.id,
          evaluation,
        );
      } else {
        await putWithEvent(
          keys.optimizationEvaluation(evaluation.id),
          keys.optimizationEvaluationsIndex,
          evaluation.id,
          evaluation,
          event,
        );
      }
    },
    async completeOptimizationEvaluation(evaluation, proposal, event) {
      await transitionWithEvent(
        [
          {
            kind: 'hash_json',
            key: keys.optimizationEvaluation(evaluation.id),
            id: evaluation.id,
            value: evaluation,
          },
          {
            kind: 'set_add',
            key: keys.optimizationEvaluationsIndex,
            member: evaluation.id,
          },
          {
            kind: 'hash_json',
            key: keys.optimizationProposal(proposal.id),
            id: proposal.id,
            value: proposal,
          },
          {
            kind: 'set_add',
            key: keys.optimizationProposalsIndex,
            member: proposal.id,
          },
        ],
        event,
      );
    },
    getOptimizationEvaluation: (evaluationId) =>
      read(
        keys.optimizationEvaluation(evaluationId),
        optimizationEvaluationSchema,
        'optimization evaluation',
      ),
    async runRetention(options) {
      const maximum = Math.max(1, Math.min(options.maximumRecords ?? 10_000, 100_000));
      const usageCutoff =
        options.now.getTime() - Math.max(1, options.usageRetentionDays) * 86_400_000;
      const rejectedCutoff =
        options.now.getTime() -
        Math.max(1, options.rejectedProposalRetentionDays ?? options.usageRetentionDays) *
          86_400_000;
      let truncated = false;
      let usageRecordsRemoved = 0;
      let gitObservationsRemoved = 0;
      let graphGenerationsRemoved = 0;
      let graphRebuildsRemoved = 0;
      let rejectedProposalsRemoved = 0;
      let earliestUsageObservation: string | undefined;

      const usageIds = await scanSet(keys.usageIndex, maximum);
      truncated ||= usageIds.truncated;
      for (const usageId of usageIds.members) {
        const record = await read(keys.usage(usageId), usageRecordSchema, 'usage');
        if (record === null) continue;
        if (
          earliestUsageObservation === undefined ||
          record.observedAt < earliestUsageObservation
        ) {
          earliestUsageObservation = record.observedAt;
        }
        if (Date.parse(record.observedAt) >= usageCutoff) continue;
        await client.sendCommand(['SREM', keys.usageIndex, record.id]);
        await client.sendCommand(['SREM', keys.projectUsage(record.projectId), record.id]);
        await client.sendCommand(['SREM', keys.agentUsage(record.agentId), record.id]);
        await client.sendCommand(['SREM', keys.sessionUsage(record.sessionId), record.id]);
        await client.sendCommand(['HDEL', keys.usage(record.id), 'json']);
        await client.sendCommand([
          'HSET',
          keys.usage(record.id),
          'id',
          record.id,
          'retained',
          'tombstone',
        ]);
        usageRecordsRemoved += 1;
        if (earliestUsageObservation === record.observedAt) {
          earliestUsageObservation = undefined;
        }
      }
      if (!truncated) {
        const remaining = await scanSet(keys.usageIndex, maximum);
        truncated ||= remaining.truncated;
        for (const usageId of remaining.members) {
          const record = await read(keys.usage(usageId), usageRecordSchema, 'usage');
          if (
            record !== null &&
            (earliestUsageObservation === undefined || record.observedAt < earliestUsageObservation)
          ) {
            earliestUsageObservation = record.observedAt;
          }
        }
        if (earliestUsageObservation === undefined) {
          await client.sendCommand(['DEL', keys.intelligenceEarliestObservation]);
        } else {
          await client.sendCommand([
            'SET',
            keys.intelligenceEarliestObservation,
            earliestUsageObservation,
          ]);
        }
      }

      const observationIds = await scanSet(keys.gitObservationsIndex, maximum);
      truncated ||= observationIds.truncated;
      const observationsByProject = new Map<string, GitObservation[]>();
      for (const observationId of observationIds.members) {
        const observation = await read(
          keys.gitObservation(observationId),
          gitObservationSchema,
          'Git observation',
        );
        if (observation === null) continue;
        const project = observationsByProject.get(observation.projectId) ?? [];
        project.push(observation);
        observationsByProject.set(observation.projectId, project);
      }
      for (const [projectId, observations] of observationsByProject) {
        const currentId = text(
          await client.sendCommand(['HGET', keys.projectGitCurrent(projectId), 'id']),
        );
        const keep = new Set(
          observations
            .toSorted((left, right) => right.observedAt.localeCompare(left.observedAt))
            .slice(0, Math.max(1, options.gitObservationRetentionCount))
            .map(({ id }) => id),
        );
        if (currentId !== null) keep.add(currentId);
        for (const observation of observations) {
          if (keep.has(observation.id)) continue;
          await client.sendCommand(['DEL', keys.gitObservation(observation.id)]);
          await client.sendCommand(['SREM', keys.gitObservationsIndex, observation.id]);
          await client.sendCommand([
            'SREM',
            keys.projectGitObservations(projectId),
            observation.id,
          ]);
          gitObservationsRemoved += 1;
        }
      }

      const generationValues = stringArray(
        await client.sendCommand(['ZRANGE', keys.graphGenerationsIndex, '0', '-1']),
      );
      const activeGeneration = text(await client.sendCommand(['GET', keys.graphActiveGeneration]));
      const retainedGenerations = new Set(
        generationValues.slice(-Math.max(1, options.graphGenerationRetentionCount)),
      );
      if (activeGeneration !== null) retainedGenerations.add(activeGeneration);
      for (const generation of generationValues) {
        if (retainedGenerations.has(generation)) continue;
        const incomplete = await removeGraphGeneration(generation, maximum);
        truncated ||= incomplete;
        if (!incomplete) graphGenerationsRemoved += 1;
      }

      const rebuildIds = await scanSet(keys.graphRebuildsIndex, maximum);
      truncated ||= rebuildIds.truncated;
      const rebuilds: GraphRebuildOperation[] = [];
      for (const operationId of rebuildIds.members) {
        const operation = await read(
          keys.graphRebuild(operationId),
          graphRebuildOperationSchema,
          'graph rebuild',
        );
        if (operation !== null) rebuilds.push(operation);
      }
      const retainedRebuildIds = new Set(
        rebuilds
          .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
          .slice(0, Math.max(1, options.graphRebuildRetentionCount ?? 100))
          .map(({ id }) => id),
      );
      for (const operation of rebuilds) {
        if (
          retainedRebuildIds.has(operation.id) ||
          operation.state === 'pending' ||
          operation.state === 'running'
        ) {
          continue;
        }
        await client.sendCommand(['DEL', keys.graphRebuild(operation.id)]);
        await client.sendCommand(['SREM', keys.graphRebuildsIndex, operation.id]);
        graphRebuildsRemoved += 1;
      }

      const proposalIds = await scanSet(keys.optimizationProposalsIndex, maximum);
      truncated ||= proposalIds.truncated;
      for (const proposalId of proposalIds.members) {
        const proposal = await read(
          keys.optimizationProposal(proposalId),
          optimizationProposalSchema,
          'optimization proposal',
        );
        if (
          proposal === null ||
          proposal.state !== 'rejected' ||
          Date.parse(proposal.updatedAt) >= rejectedCutoff
        ) {
          continue;
        }
        await client.sendCommand(['DEL', keys.optimizationProposal(proposal.id)]);
        await client.sendCommand(['SREM', keys.optimizationProposalsIndex, proposal.id]);
        rejectedProposalsRemoved += 1;
      }

      return {
        usageRecordsRemoved,
        gitObservationsRemoved,
        graphGenerationsRemoved,
        graphRebuildsRemoved,
        rejectedProposalsRemoved,
        ...(earliestUsageObservation === undefined ? {} : { earliestUsageObservation }),
        truncated,
      };
    },
  };
}
