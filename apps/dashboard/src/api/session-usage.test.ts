import { describe, expect, it, vi } from 'vitest';

import { createDaemonClient } from './client.js';
import { loadSessionUsage } from './session-usage.js';

type Counters = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalTokens?: number;
};

const record = (
  id: string,
  source: string,
  model: string | undefined,
  counters: Counters = {},
  observedAt = '2026-09-11T10:00:00.000Z',
) => ({
  id,
  projectId: 'p1',
  agentId: 'a1',
  sessionId: 's1',
  source,
  // The protocol pairs the grades: an unavailable record can only be of unknown confidence.
  confidence:
    source === 'unavailable' ? 'unknown' : source === 'adapter-extracted' ? 'reported' : 'exact',
  observedAt,
  ...(model === undefined ? {} : { model }),
  ...counters,
  createdAt: observedAt,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('session usage', () => {
  it('reads one bounded page for the session and names its models and per-grade totals', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        records: [
          record('u1', 'agent-exact', 'model-b', { totalTokens: 1200 }),
          record('u2', 'agent-exact', 'model-a', { totalTokens: 800 }),
          record('u3', 'adapter-extracted', undefined, { totalTokens: 50 }),
          record('u4', 'unavailable', undefined),
        ],
        truncated: false,
      }),
    );
    const client = createDaemonClient(fetchImpl as unknown as typeof fetch);

    const usage = await loadSessionUsage(client, 'session/1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/usage?sessionId=session%2F1&limit=200');
    expect(usage).toEqual({
      state: 'ready',
      data: {
        models: ['model-a', 'model-b'],
        latestModel: 'model-b',
        sources: [
          { source: 'agent-exact', label: 'exact', records: 2, totalTokens: 2000 },
          { source: 'adapter-extracted', label: 'extracted', records: 1, totalTokens: 50 },
          { source: 'unavailable', label: 'unavailable', records: 1 },
        ],
        counters: {},
        recordCount: 4,
        truncated: false,
      },
    });
  });

  it('sums each counter on its own and takes the context from the newest request', async () => {
    const client = createDaemonClient(
      vi.fn().mockResolvedValue(
        jsonResponse({
          records: [
            // Extracted records carry the vendor counters and no total, as the reader writes them.
            record(
              'u1',
              'adapter-extracted',
              'model-old',
              { inputTokens: 100, outputTokens: 40, cacheCreationInputTokens: 900 },
              '2026-09-11T09:00:00.000Z',
            ),
            record(
              'u2',
              'adapter-extracted',
              'model-new',
              {
                inputTokens: 2,
                outputTokens: 4700,
                cacheCreationInputTokens: 3224,
                cacheReadInputTokens: 508_374,
              },
              '2026-09-11T09:10:17.391Z',
            ),
            // A record with no counters at all contributes nothing and is never the newest request.
            record('u3', 'unavailable', undefined, {}, '2026-09-11T09:20:00.000Z'),
          ],
          truncated: true,
        }),
      ) as never,
    );

    const usage = await loadSessionUsage(client, 's1');

    expect(usage).toEqual({
      state: 'ready',
      data: {
        models: ['model-new', 'model-old'],
        latestModel: 'model-new',
        sources: [
          { source: 'adapter-extracted', label: 'extracted', records: 2 },
          { source: 'unavailable', label: 'unavailable', records: 1 },
        ],
        counters: { input: 102, output: 4740, cacheCreation: 4124, cacheRead: 508_374 },
        latestContext: { tokens: 2 + 508_374 + 3224, observedAt: '2026-09-11T09:10:17.391Z' },
        recordCount: 3,
        truncated: true,
      },
    });
  });

  it('reports a failed read as unavailable rather than as no usage', async () => {
    const client = createDaemonClient(
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: { code: 'X', message: 'no' } }, 500)) as never,
    );
    expect(await loadSessionUsage(client, 's1')).toEqual({ state: 'unavailable' });
  });
});
