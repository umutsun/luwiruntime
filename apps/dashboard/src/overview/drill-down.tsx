import { abbreviateId, formatRelativeTime } from '../components/format.js';
import { CopyIdButton } from '../components/id-badge.js';
import { StatusChip } from '../components/status-chip.js';
import { FlowPanelView } from './flow-panel-view.js';
import type { InspectorSelection } from '../inspectors/inspector-panel.js';
import type { Focus, OverviewSession, PanelLink, PanelModel } from './model.js';

/**
 * Role facts show their value as chips, not bold text. The session's "Flow role"
 * is one agent's roles joined by " + "; the project's "Flow roles" is one clause
 * per agent joined by " · " ("agent-a: implementer · agent-b: verifier").
 */
function roleChips(key: string, value: string): string[] | undefined {
  if ((key !== 'Flow role' && key !== 'Flow roles') || value === 'none') return undefined;
  return value.includes(' · ') ? value.split(' · ') : value.split(' + ');
}

/** Long facts (a coordinator name, the per-agent flow roles) get the full width. */
function isWideFact(key: string): boolean {
  return (
    key === 'Coordinator' || key === 'Autopilot' || key === 'Flow role' || key === 'Flow roles'
  );
}

export type CoordinatorLink = Extract<PanelLink, { kind: 'coordinator' }>;
export type AutopilotLink = Extract<PanelLink, { kind: 'autopilot' }>;

/**
 * The docked drill-down: one panel shape, four subjects.
 *
 * It is not a dialog. The comps dock it as the third of the layout's three
 * regions, it is always present, and nothing in it traps focus — the modal,
 * evidence-grade view is still the inspector drawer, opened from the links at
 * the bottom.
 */
export function SessionRow({
  session,
  nowMs,
  selected,
  onFocus,
  delay,
}: {
  session: OverviewSession;
  nowMs: number;
  selected: boolean;
  onFocus: (focus: Focus) => void;
  delay: number;
}) {
  const branch = session.branch === undefined ? '' : ` · ${session.branch}`;
  return (
    <button
      type="button"
      className={`drill__row${selected ? ' drill__row--selected' : ''}`}
      aria-pressed={selected}
      aria-label={`Focus session ${session.id}`}
      style={{ animationDelay: `${String(delay)}s` }}
      onClick={() => onFocus({ kind: 'session', id: session.id })}
    >
      <span className="drill__glyph" aria-hidden="true">
        {session.initials}
      </span>
      <span className="drill__row-text">
        <span className="drill__row-title">
          {session.title ?? session.taskSummary ?? `Session ${abbreviateId(session.id)}`}
        </span>
        <span className="drill__row-sub">
          {session.agentName}
          {branch} · started {formatRelativeTime(session.startedAt, nowMs)}
        </span>
      </span>
      <span className={`drill__status tone--${session.tone}`}>
        <span className="drill__status-dot" aria-hidden="true" />
        {session.statusLabel}
      </span>
    </button>
  );
}

