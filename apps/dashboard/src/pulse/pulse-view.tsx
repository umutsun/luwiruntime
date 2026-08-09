import type { PulseSnapshot } from './model.js';
import { abbreviatePath } from '../components/format.js';
import { Count, Unavailable } from '../components/panel.js';
import { StatusChip, type StatusTone } from '../components/status-chip.js';
import type { WebSocketState } from '../app.js';
import type { DashboardEvent } from '../realtime/schema.js';

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
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

export function PulseView({
  snapshot,
  websocketState,
  onOpenProject,
  onOpenSession,
  onOpenEvent,
}: {
  snapshot: PulseSnapshot;
  websocketState: WebSocketState;
  onOpenProject: (project: PulseSnapshot['projects'][number], opener: HTMLElement) => void;
  onOpenSession: (session: PulseSnapshot['activeSessions'][number], opener: HTMLElement) => void;
  onOpenEvent: (event: DashboardEvent, opener: HTMLElement) => void;
}) {
  const health = snapshot.health.state === 'ready' ? snapshot.health.data : undefined;

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

      <section className="operational-strip" aria-label="Current runtime snapshot">
        <div>
          <span>Projects</span>
          <strong>
            <Count value={snapshot.projectCount} />
          </strong>
        </div>
        <div>
          <span>Active sessions</span>
          <strong>
            <Count value={snapshot.activeSessionCount} />
          </strong>
        </div>
        <div>
          <span>Agents</span>
          <strong>
            <Count value={snapshot.agentCount} />
          </strong>
        </div>
        <div>
          <span>Runtime</span>
          <strong>{health?.runtimeState ?? 'Unavailable'}</strong>
        </div>
        <div>
          <span>Daemon latency</span>
          <strong>{snapshot.measuredLatencyMs} ms</strong>
        </div>
        <div>
          <span>Redis</span>
          <strong>
            {health === undefined
              ? 'Unavailable'
              : health.redis.connected
                ? 'Connected'
                : 'Disconnected'}
          </strong>
        </div>
      </section>

      <div className="pulse-grid">
        <section className="panel panel--sessions">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Execution plane</p>
              <h2>Active sessions</h2>
            </div>
            <span className="panel__meta">
              <Count value={snapshot.activeSessionCount} />
            </span>
          </header>
          {snapshot.activeSessionCount.state === 'unavailable' ? (
            <p className="empty-state">Session data unavailable</p>
          ) : snapshot.activeSessions.length === 0 ? (
            <p className="empty-state">No active sessions</p>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Active LUWI agent sessions</caption>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Project</th>
                    <th>State</th>
                    <th>Started</th>
                    <th>Last heartbeat</th>
                    <th>
                      <span className="sr-only">Inspect</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.activeSessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <strong>{session.agentId}</strong>
                      </td>
                      <td>{session.projectName}</td>
                      <td>
                        <StatusChip tone={toneForStatus(session.status)}>
                          {session.statusLabel}
                        </StatusChip>
                      </td>
                      <td>
                        <time dateTime={session.startedAt}>
                          {new Date(session.startedAt).toLocaleTimeString()}
                        </time>
                      </td>
                      <td>
                        <time dateTime={session.lastHeartbeatAt}>
                          {new Date(session.lastHeartbeatAt).toLocaleTimeString()}
                        </time>
                      </td>
                      <td>
                        <button
                          className="inspect-button"
                          type="button"
                          onClick={(event) => onOpenSession(session, event.currentTarget)}
                          aria-label={`Inspect session ${session.id}`}
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel panel--projects">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Control plane</p>
              <h2>Project pulse</h2>
            </div>
          </header>
          {snapshot.projectCount.state === 'unavailable' ? (
            <p className="empty-state">Project data unavailable</p>
          ) : snapshot.projects.length === 0 ? (
            <p className="empty-state">No registered projects</p>
          ) : (
            <ul className="project-list">
              {snapshot.projects.map((project) => (
                <li key={project.id}>
                  <div>
                    <strong>{project.name}</strong>
                    <small title={project.localPath}>{abbreviatePath(project.localPath)}</small>
                  </div>
                  <span>
                    <Count value={project.activeSessions} /> active
                  </span>
                  <button
                    className="inspect-button"
                    type="button"
                    onClick={(event) => onOpenProject(project, event.currentTarget)}
                    aria-label={`Inspect project ${project.name}`}
                  >
                    Inspect
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="pulse-grid pulse-grid--secondary">
        <section className="panel">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Evidence quality</p>
              <h2>Usage summary</h2>
            </div>
          </header>
          {snapshot.usageState === 'unavailable' ? (
            <p className="empty-state">Usage telemetry unavailable</p>
          ) : snapshot.usage.length === 0 ? (
            <p className="empty-state">No usage observations</p>
          ) : (
            <ul className="evidence-list">
              {snapshot.usage.map((row) => (
                <li key={row.source} data-source={row.source}>
                  <span>{row.label}</span>
                  {/* "Not reported", matching the Usage route: a source that
                      reported no token value is not the same fact as the
                      `unavailable` source label sitting beside it, and one word
                      for both meanings made the row read as a contradiction. */}
                  <strong>
                    {row.totalTokens === undefined ? (
                      <Unavailable label="Not reported" />
                    ) : (
                      row.totalTokens.toLocaleString()
                    )}
                  </strong>
                  <small>{row.records} records</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Context path</p>
              <h2>Context summary</h2>
            </div>
          </header>
          {snapshot.contextState === 'unavailable' ? (
            <p className="empty-state">Context observations unavailable</p>
          ) : (
            <ol className="context-path">
              {Object.entries({
                Assigned: snapshot.context.assigned,
                Effective: snapshot.context.effective,
                Loaded: snapshot.context.loaded,
                Invoked: snapshot.context.invoked,
                Unknown: snapshot.context.unknown,
              }).map(([label, value]) => (
                <li key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="panel">
          <header className="panel__header">
            <div>
              <p className="eyebrow">Local boundary</p>
              <h2>Runtime health</h2>
            </div>
          </header>
          <dl className="health-list">
            <div>
              <dt>Daemon</dt>
              <dd>
                {health === undefined ? (
                  <StatusChip tone="danger">Unavailable</StatusChip>
                ) : (
                  <StatusChip tone={health.status === 'ok' ? 'success' : 'danger'}>
                    {health.status}
                  </StatusChip>
                )}
              </dd>
            </div>
            <div>
              <dt>Local Redis</dt>
              <dd>
                {health?.redis.connected ? (
                  <StatusChip tone="success">Connected</StatusChip>
                ) : (
                  <StatusChip tone="danger">Unavailable</StatusChip>
                )}
              </dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{health === undefined ? 'Unavailable' : formatDuration(health.uptimeMs)}</dd>
            </div>
            <div>
              <dt>Realtime</dt>
              <dd>{websocketState}</dd>
            </div>
          </dl>
          {/*
           * "Function library" and "Projection health" used to sit here as two
           * literal `Unavailable` rows with no props behind them. They asserted
           * a fault the runtime never reported: no daemon route exposes Redis
           * function-library state at all, and projection health is read on the
           * Graph route, where ADR 0013's 56-command cost is paid on purpose.
           * A row that can only ever say one thing is not evidence.
           */}
        </section>
      </div>

      <section className="panel">
        <header className="panel__header">
          <div>
            <p className="eyebrow">Normalized events</p>
            <h2>Recent activity</h2>
          </div>
        </header>
        {snapshot.activityState === 'unavailable' ? (
          <p className="empty-state">Activity snapshot unavailable</p>
        ) : snapshot.activity.length === 0 ? (
          <p className="empty-state">No retained activity</p>
        ) : (
          <ol className="activity-list">
            {snapshot.activity.map((event) => (
              <li key={event.streamId}>
                <strong>{event.type}</strong>
                <span>{event.agentId ?? event.sessionId ?? event.projectId ?? 'Runtime'}</span>
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleString()}
                </time>
                <button
                  className="inspect-button"
                  type="button"
                  onClick={(click) => onOpenEvent(event, click.currentTarget)}
                  aria-label={`Inspect ${event.type} event`}
                >
                  Inspect
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
