import { describe, expect, it } from 'vitest';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import { knowledgePanel, layoutKnowledge } from './model.js';

const graph: KnowledgeGraph = {
  summary: {
    nodeCount: 3,
    edgeCount: 1,
    communityCount: 2,
    hubCount: 2,
    embeddings: 0,
    builtAtCommit: 'c1',
    observedAt: '2026-09-15T00:00:00.000Z',
    truncated: false,
  },
  communities: [
    { id: 0, name: 'graph', size: 2 },
    { id: 1, name: 'api', size: 1 },
  ],
  nodes: [
    {
      id: 'graph::god',
      label: 'god',
      sourceFile: 'src/graph.ts',
      community: 0,
      communityName: 'graph',
      kind: 'god',
      degree: 3,
    },
    {
      id: 'graph::leaf',
      label: 'leaf',
      sourceFile: 'src/leaf.ts',
      community: 0,
      communityName: 'graph',
      kind: 'symbol',
      degree: 1,
    },
    {
      id: 'api::hub',
      label: 'hub',
      sourceFile: 'src/api.ts',
      community: 1,
      communityName: 'api',
      kind: 'hub',
      degree: 2,
    },
  ],
  edges: [{ source: 'graph::god', target: 'api::hub', kind: 'import' }],
};

describe('layoutKnowledge', () => {
  it('places every node inside the viewBox, deterministically', () => {
    const a = layoutKnowledge(graph);
    const b = layoutKnowledge(graph);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    for (const n of a.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1000);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(680);
    }
    expect(a.nodes.find((n) => n.id === 'graph::god')?.r).toBeGreaterThan(
      a.nodes.find((n) => n.id === 'graph::leaf')!.r,
    );
  });

  it('marks the selected node, its neighbors, and the active edge', () => {
    const laid = layoutKnowledge(graph, 'graph::god');
    expect(laid.nodes.find((n) => n.id === 'graph::god')?.selected).toBe(true);
    expect(laid.nodes.find((n) => n.id === 'api::hub')?.neighbor).toBe(true);
    expect(laid.nodes.find((n) => n.id === 'graph::leaf')?.dim).toBe(true);
    expect(laid.edges[0]?.active).toBe(true);
  });
});

describe('knowledgePanel', () => {
  it('summarizes the project when nothing is selected', () => {
    const panel = knowledgePanel(graph);
    expect(panel.kind).toBe('summary');
    if (panel.kind === 'summary') {
      expect(panel.facts.map((f) => f.k)).toEqual(['Nodes', 'Edges', 'God nodes']);
      expect(panel.communities[0]?.label).toBe('graph');
    }
  });

  it('describes a selected node with its connected edges', () => {
    const panel = knowledgePanel(graph, 'graph::god');
    expect(panel.kind).toBe('node');
    if (panel.kind === 'node') {
      expect(panel.title).toBe('god');
      expect(panel.badge).toBe('GOD');
      expect(panel.rows.some((r) => r.id === 'api::hub')).toBe(true);
    }
  });
});