export function DrillDown({
  panel,
  nowMs,
  onFocus,
  onInspect,
  onCoordinator,
  coordinatorNote,
  onAutopilot,
  autopilotNote,
}: {
  panel: PanelModel;
  nowMs: number;
  onFocus: (focus: Focus) => void;
  onInspect: (selection: InspectorSelection) => void;
  /** Absent hides the coordinator switch (ADR 0035): a shell without the mutation shows no control. */
  onCoordinator?: (link: CoordinatorLink) => void;
  /** The outcome of the last claim or release, shown until the focus moves. */
  coordinatorNote?: string;
  /** Absent hides the autopilot switch (ADR 0035): a shell without the mutation shows no control. */
  onAutopilot?: (link: AutopilotLink) => void;
  /** The outcome of the last mode change, shown until the focus moves. */
  autopilotNote?: string;
}) {
  const max = panel.trend.buckets.reduce((high, value) => Math.max(high, value), 0);
  return (
    <aside className="drill" aria-label="Drill-down">
      <div className="drill__head">
        <p className="drill__eyebrow">{panel.eyebrow}</p>
        <div className="drill__title-row">
          <h2 className="drill__title">{panel.title}</h2>
          <span className={`drill__badge drill__badge--${panel.badge.tone}`}>
            {panel.badge.label}
          </span>
          {panel.copyId === undefined ? null : (
            <CopyIdButton className="drill__copy" id={panel.copyId.id} label={panel.copyId.label} />
          )}
        </div>
        <p className="drill__sub">{panel.sub}</p>
      </div>

      {panel.block === undefined ? null : (
        <div className="drill__block">
          <p className="drill__block-eyebrow">WHY BLOCKED</p>
          <p className="drill__block-title">{panel.block.title}</p>
          <dl className="drill__block-rows">
            {panel.block.rows.map(([key, value]) => (
              <div key={key} className="drill__block-row">
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="drill__facts">
        {panel.facts.map((fact, index) => (
          <div
            key={fact.k}
            className={`drill__fact${isWideFact(fact.k) ? ' drill__fact--wide' : ''}`}
            style={{ animationDelay: `${String(0.05 + index * 0.05)}s` }}
          >
            <span className="drill__fact-k">{fact.k}</span>
            {(() => {
              const chips = roleChips(fact.k, fact.v);
              return chips === undefined ? (
                <span className="drill__fact-v" title={fact.detail ?? fact.v}>
                  {fact.v}
                </span>
              ) : (
                <span className="drill__fact-roles">
                  {chips.map((role) => (
                    <StatusChip key={role} tone="info">
                      {role}
                    </StatusChip>
                  ))}
                </span>
              );
            })()}
          </div>
        ))}
      </div>

      <div className="drill__trend">
        <p className="drill__section-label">{panel.trend.label}</p>
        {panel.trend.buckets.length === 0 ? (
          <p className="drill__empty">No retained events</p>
        ) : (
          <div
            className="drill__trend-bars"
            role="img"
            aria-label={`${panel.trend.label}: ${panel.trend.buckets.join(', ')}`}
          >
            {panel.trend.buckets.map((value, index) => (
              <span
                key={index}
                className="drill__trend-bar"
                style={{
                  height: `${String(max === 0 || value === 0 ? 0 : Math.max(3, Math.round((value / max) * 56)))}px`,
                  opacity: index === panel.trend.buckets.length - 1 ? 1 : 0.3 + index * 0.08,
                  animationDelay: `${String(0.1 + index * 0.05)}s`,
                }}
              />
            ))}
          </div>
        )}
        <div className="drill__trend-axis">
          <span>{panel.trend.from}</span>
          <span>{panel.trend.to}</span>
        </div>
      </div>

      <div className="drill__list">
        <p className="drill__section-label">{panel.list.label}</p>
        {panel.list.rows.length === 0 ? (
          <p className="drill__empty">{panel.list.empty}</p>
        ) : (
          panel.list.rows.map((session, index) => (
            <SessionRow
              key={session.id}
              session={session}
              nowMs={nowMs}
              selected={panel.list.selectedId === session.id}
              onFocus={onFocus}
              delay={0.08 + index * 0.06}
            />
          ))
        )}
      </div>

      {panel.flow === undefined ? null : <FlowPanelView panel={panel.flow} />}

      {coordinatorNote === undefined ? null : (
        <p className="drill__empty" role="status">
          {coordinatorNote}
        </p>
      )}
      {autopilotNote === undefined ? null : (
        <p className="drill__empty" role="status">
          {autopilotNote}
        </p>
      )}

      <div className="drill__links">
        {panel.links.map((link) =>
          link.kind === 'route' ? (
            <a key={link.label} className="drill__link" href={link.href}>
              {link.label} ›
            </a>
          ) : link.kind === 'coordinator' ? (
            onCoordinator === undefined ? null : (
              <button
                key={link.label}
                type="button"
                className="drill__link"
                aria-label={`${link.label} for session ${link.sessionId}`}
                onClick={() => onCoordinator(link)}
              >
                {link.label} ›
              </button>
            )
          ) : link.kind === 'autopilot' ? (
            onAutopilot === undefined ? null : (
              <button
                key={link.label}
                type="button"
                className="drill__link"
                aria-label={`${link.label} for project ${link.projectId}`}
                onClick={() => onAutopilot(link)}
              >
                {link.label} ›
              </button>
            )
          ) : link.kind === 'inspect-project' ? (
            <button
              key={link.label}
              type="button"
              className="drill__link"
              aria-label={`Inspect project ${link.name}`}
              onClick={() => onInspect({ kind: 'project', projectId: link.id })}
            >
              {link.label} ›
            </button>
          ) : (
            <button
              key={link.label}
              type="button"
              className="drill__link"
              aria-label={`Inspect session ${link.id}`}
              onClick={() => onInspect({ kind: 'session', sessionId: link.id })}
            >
              {link.label} ›
            </button>
          ),
        )}
      </div>
    </aside>
  );
}
