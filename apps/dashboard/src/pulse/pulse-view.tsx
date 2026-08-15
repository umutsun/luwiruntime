import type { ReactNode } from 'react';

import type { PulseSnapshot, SessionContextEvidence } from './model.js';
import {
  bucketRetainedWindow,
  type RetainedBounds,
  type RetainedWindow,
} from './retained-window.js';
import {
  abbreviatePath,
  abbreviateSha,
  formatRelativeTime,
  monogramInitials,
  paletteIndex,
} from '../components/format.js';
import { Count, Unavailable } from '../components/panel.js';
import { StatusChip, type StatusTone } from '../components/status-chip.js';
import type { WebSocketState } from '../app.js';
import type { DashboardEvent } from '../realtime/schema.js';
import { routeHref } from '../routing.js';

/**
 * Colour family for an event type, by its first segment.
 *
 * The type text itself is the identity; the tint only groups related rows so a
 * scan of the stream can see clusters. The five families are the graph-family
 * tokens, already OKLCH-checked in both themes — no new colour is introduced
 * and no meaning rides on colour alone.
 */
function eventFamilyClass(eventType: string): string {
  const prefix = eventType.split('.', 1)[0] ?? '';
  const family: Record<string, string> = {
    project: 'scope',
    session: 'actor',
    agent: 'actor',
    message: 'history',
    lease: 'history',
    context: 'structure',
    usage: 'structure',
    package: 'structure',
    config: 'structure',
    graph: 'operational',
    runtime: 'other',
    optimization: 'other',
  };
  const name = family[prefix];
  return name === undefined ? 'evt--plain' : `evt--${name}`;
}

