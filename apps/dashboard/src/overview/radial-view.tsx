import {
  emptyProjectsLabel,
  layoutRadial,
  RADIAL_CENTRE,
  RADIAL_NODE,
  RADIAL_ORBIT,
  RADIAL_SIZE,
  type Focus,
  type Overview,
} from './model.js';

/**
 * The Radial: the runtime at the centre, projects on an orbit.
 *
 * A node's arc is its share of the retained events against the busiest node —
 * the comps' "7-day activity" ring, replaced by the one activity measure the
 * runtime actually retains, and labelled as such in the legend. Dots are the
 * node's active sessions by tone; packets on a spoke count its working ones.
 */
const CIRCUMFERENCE = 2 * Math.PI * RADIAL_NODE;
/**
 * The core rate gauge rides a ring OUTSIDE the core disc (r 58) and its centred
 * "N EVENTS / MIN" label, so the arc never crosses the text. It sits just past the
 * dashed guide ring (r 70), which reads as its track.
 */
const CORE_GAUGE_RADIUS = 74;
const CORE_CIRCUMFERENCE = 2 * Math.PI * CORE_GAUGE_RADIUS;
const pct = (value: number): string => `${((value / RADIAL_SIZE) * 100).toFixed(2)}%`;

export function RadialView({
  overview,
  focus,
  onFocus,
}: {
  overview: Overview;
  focus: Focus;
  onFocus: (focus: Focus) => void;
}) {
  const layout = layoutRadial(overview, focus);
  const coreShare = overview.activityState === 'unavailable' ? 0 : overview.rate.latestShare;
  const empty =
    overview.projectsState === 'unavailable'
      ? 'Projects unavailable'
      : layout.nodes.length === 0
        ? focus.kind === 'runtime'
          ? emptyProjectsLabel(overview)
          : 'No active sessions in this project'
        : undefined;

  return (
    <div className="radial">
      <div className="radial__stage">
        <div className="radial__box">
          <svg
            className="radial__svg"
            viewBox={`0 0 ${String(RADIAL_SIZE)} ${String(RADIAL_SIZE)}`}
            aria-hidden="true"
          >
            <circle
              className="radial__orbit"
              cx={RADIAL_CENTRE}
              cy={RADIAL_CENTRE}
              r={RADIAL_ORBIT}
            />
            <circle className="radial__guide" cx={RADIAL_CENTRE} cy={RADIAL_CENTRE} r={150} />
            {layout.nodes.map((node, index) => (
              <g
                key={`spoke:${node.key}`}
                className="radial__spoke-group"
                transform={`translate(${String(RADIAL_CENTRE)} ${String(RADIAL_CENTRE)}) rotate(${String(node.angleDeg)})`}
                style={{ animationDelay: `${String(0.45 + index * 0.09)}s` }}
              >
                <line className="radial__spoke" x1={74} y1={0} x2={192} y2={0} />
                {Array.from({ length: node.packets }, (_, packet) => (
                  <circle
                    key={packet}
                    className="radial__packet"
                    cx={0}
                    cy={0}
                    r={2.4}
                    style={{
                      animationDuration: `${String(2.4 + (index % 3) * 0.5)}s`,
                      animationDelay: `${String(index * 0.37 + packet * 1.2)}s`,
                    }}
                  />
                ))}
              </g>
            ))}
            <g className="radial__core">
              <circle className="radial__wave" cx={RADIAL_CENTRE} cy={RADIAL_CENTRE} r={66} />
              <circle
                className="radial__wave radial__wave--late"
                cx={RADIAL_CENTRE}
                cy={RADIAL_CENTRE}
                r={66}
              />
              <circle className="radial__core-ring" cx={RADIAL_CENTRE} cy={RADIAL_CENTRE} r={70} />
              <circle
                className={`radial__core-disc${layout.centre.ink ? ' radial__core-disc--ink' : ''}`}
                cx={RADIAL_CENTRE}
                cy={RADIAL_CENTRE}
                r={58}
              />
              <circle
                className="radial__core-gauge"
                cx={RADIAL_CENTRE}
                cy={RADIAL_CENTRE}
                r={CORE_GAUGE_RADIUS}
                strokeDasharray={`${(coreShare * CORE_CIRCUMFERENCE).toFixed(1)} ${CORE_CIRCUMFERENCE.toFixed(1)}`}
                transform={`rotate(-90 ${String(RADIAL_CENTRE)} ${String(RADIAL_CENTRE)})`}
              />
            </g>
            {layout.nodes.map((node, index) => (
              <g
                key={`node:${node.key}`}
                className="radial__node"
                style={{ animationDelay: `${String(0.45 + index * 0.09)}s` }}
              >
                {node.blocked ? (
                  <circle className="radial__halo" cx={node.x} cy={node.y} r={44} />
                ) : null}
                <circle className="radial__node-base" cx={node.x} cy={node.y} r={RADIAL_NODE} />
                <circle
                  className="radial__node-arc"
                  cx={node.x}
                  cy={node.y}
                  r={RADIAL_NODE}
                  strokeDasharray={`${(node.share * CIRCUMFERENCE).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`}
                  transform={`rotate(-90 ${String(node.x)} ${String(node.y)})`}
                />
                <circle
                  className={`radial__node-disc${node.selected ? ' radial__node-disc--ink' : ''}`}
                  cx={node.x}
                  cy={node.y}
                  r={29}
                />
                {node.dots.map((dot, dotIndex) => (
                  <circle
                    key={dotIndex}
                    className={`radial__dot tone--${dot.tone}`}
                    cx={dot.x}
                    cy={dot.y}
                    r={4.5}
                  />
                ))}
              </g>
            ))}
          </svg>
          <div className="radial__labels">
            <button
              type="button"
              className={`radial__centre${layout.centre.ink ? ' radial__centre--ink' : ''}`}
              aria-label={focus.kind === 'runtime' ? 'Focus runtime' : 'Back to all projects'}
              aria-pressed={focus.kind === 'runtime'}
              onClick={() => onFocus(layout.centre.focus)}
            >
              <span className="radial__centre-big">{layout.centre.big}</span>
              <span className="radial__centre-small">{layout.centre.small}</span>
            </button>
            {layout.nodes.map((node, index) => (
              <div
                key={`label:${node.key}`}
                className="radial__node-label"
                style={{ animationDelay: `${String(0.45 + index * 0.09)}s` }}
              >
                <button
                  type="button"
                  className={`radial__initials${node.selected ? ' radial__initials--ink' : ''}`}
                  style={{ left: pct(node.x), top: pct(node.y) }}
                  aria-pressed={node.selected}
                  aria-label={`Focus ${node.kind} ${node.label}`}
                  title={node.hint}
                  onClick={() => onFocus(node.selected ? { kind: 'runtime' } : node.focus)}
                >
                  {node.initials}
                </button>
                <span
                  className="radial__label"
                  style={{ left: pct(node.x), top: pct(node.below ? node.y + 62 : node.y - 58) }}
                >
                  <span className="radial__label-head">
                    <span className="radial__label-name">{node.label}</span>
                    <span className="radial__label-sub">{node.sub}</span>
                  </span>
                  {node.name ? <span className="radial__label-title">{node.name}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="radial__title">
          <span className="radial__title-name">{layout.centre.title}</span>
          <span className="radial__hint">{empty ?? layout.centre.hint}</span>
        </div>
        <div className="radial__legend" aria-hidden="true">
          <span className="radial__legend-row">
            <span className="radial__legend-dot tone--working" />
            thinking · tool running
          </span>
          <span className="radial__legend-row">
            <span className="radial__legend-dot tone--waiting" />
            waiting · idle
          </span>
          <span className="radial__legend-row">
            <span className="radial__legend-dot tone--blocked" />
            blocked
          </span>
          <span className="radial__legend-row radial__legend-row--ring">
            <span className="radial__legend-line" />
            ring = share of retained events
          </span>
        </div>
      </div>
    </div>
  );
}
