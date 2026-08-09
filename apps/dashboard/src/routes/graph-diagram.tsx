import { useMemo } from 'react';

import type { ExplorerEdge, ExplorerNode, GraphConfidence } from '../api/graph-explorer.js';
import { layoutGraph } from './graph-layout.js';

/**
 * A bounded subgraph drawn as SVG (ADR 0016).
 *
 * Three encodings, each carrying a distinction the graph already makes: node
 * kind selects fill *and* shape so identity never depends on color alone; edge
 * confidence selects stroke style, because rendering `unknown` like `high`
 * would be the conversion section 18 forbids; and provenance separates the
 * code-structure layer from event-derived relationships, which ADR 0012
 * requires to stay distinguishable.
 *
 * The diagram is `aria-hidden`. It is a second presentation of the node and
 * edge tables rendered beside it, and a screen reader should hear the data
 * once, in a form it can navigate.
 */

const WIDTH = 900;
const HEIGHT = 520;
const NODE_RADIUS = 15;

/**
 * Above this many nodes, only the root and the selected node are labelled.
 *
 * Labelling every node is the failure this bound exists to prevent: at 61 nodes
 * the ring of labels overlapped into an unreadable band, and the labels that
 * mattered were lost among the ones that did not. Identity is not lost — every
 * node is listed by name in the table below, which is where identity belongs.
 */
const LABEL_ALL_BELOW = 26;

/**
 * Color carries the node's *family*, not its exact kind, and shape separates
 * kinds inside a family.
 *
 * Five families is not a stylistic choice. A categorical palette has to keep
 * every pair distinguishable under colour-vision deficiency, and seven hues in
 * one lightness band measurably cannot: the validated all-pairs separation
 * collapses to ΔE 3.4, well under the floor. Five clears it, and the families
 * it produces mirror a distinction the graph already draws — scope, code
 * structure, runtime actors, history — rather than an arbitrary grouping.
 *
 * An unlisted kind falls through to `other` and a circle. It is never given a
 * generated hue, which is what would quietly reintroduce the failure above.
 */
type NodeFamily = 'scope' | 'structure' | 'actor' | 'history' | 'other';
type NodeShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon';

const kindFamilies: Record<string, { family: NodeFamily; shape: NodeShape }> = {
  project: { family: 'scope', shape: 'hexagon' },
  repository: { family: 'scope', shape: 'square' },
  worktree: { family: 'scope', shape: 'diamond' },
  module: { family: 'structure', shape: 'square' },
  package: { family: 'structure', shape: 'hexagon' },
  file: { family: 'structure', shape: 'circle' },
  technology: { family: 'structure', shape: 'triangle' },
  session: { family: 'actor', shape: 'diamond' },
  agent: { family: 'actor', shape: 'triangle' },
  'agent-definition': { family: 'actor', shape: 'square' },
  developer: { family: 'actor', shape: 'hexagon' },
  message: { family: 'actor', shape: 'circle' },
  commit: { family: 'history', shape: 'diamond' },
  branch: { family: 'history', shape: 'triangle' },
};

const familyColors: Record<NodeFamily, string> = {
  scope: 'var(--graph-scope)',
  structure: 'var(--graph-structure)',
  actor: 'var(--graph-actor)',
  history: 'var(--graph-history)',
  other: 'var(--graph-other)',
};

/**
 * Node families describe what a node *is*. They deliberately avoid the phrase
 * "code structure", which the legend already uses for where an *edge* came
 * from; one phrase carrying both meanings made the legend ambiguous.
 */
const familyLabels: Record<NodeFamily, string> = {
  scope: 'Project scope',
  structure: 'Source tree',
  actor: 'Runtime actors',
  history: 'History',
  other: 'Other',
};

export function nodeFamily(kind: string): NodeFamily {
  return kindFamilies[kind]?.family ?? 'other';
}

export function familyLabel(family: NodeFamily): string {
  return familyLabels[family];
}

export function nodeShape(kind: string): NodeShape {
  return kindFamilies[kind]?.shape ?? 'circle';
}

export function nodeColor(kind: string): string {
  return familyColors[nodeFamily(kind)];
}

/**
 * Certainty is stroke style, and only stroke style; it is also always stated in
 * text in the edge table.
 *
 * Opacity used to carry it too, down to 0.45 for `unknown`. That was a
 * redundant third channel bought at the cost of contrast: measured against the
 * light surface, the amber structural hue fell to 2.34:1 at 0.75 and the
 * operational grey to 1.82:1 at 0.45, both under the 3:1 floor for a
 * non-text mark. Every edge now draws at full opacity, and the dasharray
 * carries the distinction on its own.
 */
