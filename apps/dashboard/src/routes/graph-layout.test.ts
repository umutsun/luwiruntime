import { describe, expect, it } from 'vitest';

import { layoutGraph, type LayoutEdge, type LayoutNode } from './graph-layout.js';

const nodes = (...ids: string[]): LayoutNode[] => ids.map((id) => ({ id, kind: 'file' as const }));

const edge = (source: string, target: string): LayoutEdge => ({
  id: `${source}->${target}`,
  source,
  target,
});

describe('layoutGraph', () => {
  it('positions every node inside the viewport', () => {
    const result = layoutGraph({
      nodes: nodes('a', 'b', 'c'),
      edges: [edge('a', 'b'), edge('b', 'c')],
      width: 800,
      height: 500,
    });

    expect(result.nodes).toHaveLength(3);
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(800);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(500);
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it('is deterministic: the same input always produces the same picture', () => {
    const input = {
      nodes: nodes('a', 'b', 'c', 'd', 'e'),
      edges: [edge('a', 'b'), edge('a', 'c'), edge('c', 'd'), edge('d', 'e')],
      width: 800,
      height: 500,
    };

    const first = layoutGraph(input);
    const second = layoutGraph(input);

    expect(second.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      first.nodes.map(({ id, x, y }) => ({ id, x, y })),
    );
  });

  it('resolves every edge to positioned endpoints', () => {
    const result = layoutGraph({
      nodes: nodes('a', 'b'),
      edges: [edge('a', 'b')],
      width: 400,
      height: 300,
    });

    const [link] = result.edges;
    expect(link?.source.id).toBe('a');
    expect(link?.target.id).toBe('b');
    expect(Number.isFinite(link?.source.x)).toBe(true);
    expect(Number.isFinite(link?.target.y)).toBe(true);
  });

  it('drops an edge whose endpoint is absent instead of positioning a phantom node', () => {
    const result = layoutGraph({
      nodes: nodes('a'),
      edges: [edge('a', 'missing')],
      width: 400,
      height: 300,
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(result.droppedEdgeCount).toBe(1);
  });

  it('places the root at the centre so a re-root is recognisable', () => {
    const result = layoutGraph({
      nodes: nodes('root', 'a', 'b', 'c'),
      edges: [edge('root', 'a'), edge('root', 'b'), edge('root', 'c')],
      width: 800,
      height: 500,
      rootId: 'root',
    });

    const root = result.nodes.find((node) => node.id === 'root');
    expect(root?.x).toBeCloseTo(400, 5);
    expect(root?.y).toBeCloseTo(250, 5);
  });

  it('handles a single node without producing NaN', () => {
    const result = layoutGraph({ nodes: nodes('only'), edges: [], width: 400, height: 300 });

    expect(Number.isFinite(result.nodes[0]?.x)).toBe(true);
    expect(Number.isFinite(result.nodes[0]?.y)).toBe(true);
  });

  it('returns empty results for an empty graph', () => {
    const result = layoutGraph({ nodes: [], edges: [], width: 400, height: 300 });

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('separates nodes rather than stacking them at one point', () => {
    const result = layoutGraph({
      nodes: nodes('a', 'b', 'c', 'd'),
      edges: [],
      width: 800,
      height: 500,
    });

    const positions = new Set(result.nodes.map((node) => `${String(node.x)}:${String(node.y)}`));
    expect(positions.size).toBe(4);
  });
});
