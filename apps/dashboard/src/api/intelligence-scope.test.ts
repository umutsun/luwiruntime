import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { DaemonClient, ResourceResult } from './client.js';
import {
  intelligenceResourceKeys,
  intelligenceResourcesForEvent,
  loadIntelligenceScope,
} from './intelligence-scope.js';

const observedAt = '2026-08-08T00:00:00.000Z';

const graphFixture = {
  observed: true,
  generation: 'generation-1',
  projectionHealth: 'healthy',
  nodeCount: 7,
  edgeCount: 4,
  nodeCountsByKind: [
    { kind: 'project', count: 2 },
    { kind: 'session', count: 5 },
  ],
  edgeCountsByKind: [{ kind: 'PROJECT_BOUND_AGENT', count: 4 }],
  observedAt,
};

const unbuiltFixture = {
  observed: false,
  projectionHealth: 'healthy',
  nodeCountsByKind: [],
  edgeCountsByKind: [],
  observedAt,
};

const emptyCollections: Record<string, unknown> = {
  '/api/v1/context/sources': { sources: [], truncated: false },
  '/api/v1/optimization/proposals': { proposals: [], truncated: false },
};

/**
 * Answers per path, because each resource parses against its own schema and a
 * single shared body would fail validation on the routes it does not describe.
 */
function clientFor(graphBody: unknown, options: { fail?: boolean } = {}) {
  const paths: string[] = [];
  const client: DaemonClient = {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<ResourceResult<T>> {
      paths.push(path);
      if (options.fail === true) return { state: 'unavailable', reason: 'transport' };
      const matched = Object.entries(emptyCollections).find(([prefix]) => path.startsWith(prefix));
      const body = matched === undefined ? graphBody : matched[1];
      return {
        state: 'ready',
        data: schema.parse(body),
        httpStatus: 200,
        receivedAt: observedAt,
      };
    },
  };
  return { client, paths };
}

describe('intelligence scope graph summary', () => {
  it('reads the bounded summary route and keeps kinds verbatim', async () => {
    const { client, paths } = clientFor(graphFixture);

    const resources = await loadIntelligenceScope(client, ['graph']);

    expect(paths).toEqual(['/api/v1/graph/summary']);
    expect(resources.graph).toEqual({
      state: 'ready',
      data: {
        observed: true,
        generation: 'generation-1',
        projectionHealth: 'healthy',
        nodeCount: 7,
        edgeCount: 4,
        nodeCountsByKind: [
          { kind: 'project', count: 2 },
          { kind: 'session', count: 5 },
        ],
        edgeCountsByKind: [{ kind: 'PROJECT_BOUND_AGENT', count: 4 }],
        observedAt,
      },
    });
  });

  it('carries an unbuilt graph across without inventing totals', async () => {
    const { client } = clientFor(unbuiltFixture);

    const resources = await loadIntelligenceScope(client, ['graph']);

    expect(resources.graph?.state).toBe('ready');
    const data = resources.graph?.state === 'ready' ? resources.graph.data : undefined;
    expect(data?.observed).toBe(false);
    expect(data).not.toHaveProperty('nodeCount');
    expect(data).not.toHaveProperty('edgeCount');
    expect(data).not.toHaveProperty('generation');
  });

  it('reports a failed read as unavailable rather than an empty graph', async () => {
    const { client } = clientFor(graphFixture, { fail: true });

    const resources = await loadIntelligenceScope(client, ['graph']);

    expect(resources.graph).toEqual({ state: 'unavailable' });
  });

  it('requests nothing for keys it was not asked for', async () => {
    const { client, paths } = clientFor(graphFixture);

    await loadIntelligenceScope(client, ['sources']);

    expect(paths).not.toContain('/api/v1/graph/summary');
  });

  it('invalidates the graph panel on projection and rebuild events', () => {
    expect(intelligenceResourcesForEvent('graph.node.projected')).toEqual(['graph']);
    expect(intelligenceResourcesForEvent('graph.rebuild.completed')).toEqual(['graph']);
    // A runtime restart invalidates everything, including the graph.
    expect(intelligenceResourcesForEvent('runtime.ready')).toEqual([...intelligenceResourceKeys]);
    expect(intelligenceResourcesForEvent('session.heartbeat')).toEqual([]);
  });

  it('passes the abort signal to every request', async () => {
    const controller = new AbortController();
    const get = vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'transport' });

    await loadIntelligenceScope({ get } as unknown as DaemonClient, intelligenceResourceKeys, {
      signal: controller.signal,
    });

    expect(get).toHaveBeenCalledTimes(intelligenceResourceKeys.length);
    for (const call of get.mock.calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });
});
