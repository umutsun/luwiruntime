import { abbreviateSha, formatRelativeTime } from '../components/format.js';
import {
  emptyProjectsLabel,
  planTiles,
  subagentCount,
  type Focus,
  type Overview,
  type OverviewProject,
} from './model.js';

/**
 * The Board: a treemap of tiles sized by work, with the runtime as the first
 * 2×2. Colour never carries the state alone — a blocked tile also gets the
 * solid ink border and the halo, a quiet tile the dashed border, and every
 * session chip is written with its agent's initials and its age.
 */
function Sparkline({ buckets }: { buckets: readonly number[] }) {
  if (buckets.length === 0) return null;
  const max = buckets.reduce((high, value) => Math.max(high, value), 0);
  return (
    <span className="spark" aria-hidden="true">
      {buckets.map((value, index) => (
        <span
          key={index}
          className="spark__bar"
          style={{
            height: `${String(max === 0 || value === 0 ? 0 : Math.max(2, Math.round((value / max) * 18)))}px`,
            opacity: index === buckets.length - 1 ? 1 : 0.4,
            animationDelay: `${String(0.5 + index * 0.04)}s`,
          }}
        />
      ))}
    </span>
  );
}

function tileState(project: OverviewProject, on: boolean): string {
  if (on) return 'tile--on';
  if (project.blocked) return 'tile--blocked';
  if (project.sessions.length === 0) return 'tile--quiet';
  return 'tile--active';
}

function metaOf(project: OverviewProject): string {
  if (project.git.state !== 'ready')
    return project.git.state === 'not-observed' ? 'git not observed' : 'git unavailable';
  const sha =
    project.git.data.headSha === undefined
      ? '—'
      : abbreviateSha(project.git.data.headSha).slice(0, 7);
  return `${sha} · ${project.git.data.clean ? 'clean' : `${String(project.git.data.untrackedCount)} untracked`}`;
}

export function BoardView({
  overview,
  focus,
  realtime,
  onFocus,
}: {
  overview: Overview;
  focus: Focus;
  realtime: string;
  onFocus: (focus: Focus) => void;
}) {
  const tiles = planTiles(overview.projects);
  const focused = focus.kind === 'project' ? focus.id : undefined;
  const coreOn = focus.kind === 'runtime';
  const { health, rate } = overview;
  const ringDash = `${rate.latestShare.toFixed(3)} 1`;

  return (
    <div className="board">
      <div className="board__grid">
        <button
          type="button"
          className={`tile tile--runtime${coreOn ? ' tile--on' : ''}`}
          aria-pressed={coreOn}
          aria-label="Focus runtime"
          onClick={() => onFocus({ kind: 'runtime' })}
        >
          <div className="tile__head">
            <div className="tile__heading">
              <span className="tile__eyebrow">RUNTIME</span>
              <span className="tile__name tile__name--runtime">Daemon · Redis · Realtime</span>
            </div>
            <span className="tile__badge">{health.label}</span>
          </div>
          <div className="tile__gauge">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle className="tile__gauge-track" cx="60" cy="60" r="54" />
              <circle className="tile__gauge-orbit" cx="60" cy="60" r="54" />
              <circle
                className="tile__gauge-ring"
                cx="60"
                cy="60"
                r="46"
                pathLength={1}
                strokeDasharray={ringDash}
                transform="rotate(-90 60 60)"
              />
              <text className="tile__gauge-value" x="60" y="58" textAnchor="middle" fontSize={24}>
                {overview.activityState === 'unavailable' ? '—' : rate.label}
              </text>
              <text className="tile__gauge-label" x="60" y="74" textAnchor="middle" fontSize={7.5}>
                EVENTS / MIN
              </text>
            </svg>
          </div>
          <div className="tile__facts">
            <span className="tile__fact">
              <span className="tile__fact-k">UPTIME</span>
              {health.uptime ?? 'unavailable'}
            </span>
            <span className="tile__fact">
              <span className="tile__fact-k">REDIS</span>
              {health.latency ?? (health.redis === undefined ? 'unavailable' : 'disconnected')}
            </span>
            <span className="tile__fact">
              <span className="tile__fact-k">REALTIME</span>
              {realtime}
            </span>
          </div>
        </button>

        {overview.projectsState === 'unavailable' ? (
          <div className="tile tile--empty">Projects unavailable</div>
        ) : tiles.length === 0 ? (
          <div className="tile tile--empty">{emptyProjectsLabel(overview)}</div>
        ) : null}

        {tiles.map(({ project, span, rows }, index) => {
          const on = focused === project.id;
          const dim = focused !== undefined && !on;
          return (
            <button
              key={project.id}
              type="button"
              className={`tile ${tileState(project, on)}${dim ? ' tile--dim' : ''} tile--span-${String(span)} tile--rows-${String(rows)}`}
              aria-pressed={on}
              aria-label={`Focus project ${project.name}`}
              style={{ animationDelay: `${String(0.12 + index * 0.07)}s` }}
              onClick={() =>
                onFocus(on ? { kind: 'runtime' } : { kind: 'project', id: project.id })
              }
            >
              {project.blocked ? <span className="tile__halo" aria-hidden="true" /> : null}
              {project.working ? <span className="tile__sweep" aria-hidden="true" /> : null}
              <div className="tile__head">
                <div className="tile__heading">
                  <span className="tile__eyebrow">{project.eyebrow}</span>
                  <span className="tile__name">{project.name}</span>
                </div>
                <span
                  className={`tile__badge${project.badge.tone === 'ink' ? ' tile__badge--ink' : ''}`}
                >
                  {project.badge.label}
                </span>
              </div>
              <div className="tile__chips">
                {project.sessions.map((session) => {
                  const subagents =
                    session.subagents.length > 0
                      ? ` · ${subagentCount(session.subagents.length)}`
                      : '';
                  return (
                    <span
                      key={session.id}
                      className={`chip${session.tone === 'blocked' ? ' chip--blocked' : ''}`}
                      title={`${session.agentName} · ${session.statusLabel}${session.taskSummary === undefined ? '' : ` · ${session.taskSummary}`}${subagents}`}
                    >
                      <span className={`chip__dot tone--${session.tone}`} aria-hidden="true" />
                      <span className="chip__name">{session.agentName}</span>
                      <span className="chip__age">
                        {session.statusLabel} ·{' '}
                        {formatRelativeTime(session.startedAt, overview.nowMs)}
                        {subagents}
                      </span>
                    </span>
                  );
                })}
              </div>
              <div className="tile__foot">
                <span className="tile__meta">{metaOf(project)}</span>
                <Sparkline buckets={project.buckets} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
