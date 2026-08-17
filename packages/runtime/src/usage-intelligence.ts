import { randomUUID } from 'node:crypto';

import {
  usageRecordSchema,
  usageSourceSchema,
  usageSummarySchema,
  type UsageIngestRequest,
  type UsageRecord,
  type UsageSource,
  type UsageSourceComposition,
  type UsageSummary,
} from '@luwi/protocol';

export type UsageNormalizationDependencies = {
  createId: () => string;
  now: () => Date;
};

const defaultDependencies: UsageNormalizationDependencies = {
  createId: randomUUID,
  now: () => new Date(),
};

export function normalizeUsageRecord(
  input: UsageIngestRequest,
  dependencies: UsageNormalizationDependencies = defaultDependencies,
): UsageRecord {
  return usageRecordSchema.parse({
    ...input,
    id: input.id ?? dependencies.createId(),
    createdAt: dependencies.now().toISOString(),
  });
}

export function usageDayBucket(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) throw new Error('Usage timestamp is invalid.');
  return date.toISOString().slice(0, 10);
}

const numericFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cachedOutputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'reasoningTokens',
  'totalTokens',
  'contextUsedTokens',
] as const;

function compose(source: UsageSource, records: UsageRecord[]): UsageSourceComposition {
  const result: Record<string, unknown> = { source, recordCount: records.length };
  for (const field of numericFields) {
    const values = records
      .map((record) => record[field])
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) result[field] = values.reduce((sum, value) => sum + value, 0);
  }
  return result as UsageSourceComposition;
}

function common(
  records: UsageRecord[],
  field: 'projectId' | 'agentId' | 'sessionId' | 'model',
): string | undefined {
  const values = new Set(
    records.map((record) => record[field]).filter((value) => value !== undefined),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

export function summarizeUsageRecords(records: UsageRecord[]): UsageSummary {
  const sourceEvents = new Set<string>();
  for (const record of records) {
    if (record.sourceEventId === undefined) continue;
    if (sourceEvents.has(record.sourceEventId)) {
      throw new Error(`Duplicate source event identity: ${record.sourceEventId}`);
    }
    sourceEvents.add(record.sourceEventId);
  }

  const timestamps = records.map(({ observedAt }) => observedAt).toSorted();
  const result: Record<string, unknown> = {
    recordCount: records.length,
    sources: usageSourceSchema.options
      .map((source) => {
        const matching = records.filter((record) => record.source === source);
        return matching.length === 0 ? undefined : compose(source, matching);
      })
      .filter((value): value is UsageSourceComposition => value !== undefined),
  };

  for (const field of ['projectId', 'agentId', 'sessionId', 'model'] as const) {
    const value = common(records, field);
    if (value !== undefined) result[field] = value;
  }
  if (timestamps.length > 0) {
    result['observedFrom'] = timestamps[0];
    result['observedTo'] = timestamps.at(-1);
  }
  return usageSummarySchema.parse(result);
}
