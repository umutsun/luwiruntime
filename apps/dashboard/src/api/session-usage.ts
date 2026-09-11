import { usageCollectionSchema } from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * One session's usage, read on focus.
 *
 * A session states its model at registration (`metadata.model`) only when the
 * client that registered it knew one. When it did not, the model is still on
 * the usage records the transcript reader attributed to the session (ADR 0023
 * B1), each of which carries the model the vendor wrote. Those records also
 * carry the per-request counters the vendor reported — fresh input, output,
 * cache written, cache read — which is where two things the comps drew come
 * from: what the session has spent, and how large its context has grown. The
 * newest request's input plus cache is the prompt the model was last sent,
 * i.e. the context the session carries right now.
 *
 * Nothing is summed across provenance grades, and no single "total" is made
 * up: the extracted grade reports no `totalTokens`, and adding cache reads to
 * fresh input would fabricate one. Each counter is summed on its own.
 *
 * Bounded: one read of at most `LIMIT` records; a session past it is disclosed
 * as truncated rather than summed short in silence.
 */
const LIMIT = 200;

const sourceOrder = [
  'agent-exact',
  'agent-reported',
  'adapter-extracted',
  'luwi-estimated',
  'unavailable',
] as const;

const sourceLabels: Record<(typeof sourceOrder)[number], string> = {
  'agent-exact': 'exact',
  'agent-reported': 'reported',
  'adapter-extracted': 'extracted',
  'luwi-estimated': 'estimated',
  unavailable: 'unavailable',
};

export type SessionUsageCounters = {
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
};

export type SessionUsage = {
  /** Distinct models the records name, sorted; empty when none named one. */
  models: string[];
  /** The model of the newest record that named one. */
  latestModel?: string;
  /** One row per grade present, in provenance order. */
  sources: Array<{ source: string; label: string; records: number; totalTokens?: number }>;
  /** Per-counter sums over the records read; a counter is present only when a record carried it. */
  counters: SessionUsageCounters;
  /**
   * The newest request's prompt size — fresh input plus cache written plus
   * cache read — and when the transcript recorded it.
   */
  latestContext?: { tokens: number; observedAt: string };
  recordCount: number;
  truncated: boolean;
};

type UsageRecord = ReturnType<typeof usageCollectionSchema.parse>['records'][number];

function newest(records: readonly UsageRecord[]): UsageRecord | undefined {
  let latest: UsageRecord | undefined;
  for (const record of records) {
    if (latest === undefined || record.observedAt > latest.observedAt) latest = record;
  }
  return latest;
}

function sum(records: readonly UsageRecord[], pick: (record: UsageRecord) => number | undefined) {
  const values = records.flatMap((record) => {
    const value = pick(record);
    return value === undefined ? [] : [value];
  });
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
}

export async function loadSessionUsage(
  client: DaemonClient,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<SessionUsage>> {
  const result = await client.get(
    `/api/v1/usage?sessionId=${encodeURIComponent(sessionId)}&limit=${String(LIMIT)}`,
    usageCollectionSchema,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (result.state !== 'ready') return { state: 'unavailable' };

  const { records, truncated } = result.data;
  const models = [
    ...new Set(records.flatMap((record) => (record.model === undefined ? [] : [record.model]))),
  ].sort();
  const latestModel = newest(records.filter((record) => record.model !== undefined))?.model;
  const sources = sourceOrder.flatMap((source) => {
    const rows = records.filter((record) => record.source === source);
    if (rows.length === 0) return [];
    const totals = sum(rows, (record) => record.totalTokens);
    return [
      {
        source,
        label: sourceLabels[source],
        records: rows.length,
        ...(totals === undefined ? {} : { totalTokens: totals }),
      },
    ];
  });
  const counters: SessionUsageCounters = {};
  const input = sum(records, (record) => record.inputTokens);
  const output = sum(records, (record) => record.outputTokens);
  const cacheCreation = sum(records, (record) => record.cacheCreationInputTokens);
  const cacheRead = sum(records, (record) => record.cacheReadInputTokens);
  if (input !== undefined) counters.input = input;
  if (output !== undefined) counters.output = output;
  if (cacheCreation !== undefined) counters.cacheCreation = cacheCreation;
  if (cacheRead !== undefined) counters.cacheRead = cacheRead;

  const latest = newest(
    records.filter(
      (record) =>
        record.inputTokens !== undefined ||
        record.cacheReadInputTokens !== undefined ||
        record.cacheCreationInputTokens !== undefined,
    ),
  );
  const latestContext =
    latest === undefined
      ? undefined
      : {
          tokens:
            (latest.inputTokens ?? 0) +
            (latest.cacheReadInputTokens ?? 0) +
            (latest.cacheCreationInputTokens ?? 0),
          observedAt: latest.observedAt,
        };

  return {
    state: 'ready',
    data: {
      models,
      ...(latestModel === undefined ? {} : { latestModel }),
      sources,
      counters,
      ...(latestContext === undefined ? {} : { latestContext }),
      recordCount: records.length,
      truncated,
    },
  };
}
