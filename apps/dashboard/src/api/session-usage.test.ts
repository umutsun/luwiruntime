import { describe, expect, it, vi } from 'vitest';

import { createDaemonClient } from './client.js';
import { loadSessionUsage } from './session-usage.js';

const record = (id: string, source: string, model: string | undefined, totalTokens?: number) => ({
  id,
  projectId: 'p1',
  agentId: 'a1',
  sessionId: 's1',
  source,
  // The protocol pairs the grades: an unavailable record can only be of unknown confidence.
  confidence:
    source === 'unavailable' ? 'unknown' : source === 'adapter-extracted' ? 'reported' : 'exact',
  observedAt: '2026-09-11T10:00:00.000Z',
  ...(model === undefined ? {} : { model }),
  ...(totalTokens === undefined ? {} : { totalTokens }),
  createdAt: '2026-09-11T10:00:00.000Z',
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
          record('u1', 'agent-exact', 'model-b', 1200),
          record('u2', 'agent-exact', 'model-a', 800),
          record('u3', 'adapter-extracted', undefined, 50),
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
        sources: [
          { source: 'agent-exact', label: 'exact', records: 2, totalTokens: 2000 },
          { source: 'adapter-extracted', label: 'extracted', records: 1, totalTokens: 50 },
          { source: 'unavailable', label: 'unavailable', records: 1 },
        ],
        recordCount: 4,
        truncated: false,
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