function toneForStatus(status: string): StatusTone {
  if (status === 'thinking' || status === 'tool_running') return 'success';
  if (status.startsWith('waiting')) return 'warning';
  if (status === 'blocked') return 'danger';
  return 'unknown';
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${minutes.toString().padStart(2, '0')}m`;
}

/** Buckets in the strip's whole-runtime trace, and in each project's row. */
const STRIP_BUCKETS = 24;
const PROJECT_BUCKETS = 7;
/** Five families, matching the graph palette that is already OKLCH-checked. */
const MONOGRAM_TONES = 5;

/**
 * The distribution of retained events, drawn as marks with gaps.
 *
 * A bucket that observed nothing draws nothing. It is not a zero-height bar and
 * there is no baseline behind it, because a mark on the axis would read as a
 * measured zero — and the honest claim here is weaker than that: the runtime
 * exposes no event-rate read, so this is only the shape of the events the
 * dashboard is currently holding.
 */
function RetainedTrace({ window, label }: { window: RetainedWindow; label: string }) {
  const width = 96;
  const height = 24;
  const gap = 1.5;
  if (window.buckets.length === 0) return null;
  const slot = width / window.buckets.length;
  const peak = Math.max(...window.buckets, 1);

  return (
    <svg
      className="retained-trace"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      {window.buckets.map((count, index) => {
        if (count === 0) return null;
        // A floor of 3px, so one observation is visible rather than a hairline
        // that reads as an empty bucket.
        const barHeight = Math.max(3, (count / peak) * height);
        return (
          <rect
            className="retained-trace__bar"
            key={index}
            x={index * slot}
            y={height - barHeight}
            width={Math.max(1, slot - gap)}
            height={barHeight}
            rx="1"
          />
        );
      })}
    </svg>
  );
}

/**
 * The noun that goes with a count.
 *
 * An unavailable count takes the plural, because the sentence is about the
 * resource and not about a quantity nobody measured.
 */
function countNoun(value: PulseSnapshot['projectCount'], singular: string, plural: string): string {
  return value.state !== 'unavailable' && value.value === 1 ? singular : plural;
}

function Stat({
  value,
  label,
  href,
  tone,
}: {
  value: ReactNode;
  label: string;
  href?: string;
  tone?: 'warning' | 'danger';
}) {
  const className = `stat${tone === undefined ? '' : ` stat--${tone}`}`;
  const body = (
    <>
      <span className="stat__value">{value}</span> <span className="stat__label">{label}</span>
    </>
  );
  return href === undefined ? (
    <span className={className}>{body}</span>
  ) : (
    <a className={className} href={href}>
      {body}
    </a>
  );
}

function SessionContext({ context }: { context: SessionContextEvidence }) {
  if (context.state === 'unavailable') return <Unavailable />;
  /*
   * Not the same statement as `0 loaded`. The contributions read succeeded and
   * no contribution named this session — which is what the runtime observed,
   * and is also what a bounded read that never reached this session looks like.
   */
  if (context.state === 'not-observed') return <span className="work-dim">Not observed</span>;
  return (
    <>
      <span className="work-context">{`${String(context.loaded)} loaded · ${String(context.invoked)} invoked`}</span>
      <span className="work-dim">{`${String(context.assigned)} assigned`}</span>
    </>
  );
}

export function PulseView({
  snapshot,
  websocketState,
  selectedSessionId,
  selectedProjectId,
  onOpenProject,
  onOpenSession,
  onOpenEvent,
}: {
  snapshot: PulseSnapshot;
  websocketState: WebSocketState;
  /** What the docked inspector is showing, so the row it came from is marked. */
  selectedSessionId?: string;
  selectedProjectId?: string;
  onOpenProject: (project: PulseSnapshot['projects'][number], opener: HTMLElement) => void;
  onOpenSession: (session: PulseSnapshot['activeSessions'][number], opener: HTMLElement) => void;
  onOpenEvent: (event: DashboardEvent, opener: HTMLElement) => void;
}) {
  const health = snapshot.health.state === 'ready' ? snapshot.health.data : undefined;
  /*
   * Ages and durations are stated against the snapshot they were read with,
   * not against the wall clock. A row that ticks between refreshes would be
   * claiming an observation it did not make, and a clock here would put the
   * whole panel a minute ahead of the evidence beside it.
   */
  const snapshotMs = Date.parse(snapshot.snapshotAt);
  const retained = snapshot.activityState === 'ready' ? snapshot.activity : [];
  const stripWindow = bucketRetainedWindow(retained, STRIP_BUCKETS);
  const stripBounds: RetainedBounds | undefined =
    stripWindow.firstAt === undefined || stripWindow.lastAt === undefined
      ? undefined
      : { firstMs: Date.parse(stripWindow.firstAt), lastMs: Date.parse(stripWindow.lastAt) };

  return (
    <div className="pulse-stack">
      {snapshot.health.state === 'unavailable' ? (
        <section className="state-banner state-banner--danger" role="status">
          <strong>Daemon unavailable</strong>
          <span>The last request did not reach the local LUWI daemon.</span>
        </section>
      ) : health?.redis.connected === false ? (
        <section className="state-banner state-banner--danger" role="status">
          <strong>Redis unavailable</strong>
          <span>Runtime projections cannot be refreshed. Redis is shown only as Local Redis.</span>
        </section>
      ) : null}

      {/*
       * One line of counters, each a link into the route that holds the
       * authoritative list. Latency, runtime state and Redis carry no link:
       * there is no Runtime route yet, and a link to a destination that does
       * not exist is worse than no link at all.
       */}
      <section className="stat-strip" aria-label="Current runtime snapshot">
        <Stat
          value={<Count value={snapshot.projectCount} />}
          label={countNoun(snapshot.projectCount, 'project', 'projects')}
          href={routeHref({ name: 'projects' })}
        />
        <Stat
          value={<Count value={snapshot.agentCount} />}
          label={countNoun(snapshot.agentCount, 'agent', 'agents')}
          href={routeHref({ name: 'agents' })}
        />
        <Stat
          value={<Count value={snapshot.activeSessionCount} />}
          label={countNoun(snapshot.activeSessionCount, 'active session', 'active sessions')}
          href={routeHref({ name: 'sessions' })}
        />
        {/*
         * Derived from the real status values. There is deliberately no
         * "running" counter beside these: it is not one of the nine observed
         * statuses, and merging thinking with tool_running would invent it.
         */}
        <Stat
          value={<Count value={snapshot.waitingCount} />}
          label="waiting"
          href={routeHref({ name: 'sessions' })}
          {...(snapshot.waitingCount.state === 'ready' ? { tone: 'warning' as const } : {})}
        />
        <Stat
          value={<Count value={snapshot.blockedCount} />}
          label="blocked"
          href={routeHref({ name: 'sessions' })}
          {...(snapshot.blockedCount.state === 'ready' ? { tone: 'danger' as const } : {})}
        />
        <Stat
          value={health?.runtimeState ?? <Unavailable />}
          label="runtime"
          href={routeHref({ name: 'runtime' })}
        />
        <Stat
          value={`${String(snapshot.measuredLatencyMs)} ms`}
          label="daemon latency"
          href={routeHref({ name: 'runtime' })}
        />
        <Stat
          value="Redis"
          label={
            health === undefined
              ? 'unavailable'
              : health.redis.connected
                ? 'connected'
                : 'disconnected'
          }
          href={routeHref({ name: 'runtime' })}
          {...(health?.redis.connected === false ? { tone: 'danger' as const } : {})}
        />
        <div className="stat-strip__window">
          {snapshot.activityState === 'unavailable' ? (
            <Unavailable />
          ) : stripWindow.total === 0 ? (
            <span className="stat__label">no retained activity</span>
          ) : (
            <>
              <span className="stat__label">
                {`retained window · ${stripWindow.spanLabel ?? 'a moment'}`}
              </span>
              <RetainedTrace
                window={stripWindow}
                label={`${String(stripWindow.total)} retained events distributed over ${stripWindow.spanLabel ?? 'a moment'}. This is not a rate: the runtime exposes no event-rate read.`}
              />
              <span className="stat__value">{stripWindow.total}</span>
            </>
          )}
        </div>
      </section>

      <div className="pulse-grid">
        <section className="panel panel--work" aria-labelledby="active-work-title">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Execution plane</p>
              <h2 id="active-work-title">Active Work</h2>
            </div>
            <span className="panel__meta">
              {snapshot.statusBreakdown.length === 0 ? (
                <Count value={snapshot.activeSessionCount} />
              ) : (
                snapshot.statusBreakdown
                  .map((entry) => `${String(entry.count)} ${entry.label}`)
                  .join(' · ')
              )}
            </span>
          </header>
          {snapshot.activeSessionCount.state === 'unavailable' ? (
            <p className="empty-state">Session data unavailable</p>
          ) : snapshot.activeSessions.length === 0 ? (
            <p className="empty-state">No active sessions</p>
          ) : (
            <>
              {/*
               * Presentational: the row buttons carry their own description, so
               * a duplicate column legend in the accessibility tree would be
               * read twice for every row.
               */}
              <div className="work-columns" data-testid="work-columns" aria-hidden="true">
                <span>Agent · Project</span>
                <span>Task · Scope</span>
                <span>Context</span>
                <span>Status · Age</span>
              </div>
              <ul className="work-list">
                {snapshot.activeSessions.map((session) => {
                  const selected = session.id === selectedSessionId;
                  const startedMs = Date.parse(session.startedAt);
                  const duration =
                    Number.isFinite(startedMs) &&
                    Number.isFinite(snapshotMs) &&
                    snapshotMs >= startedMs
                      ? formatDuration(snapshotMs - startedMs)
                      : 'unavailable';
                  const rowClass = [
                    'work-row',
                    session.status === 'blocked' ? 'work-row--blocked' : '',
                    selected ? 'work-row--selected' : '',
                  ]
                    .filter((entry) => entry !== '')
                    .join(' ');
                  return (
                    <li className={rowClass} key={session.id}>
                      {/*
                       * The whole row is the control, and its name states the
                       * action. The row content is attached as the description
                       * rather than left as the name, so the evidence is still
                       * announced instead of being replaced by the label.
                       */}
                      <button
                        className="work-row__button"
                        type="button"
                        aria-label={`Inspect session ${session.id}`}
                        aria-describedby={`work-row-${session.id}`}
                        {...(selected ? { 'aria-current': true as const } : {})}
                        onClick={(event) => onOpenSession(session, event.currentTarget)}
                      >
                        <span className="work-row__cells" id={`work-row-${session.id}`}>
                          <span className="work-cell">
                            {session.agentKnown ? (
                              <span className="work-agent">{session.agentName}</span>
                            ) : (
                              <span
                                className="work-agent work-agent--id"
                                title="Agent identifier; no agent definition was read for it"
                              >
                                {session.agentName}
                              </span>
                            )}
                            <span className="work-dim">{session.projectName}</span>
                          </span>
                          <span className="work-cell">
                            {/*
                             * Reported by the session, not assigned by LUWI —
                             * there is no task domain here and section 21 keeps
                             * it that way. When the session reported none, the
                             * row says so rather than naming one for it.
                             */}
                            {session.taskSummary === undefined ? (
                              <span className="work-dim">No task reported</span>
                            ) : (
                              <span className="work-task" title={session.taskSummary}>
                                {session.taskSummary}
                              </span>
                            )}
                            {/*
                             * The comp's "3 files" has no observer behind it.
                             * The branch does, and it is the whole of the scope
                             * this read can state.
                             */}
                            {session.branch === undefined ? (
                              <span className="work-dim">No branch observed</span>
                            ) : (
                              <span className="work-dim">
                                branch <span className="work-branch">{session.branch}</span>
                              </span>
                            )}
                          </span>
                          <span className="work-cell">
                            <SessionContext context={session.context} />
                          </span>
                          <span className="work-cell work-cell--end">
                            <StatusChip tone={toneForStatus(session.status)}>
                              {session.statusLabel}
                            </StatusChip>
                            {/*
                             * A blocked row is railed, and that is all. Session
                             * status carries no reason, so naming a cause here
                             * would be an inference presented as evidence.
                             */}
                            <span className="work-dim">
                              {`${duration} · ${formatRelativeTime(session.lastHeartbeatAt, snapshotMs)}`}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section className="panel panel--projects" aria-labelledby="project-pulse-title">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Control plane</p>
              <h2 id="project-pulse-title">Project Pulse</h2>
            </div>
            <span className="panel__meta">
              <Count value={snapshot.projectCount} />
            </span>
          </header>
          {snapshot.projectCount.state === 'unavailable' ? (
            <p className="empty-state">Project data unavailable</p>
          ) : snapshot.projects.length === 0 ? (
            <p className="empty-state">No registered projects</p>
          ) : (
            <ul className="project-list">
              {snapshot.projects.map((project) => {
                const tone = paletteIndex(project.id, MONOGRAM_TONES);
                const projectWindow = bucketRetainedWindow(
                  retained.filter((event) => event.projectId === project.id),
                  PROJECT_BUCKETS,
                  stripBounds,
                );
                const agents = project.activeAgents;
                /*
                 * Sessions and the distinct agents holding them — not the
                 * project's agent bindings, which are a scoped read this batch
                 * does not make. An unavailable read says so; it is never a 0.
                 */
                const counts =
                  project.activeSessions.state === 'unavailable' || agents.state === 'unavailable'
                    ? 'Active sessions unavailable'
                    : `${String(project.activeSessions.value)} active · ${String(agents.value)} ${
                        agents.value === 1 ? 'agent' : 'agents'
                      }`;
                return (
                  <li
                    className={`project-row${project.id === selectedProjectId ? ' project-row--selected' : ''}`}
                    key={project.id}
                  >
                    <button
                      className="project-row__button"
                      type="button"
                      aria-label={`Inspect project ${project.name}`}
                      aria-describedby={`project-row-${project.id}`}
                      {...(project.id === selectedProjectId
                        ? { 'aria-current': true as const }
                        : {})}
                      onClick={(event) => onOpenProject(project, event.currentTarget)}
                    >
                      {/*
                       * A label, not a claim. The initials come from the name
                       * the runtime already holds and the tone from a hash of
                       * the id — there is no product palette behind it.
                       */}
                      <span className={`project-monogram project-monogram--${String(tone)}`}>
                        {monogramInitials(project.name)}
                      </span>
                      {/*
                       * Two lines, and the trace sits on the second one rather
                       * than beside both. As a third flex column it took 96 px
                       * out of every line, which left the local path four
                       * pixels wide against a 251 px string.
                       */}
                      <span className="project-row__body" id={`project-row-${project.id}`}>
                        <span className="project-row__head">
                          <span className="project-row__name">{project.name}</span>
                          <span className="project-row__counts">{counts}</span>
                        </span>
                        <span className="project-row__meta">
                          <span className="project-row__path" title={project.localPath}>
                            {abbreviatePath(project.localPath)}
                          </span>
                          {projectWindow.total === 0 ? null : (
                            <RetainedTrace
                              window={projectWindow}
                              label={`${String(projectWindow.total)} retained events name this project, over the same window as the runtime trace.`}
                            />
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="pulse-grid pulse-grid--tertiary">
        <section className="panel panel--stream" aria-labelledby="realtime-stream-title">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Normalized events</p>
              <h2 id="realtime-stream-title">Realtime Stream</h2>
            </div>
            <span className="panel__meta">
              {snapshot.activityState === 'ready'
                ? `${String(snapshot.activity.length)} retained · realtime ${websocketState}`
                : `realtime ${websocketState}`}
            </span>
          </header>
          {snapshot.activityState === 'unavailable' ? (
            <p className="empty-state">Activity snapshot unavailable</p>
          ) : snapshot.activity.length === 0 ? (
            <p className="empty-state">No retained activity</p>
          ) : (
            <ol className="stream-list">
              {snapshot.activity.map((event) => (
                <li key={event.streamId} className="stream-row">
                  {/*
                   * The whole row is the control, like Active Work. The comp
                   * also drew an evidence-grade column here; the envelope
                   * carries no confidence field, so that column stays dropped
                   * and its width goes to the object column.
                   */}
                  <button
                    type="button"
                    className="stream-row__button"
                    aria-label={`Inspect ${event.type} event`}
                    onClick={(click) => onOpenEvent(event, click.currentTarget)}
                  >
                    <time className="stream-row__time" dateTime={event.occurredAt}>
                      {new Date(event.occurredAt).toLocaleTimeString()}
                    </time>
                    <span className="stream-row__source">
                      {event.agentId ?? event.sessionId ?? 'Runtime'}
                    </span>
                    <span className={`stream-row__type ${eventFamilyClass(event.type)}`}>
                      {event.type}
                    </span>
                    <span className="stream-row__object">
                      {event.projectId ?? event.sessionId ?? event.id}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="panel" aria-labelledby="context-efficiency-title">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Context path</p>
              <h2 id="context-efficiency-title">Context Efficiency</h2>
            </div>
            <a className="panel__meta panel__meta--link" href="#/context">
              source →
            </a>
          </header>
          {snapshot.contextState === 'unavailable' ? (
            <p className="empty-state">Context observations unavailable</p>
          ) : (
            <div className="context-stages">
              {(
                [
                  ['Assigned', snapshot.context.assigned],
                  ['Effective', snapshot.context.effective],
                  ['Loaded', snapshot.context.loaded],
                  ['Invoked', snapshot.context.invoked],
                  ['Unknown', snapshot.context.unknown],
                ] as const
              ).map(([label, value]) => {
                const peak = Math.max(
                  snapshot.context.assigned,
                  snapshot.context.effective,
                  snapshot.context.loaded,
                  snapshot.context.invoked,
                  snapshot.context.unknown,
                  1,
                );
                return (
                  <div className="context-stage" key={label}>
                    <span className="context-stage__label">{label}</span>
                    {/* Five independent counts — deliberately not a funnel:
                        Assigned and Effective are equal at every writer site
                        today, and equal bars are the normal case. */}
                    <span className="context-stage__track" aria-hidden="true">
                      <span
                        className="context-stage__fill"
                        style={{ width: `${String((value / peak) * 100)}%` }}
                      />
                    </span>
                    <span className="context-stage__value">{value}</span>
                  </div>
                );
              })}
              <div className="context-divider" aria-hidden="true" />
              {/* Counted only over pairs where both sides are observed
                  booleans; an `unknown` is never counted as unused. */}
              <p className="context-insight">
                {`${String(snapshot.contextInsights.assignedNeverLoaded)} assigned ${
                  snapshot.contextInsights.assignedNeverLoaded === 1 ? 'source was' : 'sources were'
                } never loaded`}
              </p>
              <p className="context-insight">
                {`${String(snapshot.contextInsights.loadedNotInvoked)} loaded ${
                  snapshot.contextInsights.loadedNotInvoked === 1 ? 'source was' : 'sources were'
                } not invoked`}
              </p>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="repository-facts-title">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Stated Git facts</p>
              <h2 id="repository-facts-title">Repository facts</h2>
            </div>
            {snapshot.gitTruncated ? (
              <span className="panel__meta">first {snapshot.repositoryFacts.length} shown</span>
            ) : null}
          </header>
          {/*
           * The comp drew Release Readiness here — tests, build, secrets and a
           * verdict. No such observer exists and section 21 bans release
           * scoring, so this panel states only what the read-only Git
           * observation recorded, per project, and passes no judgement.
           */}
          {snapshot.projectCount.state === 'unavailable' || snapshot.gitState === 'unavailable' ? (
            <p className="empty-state">Unavailable</p>
          ) : snapshot.repositoryFacts.length === 0 ? (
            <p className="empty-state">No registered projects</p>
          ) : (
            <ul className="repo-list">
              {snapshot.repositoryFacts.map((row) => (
                <li className="repo-row" key={row.projectId}>
                  <span className="repo-row__name">{row.name}</span>
                  {row.git.state === 'ready' ? (
                    <span className="repo-row__facts">
                      {row.git.data.branch === undefined ? null : (
                        <span className="repo-row__branch">{row.git.data.branch}</span>
                      )}
                      {row.git.data.headSha === undefined ? null : (
                        <span className="repo-row__sha" title={row.git.data.headSha}>
                          {abbreviateSha(row.git.data.headSha)}
                        </span>
                      )}
                      <StatusChip tone={row.git.data.clean ? 'success' : 'warning'}>
                        {row.git.data.clean ? 'clean' : 'dirty'}
                      </StatusChip>
                      <span className="repo-row__counts">
                        {`${String(row.git.data.untrackedCount)} untracked · ${String(
                          row.git.data.tagCount,
                        )} tags`}
                      </span>
                      <span className="repo-row__age">
                        {formatRelativeTime(row.git.data.observedAt, snapshotMs)}
                      </span>
                    </span>
                  ) : row.git.state === 'not-observed' ? (
                    <span className="work-dim">No Git scan recorded for this project</span>
                  ) : (
                    <Unavailable />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
