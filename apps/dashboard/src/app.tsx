import { useEffect, useMemo, useRef, useState } from 'react';

import { ActivityView } from './activity/activity-view.js';
import type { GraphRoot, Subgraph, SubgraphBounds } from './api/graph-explorer.js';
import type { IntelligenceResources } from './api/intelligence-scope.js';
import type { ProjectScopeResources } from './api/project-scope.js';
import type { PulseFreshness } from './api/refresh-state.js';
import type { ResourceState } from './components/panel.js';
import { StatusChip } from './components/status-chip.js';
import { InspectorPanel, type InspectorSelection } from './inspectors/inspector-panel.js';
import type { GraphSeed } from './routes/graph-explorer-view.js';
import { ProjectsView } from './projects/projects-view.js';
import { AgentsView } from './routes/agents-view.js';
import { ContextView } from './routes/context-view.js';
import { GraphView } from './routes/graph-view.js';
import type { AgentPairResources } from './api/agent-pair-scope.js';
import type { MessageResources } from './api/messages-scope.js';
import { MessagesView } from './routes/messages-view.js';
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
 * Routes with no sufficient read contract yet. `Graph` left this list once
 * `/api/v1/graph/summary` gave it a bounded global answer (ADR 0013); until
 * then only rooted queries existed and no honest overview could be derived.
 * See `docs/phase5-dashboard-capability-matrix.md`.
 */
const planned: string[] = [];

/** Routes reachable from the rail, in navigation order. */
const scopeRoutes = [
  { name: 'projects', label: 'Projects' },
  { name: 'agents', label: 'Agents' },
  { name: 'sessions', label: 'Sessions' },
  { name: 'messages', label: 'Messages' },
] as const;

const intelligenceRoutes = [
  { name: 'usage', label: 'Usage' },
  { name: 'context', label: 'Context' },
  { name: 'optimization', label: 'Optimization' },
  { name: 'graph', label: 'Graph' },
] as const;

const routeTitles: Record<DashboardRouteName, { eyebrow: string; heading: string }> = {
  pulse: { eyebrow: 'Operational snapshot', heading: 'Pulse' },
  activity: { eyebrow: 'Event observer', heading: 'Activity' },
  projects: { eyebrow: 'Project scope', heading: 'Projects' },
  agents: { eyebrow: 'Registered definitions', heading: 'Agents' },
  sessions: { eyebrow: 'Observed sessions', heading: 'Sessions' },
  messages: { eyebrow: 'Inter-agent requests', heading: 'Messages' },
  usage: { eyebrow: 'Observation sources', heading: 'Usage' },
  context: { eyebrow: 'Context evidence', heading: 'Context' },
  optimization: { eyebrow: 'Structural findings', heading: 'Optimization' },
  graph: { eyebrow: 'Operational graph', heading: 'Graph' },
};

