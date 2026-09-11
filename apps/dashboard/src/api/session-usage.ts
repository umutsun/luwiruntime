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
 * give the one per-session token figure the comps drew — per provenance grade,
 * never summed across grades, exactly as the runtime-wide summary is shown.
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

export type SessionUsage = {
  /** Distinct models the records name, sorted; empty when none named one. */
  models: string[];
  /** One row per grade present, in provenance order. */
  sources: Array<{ source: string; label: string; records: number; totalTokens?: number }>;
  recordCount: number;
  truncated: boolean;
};

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
  const sources = sourceOrder.flatMap((source) => {
    const rows = records.filter((record) => record.source === source);
    if (rows.length === 0) return [];
    const totals = rows.flatMap((record) =>
      record.totalTokens === undefined ? [] : [record.totalTokens],
    );
    return [
      {
        source,
        label: sourceLabels[source],
        records: rows.length,
        ...(totals.length === 0
          ? {}
          : { totalTokens: totals.reduce((sum, value) => sum + value, 0) }),
      },
    ];
  });
  return {
    state: 'ready',
    data: { models, sources, recordCount: records.length, truncated },
  };
}
