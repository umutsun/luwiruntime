import { describe, expect, it, vi } from 'vitest';

import { loadSubgraph, subgraphPath, type GraphRoot } from './graph-explorer.js';
import type { DaemonClient, ResourceResult } from './client.js';

const root: GraphRoot = { kind: 'project', id: 'p1', label: 'Alpha' };

const neighbors = {
  node: {
    id: 'node-1',
    kind: 'project',
    entityId: 'p1',
    observedAt: '2026-08-08T00:00:00.000Z',
    provenance: 'project-projection',
    confidence: 'high',
    evidenceIds: ['p1'],
    metadata: { name: 'Alpha' },
  },
  truncated: false,
  nodes: [] as unknown[],
  edges: [] as unknown[],
};

/**
 * `loadSubgraph` issues two reads: the outgoing subgraph and the root's
 * incoming neighbours. Responses are routed by path so a test can fail one
 * without failing the other.
 */
function clientReturning(
  result: ResourceResult<unknown>,
  incoming: ResourceResult<unknown> = {
    state: 'ready',
    data: neighbors,
    httpStatus: 200,
    receivedAt: '2026-08-08T00:00:00.000Z',
  },
): { client: DaemonClient; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (path: string) =>
    path.endsWith('/in') || path.includes('/in?') ? incoming : result,
  );
  return { client: { get } as unknown as DaemonClient, get };
}

const subgraph = {
  truncated: false,
  nodes: [
    {
      id: 'node-1',
      kind: 'project',
      entityId: 'p1',
      observedAt: '2026-08-08T00:00:00.000Z',
      provenance: 'project-projection',
      confidence: 'high',
      evidenceIds: ['p1'],
      metadata: { name: 'Alpha' },
    },
    {
      id: 'node-2',
      kind: 'module',
      entityId: 'module-abc',
      observedAt: '2026-08-08T00:00:00.000Z',
      provenance: 'code-structure-observer@1',
      confidence: 'high',
      evidenceIds: ['module-abc'],
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'edge-1',
      source: { kind: 'project', id: 'p1' },
      target: { kind: 'module', id: 'module-abc' },
      kind: 'PROJECT_HAS_MODULE',
      observedAt: '2026-08-08T00:00:00.000Z',
      provenance: 'code-structure-observer@1',
      confidence: 'medium',
      evidenceIds: ['e1'],
    },
  ],
};

describe('subgraphPath', () => {
  it('encodes the root and the bounds the daemon expects', () => {
    expect(subgraphPath(root, { maxDepth: 3, nodeLimit: 120 })).toBe(
      '/api/v1/graph/subgraph?nodeKind=project&nodeId=p1&maxDepth=3&nodeLimit=120',
    );
  });

  it('escapes a root id that is not URL-safe', () => {
    const path = subgraphPath({ kind: 'file', id: 'src/a b.ts', label: 'a b' }, {});

    // The slash is the one that would otherwise change the route. Space becomes
    // '+', which is the standard query-string encoding and what the daemon's
    // parser decodes back to a space.
    expect(path).toContain('nodeId=src%2Fa+b.ts');
    const parsed = new URLSearchParams(path.split('?')[1]);
    expect(parsed.get('nodeId')).toBe('src/a b.ts');
  });
});

