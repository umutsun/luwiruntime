import { useEffect, useMemo, useState } from 'react';

import { ActivityView } from './activity/activity-view.js';
import type { IntelligenceResources } from './api/intelligence-scope.js';
import type { ProjectScopeResources } from './api/project-scope.js';
import type { PulseFreshness } from './api/refresh-state.js';
import { StatusChip } from './components/status-chip.js';
import { InspectorPanel, type InspectorSelection } from './inspectors/inspector-panel.js';
import { ProjectsView } from './projects/projects-view.js';
import { AgentsView } from './routes/agents-view.js';
import { ContextView } from './routes/context-view.js';
import { OptimizationView } from './routes/optimization-view.js';
import { SessionsView } from './routes/sessions-view.js';
import { UsageView } from './routes/usage-view.js';
import type { PulseSnapshot } from './pulse/model.js';
import { PulseView } from './pulse/pulse-view.js';
import {
  acceptActivityEvent,
  createActivityState,
  type ActivityState,
} from './realtime/activity-store.js';
import type { RealtimeConnectionState } from './realtime/observer.js';
import { parseRoute, routeHref, type DashboardRouteName } from './routing.js';

export type WebSocketState = RealtimeConnectionState;

/**
 * Routes with no sufficient read contract yet. `Graph` stays here because the
 * daemon exposes only rooted graph queries — `/api/v1/graph/nodes/:kind/:id`,
 * `/graph/path`, `/graph/subgraph` — and no global summary, so no honest
 * overview can be derived. See `docs/phase5-dashboard-capability-matrix.md`.
 */
const planned = ['Graph'];

/** Routes reachable from the rail, in navigation order. */
const scopeRoutes = [
  { name: 'projects', label: 'Projects' },
  { name: 'agents', label: 'Agents' },
  { name: 'sessions', label: 'Sessions' },
] as const;

const intelligenceRoutes = [
  { name: 'usage', label: 'Usage' },
  { name: 'context', label: 'Context' },
  { name: 'optimization', label: 'Optimization' },
] as const;

const routeTitles: Record<DashboardRouteName, { eyebrow: string; heading: string }> = {
  pulse: { eyebrow: 'Operational snapshot', heading: 'Pulse' },
  activity: { eyebrow: 'Event observer', heading: 'Activity' },
  projects: { eyebrow: 'Project scope', heading: 'Projects' },
  agents: { eyebrow: 'Registered definitions', heading: 'Agents' },
  sessions: { eyebrow: 'Observed sessions', heading: 'Sessions' },
  usage: { eyebrow: 'Observation sources', heading: 'Usage' },
  context: { eyebrow: 'Context evidence', heading: 'Context' },
  optimization: { eyebrow: 'Structural findings', heading: 'Optimization' },
};

function connectionLabel(state: WebSocketState): string {
  if (state === 'live') return 'Realtime live';
  if (state === 'connecting') return 'Realtime connecting';
  if (state === 'reconnecting') return 'Realtime reconnecting';
  if (state === 'unavailable') return 'Realtime unavailable';
  return 'Realtime disconnected';
}

