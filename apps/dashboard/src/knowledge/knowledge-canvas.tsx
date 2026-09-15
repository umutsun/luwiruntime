import type { LaidEdge, LaidNode } from './model.js';

/**
 * The graph canvas: an SVG rendered once from `layoutKnowledge`'s positions.
 *
 * Deliberately static — no `requestAnimationFrame`, no force simulation. The
 * comp animates a live layout; this reads a projection that graphify already
 * computed, so redrawing it every frame would animate nothing but jitter.
 *
 * A click on a node selects it (or clears the selection if it was already
 * selected); a click on the background clears it. The background handler
 * lives on the `<svg>` itself, and each node stops propagation so its own
 * click never also reaches the background.
 */
export function KnowledgeCanvas({
  nodes,
  edges,
  communityLabels,
  onSelectNode,
  onClearSelection,
}: {
  nodes: readonly LaidNode[];
  edges: readonly LaidEdge[];
  communityLabels: readonly { x: number; y: number; label: string }[];
  onSelectNode: (id: string) => void;
  onClearSelection: () => void;
}) {
  return (
    <svg
      className="knowledge__svg"
      viewBox="0 0 1000 680"
      preserveAspectRatio="xMidYMid meet"
      aria-label="Project knowledge graph"
      onClick={onClearSelection}
    >
      <g>
        {edges.map((edge, index) => (
          <line
            key={`${edge.source}->${edge.target}:${String(index)}`}
            className={`knowledge__edge knowledge__edge--${edge.kind}${edge.active ? ' knowledge__edge--active' : ''}`}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
          />
        ))}
      </g>
      {communityLabels.map((label) => (
        <text
          key={label.label}
          className="knowledge__community-mark"
          x={label.x}
          y={label.y}
          textAnchor="middle"
        >
          {label.label}
        </text>
      ))}
      {nodes.map((node) => (
        <g
          key={node.id}
          className={`knowledge__node knowledge__node--${node.kind}${node.selected ? ' knowledge__node--selected' : ''}${node.dim ? ' knowledge__node--dim' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onSelectNode(node.id);
          }}
        >
          <circle className="knowledge__node-hit" cx={node.x} cy={node.y} r={node.r + 9} />
          <circle className="knowledge__node-dot" cx={node.x} cy={node.y} r={node.r} />
          {node.kind !== 'symbol' || node.selected || node.neighbor ? (
            <text
              className="knowledge__node-label"
              x={node.x}
              y={node.y - node.r - 6}
              textAnchor="middle"
            >
              {node.label}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