describe('loadSubgraph', () => {
  it('keys nodes by entity id, because edge endpoints reference that', async () => {
    const { client } = clientReturning({
      state: 'ready',
      data: subgraph,
      httpStatus: 200,
      receivedAt: '2026-08-08T00:00:00.000Z',
    });

    const result = await loadSubgraph(client, root, {});

    expect(result.state).toBe('ready');
    if (result.state !== 'ready') return;
    expect(result.data.nodes.map((node) => node.id)).toEqual(['p1', 'module-abc']);
    expect(result.data.edges[0]).toMatchObject({ source: 'p1', target: 'module-abc' });
  });

  it('marks edges the code-structure observer produced', async () => {
    const { client } = clientReturning({
      state: 'ready',
      data: subgraph,
      httpStatus: 200,
      receivedAt: '2026-08-08T00:00:00.000Z',
    });

    const result = await loadSubgraph(client, root, {});

    if (result.state !== 'ready') throw new Error('expected ready');
    expect(result.data.edges[0]?.structural).toBe(true);
    expect(result.data.nodes[1]?.structural).toBe(true);
    expect(result.data.nodes[0]?.structural).toBe(false);
  });

  it('carries confidence through rather than defaulting it to high', async () => {
    const { client } = clientReturning({
      state: 'ready',
      data: subgraph,
      httpStatus: 200,
      receivedAt: '2026-08-08T00:00:00.000Z',
    });

    const result = await loadSubgraph(client, root, {});

    if (result.state !== 'ready') throw new Error('expected ready');
    expect(result.data.edges[0]?.confidence).toBe('medium');
  });

  it('preserves the truncated flag so coverage is never overstated', async () => {
    const { client } = clientReturning({
      state: 'ready',
      data: { ...subgraph, truncated: true },
      httpStatus: 200,
      receivedAt: '2026-08-08T00:00:00.000Z',
    });

    const result = await loadSubgraph(client, root, {});

    if (result.state !== 'ready') throw new Error('expected ready');
    expect(result.data.truncated).toBe(true);
  });

  it('reports a failed read as unavailable rather than as an empty graph', async () => {
    const { client } = clientReturning({ state: 'unavailable', reason: 'http', httpStatus: 404 });

    const result = await loadSubgraph(client, root, {});

    expect(result.state).toBe('unavailable');
  });

  it('merges the root incoming edges, so a sink kind is not reported as empty', async () => {
    const module = {
      id: 'node-9',
      kind: 'module',
      entityId: 'module-abc',
      observedAt: '2026-08-08T00:00:00.000Z',
      provenance: 'code-structure-observer@1',
      confidence: 'high' as const,
      evidenceIds: ['module-abc'],
      metadata: {},
    };
    const file = { ...module, id: 'node-10', kind: 'file', entityId: 'file-1' };
    const { client } = clientReturning(
      {
        state: 'ready',
        data: { truncated: false, nodes: [module], edges: [] },
        httpStatus: 200,
        receivedAt: '2026-08-08T00:00:00.000Z',
      },
      {
        state: 'ready',
        data: {
          node: module,
          truncated: false,
          nodes: [file],
          edges: [
            {
              id: 'e-in',
              source: { kind: 'file', id: 'file-1' },
              target: { kind: 'module', id: 'module-abc' },
              kind: 'FILE_BELONGS_TO_MODULE',
              observedAt: '2026-08-08T00:00:00.000Z',
              provenance: 'deterministic-module-mapping',
              confidence: 'high',
              evidenceIds: ['x'],
            },
          ],
        },
        httpStatus: 200,
        receivedAt: '2026-08-08T00:00:00.000Z',
      },
    );

    const result = await loadSubgraph(client, { kind: 'module', id: 'module-abc', label: 'm' }, {});

    if (result.state !== 'ready') throw new Error('expected ready');
    expect(result.data.nodes.map((node) => node.id)).toEqual(['module-abc', 'file-1']);
    expect(result.data.edges).toHaveLength(1);
  });

  it('degrades to the outgoing view when the incoming read fails', async () => {
    const { client } = clientReturning(
      {
        state: 'ready',
        data: subgraph,
        httpStatus: 200,
        receivedAt: '2026-08-08T00:00:00.000Z',
      },
      { state: 'unavailable', reason: 'http', httpStatus: 500 },
    );

    const result = await loadSubgraph(client, root, {});

    expect(result.state).toBe('ready');
    if (result.state !== 'ready') return;
    expect(result.data.nodes).toHaveLength(2);
  });

  it('labels each kind from the metadata key that kind actually records', async () => {
    // Measured against db0: packages carry packageName, files relativePath,
    // modules path, commits commitSha, technologies and projects name. Only the
    // first three were previously missed, and files are most of the graph.
    const base = {
      id: 'n',
      observedAt: '2026-08-08T00:00:00.000Z',
      provenance: 'p',
      confidence: 'high' as const,
      evidenceIds: ['e'],
    };
    const { client } = clientReturning({
      state: 'ready',
      data: {
        truncated: false,
        edges: [],
        nodes: [
          { ...base, kind: 'package', entityId: 'pkg-abc', metadata: { packageName: 'react-dom' } },
          {
            ...base,
            kind: 'file',
            entityId: 'file-abc',
            metadata: { relativePath: 'apps/dashboard/src/app.tsx' },
          },
          { ...base, kind: 'module', entityId: 'module-abc', metadata: { path: 'apps/cli' } },
          {
            ...base,
            kind: 'commit',
            entityId: 'scoped-abc',
            metadata: { commitSha: 'ea487d981e1dc2dec528f6c12c30004ddb2c5b21' },
          },
          { ...base, kind: 'agent', entityId: 'codex', metadata: {} },
        ],
      },
      httpStatus: 200,
      receivedAt: '2026-08-08T00:00:00.000Z',
    });

    const result = await loadSubgraph(client, root, {});

    if (result.state !== 'ready') throw new Error('expected ready');
    expect(result.data.nodes.map((node) => node.label)).toEqual([
      'react-dom',
      'apps/dashboard/src/app.tsx',
      'apps/cli',
      'ea487d981e1d',
      'codex',
    ]);
  });

  it('prefers a node name from metadata and falls back to the entity id', async () => {
    const { client } = clientReturning({
      state: 'ready',
      data: subgraph,
      httpStatus: 200,
      receivedAt: '2026-08-08T00:00:00.000Z',
    });

    const result = await loadSubgraph(client, root, {});

    if (result.state !== 'ready') throw new Error('expected ready');
    expect(result.data.nodes[0]?.label).toBe('Alpha');
    expect(result.data.nodes[1]?.label).toBe('module-abc');
  });
});