function pluralize(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Roots the Graph explorer can start from (ADR 0016).
 *
 * Graph nodes are keyed by `entityId`, which for these kinds is the same
 * identifier the snapshot already carries — so no derivation and no extra
 * request is needed. Modules, files, and commits have synthetic entity ids and
 * are reached by traversing from a project rather than seeded directly.
 */
function graphSeedsOf(snapshot: PulseSnapshot): GraphSeed[] {
  return [
    ...snapshot.projects.map((project) => ({
      kind: 'project',
      id: project.id,
      label: project.name,
    })),
    ...snapshot.agents.map((agent) => ({
      kind: 'agent',
      id: agent.id,
      label: agent.displayName,
    })),
    ...snapshot.sessions.map((session) => ({
      kind: 'session',
      id: session.id,
      label: `${session.agentId} · ${session.projectName}`,
    })),
  ];
}

/**
 * What the current route is showing, in the runtime's own counts.
 *
 * This replaced a placeholder that advertised a unified search the daemon has
 * no read contract for. An affordance that cannot act is worse than none, and
 * the space is better spent on evidence the snapshot already carries. An
 * unavailable count says so; it is never rendered as zero.
 */
function scopeSummary(route: DashboardRouteName, snapshot: PulseSnapshot): string {
  const count = (value: PulseSnapshot['projectCount'], noun: string, label: string): string =>
    value.state === 'unavailable' ? `${label} unavailable` : pluralize(value.value, noun);
  if (route === 'projects') return count(snapshot.projectCount, 'project', 'Projects');
  if (route === 'agents') return count(snapshot.agentCount, 'agent', 'Agents');
  if (route === 'sessions') {
    return snapshot.sessionsState === 'ready'
      ? pluralize(snapshot.sessions.length, 'session')
      : 'Sessions unavailable';
  }
  if (route === 'activity') {
    return snapshot.activityState === 'ready'
      ? pluralize(snapshot.activity.length, 'retained event')
      : 'Activity unavailable';
  }
  return `${count(snapshot.projectCount, 'project', 'Projects')} · ${count(
    snapshot.activeSessionCount,
    'active session',
    'Sessions',
  )}`;
}

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
  messageResources = {},
  messagesLoading = false,
  agentPairResources = {},
  agentPairLoading = false,
  intelligenceLoading = false,
  loadSubgraph,
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
  /** The on-demand intelligence reads have not returned yet. */
  intelligenceLoading?: boolean;
  messageResources?: Partial<MessageResources>;
  /** The on-demand message read has not returned yet. */
  messagesLoading?: boolean;
  agentPairResources?: Partial<AgentPairResources>;
  /** The pair-scoped reads have not returned yet. */
  agentPairLoading?: boolean;
  loadSubgraph?: (
    root: GraphRoot,
    bounds: SubgraphBounds,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<Subgraph>>;
  onRetry: () => void;
  onActivityStateChange?: (state: ActivityState) => void;
}) {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [selection, setSelection] = useState<InspectorSelection>();
  const mainRegion = useRef<HTMLElement>(null);
  const fallbackActivity = useMemo(
    () =>
      snapshot.activity.reduce(
        (state, event) => acceptActivityEvent(state, event).state,
        createActivityState(),
      ),
    [snapshot.activity],
  );
  const displayedActivity = activityState ?? fallbackActivity;
  const graphSeeds = useMemo(() => graphSeedsOf(snapshot), [snapshot]);

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
      {/*
       * The href keeps the link meaningful without JavaScript, but the click is
       * handled here: `#main-content` is not a route, so letting it reach the
       * hash would send `parseRoute` to its Pulse fallback and clear the
       * project selection. The one control whose purpose is to help keyboard
       * users would be the one that resets their context.
       */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRegion.current?.focus();
        }}
      >
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
          {planned.length === 0 ? null : (
            <>
              <p className="nav-group">Prepared routes</p>
              {planned.map((label) => (
                <span className="nav-item nav-item--disabled" aria-disabled="true" key={label}>
                  {label}
                  <small>Planned</small>
                </span>
              ))}
            </>
          )}
        </nav>
        <div className="runtime-footer">
          <StatusChip tone={snapshot.health.state === 'ready' ? 'success' : 'danger'}>
            {snapshot.health.state === 'ready' ? 'Daemon online' : 'Daemon offline'}
          </StatusChip>
          <small>Loopback only</small>
        </div>
      </aside>

      {/* `tabIndex={-1}` makes the region focusable by the skip link without
          adding a tab stop of its own. */}
      <main id="main-content" className="workspace" ref={mainRegion} tabIndex={-1}>
        <header className="command-bar">
          <div>
            <p className="eyebrow">{titles.eyebrow}</p>
            <h1>{titles.heading}</h1>
          </div>
          <div className="command-bar__right">
            <span className="command-shell" aria-label="Current scope">
              {scopeSummary(route.name, snapshot)}
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
              available={snapshot.activityState === 'ready'}
              onStateChange={onActivityStateChange ?? (() => undefined)}
              onOpenEvent={(event, opener) =>
                openInspector({ kind: 'event', streamId: event.streamId }, opener)
              }
            />
          ) : route.name === 'sessions' ? (
            <SessionsView
              snapshot={snapshot}
              onOpenSession={(session, opener) =>
                openInspector({ kind: 'session', sessionId: session.id }, opener)
              }
            />
          ) : route.name === 'messages' ? (
            <MessagesView messages={messageResources.messages} loading={messagesLoading} />
          ) : route.name === 'agents' ? (
            <AgentsView snapshot={snapshot} />
          ) : route.name === 'usage' ? (
            <UsageView snapshot={snapshot} />
          ) : route.name === 'context' ? (
            <ContextView
              snapshot={snapshot}
              loading={intelligenceLoading}
              sources={
                intelligenceResources.sources?.state === 'ready'
                  ? intelligenceResources.sources.data
                  : undefined
              }
            />
          ) : route.name === 'optimization' ? (
            <OptimizationView
              snapshot={snapshot}
              loading={intelligenceLoading}
              proposals={
                intelligenceResources.proposals?.state === 'ready'
                  ? intelligenceResources.proposals.data
                  : undefined
              }
            />
          ) : route.name === 'graph' ? (
            <GraphView
              summary={intelligenceResources.graph}
              loading={intelligenceLoading}
              seeds={graphSeeds}
              {...(loadSubgraph === undefined ? {} : { loadSubgraph })}
            />
          ) : route.name === 'projects' ? (
            <ProjectsView
              snapshot={snapshot}
              {...(route.projectId === undefined ? {} : { selectedProjectId: route.projectId })}
              {...(route.agentId === undefined ? {} : { selectedAgentId: route.agentId })}
              resources={projectResources}
              scopeLoading={projectScopeLoading}
              agentPairResources={agentPairResources}
              agentPairLoading={agentPairLoading}
              onSelectProject={(projectId) => {
                window.location.hash = routeHref({ name: 'projects', projectId });
              }}
              onSelectAgent={(agentId) => {
                if (route.projectId === undefined) return;
                window.location.hash = routeHref({
                  name: 'projects',
                  projectId: route.projectId,
                  ...(agentId === undefined ? {} : { agentId }),
                });
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
