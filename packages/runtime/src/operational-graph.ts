import { createHash } from 'node:crypto';

import {
  GRAPH_MAX_NEIGHBOR_LIMIT,
  GRAPH_MAX_PATH_DEPTH,
  GRAPH_MAX_SUBGRAPH_NODE_LIMIT,
  graphEdgeSchema,
  graphNodeSchema,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphNeighborsQuery,
  type GraphNode,
  type GraphNodeKind,
  type GraphPathQuery,
  type GraphSubgraphQuery,
} from '@luwi/protocol';

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40);
}

export type CreateGraphNodeInput = Omit<GraphNode, 'id' | 'metadata'> & {
  id?: string | undefined;
  metadata?: GraphNode['metadata'];
};

export function createGraphNode(input: CreateGraphNodeInput): GraphNode {
  const { id: ignoredId, ...value } = input;
  void ignoredId;
  return graphNodeSchema.parse({
    ...value,
    id: `node-${digest([input.kind, input.projectId ?? '', input.entityId])}`,
    metadata: input.metadata ?? {},
  });
}

export type CreateGraphEdgeInput = Omit<GraphEdge, 'id' | 'metadata'> & {
  id?: string | undefined;
  metadata?: GraphEdge['metadata'];
};

export function createGraphEdge(input: CreateGraphEdgeInput): GraphEdge {
  const { id: ignoredId, ...value } = input;
  void ignoredId;
  return graphEdgeSchema.parse({
    ...value,
    id: `edge-${digest([
      input.kind,
      input.source.kind,
      input.source.id,
      input.target.kind,
      input.target.id,
      input.projectId ?? '',
    ])}`,
    metadata: input.metadata ?? {},
  });
}

function reference(kind: GraphNodeKind, id: string): string {
  return `${kind}\0${id}`;
}

export class OperationalGraphQueryError extends Error {
  readonly code = 'GRAPH_QUERY_LIMIT_EXCEEDED';
}

export type GraphDirection = 'out' | 'in';

export interface OperationalGraphQuery {
  node(kind: GraphNodeKind, id: string): GraphNode | null;
  neighbors(
    kind: GraphNodeKind,
    id: string,
    direction: GraphDirection,
    query: Partial<GraphNeighborsQuery> & { limit: number },
  ): {
    node: GraphNode;
    nodes: GraphNode[];
    edges: GraphEdge[];
    truncated: boolean;
  };
  shortestPath(
    kind: GraphNodeKind,
    id: string,
    query: GraphPathQuery,
  ): { found: boolean; nodes: GraphNode[]; edges: GraphEdge[] };
  subgraph(query: GraphSubgraphQuery): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    truncated: boolean;
  };
}

function queryMatches(edge: GraphEdge, query: Partial<GraphNeighborsQuery>): boolean {
  if (query.edgeKind !== undefined && edge.kind !== query.edgeKind) return false;
  if (query.projectId !== undefined && edge.projectId !== query.projectId) return false;
  if (query.from !== undefined && edge.observedAt < query.from) return false;
  if (query.to !== undefined && edge.observedAt > query.to) return false;
  return true;
}