export function DashboardApp({
  snapshot,
  websocketState,
  activityState,
  freshness = 'current',
  staleResources = [],
  invalidEventCount = 0,
  projectResources = {},
  projectScopeLoading = false,
  intelligenceResources = {},
  onRetry,
  onActivityStateChange,
}: {
  snapshot: PulseSnapshot;
  websocketState: WebSocketState;
  activityState?: ActivityState;
  freshness?: PulseFreshness;
  staleResources?: readonly string[];
  invalidEventCount?: number;
  projectResources?: Partial<ProjectScopeResources>;
  projectScopeLoading?: boolean;
  intelligenceResources?: Partial<IntelligenceResources>;
  onRetry: () => void;
  onActivityStateChange?: (state: ActivityState) => void;
}) {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [selection, setSelection] = useState<InspectorSelection>();
  const fallbackActivity = useMemo(
    () =>
      snapshot.activity.reduce(
        (state, event) => acceptActivityEvent(state, event).state,
        createActivityState(),
      ),
    [snapshot.activity],
  );
  const displayedActivity = activityState ?? fallbackActivity;

  useEffect(() => {
    const updateRoute = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);

  const titles = routeTitles[route.name];

  const openInspector = (next: InspectorSelection, opener: HTMLElement) => {
    opener.focus();
    setSelection(next);
  };
  const closeInspector = () => setSelection(undefined);
  const websocketTone =
    websocketState === 'live'
      ? 'success'
      : websocketState === 'connecting' || websocketState === 'reconnecting'
        ? 'warning'
        : 'danger';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to {titles.heading}
      </a>
      <aside className="sidebar">
        <div className="identity">
          <span className="identity__mark">L</span>
          <div>
            <strong>LUWI Runtime</strong>
            <small>local control plane</small>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          <p className="nav-group">Monitor</p>
          <a
            className={`nav-item${route.name === 'pulse' ? ' nav-item--active' : ''}`}
            href={routeHref({ name: 'pulse' })}
            aria-current={route.name === 'pulse' ? 'page' : undefined}
          >
            Pulse
          </a>
          <a
            className={`nav-item${route.name === 'activity' ? ' nav-item--active' : ''}`}
            href={routeHref({ name: 'activity' })}
            aria-current={route.name === 'activity' ? 'page' : undefined}
          >
            Activity
            {displayedActivity.pendingCount > 0 ? (
              <small>{displayedActivity.pendingCount} new</small>
            ) : null}
          </a>
          <p className="nav-group">Scope</p>
          {scopeRoutes.map((entry) => (
            <a
              key={entry.name}
              className={`nav-item${route.name === entry.name ? ' nav-item--active' : ''}`}
              href={routeHref({ name: entry.name })}
              aria-current={route.name === entry.name ? 'page' : undefined}
            >
              {entry.label}
            </a>
          ))}
          <p className="nav-group">Intelligence</p>
          {intelligenceRoutes.map((entry) => (
            <a
              key={entry.name}
              className={`nav-item${route.name === entry.name ? ' nav-item--active' : ''}`}
              href={routeHref({ name: entry.name })}
              aria-current={route.name === entry.name ? 'page' : undefined}
            >
              {entry.label}
            </a>
          ))}
          <p className="nav-group">Prepared routes</p>
          {planned.map((label) => (
            <span className="nav-item nav-item--disabled" aria-disabled="true" key={label}>
              {label}
              <small>Planned</small>
            </span>
          ))}
        </nav>
        <div className="runtime-footer">
          <StatusChip tone={snapshot.health.state === 'ready' ? 'success' : 'danger'}>
            {snapshot.health.state === 'ready' ? 'Daemon online' : 'Daemon offline'}
          </StatusChip>
          <small>Loopback only</small>
        </div>
      </aside>

      <main id="main-content" className="workspace">
        <header className="command-bar">
          <div>
            <p className="eyebrow">{titles.eyebrow}</p>
            <h1>{titles.heading}</h1>
          </div>
          <div className="command-bar__right">
            <span className="command-shell" aria-label="Search scope">
              {route.name === 'activity'
                ? 'Use bounded activity filters below'
                : route.name === 'projects'
                  ? 'Select a project to scope its evidence'
                  : 'Unified search has no read contract yet'}
            </span>
            <StatusChip tone={websocketTone}>{connectionLabel(websocketState)}</StatusChip>
            {invalidEventCount > 0 ? (
              <span className="sr-only" role="status">
                {invalidEventCount} invalid realtime messages ignored
              </span>
            ) : null}
          </div>
        </header>

        <div className="workspace__body">
          <div className="snapshot-line">
            <span>
              Snapshot{' '}
              <time dateTime={snapshot.snapshotAt}>
                {new Date(snapshot.snapshotAt).toLocaleString()}
              </time>
            </span>
            <div>
              {freshness === 'refreshing' ? (
                <StatusChip tone="warning">Refreshing snapshot</StatusChip>
              ) : freshness === 'stale' ? (
                <StatusChip tone="warning">Stale: {staleResources.join(', ')}</StatusChip>
              ) : freshness === 'unavailable' ? (
                <StatusChip tone="danger">Snapshot unavailable</StatusChip>
              ) : snapshot.partial ? (
                <StatusChip tone="warning">Partial snapshot</StatusChip>
              ) : (
                <StatusChip tone="success">Validated snapshot</StatusChip>
              )}
              <button className="retry-button" type="button" onClick={onRetry}>
                Retry snapshot
              </button>
            </div>
          </div>
          {route.name === 'activity' ? (
            <ActivityView
              state={displayedActivity}
              onStateChange={onActivityStateChange ?? (() => undefined)}
              onOpenEvent={(event, opener) =>
                openInspector({ kind: 'event', streamId: event.streamId }, opener)
              }
            />
          ) : route.name === 'sessions' ? (
            <SessionsView snapshot={snapshot} />
          ) : route.name === 'agents' ? (
            <AgentsView snapshot={snapshot} />
          ) : route.name === 'usage' ? (
            <UsageView snapshot={snapshot} />
          ) : route.name === 'context' ? (
            <ContextView
              snapshot={snapshot}
              sources={
                intelligenceResources.sources?.state === 'ready'
                  ? intelligenceResources.sources.data
                  : undefined
              }
            />
          ) : route.name === 'optimization' ? (
            <OptimizationView
              snapshot={snapshot}
              proposals={
                intelligenceResources.proposals?.state === 'ready'
                  ? intelligenceResources.proposals.data
                  : undefined
              }
            />
          ) : route.name === 'projects' ? (
            <ProjectsView
              snapshot={snapshot}
              {...(route.projectId === undefined ? {} : { selectedProjectId: route.projectId })}
              resources={projectResources}
              scopeLoading={projectScopeLoading}
              onSelectProject={(projectId) => {
                window.location.hash = routeHref({ name: 'projects', projectId });
              }}
            />
          ) : (
            <PulseView
              snapshot={snapshot}
              websocketState={websocketState}
              onOpenProject={(project, opener) =>
                openInspector({ kind: 'project', projectId: project.id }, opener)
              }
              onOpenSession={(session, opener) =>
                openInspector({ kind: 'session', sessionId: session.id }, opener)
              }
              onOpenEvent={(event, opener) =>
                openInspector({ kind: 'event', streamId: event.streamId }, opener)
              }
            />
          )}
        </div>
      </main>
      {selection === undefined ? null : (
        <InspectorPanel
          selection={selection}
          activity={displayedActivity.events}
          projects={snapshot.projects}
          sessions={snapshot.sessions}
          onNavigate={setSelection}
          onClose={closeInspector}
        />
      )}
    </div>
  );
}
