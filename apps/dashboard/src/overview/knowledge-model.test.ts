import { describe, expect, it } from 'vitest';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import {
  createKnowledgeSim,
  KNOWLEDGE_HEIGHT,
  KNOWLEDGE_WIDTH,
  knowledgePanel,
  settleKnowledgeSim,
} from './knowledge-model.js';

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

function node(
  id: string,
  kind: 'god' | 'hub' | 'symbol',
  community: number | undefined,
  degree = 1,
): KnowledgeGraph['nodes'][number] {
  return {
    id,
    label: id.split('::')[1] ?? id,
    sourceFile: `src/${id}.ts`,
    ...(community === undefined ? {} : { community, communityName: `c${String(community)}` }),
    kind,
    degree,
  };
}

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
    { ...node('graph::god', 'god', 0, 3), communityName: 'graph' },
    { ...node('graph::leaf', 'symbol', 0, 1), communityName: 'graph' },
    { ...node('api::hub', 'hub', 1, 2), communityName: 'api' },
  ],
  edges: [{ source: 'graph::god', target: 'api::hub', kind: 'import' }],
};

describe('createKnowledgeSim', () => {
  it('lays the same graph out the same way under the same seed', () => {
    const a = createKnowledgeSim(graph, 7);
    const b = createKnowledgeSim(graph, 7);
    settleKnowledgeSim(a, 50);
    settleKnowledgeSim(b, 50);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });

  it('keeps every node inside the canvas and one projection per community present', () => {
    const sim = createKnowledgeSim(graph, 1);
    settleKnowledgeSim(sim, 200);
    for (const n of sim.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(KNOWLEDGE_WIDTH);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(KNOWLEDGE_HEIGHT);
    }
    expect(sim.communities.map((c) => [c.id, c.label])).toEqual([
      [0, 'graph'],
      [1, 'api'],
    ]);
  });

  it('pulls a node toward its own community rather than another', () => {
    const sim = createKnowledgeSim(graph, 3);
    settleKnowledgeSim(sim, 300);
    const own = sim.communities.find((c) => c.id === 0)!;
    const other = sim.communities.find((c) => c.id === 1)!;
    const leaf = sim.byId.get('graph::leaf')!;
    expect(distance(leaf, own)).toBeLessThan(distance(leaf, other));
  });

  it('rests a call edge longer than an unlinked pair in the same community', () => {
    const linked: KnowledgeGraph = {
      ...graph,
      nodes: [
        node('a::1', 'hub', 0),
        node('a::2', 'hub', 0),
        node('b::1', 'hub', 1),
        node('b::2', 'hub', 1),
      ],
      edges: [{ source: 'a::1', target: 'a::2', kind: 'call' }],
    };
    const sim = createKnowledgeSim(linked, 5);
    settleKnowledgeSim(sim, 600);
    const pair = distance(sim.byId.get('a::1')!, sim.byId.get('a::2')!);
    const loose = distance(sim.byId.get('b::1')!, sim.byId.get('b::2')!);
    expect(pair).toBeGreaterThan(loose);
  });

  it('cools to the alpha floor and never below it', () => {
    const sim = createKnowledgeSim(graph, 1);
    settleKnowledgeSim(sim, 2_000);
    expect(sim.alpha).toBeGreaterThanOrEqual(0.04);
    expect(sim.alpha).toBeLessThan(0.041);
  });

  it('holds a node with no community at the centre instead of failing', () => {
    const loose: KnowledgeGraph = {
      ...graph,
      nodes: [...graph.nodes, node('x::free', 'symbol', undefined)],
    };
    const sim = createKnowledgeSim(loose, 1);
    settleKnowledgeSim(sim, 100);
    const free = sim.byId.get('x::free')!;
    expect(distance(free, { x: KNOWLEDGE_WIDTH / 2, y: KNOWLEDGE_HEIGHT / 2 })).toBeLessThan(120);
    expect(sim.communities).toHaveLength(2);
  });

  it('orbits only when asked, so reduced motion holds the ring still', () => {
    const still = createKnowledgeSim(graph, 1);
    const moving = createKnowledgeSim(graph, 1);
    still.step(false);
    moving.step(true);
    expect(still.communities[0]?.x).not.toBe(moving.communities[0]?.x);
    const before = still.communities[0]?.x;
    still.step(false);
    expect(still.communities[0]?.x).toBe(before);
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