export function createOperationalGraphQuery(
  nodeValues: readonly GraphNode[],
  edgeValues: readonly GraphEdge[],
): OperationalGraphQuery {
  const nodes = new Map(
    nodeValues.map((node) => [reference(node.kind, node.entityId), graphNodeSchema.parse(node)]),
  );
  const edges = edgeValues.map((edge) => graphEdgeSchema.parse(edge));

  const findNode = (kind: GraphNodeKind, id: string): GraphNode | null =>
    nodes.get(reference(kind, id)) ?? null;

  const matchingEdges = (
    kind: GraphNodeKind,
    id: string,
    direction: GraphDirection,
    query: Partial<GraphNeighborsQuery> = {},
  ): GraphEdge[] =>
    edges
      .filter((edge) => {
        const endpoint = direction === 'out' ? edge.source : edge.target;
        return endpoint.kind === kind && endpoint.id === id && queryMatches(edge, query);
      })
      .toSorted((left, right) => left.id.localeCompare(right.id));

  const otherNode = (edge: GraphEdge, direction: GraphDirection): GraphNode | undefined => {
    const endpoint = direction === 'out' ? edge.target : edge.source;
    return nodes.get(reference(endpoint.kind, endpoint.id));
  };

  return {
    node: findNode,
    neighbors(kind, id, direction, query) {
      if (query.limit < 1 || query.limit > GRAPH_MAX_NEIGHBOR_LIMIT) {
        throw new OperationalGraphQueryError('Graph neighbor limit exceeded.');
      }
      const node = findNode(kind, id);
      if (node === null) throw new Error('Graph node not found.');
      const all = matchingEdges(kind, id, direction, query);
      const selected = all.slice(0, query.limit);
      return {
        node,
        edges: selected,
        nodes: selected
          .map((edge) => otherNode(edge, direction))
          .filter((value): value is GraphNode => value !== undefined),
        truncated: all.length > selected.length,
      };
    },
    shortestPath(kind, id, query) {
      if (query.maxDepth < 1 || query.maxDepth > GRAPH_MAX_PATH_DEPTH) {
        throw new OperationalGraphQueryError('Graph path depth exceeded.');
      }
      const start = findNode(kind, id);
      if (start === null) throw new Error('Graph node not found.');
      const targetReference = reference(query.toKind, query.toId);
      if (reference(start.kind, start.entityId) === targetReference) {
        return { found: true, nodes: [start], edges: [] };
      }

      type QueueItem = { node: GraphNode; pathNodes: GraphNode[]; pathEdges: GraphEdge[] };
      const queue: QueueItem[] = [{ node: start, pathNodes: [start], pathEdges: [] }];
      const visited = new Set([reference(start.kind, start.entityId)]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.pathEdges.length >= query.maxDepth) continue;
        for (const edge of matchingEdges(current.node.kind, current.node.entityId, 'out', query)) {
          const next = otherNode(edge, 'out');
          if (next === undefined) continue;
          const key = reference(next.kind, next.entityId);
          if (visited.has(key)) continue;
          const pathNodes = [...current.pathNodes, next];
          const pathEdges = [...current.pathEdges, edge];
          if (key === targetReference) return { found: true, nodes: pathNodes, edges: pathEdges };
          visited.add(key);
          queue.push({ node: next, pathNodes, pathEdges });
        }
      }
      return { found: false, nodes: [], edges: [] };
    },
    subgraph(query) {
      if (query.maxDepth < 1 || query.maxDepth > GRAPH_MAX_PATH_DEPTH) {
        throw new OperationalGraphQueryError('Graph subgraph depth exceeded.');
      }
      if (query.nodeLimit < 1 || query.nodeLimit > GRAPH_MAX_SUBGRAPH_NODE_LIMIT) {
        throw new OperationalGraphQueryError('Graph subgraph node limit exceeded.');
      }
      const start = findNode(query.nodeKind, query.nodeId);
      if (start === null) throw new Error('Graph node not found.');
      const selectedNodes: GraphNode[] = [start];
      const selectedEdges: GraphEdge[] = [];
      const visited = new Set([reference(start.kind, start.entityId)]);
      let frontier = [start];
      let truncated = false;
      for (let depth = 0; depth < query.maxDepth && frontier.length > 0; depth += 1) {
        const nextFrontier: GraphNode[] = [];
        for (const current of frontier) {
          for (const edge of matchingEdges(current.kind, current.entityId, 'out', query)) {
            const next = otherNode(edge, 'out');
            if (next === undefined) continue;
            const key = reference(next.kind, next.entityId);
            if (visited.has(key)) continue;
            if (selectedNodes.length >= query.nodeLimit) {
              truncated = true;
              continue;
            }
            visited.add(key);
            selectedNodes.push(next);
            selectedEdges.push(edge);
            nextFrontier.push(next);
          }
        }
        frontier = nextFrontier;
      }
      return { nodes: selectedNodes, edges: selectedEdges, truncated };
    },
  };
}

export function graphEdgeKinds(edges: readonly GraphEdge[]): GraphEdgeKind[] {
  return [...new Set(edges.map(({ kind }) => kind))].toSorted();
}
