import { useEffect, useMemo, useRef, useState } from 'react';

import { ActivityView } from './activity/activity-view.js';
import type { GraphRoot, Subgraph, SubgraphBounds } from './api/graph-explorer.js';
import type { IntelligenceResources } from './api/intelligence-scope.js';
import type { ProjectScopeResources } from './api/project-scope.js';
import type { PulseFreshness } from './api/refresh-state.js';
import { BrandMark } from './components/brand-mark.js';
import { CommandPalette } from './components/command-palette.js';
import { NavIcon } from './components/nav-icon.js';
import type { ResourceState } from './components/panel.js';
import { StatusChip } from './components/status-chip.js';
import { nextTheme, THEME_LABELS, useTheme } from './components/use-theme.js';
import {
  InspectorEmpty,
  InspectorPanel,
  type InspectorSelection,
} from './inspectors/inspector-panel.js';
import type { GraphSeed } from './routes/graph-explorer-view.js';
import { ProjectsView } from './projects/projects-view.js';
import { AgentsView } from './routes/agents-view.js';
import { ContextView } from './routes/context-view.js';
import { GraphView } from './routes/graph-view.js';
import type { AgentPairResources } from './api/agent-pair-scope.js';
import type { CapabilityCatalogResources } from './api/capability-catalog.js';
import { CapabilitiesView } from './routes/capabilities-view.js';
import type { ConfigMutations } from './api/config-mutations.js';
import type { ConfigResources } from './api/config-scope.js';
import type { LeaseResources } from './api/lease-scope.js';
import { ConfigView } from './routes/config-view.js';
import type { MessageResources } from './api/messages-scope.js';
import { MessagesView } from './routes/messages-view.js';
import { OptimizationView } from './routes/optimization-view.js';
import { RuntimeView } from './routes/runtime-view.js';
import { SessionsView } from './routes/sessions-view.js';
import { UsageView } from './routes/usage-view.js';
import { scopePulseSnapshot, type PulseSnapshot } from './pulse/model.js';
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
  { name: 'capabilities', label: 'Capabilities' },
  { name: 'config', label: 'Configuration' },
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
  runtime: { eyebrow: 'Local boundary', heading: 'Runtime' },
  projects: { eyebrow: 'Project scope', heading: 'Projects' },
  agents: { eyebrow: 'Registered definitions', heading: 'Agents' },
  sessions: { eyebrow: 'Observed sessions', heading: 'Sessions' },
  messages: { eyebrow: 'Inter-agent requests', heading: 'Messages' },
  capabilities: { eyebrow: 'Registered catalogue', heading: 'Capabilities' },
  config: { eyebrow: 'Native configuration', heading: 'Configuration' },
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

/**
 * The count beside a rail entry.
 *
 * It renders nothing at all when the read failed. A badge is glanceable and
 * unlabelled, so an `Unavailable` word does not fit and a `0` would be a lie —
 * "no projects" and "we could not ask" are different facts, and only the first
 * of them is a number. The command bar still states the unavailability in full.
 *
 * `aria-hidden` because it is a second rendering of a number, not a second
 * number. Inside the link it would append to the accessible name and produce
 * "Projects 3", which reads as an ordinal rather than a count; the authoritative
 * figure is on the destination and in the command bar's scope summary. The rail
 * keeps its one-word link names, which is what `app.test.tsx` pins.
 */
