import type { KnowledgeGraph } from '../api/knowledge-scope.js';

const VIEW_W = 1000;
const VIEW_H = 680;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const RING = 235; // community ring radius
const R = { god: 15, hub: 10, symbol: 5.5 } as const;

export type LaidNode = {
  id: string;
  label: string;
  kind: 'god' | 'hub' | 'symbol';
  x: number;
  y: number;
  r: number;
  selected: boolean;
  neighbor: boolean;
  dim: boolean;
};
export type LaidEdge = {
  source: string;
  target: string;
  kind: 'import' | 'call';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  active: boolean;
};

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** Deterministic [0,1) from a string. */
function unit(value: string): number {
  return hash(value) / 4294967296;
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function layoutKnowledge(
  graph: KnowledgeGraph,
  selectedId?: string,
): {
  nodes: LaidNode[];
  edges: LaidEdge[];
  communityLabels: { x: number; y: number; label: string }[];
} {
  // Community index → ring angle. Communities present on kept nodes, ordered.
  const communityIds = [
    ...new Set(graph.nodes.map((n) => n.community).filter((c): c is number => c !== undefined)),
  ].sort((a, b) => a - b);
  const angleOf = new Map<number, number>();
  communityIds.forEach((id, i) =>
    angleOf.set(id, (i / Math.max(1, communityIds.length)) * Math.PI * 2),
  );

  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    (adjacency.get(edge.source) ?? adjacency.set(edge.source, new Set()).get(edge.source)!).add(
      edge.target,
    );
    (adjacency.get(edge.target) ?? adjacency.set(edge.target, new Set()).get(edge.target)!).add(
      edge.source,
    );
  }
  const neighbors =
    selectedId === undefined ? undefined : (adjacency.get(selectedId) ?? new Set<string>());

  const pos = new Map<string, { x: number; y: number }>();
  const nodes: LaidNode[] = graph.nodes.map((node) => {
    const base = node.community === undefined ? 0 : (angleOf.get(node.community) ?? 0);
    const cx = CX + RING * Math.cos(base);
    const cy = CY + RING * Math.sin(base);
    // Hubs/gods sit near the community centre; symbols spread on a small ring around it.
    const spread = node.kind === 'symbol' ? 78 : 26;
    const a = unit(node.id) * Math.PI * 2;
    const rad = spread * (0.35 + 0.65 * unit(`${node.id}:r`));
    const x = clamp(cx + rad * Math.cos(a), 24, VIEW_W - 24);
    const y = clamp(cy + rad * Math.sin(a), 24, VIEW_H - 24);
    pos.set(node.id, { x, y });
    const selected = node.id === selectedId;
    const neighbor = neighbors?.has(node.id) ?? false;
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      x,
      y,
      r: R[node.kind] + (selected ? 2 : 0),
      selected,
      neighbor,
      dim: selectedId !== undefined && !selected && !neighbor,
    };
  });

  const edges: LaidEdge[] = graph.edges
    .map((edge) => {
      const a = pos.get(edge.source);
      const b = pos.get(edge.target);
      if (a === undefined || b === undefined) return undefined;
      const active =
        selectedId !== undefined && (edge.source === selectedId || edge.target === selectedId);
      return {
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        active,
      };
    })
    .filter((edge): edge is LaidEdge => edge !== undefined);

  const communityLabels = communityIds.map((id) => {
    const base = angleOf.get(id) ?? 0;
    const label =
      graph.nodes.find((n) => n.community === id)?.communityName ?? `community ${String(id)}`;
    return { x: CX + RING * Math.cos(base), y: CY + RING * Math.sin(base) - 96, label };
  });

  return { nodes, edges, communityLabels };
}

export type KnowledgePanel =
  | {
      kind: 'summary';
      title: string;
      badge: string;
      sub: string;
      facts: { k: string; v: string }[];
      communities: { label: string; pct: string; n: number }[];
      rows: { id: string; rel: string; title: string; sub: string; meta: string }[];
    }
  | {
      kind: 'node';
      title: string;
      badge: string;
      eyebrow: string;
      sub: string;
      facts: { k: string; v: string }[];
      rows: { id: string; rel: string; title: string; sub: string; meta: string }[];
    };

export function knowledgePanel(graph: KnowledgeGraph, selectedId?: string): KnowledgePanel {
  const selected =
    selectedId === undefined ? undefined : graph.nodes.find((n) => n.id === selectedId);
  if (selected === undefined) {
    const total = Math.max(1, graph.summary.nodeCount);
    return {
      kind: 'summary',
      title: 'Project graph',
      badge: graph.summary.truncated ? 'BOUNDED' : 'COMPLETE',
      sub: `${String(graph.summary.edgeCount)} typed edges · no embeddings`,
      facts: [
        { k: 'Nodes', v: String(graph.summary.nodeCount) },
        { k: 'Edges', v: String(graph.summary.edgeCount) },
        { k: 'God nodes', v: String(graph.nodes.filter((n) => n.kind === 'god').length) },
      ],
      communities: graph.communities.map((c) => ({
        label: c.name,
        n: c.size,
        pct: `${String(Math.round((c.size / total) * 100))}%`,
      })),
      rows: graph.nodes
        .filter((n) => n.kind !== 'symbol')
        .slice(0, 8)
        .map((n) => ({
          id: n.id,
          rel: n.kind === 'god' ? '★' : '◦',
          title: n.label,
          sub: n.sourceFile,
          meta: `${String(n.degree)} deg`,
        })),
    };
  }
  const connectedIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source === selectedId) connectedIds.add(edge.target);
    if (edge.target === selectedId) connectedIds.add(edge.source);
  }
  const rows = [...connectedIds]
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is KnowledgeGraph['nodes'][number] => n !== undefined)
    .slice(0, 12)
    .map((n) => ({
      id: n.id,
      rel: n.kind === 'god' ? '★' : '◦',
      title: n.label,
      sub: n.sourceFile,
      meta: n.kind,
    }));
  return {
    kind: 'node',
    eyebrow: selected.communityName ?? 'symbol',
    title: selected.label,
    badge: selected.kind.toUpperCase(),
    sub: selected.sourceFile,
    facts: [
      { k: 'Degree', v: String(selected.degree) },
      { k: 'Kind', v: selected.kind },
      { k: 'Community', v: selected.communityName ?? '—' },
    ],
    rows,
  };
}
