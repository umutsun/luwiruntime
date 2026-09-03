import { graphNeighborsResponseSchema, graphSubgraphResponseSchema } from '@luwi/protocol/browser';

import { abbreviateSha } from '../components/format.js';
import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * The rooted, bounded subgraph read behind the Graph explorer (ADR 0016).
 *
 * Node identity here is `entityId`, not the node's own `id`. The daemon keys
 * `graph:generation:<g>:node:<kind>:<entityId>`, and edge endpoints reference
 * the same value, so `entityId` is the only identifier that both addresses a
 * node and links two of them. The digest `id` is carried for display only.
 */

/** ADR 0012's marker for edges and nodes the code-structure observer produced. */
const CODE_STRUCTURE_PROVENANCE_PREFIX = 'code-structure-observer';
/** ADR 0029's marker for what was read from graphify's own output. */
const GRAPHIFY_PROVENANCE_PREFIX = 'graphify-graph-json';

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_NODE_LIMIT = 250;

export type GraphConfidence = 'high' | 'medium' | 'low' | 'unknown';

export type GraphRoot = { kind: string; id: string; label: string };

export type ExplorerNode = {
  /** The entity id; edges reference this. */
  id: string;
  kind: string;
  label: string;
  confidence: GraphConfidence;
  provenance: string;
  structural: boolean;
};

export type ExplorerEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  confidence: GraphConfidence;
  provenance: string;
  structural: boolean;
};

export type Subgraph = {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  truncated: boolean;
};

export type SubgraphBounds = { maxDepth?: number; nodeLimit?: number };

export function subgraphPath(root: GraphRoot, bounds: SubgraphBounds): string {
  const query = new URLSearchParams({
    nodeKind: root.kind,
    nodeId: root.id,
    maxDepth: String(bounds.maxDepth ?? DEFAULT_MAX_DEPTH),
    nodeLimit: String(bounds.nodeLimit ?? DEFAULT_NODE_LIMIT),
  });
  return `/api/v1/graph/subgraph?${query.toString()}`;
}

export type GraphOrigin = 'runtime' | 'code-structure' | 'graphify';

/** Where a claim came from, by the provenance prefix each source stamps on its records. */
export function originOf(provenance: string): GraphOrigin {
  if (provenance.startsWith(CODE_STRUCTURE_PROVENANCE_PREFIX)) return 'code-structure';
  if (provenance.startsWith(GRAPHIFY_PROVENANCE_PREFIX)) return 'graphify';
  return 'runtime';
}

export const originLabels: Record<GraphOrigin, string> = {
  runtime: 'Runtime events',
  'code-structure': 'Code structure',
  graphify: 'Graphify output',
};

/** Structure parsed from code rather than derived from events — by either observer. */
function isStructural(provenance: string): boolean {
  return originOf(provenance) !== 'runtime';
}

/**
 * A readable name when the projection recorded one; never an invented one.
 *
 * The keys differ per node kind and were read off the live projection: projects
 * and technologies record `name`, packages `packageName`, files `relativePath`,
 * modules `path`, commits `commitSha`. Missing `packageName` and `relativePath`
 * meant most of the graph — 345 of 433 nodes are files — rendered as an opaque
 * hash. A commit is shown abbreviated, as everywhere else in this dashboard.
 */
function labelOf(metadata: Record<string, unknown>, entityId: string): string {
  for (const key of ['name', 'displayName', 'packageName', 'relativePath', 'path', 'title']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const sha = metadata['commitSha'];
  if (typeof sha === 'string' && sha.length > 0) return abbreviateSha(sha);
  return entityId;
}

type RawNode = {
  entityId: string;
  kind: string;
  confidence: GraphConfidence;
  provenance: string;
  metadata: Record<string, unknown>;
};
type RawEdge = {
  id: string;
  source: { id: string };
  target: { id: string };
  kind: string;
  confidence: GraphConfidence;
  provenance: string;
};

const toNode = (node: RawNode): ExplorerNode => ({
  id: node.entityId,
  kind: node.kind,
  label: labelOf(node.metadata, node.entityId),
  confidence: node.confidence,
  provenance: node.provenance,
  structural: isStructural(node.provenance),
});

const toEdge = (edge: RawEdge): ExplorerEdge => ({
  id: edge.id,
  source: edge.source.id,
  target: edge.target.id,
  kind: edge.kind,
  confidence: edge.confidence,
  provenance: edge.provenance,
  structural: isStructural(edge.provenance),
});

export function incomingPath(root: GraphRoot, limit: number): string {
  return `/api/v1/graph/nodes/${encodeURIComponent(root.kind)}/${encodeURIComponent(root.id)}/in?limit=${String(limit)}`;
}

/**
 * The root's neighbourhood: the bounded outgoing subgraph, plus the root's
 * immediate incoming edges.
 *
 * `graphSubgraph` traverses `out` only — verified in
 * `apps/daemon/src/intelligence-service.ts`. On a sink kind such as `module`,
 * whose edges all point inward, an outgoing-only read is empty, and the view
 * would report "no relationships" about a node with nine of them. One extra
 * bounded request buys the root's true immediate neighbourhood.
 *
 * Only the root's incoming edges are fetched, not every node's: expanding
 * inward at every depth would multiply requests without a bound the daemon
 * enforces for us.
 */
export async function loadSubgraph(
  client: DaemonClient,
  root: GraphRoot,
  bounds: SubgraphBounds,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<Subgraph>> {
  const get = options.signal === undefined ? {} : { signal: options.signal };
  const limit = bounds.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const [outward, inward] = await Promise.all([
    client.get(subgraphPath(root, bounds), graphSubgraphResponseSchema, get),
    client.get(incomingPath(root, limit), graphNeighborsResponseSchema, get),
  ]);
  if (outward.state !== 'ready') return { state: 'unavailable' };

  const nodes = new Map<string, ExplorerNode>();
  const edges = new Map<string, ExplorerEdge>();
  for (const node of outward.data.nodes) nodes.set(node.entityId, toNode(node));
  for (const edge of outward.data.edges) edges.set(edge.id, toEdge(edge));

  // A failed incoming read degrades to the outgoing view rather than failing
  // the whole panel; the outgoing half is a true answer on its own.
  if (inward.state === 'ready') {
    for (const node of inward.data.nodes) {
      if (nodes.size >= limit && !nodes.has(node.entityId)) continue;
      nodes.set(node.entityId, toNode(node));
    }
    for (const edge of inward.data.edges) {
      if (nodes.has(edge.source.id) && nodes.has(edge.target.id)) edges.set(edge.id, toEdge(edge));
    }
  }

  return {
    state: 'ready',
    data: {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      truncated:
        outward.data.truncated || (inward.state === 'ready' ? inward.data.truncated : false),
    },
  };
}
