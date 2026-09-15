import type { KnowledgeGraph } from '../api/knowledge-scope.js';

/**
 * The Knowledge lens's model: the comp's force simulation, ported verbatim,
 * and the inspector panel.
 *
 * The simulation is the one drawn in `Luwi Runtime - Graph.dc.html`:
 * community centres sit on a ring tilted into the third dimension and orbit
 * slowly under a perspective projection; nodes repel inside a radius, edges
 * are springs, and every node is drawn toward its community's projected
 * centre. It runs over the endpoint's bounded backbone (tens of nodes), so the
 * pairwise pass is cheap. Randomness is seeded so the same graph lays out the
 * same way twice and a test can assert positions.
 */

export const KNOWLEDGE_WIDTH = 1000;
export const KNOWLEDGE_HEIGHT = 680;
const CX = KNOWLEDGE_WIDTH / 2;
const CY = KNOWLEDGE_HEIGHT / 2;

const RING_RADIUS = 250;
const TILT = 0.46;
const PERSPECTIVE = 1000;
const ORBIT_PER_TICK = 0.00055;
const REPEL_RADIUS_SQ = 40_000;
const REPEL_SAME = 1500;
const REPEL_OTHER = 2400;
const SPRING_IMPORT = 70;
const SPRING_CALL = 150;
const SPRING_K = 0.009;
const COMMUNITY_PULL = 0.01;
const CENTRE_PULL = 0.0008;
const JITTER = 0.06;
const DAMPING = 0.9;
const ALPHA_DECAY = 0.993;
const ALPHA_FLOOR = 0.04;
const MARGIN = 30;

export type SimNode = {
  id: string;
  kind: 'god' | 'hub' | 'symbol';
  community?: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

/** A community's centre this tick: where it projects, how near it is (`s`), and its depth. */
export type CommunityProjection = {
  id: number;
  label: string;
  x: number;
  y: number;
  s: number;
  z: number;
};

export type KnowledgeSim = {
  nodes: SimNode[];
  byId: Map<string, SimNode>;
  edges: { a: SimNode; b: SimNode; kind: 'import' | 'call' }[];
  communities: CommunityProjection[];
  alpha: number;
  /** One tick. `orbit` false holds the ring still, for reduced motion. */
  step: (orbit: boolean) => void;
};

/** mulberry32 — the comp's generator, seeded so a layout is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function createKnowledgeSim(
  graph: KnowledgeGraph,
  seed = hash(`${graph.summary.builtAtCommit ?? ''}:${String(graph.summary.nodeCount)}`),
): KnowledgeSim {
  const random = rng(seed);
  const communityIds = [
    ...new Set(graph.nodes.map((n) => n.community).filter((c): c is number => c !== undefined)),
  ].sort((a, b) => a - b);
  const indexOf = new Map(communityIds.map((id, index) => [id, index]));
  const count = Math.max(1, communityIds.length);
  const communities: CommunityProjection[] = communityIds.map((id) => ({
    id,
    label: graph.nodes.find((n) => n.community === id)?.communityName ?? `community ${String(id)}`,
    x: CX,
    y: CY,
    s: 1,
    z: 0,
  }));

  const nodes: SimNode[] = graph.nodes.map((n) => {
    const index = n.community === undefined ? undefined : indexOf.get(n.community);
    const angle = index === undefined ? 0 : (index / count) * Math.PI * 2;
    const cx = index === undefined ? CX : CX + 230 * Math.cos(angle);
    const cy = index === undefined ? CY : CY + 210 * Math.sin(angle);
    return {
      id: n.id,
      kind: n.kind,
      ...(n.community === undefined ? {} : { community: n.community }),
      x: cx + (random() - 0.5) * 40,
      y: cy + (random() - 0.5) * 40,
      vx: 0,
      vy: 0,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.flatMap((e) => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    return a === undefined || b === undefined ? [] : [{ a, b, kind: e.kind }];
  });

  let baseAngle = 0;
  const sim: KnowledgeSim = {
    nodes,
    byId,
    edges,
    communities,
    alpha: 1,
    step(orbit) {
      if (orbit) baseAngle += ORBIT_PER_TICK;
      communities.forEach((c, i) => {
        const a = baseAngle + (i / count) * Math.PI * 2;
        const rx = RING_RADIUS * Math.cos(a);
        const rz = RING_RADIUS * Math.sin(a);
        const z = rz * Math.cos(TILT);
        const s = PERSPECTIVE / (PERSPECTIVE - z);
        c.x = CX + rx * s;
        c.y = CY + rz * Math.sin(TILT) * s;
        c.s = s;
        c.z = z;
      });
      const alpha = sim.alpha;
      for (let i = 0; i < nodes.length; i += 1) {
        const pi = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j += 1) {
          const pj = nodes[j]!;
          let dx = pi.x - pj.x;
          let dy = pi.y - pj.y;
          const d2 = dx * dx + dy * dy || 1;
          if (d2 >= REPEL_RADIUS_SQ) continue;
          const f = ((pi.community === pj.community ? REPEL_SAME : REPEL_OTHER) / d2) * alpha;
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          pi.vx += dx * f;
          pi.vy += dy * f;
          pj.vx -= dx * f;
          pj.vy -= dy * f;
        }
      }
      for (const e of edges) {
        let dx = e.b.x - e.a.x;
        let dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = e.kind === 'call' ? SPRING_CALL : SPRING_IMPORT;
        const f = (d - rest) * SPRING_K * alpha;
        dx /= d;
        dy /= d;
        e.a.vx += dx * f;
        e.a.vy += dy * f;
        e.b.vx -= dx * f;
        e.b.vy -= dy * f;
      }
      for (const n of nodes) {
        const index = n.community === undefined ? undefined : indexOf.get(n.community);
        const c = index === undefined ? undefined : communities[index];
        const tx = c?.x ?? CX;
        const ty = c?.y ?? CY;
        n.vx += (tx - n.x) * COMMUNITY_PULL * alpha;
        n.vy += (ty - n.y) * COMMUNITY_PULL * alpha;
        n.vx += (CX - n.x) * CENTRE_PULL;
        n.vy += (CY - n.y) * CENTRE_PULL;
        n.vx += (random() - 0.5) * JITTER;
        n.vy += (random() - 0.5) * JITTER;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        n.x = clamp(n.x + n.vx, MARGIN, KNOWLEDGE_WIDTH - MARGIN);
        n.y = clamp(n.y + n.vy, MARGIN, KNOWLEDGE_HEIGHT - MARGIN);
      }
      sim.alpha = Math.max(ALPHA_FLOOR, sim.alpha * ALPHA_DECAY);
    },
  };
  sim.step(false);
  return sim;
}

/** Runs the simulation without orbiting, so a first paint is already a layout. */
export function settleKnowledgeSim(sim: KnowledgeSim, steps: number): void {
  for (let i = 0; i < steps; i += 1) sim.step(false);
}

// ---------------------------------------------------------------------------
// The inspector panel
// ---------------------------------------------------------------------------

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
