import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceCollide,
  type SimulationNodeDatum,
} from 'd3-force';

/**
 * Force layout for a bounded subgraph (ADR 0016).
 *
 * This is a pure function: same input, same picture. Determinism is not a
 * nicety here — `d3-force` jiggles coincident nodes through `Math.random`, so
 * without a seeded source the layout is untestable and a reader who returns to
 * a root sees a different arrangement each time. The simulation is stepped a
 * fixed number of ticks rather than run to its own convergence, for the same
 * reason.
 */

const TICKS = 300;
const NODE_RADIUS = 22;
const MARGIN = 28;

export type LayoutNode = { id: string; kind: string };
export type LayoutEdge = { id: string; source: string; target: string };

export type PositionedNode = LayoutNode & { x: number; y: number };
export type PositionedEdge = {
  id: string;
  source: PositionedNode;
  target: PositionedNode;
};

export type LayoutResult = {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  /** Edges whose endpoint was outside the returned node set. */
  droppedEdgeCount: number;
};

type Simulated = SimulationNodeDatum & { id: string; kind: string };

/** A small deterministic generator, standing in for `Math.random`. */
function seededRandom(seed = 0x2f6e2b1): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return (low + high) / 2;
  return Math.min(high, Math.max(low, value));
}

export function layoutGraph({
  nodes,
  edges,
  width,
  height,
  rootId,
}: {
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  width: number;
  height: number;
  rootId?: string;
}): LayoutResult {
  if (nodes.length === 0) return { nodes: [], edges: [], droppedEdgeCount: 0 };

  const present = new Set(nodes.map((node) => node.id));
  const usable = edges.filter(
    (candidate) => present.has(candidate.source) && present.has(candidate.target),
  );
  const droppedEdgeCount = edges.length - usable.length;

  const simulated: Simulated[] = nodes.map((node, index) => ({
    id: node.id,
    kind: node.kind,
    // A deterministic ring seed; d3's own phyllotaxis start is fine, but an
    // explicit one keeps the result stable across d3 versions.
    x: width / 2 + Math.cos((index / nodes.length) * Math.PI * 2) * Math.min(width, height) * 0.3,
    y: height / 2 + Math.sin((index / nodes.length) * Math.PI * 2) * Math.min(width, height) * 0.3,
  }));
  const byId = new Map(simulated.map((node) => [node.id, node]));

  const root = rootId === undefined ? undefined : byId.get(rootId);
  if (root !== undefined) {
    // The root is pinned to the centre so re-rooting reads as a move to a new
    // subject rather than as an unrelated new picture.
    root.fx = width / 2;
    root.fy = height / 2;
  }

  const simulation = forceSimulation(simulated)
    .randomSource(seededRandom())
    .force(
      'link',
      forceLink(usable.map((link) => ({ ...link })))
        .id((node) => (node as Simulated).id)
        .distance(90)
        .strength(0.35),
    )
    .force('charge', forceManyBody().strength(-320))
    .force('collide', forceCollide(NODE_RADIUS + 6))
    .force('center', forceCenter(width / 2, height / 2))
    .stop();

  simulation.tick(TICKS);

  const positioned: PositionedNode[] = simulated.map((node) => ({
    id: node.id,
    kind: node.kind,
    x: clamp(node.x ?? width / 2, MARGIN, width - MARGIN),
    y: clamp(node.y ?? height / 2, MARGIN, height - MARGIN),
  }));
  const positionedById = new Map(positioned.map((node) => [node.id, node]));

  return {
    nodes: positioned,
    edges: usable.flatMap((link) => {
      const source = positionedById.get(link.source);
      const target = positionedById.get(link.target);
      return source === undefined || target === undefined ? [] : [{ id: link.id, source, target }];
    }),
    droppedEdgeCount,
  };
}