function navBadge(route: DashboardRouteName, snapshot: PulseSnapshot) {
  const counts: Partial<Record<DashboardRouteName, PulseSnapshot['projectCount']>> = {
    projects: snapshot.projectCount,
    agents: snapshot.agentCount,
    optimization: snapshot.findingCount,
  };
  const count = counts[route];
  if (count === undefined || count.state === 'unavailable' || count.value === 0) return null;
  return (
    <span className="nav-item__badge" aria-hidden="true">
      {count.value}
    </span>
  );
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
  capabilityCatalogResources = {},
  capabilityCatalogLoading = false,
  configResources = {},
  configLoading = false,
  configMutations,
  onConfigMutated,
  agentPairResources = {},
  agentPairLoading = false,
  leaseResources = {},
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
  capabilityCatalogResources?: Partial<CapabilityCatalogResources>;
  /** The on-demand catalogue reads have not returned yet. */
  capabilityCatalogLoading?: boolean;
  configResources?: Partial<ConfigResources>;
  /** The on-demand config chain reads have not returned yet. */
  configLoading?: boolean;
  /**
   * Absent by default, so a shell rendered without it — which is what most of
   * this file's tests do — carries no mutation capability at all.
   */
  configMutations?: ConfigMutations | undefined;
  onConfigMutated?: (() => void) | undefined;
  agentPairResources?: Partial<AgentPairResources>;
  /** The pair-scoped reads have not returned yet. */
  agentPairLoading?: boolean;
  leaseResources?: Partial<LeaseResources>;
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
  const [railCollapsed, setRailCollapsed] = useState(false);
  /*
   * The mockup's scope switcher. Client-side narrowing only: rows carrying a
   * projectId are filtered and their counts recomputed; nothing is refetched
   * and reads without a per-project shape stay runtime-wide.
   */
  const [scopeProjectId, setScopeProjectId] = useState<string>();
  const scoped = useMemo(
    () => scopePulseSnapshot(snapshot, scopeProjectId),
    [snapshot, scopeProjectId],
  );
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
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
    <div className={`app-shell${railCollapsed ? ' app-shell--rail-collapsed' : ''}`}>
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
          <span className="identity__mark">
            <BrandMark />
          </span>
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
            <NavIcon route="pulse" />
            <span className="nav-item__label">Pulse</span>
          </a>
          <a
            className={`nav-item${route.name === 'activity' ? ' nav-item--active' : ''}`}
            href={routeHref({ name: 'activity' })}
            aria-current={route.name === 'activity' ? 'page' : undefined}
          >
            <NavIcon route="activity" />
            <span className="nav-item__label">Activity</span>
            {displayedActivity.pendingCount > 0 ? (
              <small>{displayedActivity.pendingCount} new</small>
            ) : null}
          </a>
          <a
            className={`nav-item${route.name === 'runtime' ? ' nav-item--active' : ''}`}
            href={routeHref({ name: 'runtime' })}
            aria-current={route.name === 'runtime' ? 'page' : undefined}
          >
            <NavIcon route="runtime" />
            <span className="nav-item__label">Runtime</span>
          </a>
          <p className="nav-group">Scope</p>
          {scopeRoutes.map((entry) => (
            <a
              key={entry.name}
              className={`nav-item${route.name === entry.name ? ' nav-item--active' : ''}`}
              href={routeHref({ name: entry.name })}
              aria-current={route.name === entry.name ? 'page' : undefined}
            >
              <NavIcon route={entry.name} />
              <span className="nav-item__label">{entry.label}</span>
              {navBadge(entry.name, snapshot)}
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
              <NavIcon route={entry.name} />
              <span className="nav-item__label">{entry.label}</span>
              {navBadge(entry.name, snapshot)}
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
          <div className="command-bar__left">
            <button
              type="button"
              className="icon-button"
              aria-pressed={railCollapsed}
              aria-label={
                railCollapsed ? 'Expand the navigation rail' : 'Collapse the navigation rail'
              }
              onClick={() => setRailCollapsed((collapsed) => !collapsed)}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden="true"
              >
                <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
              </svg>
            </button>
            <div>
              <p className="eyebrow">{titles.eyebrow}</p>
              <h1>{titles.heading}</h1>
            </div>
          </div>
          <div className="command-bar__right">
            <CommandPalette snapshot={snapshot} scopeSummary={scopeSummary(route.name, scoped)} />
            {/* A native select: eleven projects do not cycle well, and a
                custom dropdown would be accessibility work for no gain. */}
            <select
              className="scope-select"
              aria-label="Project scope"
              value={scopeProjectId ?? ''}
              onChange={(event) =>
                setScopeProjectId(event.target.value === '' ? undefined : event.target.value)
              }
            >
              <option value="">All projects</option>
              {snapshot.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <StatusChip tone={websocketTone}>{connectionLabel(websocketState)}</StatusChip>
            {/* Three states, not two: the stylesheet has always had a
                system-following mode, and collapsing it into a light/dark
                switch would take away the default that tracks the OS. */}
            <button
              type="button"
              className="icon-button"
              aria-label={`${THEME_LABELS[themeChoice]}. Activate to change.`}
              onClick={() => setThemeChoice(nextTheme(themeChoice))}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="5.25" />
                <path d="M8 2.75v10.5a5.25 5.25 0 0 0 0-10.5z" fill="currentColor" stroke="none" />
              </svg>
            </button>
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
          ) : route.name === 'runtime' ? (
            <RuntimeView snapshot={snapshot} websocketState={websocketState} />
          ) : route.name === 'sessions' ? (
            <SessionsView
              snapshot={scoped}
              onOpenSession={(session, opener) =>
                openInspector({ kind: 'session', sessionId: session.id }, opener)
              }
            />
          ) : route.name === 'messages' ? (
            <MessagesView messages={messageResources.messages} loading={messagesLoading} />
          ) : route.name === 'capabilities' ? (
            <CapabilitiesView
              capabilities={capabilityCatalogResources.capabilities}
              profiles={capabilityCatalogResources.profiles}
              loading={capabilityCatalogLoading}
            />
          ) : route.name === 'config' ? (
            <ConfigView
              drifts={configResources.drifts}
              plans={configResources.plans}
              snapshots={configResources.snapshots}
              agents={configResources.agents}
              loading={configLoading}
              {...(configMutations === undefined ? {} : { mutations: configMutations })}
              {...(onConfigMutated === undefined ? {} : { onMutated: onConfigMutated })}
            />
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
              leaseResources={leaseResources}
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
            /*
             * The docked pane is permanently visible, so the row it is showing
             * has to be identifiable in the list too — otherwise the inspector
             * describes a row the reader has to find again by eye.
             */
            <PulseView
              snapshot={scoped}
              websocketState={websocketState}
              {...(selection?.kind === 'session' ? { selectedSessionId: selection.sessionId } : {})}
              {...(selection?.kind === 'project' ? { selectedProjectId: selection.projectId } : {})}
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
      {/* Grid column three. Permanently mounted, so it keeps its landmark and
          its accessible name whether or not anything is selected — an overlay
          that appears and disappears was a different contract, and the empty
          state is what a docked pane needs instead. */}
      {selection === undefined ? (
        <InspectorEmpty />
      ) : (
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
