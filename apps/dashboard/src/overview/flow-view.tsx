import {
  emptyProjectsLabel,
  FLOW_HEIGHT,
  FLOW_WIDTH,
  layoutFlow,
  type Focus,
  type FlowNode,
  type Overview,
} from './model.js';

/**
 * The Flow: a Sankey from agents through projects to session status.
 *
 * The comps' third column was release readiness; §21 bans it, so the column
 * is the nine-value status vocabulary — which is also what a reader wants to
 * know about the flow of work. Ribbons are drawn in SVG, nodes in HTML on top
 * so they stay real buttons with real text.
 */
const pct = (value: number, of: number): string => `${((value / of) * 100).toFixed(3)}%`;

function nodeStyle(node: FlowNode) {
  return {
    left: pct(node.x, FLOW_WIDTH),
    top: pct(node.y, FLOW_HEIGHT),
    width: pct(node.w, FLOW_WIDTH),
    height: pct(node.h, FLOW_HEIGHT),
  };
}

function nodeClass(node: FlowNode, extra: string): string {
  return `flow-node ${extra}${node.selected ? ' flow-node--on' : ''}${node.dim ? ' flow-node--dim' : ''}${node.quiet ? ' flow-node--quiet' : ''}`;
}

export function FlowView({
  overview,
  focus,
  onFocus,
}: {
  overview: Overview;
  focus: Focus;
  onFocus: (focus: Focus) => void;
}) {
  const layout = layoutFlow(overview, focus);
  const toggle = (node: FlowNode) => onFocus(node.selected ? { kind: 'runtime' } : node.focus);
  const empty =
    overview.projectsState === 'unavailable'
      ? 'Projects unavailable'
      : overview.sessionsState === 'unavailable'
        ? 'Session data unavailable'
        : overview.projects.length === 0
          ? emptyProjectsLabel(overview)
          : undefined;

  return (
    <div className="flow">
      <div className="flow__headers" aria-hidden="true">
        <span>Agents</span>
        <span />
        <span className="flow__headers-mid">Projects</span>
        <span className="flow__headers-end">Status</span>
        <span />
      </div>
      <div className="flow__board">
        {empty === undefined ? null : <p className="flow__empty">{empty}</p>}
        <svg
          className="flow__svg"
          viewBox={`0 0 ${String(FLOW_WIDTH)} ${String(FLOW_HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {layout.ribbons.map((ribbon, index) => (
            <g
              key={ribbon.key}
              className={`flow__ribbon flow__ribbon--${ribbon.tone}${ribbon.live ? ' flow__ribbon--live' : ''}${ribbon.dim ? ' flow__ribbon--dim' : ''}`}
            >
              <path
                className="flow__ribbon-base"
                d={ribbon.d}
                strokeWidth={ribbon.width}
                pathLength={1}
                style={{ animationDelay: `${String(0.35 + index * 0.04)}s` }}
              />
              <path className="flow__ribbon-flow" d={ribbon.d} strokeWidth={ribbon.width} />
            </g>
          ))}
        </svg>
        <div className="flow__nodes">
          {layout.agents.map((node, index) => (
            <button
              key={node.key}
              type="button"
              className={nodeClass(node, 'flow-node--agent')}
              style={{ ...nodeStyle(node), animationDelay: `${String(0.15 + index * 0.08)}s` }}
              aria-pressed={node.selected}
              aria-label={`Focus agent ${node.label}`}
              onClick={() => toggle(node)}
            >
              <span className="flow-node__init">{node.initials}</span>
              <span className="flow-node__text">
                <span className="flow-node__name">{node.label}</span>
                <span className="flow-node__sub">{node.sub}</span>
              </span>
            </button>
          ))}
          {layout.projects.map((node, index) => (
            <button
              key={node.key}
              type="button"
              className={nodeClass(node, 'flow-node--project')}
              style={{ ...nodeStyle(node), animationDelay: `${String(0.3 + index * 0.07)}s` }}
              aria-pressed={node.selected}
              aria-label={`Focus project ${node.label}`}
              title={`${node.label} · ${node.sub}`}
              onClick={() => toggle(node)}
            >
              <span className="flow-node__init">{node.initials}</span>
              <span className="flow-node__name">{node.label}</span>
              {node.buckets !== undefined && node.buckets.length > 0 ? (
                <span className="flow-node__spark" aria-hidden="true">
                  {node.buckets.map((value, barIndex, all) => {
                    const max = all.reduce((high, entry) => Math.max(high, entry), 0);
                    return (
                      <span
                        key={barIndex}
                        className="flow-node__spark-bar"
                        style={{
                          height: `${String(max === 0 || value === 0 ? 0 : Math.max(2, Math.round((value / max) * 14)))}px`,
                          opacity: barIndex === all.length - 1 ? 1 : 0.4,
                        }}
                      />
                    );
                  })}
                </span>
              ) : null}
            </button>
          ))}
          {layout.statuses.map((node, index) => (
            <div
              key={node.key}
              className={`${nodeClass(node, 'flow-node--status')} tone--${node.tone ?? 'quiet'}`}
              style={{ ...nodeStyle(node), animationDelay: `${String(0.5 + index * 0.08)}s` }}
            >
              <span className="flow-node__status">{node.label}</span>
              <span className="flow-node__count">{node.count}</span>
            </div>
          ))}
        </div>
        <p className="flow__note" aria-hidden="true">
          moving ribbon = working status, or an event in the last 10 min
        </p>
      </div>
    </div>
  );
}
