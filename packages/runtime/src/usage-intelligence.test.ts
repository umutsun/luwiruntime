import { describe, expect, it } from 'vitest';

import type { UsageRecord } from '@luwi/protocol';

import {
  normalizeUsageRecord,
  summarizeUsageRecords,
  usageDayBucket,
} from './usage-intelligence.js';

const observedAt = '2026-07-30T23:59:59.000Z';

function record(overrides: Partial<UsageRecord>): UsageRecord {
  const source = overrides.source ?? 'agent-reported';
  const confidence = {
    'agent-exact': 'exact',
    'agent-reported': 'reported',
    'adapter-extracted': 'reported',
    'luwi-estimated': 'estimated',
    unavailable: 'unknown',
  } as const;
  return {
    id: 'usage-1',
    projectId: 'project-1',
    agentId: 'codex',
    sessionId: 'session-1',
    source,
    confidence: confidence[source],
    observedAt,
    createdAt: observedAt,
    metadata: {},
    ...overrides,
  };
}

describe('usage intelligence', () => {
  it('normalizes a record without converting absent token values to zero', () => {
    const normalized = normalizeUsageRecord(
      {
        projectId: 'project-1',
        agentId: 'codex',
        sessionId: 'session-1',
        source: 'unavailable',
        confidence: 'unknown',
        observedAt,
        metadata: {},
      },
      { createId: () => 'usage-generated', now: () => new Date(observedAt) },
    );

    expect(normalized.id).toBe('usage-generated');
    expect(normalized).not.toHaveProperty('inputTokens');
    expect(normalized).not.toHaveProperty('totalTokens');
  });

  it('keeps source composition separate while aggregating compatible fields', () => {
    const summary = summarizeUsageRecords([
      record({
        id: 'exact-1',
        source: 'agent-exact',
        confidence: 'exact',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      }),
      record({
        id: 'reported-1',
        source: 'agent-reported',
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
      }),
      record({
        id: 'reported-2',
        source: 'agent-reported',
        inputTokens: 25,
      }),
      record({ id: 'estimated-1', source: 'luwi-estimated', totalTokens: 90 }),
      record({ id: 'unavailable-1', source: 'unavailable', confidence: 'unknown' }),
    ]);

    expect(summary.recordCount).toBe(5);
    expect(summary.sources).toEqual([
      {
        source: 'agent-exact',
        recordCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
      {
        source: 'agent-reported',
        recordCount: 2,
        inputTokens: 75,
        outputTokens: 10,
        totalTokens: 60,
      },
      { source: 'luwi-estimated', recordCount: 1, totalTokens: 90 },
      { source: 'unavailable', recordCount: 1 },
    ]);
    expect(summary).not.toHaveProperty('totalTokens');
  });

  it('creates stable UTC day buckets independent of local timezone', () => {
    expect(usageDayBucket('2026-07-30T23:59:59.000Z')).toBe('2026-07-30');
  });

  it('rejects duplicate source event identities within one ingestion batch', () => {
    expect(() =>
      summarizeUsageRecords([
        record({ id: 'one', sourceEventId: 'event-1' }),
        record({ id: 'two', sourceEventId: 'event-1' }),
      ]),
    ).toThrowError(/duplicate source event/i);
  });
});