export function edgeStroke(confidence: GraphConfidence): { dasharray: string | undefined } {
  if (confidence === 'high') return { dasharray: undefined };
  if (confidence === 'medium') return { dasharray: '6 4' };
  if (confidence === 'low') return { dasharray: '2 5' };
  return { dasharray: '1 4' };
}

function NodeMark({ kind, x, y }: { kind: string; x: number; y: number }) {
  const fill = nodeColor(kind);
  const shape = nodeShape(kind);
  const r = NODE_RADIUS;
  if (shape === 'square') {
    return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={3} fill={fill} />;
  }
  if (shape === 'diamond') {
    return (
      <path d={`M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`} fill={fill} />
    );
  }
  if (shape === 'triangle') {
    return (
      <path
        d={`M ${x} ${y - r} L ${x + r} ${y + r * 0.8} L ${x - r} ${y + r * 0.8} Z`}
        fill={fill}
      />
    );
  }
  if (shape === 'hexagon') {
    const points = Array.from({ length: 6 }, (_unused, index) => {
      const angle = (Math.PI / 3) * index - Math.PI / 2;
      return `${x + r * Math.cos(angle)},${y + r * Math.sin(angle)}`;
    }).join(' ');
    return <polygon points={points} fill={fill} />;
  }
  return <circle cx={x} cy={y} r={r} fill={fill} />;
}

export function GraphDiagram({
  nodes,
  edges,
  rootId,
  selectedId,
  onSelect,
}: {
  nodes: readonly ExplorerNode[];
  edges: readonly ExplorerEdge[];
  rootId: string;
  selectedId?: string;
  onSelect: (nodeId: string) => void;
}) {
  const layout = useMemo(
    () =>
      layoutGraph({
        nodes: nodes.map(({ id, kind }) => ({ id, kind })),
        edges: edges.map(({ id, source, target }) => ({ id, source, target })),
        width: WIDTH,
        height: HEIGHT,
        rootId,
      }),
    [nodes, edges, rootId],
  );
  const edgeById = useMemo(() => new Map(edges.map((edge) => [edge.id, edge])), [edges]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const labelAll = nodes.length < LABEL_ALL_BELOW;

  return (
    <div className="graph-canvas">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="img"
        aria-label={`Bounded subgraph: ${String(nodes.length)} nodes, ${String(edges.length)} edges.${labelAll ? '' : ' Only the root and the selected node are labelled at this size.'} The same data is listed in the tables below.`}
        preserveAspectRatio="xMidYMid meet"
      >
        <g>
          {layout.edges.map((link) => {
            const edge = edgeById.get(link.id);
            if (edge === undefined) return null;
            const stroke = edgeStroke(edge.confidence);
            return (
              <line
                key={link.id}
                x1={link.source.x}
                y1={link.source.y}
                x2={link.target.x}
                y2={link.target.y}
                stroke={edge.structural ? 'var(--graph-structural)' : 'var(--graph-operational)'}
                strokeWidth={2}
                {...(stroke.dasharray === undefined ? {} : { strokeDasharray: stroke.dasharray })}
              />
            );
          })}
        </g>
        <g>
          {layout.nodes.map((positioned) => {
            const node = nodeById.get(positioned.id);
            if (node === undefined) return null;
            const isRoot = positioned.id === rootId;
            const isSelected = positioned.id === selectedId;
            return (
              <g
                key={positioned.id}
                className="graph-node"
                data-selected={isSelected ? 'true' : undefined}
                data-root={isRoot ? 'true' : undefined}
                onClick={() => onSelect(positioned.id)}
              >
                {isRoot || isSelected ? (
                  <circle
                    cx={positioned.x}
                    cy={positioned.y}
                    r={NODE_RADIUS + 5}
                    fill="none"
                    stroke={isSelected ? 'var(--selection)' : 'var(--text-dim)'}
                    strokeWidth={2}
                  />
                ) : null}
                <NodeMark kind={node.kind} x={positioned.x} y={positioned.y} />
                {labelAll || isRoot || isSelected ? (
                  <text
                    x={positioned.x}
                    y={positioned.y + NODE_RADIUS + 14}
                    textAnchor="middle"
                    className="graph-node__label"
                  >
                    {node.label.length > 24 ? `…${node.label.slice(-23)}` : node.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
