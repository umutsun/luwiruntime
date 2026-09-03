import { useEffect, useMemo, useRef, useState } from 'react';

import { ActivityView } from './activity/activity-view.js';
import type { GraphRoot, Subgraph, SubgraphBounds } from './api/graph-explorer.js';
import type { IntelligenceResources } from './api/intelligence-scope.js';
import type { ProjectScopeResources } from './api/project-scope.js';
import type { PulseFreshness } from './api/refresh-state.js';
import { BrandMark } from './components/brand-mark.js';
import { CommandPalette } from './components/command-palette.js';
import { DetailDrawer } from './components/detail-drawer.js';
import { NavIcon } from './components/nav-icon.js';
import type { ResourceState } from './components/panel.js';
import { StatusChip } from './components/status-chip.js';
import { THEME_OPTIONS, useTheme, type ThemeChoice } from './components/use-theme.js';
import {
  InspectorPanel,
  inspectorTitle,
  type InspectorSelection,
} from './inspectors/inspector-panel.js';
import type { GraphSeed } from './routes/graph-explorer-view.js';
import { ProjectDetail, ProjectsView } from './projects/projects-view.js';
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
import type { MessageMutations } from './api/message-mutations.js';
import { MessagesView } from './routes/messages-view.js';
import { OptimizationView } from './routes/optimization-view.js';
import type { RuntimeResources } from './api/runtime-resources.js';
import { RuntimeView } from './routes/runtime-view.js';
import { SessionsView } from './routes/sessions-view.js';
import { UsageView } from './routes/usage-view.js';
import { scopePulseSnapshot, type PulseSnapshot } from './pulse/model.js';
import { PulseView } from './pulse/pulse-view.js';
import {
  acceptActivityEvent,
  createActivityState,
  resumeActivity,
  setActivityFollowing,
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

/**
 * The realtime switch's face. Pressed (following) shows the connection as it
 * is — "Live" only when the socket is live, and the fault otherwise, because a
 * pressed switch reading "Live" over a dead socket would be the one lie this
 * control exists to prevent. Released shows what arrived while it was held.
 */
function realtimeFace(
  state: WebSocketState,
  following: boolean,
  pendingCount: number,
): { label: string; tone: 'live' | 'warning' | 'danger' | 'paused' } {
  if (!following) return { label: `Paused · ${String(pendingCount)} new · resume`, tone: 'paused' };
  if (state === 'live') return { label: 'Live', tone: 'live' };
  if (state === 'connecting') return { label: 'Realtime connecting', tone: 'warning' };
  if (state === 'reconnecting') return { label: 'Realtime reconnecting', tone: 'warning' };
  if (state === 'unavailable') return { label: 'Realtime unavailable', tone: 'danger' };
  return { label: 'Realtime disconnected', tone: 'danger' };
}

function ThemeGlyph({ choice }: { choice: ThemeChoice }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {choice === 'system' ? (
        <>
          <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" />
          <path d="M5.5 13.5h5M8 11v2.5" />
        </>
      ) : choice === 'light' ? (
        <>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
        </>
      ) : (
        <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />
      )}
    </svg>
  );
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
  messageMutations,
  onConfigMutated,
  agentPairResources = {},
  agentPairLoading = false,
  leaseResources = {},
  intelligenceLoading = false,
  loadSubgraph,
  loadResources,
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
  /** Absent keeps the sessions route observational and removes Ask actions. */
  messageMutations?: MessageMutations | undefined;
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
  /** Absent keeps the Runtime route to identity and health, with no machine figures. */
  loadResources?: (options?: { signal?: AbortSignal }) => Promise<ResourceState<RuntimeResources>>;
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
  const following = displayedActivity.following;
  /*
   * Released, the realtime switch holds the retained activity Pulse was showing
   * at that moment — the stream and both traces — while the store keeps
   * accepting events and counting them on the switch. Resuming drops the hold.
   */
  const [heldActivity, setHeldActivity] = useState<PulseSnapshot['activity']>();
  useEffect(() => {
    if (following) setHeldActivity(undefined);
    else setHeldActivity((current) => current ?? snapshot.activity);
  }, [following, snapshot.activity]);
  const pulseSource = useMemo(
    () => (heldActivity === undefined ? snapshot : { ...snapshot, activity: heldActivity }),
    [snapshot, heldActivity],
  );
  const scoped = useMemo(
    () => scopePulseSnapshot(pulseSource, scopeProjectId),
    [pulseSource, scopeProjectId],
  );
  const setFollowing = (next: boolean) => {
    onActivityStateChange?.(
      next ? resumeActivity(displayedActivity) : setActivityFollowing(displayedActivity, false),
    );
  };
  const graphSeeds = useMemo(() => graphSeedsOf(snapshot), [snapshot]);

  useEffect(() => {
    const updateRoute = () => {
      // Route-local and inspector selections share one modal surface. Closing
      // the inspector in the same hash transition prevents two focus traps
      // and two scroll-lock owners from mounting at once.
      setSelection(undefined);
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);

  const titles = routeTitles[route.name];
  /*
   * The eyebrow repeats the scope on the routes the scope narrows, so a
   * narrowed Pulse is never mistaken for the whole runtime. The other routes
   * read runtime-wide whatever the select says, and their eyebrow says nothing
   * it cannot back.
   */
  const scopeProject = snapshot.projects.find((project) => project.id === scopeProjectId);
  const eyebrow =
    scopeProject !== undefined && (route.name === 'pulse' || route.name === 'sessions')
      ? `${titles.eyebrow} · ${scopeProject.name}`
      : titles.eyebrow;
  const health = snapshot.health.state === 'ready' ? snapshot.health.data : undefined;
  const realtime = realtimeFace(websocketState, following, displayedActivity.pendingCount);

  const openInspector = (next: InspectorSelection, opener: HTMLElement) => {
    opener.focus();
    setSelection(next);
  };
  const closeInspector = () => setSelection(undefined);

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
        {/*
         * Runtime health lives here rather than in the Pulse stat strip, which
         * keeps only work counts. The daemon and Redis lines used to sit beside
         * "waiting" and "blocked" as if they were the same kind of number.
         */}
        <div className="runtime-footer">
          <StatusChip
            tone={health === undefined ? 'danger' : health.status === 'ok' ? 'success' : 'warning'}
          >
            <span className="rail-health__label">
              {health === undefined
                ? 'Daemon offline'
                : health.status === 'ok'
                  ? 'Daemon online'
                  : 'Daemon degraded'}
            </span>
          </StatusChip>
          {health === undefined ? null : (
            <StatusChip tone={health.redis.connected ? 'success' : 'danger'}>
              <span className="rail-health__label">
                {health.redis.connected
                  ? `Redis connected · ${String(health.redis.latencyMs)} ms`
                  : 'Redis disconnected'}
              </span>
            </StatusChip>
          )}
          <small>Loopback only</small>
        </div>
      </aside>

      {/* `tabIndex={-1}` makes the region focusable by the skip link without
          adding a tab stop of its own. */}
      <main id="main-content" className="workspace" ref={mainRegion} tabIndex={-1}>
        <header className="command-bar">
          <div className="command-bar__left">
            {/* The glyph changes with the state and the tooltip names the
                action, so collapsed and expanded are told apart before the
                click rather than only by the rail's width. */}
            <button
              type="button"
              className="icon-button"
              aria-pressed={railCollapsed}
              aria-label={
                railCollapsed ? 'Expand the navigation rail' : 'Collapse the navigation rail'
              }
              title={railCollapsed ? 'Expand the navigation rail' : 'Collapse the navigation rail'}
              onClick={() => setRailCollapsed((collapsed) => !collapsed)}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden="true"
              >
                <path
                  d={railCollapsed ? 'M2 4h12M2 8h7M2 12h12' : 'M2 4h12M2 8h12M2 12h12'}
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <div>
              <p className="eyebrow">{eyebrow}</p>
              <h1>{titles.heading}</h1>
            </div>
          </div>
          <div className="command-bar__right">
            <CommandPalette snapshot={snapshot} scopeSummary={scopeSummary(route.name, scoped)} />
            {/* A native select: eleven projects do not cycle well, and a
                custom dropdown would be accessibility work for no gain. It
                carries the count in its resting label and a one-click way
                back once narrowed. */}
            <div className="scope-group">
              <select
                className="scope-select"
                aria-label="Project scope"
                value={scopeProjectId ?? ''}
                onChange={(event) =>
                  setScopeProjectId(event.target.value === '' ? undefined : event.target.value)
                }
              >
                <option value="">
                  {snapshot.projectCount.state === 'unavailable'
                    ? 'All projects'
                    : `All projects · ${String(snapshot.projectCount.value)}`}
                </option>
                {snapshot.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              {scopeProjectId === undefined ? null : (
                <button
                  type="button"
                  className="scope-clear"
                  aria-label="Back to all projects"
                  title="Back to all projects"
                  onClick={() => setScopeProjectId(undefined)}
                >
                  ×
                </button>
              )}
            </div>
            {/* One switch for the whole console: pressed follows the feed,
                released holds it and counts what arrives. It replaces the
                connection chip here and the follow label and resume button
                the Activity route used to carry apart from it. */}
            <button
              type="button"
              className={`live-switch live-switch--${realtime.tone}`}
              aria-pressed={following}
              title={
                following
                  ? 'Pause the realtime feed; new events are counted until you resume'
                  : 'Resume the realtime feed'
              }
              onClick={() => setFollowing(!following)}
            >
              <span className="live-switch__dot" aria-hidden="true" />
              {realtime.label}
            </button>
            {/* Three states, not two: the stylesheet has always had a
                system-following mode, and a segmented control keeps that
                default visible instead of hiding it behind a cycling icon. */}
            <div className="segmented" role="group" aria-label="Theme">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.choice}
                  type="button"
                  className="segmented__option"
                  aria-pressed={themeChoice === option.choice}
                  title={option.title}
                  onClick={() => setThemeChoice(option.choice)}
                >
                  <ThemeGlyph choice={option.choice} />
                  {option.label}
                </button>
              ))}
            </div>
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
            <RuntimeView
              snapshot={snapshot}
              websocketState={websocketState}
              {...(loadResources === undefined ? {} : { loadResources })}
            />
          ) : route.name === 'sessions' ? (
            <SessionsView
              snapshot={scoped}
              {...(messageMutations === undefined ? {} : { messageMutations })}
              onMessageCreated={(correlationId) => {
                window.location.hash = routeHref({ name: 'messages', correlationId });
              }}
              onOpenSession={(session, opener) =>
                openInspector({ kind: 'session', sessionId: session.id }, opener)
              }
            />
          ) : route.name === 'messages' ? (
            <MessagesView
              messages={messageResources.messages}
              loading={messagesLoading}
              onCloseRoutedDetail={() => {
                window.location.hash = routeHref({ name: 'messages' });
              }}
              {...(route.correlationId === undefined
                ? {}
                : { selectedCorrelationId: route.correlationId })}
            />
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
              renderDetailInline={false}
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
            /* The selected row stays identifiable while its overlay is open. */
            <PulseView
              snapshot={scoped}
              websocketState={websocketState}
              following={following}
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
      {selection !== undefined ? (
        <DetailDrawer
          eyebrow="Read-only evidence"
          title={inspectorTitle(selection)}
          onClose={closeInspector}
        >
          <InspectorPanel
            selection={selection}
            activity={displayedActivity.events}
            projects={snapshot.projects}
            sessions={snapshot.sessions}
            onNavigate={setSelection}
          />
        </DetailDrawer>
      ) : route.name === 'projects' && route.projectId !== undefined ? (
        <DetailDrawer
          key={route.projectId}
          eyebrow="Scoped evidence"
          title="Project evidence"
          meta={
            snapshot.projects.find((project) => project.id === route.projectId)?.name ??
            route.projectId
          }
          onClose={() => {
            window.location.hash = routeHref({ name: 'projects' });
          }}
        >
          <ProjectDetail
            snapshot={snapshot}
            selectedProjectId={route.projectId}
            {...(route.agentId === undefined ? {} : { selectedAgentId: route.agentId })}
            resources={projectResources}
            scopeLoading={projectScopeLoading}
            agentPairResources={agentPairResources}
            agentPairLoading={agentPairLoading}
            leaseResources={leaseResources}
            onSelectAgent={(agentId) => {
              if (route.projectId === undefined) return;
              window.location.hash = routeHref({
                name: 'projects',
                projectId: route.projectId,
                ...(agentId === undefined ? {} : { agentId }),
              });
            }}
          />
        </DetailDrawer>
      ) : null}
    </div>
  );
}
