import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ActivityView } from './activity/activity-view.js';
import type { AgentPairResources } from './api/agent-pair-scope.js';
import type { CapabilityCatalogResources } from './api/capability-catalog.js';
import type { ConfigMutations } from './api/config-mutations.js';
import type { ConfigResources } from './api/config-scope.js';
import type { GraphRoot, Subgraph, SubgraphBounds } from './api/graph-explorer.js';
import type { IntelligenceResources } from './api/intelligence-scope.js';
import type { CapabilityMutations } from './api/capability-mutations.js';
import type { CoordinatorMutations } from './api/coordinator-mutations.js';
import type { KnowledgeGraph } from './api/knowledge-scope.js';
import type { LeaseResources } from './api/lease-scope.js';
import type { MessageMutations } from './api/message-mutations.js';
import type { MessageResources } from './api/messages-scope.js';
import type { ProjectMutations } from './api/project-mutations.js';
import type { ProjectScopeResources } from './api/project-scope.js';
import type { PulseFreshness } from './api/refresh-state.js';
import type { RuntimeResources } from './api/runtime-resources.js';
import type { ProjectDiscoveryResult } from './api/project-discovery.js';
import type { SessionUsage } from './api/session-usage.js';
import { BrandMark } from './components/brand-mark.js';
import { ConfirmDialog } from './components/confirm-dialog.js';
import { DetailDrawer } from './components/detail-drawer.js';
import { ProjectDiscoveryPanel } from './components/project-discovery-panel.js';
import { ProjectForm } from './components/project-form.js';
import type { ResourceState } from './components/panel.js';
import { THEME_OPTIONS, useTheme, type ThemeChoice } from './components/use-theme.js';
import {
  InspectorPanel,
  inspectorTitle,
  type InspectorSelection,
} from './inspectors/inspector-panel.js';
import { formatClock, RUNTIME_FOCUS, sessionBadge, toneOf, type Focus } from './overview/model.js';
import { Overview } from './overview/overview.js';
import { useProjectFilter, visibleProjectIds } from './overview/use-project-filter.js';
import { useViewChoice, VIEW_CHOICES, VIEW_LABELS } from './overview/use-view-choice.js';
import { useBuildWatch } from './use-build-watch.js';
import { ProjectDetail, ProjectsView } from './projects/projects-view.js';
import { scopePulseSnapshotToProjects, type PulseSnapshot } from './pulse/model.js';
import {
  acceptActivityEvent,
  createActivityState,
  resumeActivity,
  setActivityFollowing,
  type ActivityState,
} from './realtime/activity-store.js';
import type { RealtimeConnectionState } from './realtime/observer.js';
import type { DashboardEvent } from './realtime/schema.js';
import { AgentsView } from './routes/agents-view.js';
import { CapabilitiesView } from './routes/capabilities-view.js';
import { ConfigView } from './routes/config-view.js';
import { ContextView } from './routes/context-view.js';
import type { GraphSeed } from './routes/graph-explorer-view.js';
import { GraphView } from './routes/graph-view.js';
import { MessagesView } from './routes/messages-view.js';
import { OptimizationView } from './routes/optimization-view.js';
import { RuntimeView } from './routes/runtime-view.js';
import { SessionsView } from './routes/sessions-view.js';
import { UsageView } from './routes/usage-view.js';
import { parseRoute, routeHref, type DashboardRoute, type DashboardRouteName } from './routing.js';
import { monogramInitials } from './components/format.js';

export type WebSocketState = RealtimeConnectionState;

const wallClock = (): number => Date.now();

const routeTitles: Record<DashboardRouteName, { eyebrow: string; heading: string }> = {
  pulse: { eyebrow: 'Overview', heading: 'Overview' },
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

/** The routes whose tables run six to eight columns take the wide drawer. */
const WIDE_DRAWER_ROUTES: ReadonlySet<DashboardRouteName> = new Set<DashboardRouteName>([
  'sessions',
  'messages',
  'capabilities',
  'config',
  'projects',
]);

/** The project a `#/pulse/<projectId>` hash names; anything else is the runtime. */
function focusOfRoute(route: DashboardRoute): Focus {
  return route.name === 'pulse' && route.projectId !== undefined
    ? { kind: 'project', id: route.projectId }
    : RUNTIME_FOCUS;
}

/**
 * Roots the Graph explorer can start from (ADR 0016).
 *
 * Graph nodes are keyed by `entityId`, which for these kinds is the same
 * identifier the snapshot already carries — so no derivation and no extra
 * request is needed.
 */
function graphSeedsOf(snapshot: PulseSnapshot): GraphSeed[] {
  return [
    ...snapshot.projects.map((project) => ({
      kind: 'project',
      id: project.id,
      label: project.name,
    })),
    ...snapshot.agents.map((agent) => ({ kind: 'agent', id: agent.id, label: agent.displayName })),
    ...snapshot.sessions.map((session) => ({
      kind: 'session',
      id: session.id,
      label: `${session.agentId} · ${session.projectName}`,
    })),
  ];
}

/**
 * The realtime switch's face. Pressed (following) shows the connection as it
 * is — "Live" only when the socket is live, and the fault otherwise, because a
 * pressed switch reading "Live" over a dead socket would be the one lie this
 * control exists to prevent. Released shows what arrived while it was held.
 */
export function realtimeFace(
  state: WebSocketState,
  following: boolean,
  pendingCount: number,
): { label: string; word: string; tone: 'live' | 'warning' | 'danger' | 'paused' } {
  if (!following) {
    return {
      label: `Paused · ${String(pendingCount)} new · resume`,
      word: 'PAUSED',
      tone: 'paused',
    };
  }
  if (state === 'live') return { label: 'Live', word: 'LIVE', tone: 'live' };
  if (state === 'connecting')
    return { label: 'Realtime connecting', word: 'CONNECTING', tone: 'warning' };
  if (state === 'reconnecting')
    return { label: 'Realtime reconnecting', word: 'RECONNECTING', tone: 'warning' };
  if (state === 'unavailable')
    return { label: 'Realtime unavailable', word: 'UNAVAILABLE', tone: 'danger' };
  return { label: 'Realtime disconnected', word: 'OFFLINE', tone: 'danger' };
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

/**
 * A header popover. It closes on Escape, on a click outside, and on any hash
 * change — the last so a menu that navigated is not still open on the next
 * route. Nothing here traps focus: a menu is not a dialog.
 */
function Popover({
  open,
  onClose,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className: string;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && surface.current?.parentElement?.contains(target) === true)
        return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('hashchange', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('hashchange', onClose);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={surface} className={className}>
      {children}
    </div>
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
  projectMutations,
  onProjectMutated,
  coordinatorMutations,
  onCoordinatorMutated,
  capabilityMutations,
  agentPairResources = {},
  agentPairLoading = false,
  leaseResources = {},
  intelligenceLoading = false,
  loadSubgraph,
  loadResources,
  loadSessionUsage,
  loadKnowledge,
  loadProjectDiscovery,
  onRetry,
  onActivityStateChange,
  now = wallClock,
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
  /** Absent keeps the overview free of project registration and in-place editing (ADR 0033). */
  projectMutations?: ProjectMutations | undefined;
  /** Called after a project was registered or changed, so the snapshot can be re-read. */
  onProjectMutated?: (() => void) | undefined;
  /** Absent keeps the sessions route free of coordinator assignment (ADR 0035). */
  coordinatorMutations?: CoordinatorMutations | undefined;
  /** Called after a coordinator claim/release, so the snapshot can be re-read. */
  onCoordinatorMutated?: (() => void) | undefined;
  /** Absent keeps the project drawer's Skills panel read-only (ADR 0036). */
  capabilityMutations?: CapabilityMutations | undefined;
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
  /** Absent leaves a focused session's model and tokens as dashes. */
  loadSessionUsage?: (
    sessionId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<SessionUsage>>;
  /** Reads one project's knowledge graph for the overview's Knowledge lens. */
  loadKnowledge?: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<KnowledgeGraph>>;
  /** Lists one directory level under a root for "Scan a folder"; absent hides that menu item. */
  loadProjectDiscovery?: (
    root: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ProjectDiscoveryResult>;
  onRetry: () => void;
  onActivityStateChange?: (state: ActivityState) => void;
  /** Injectable clock, so tests can pin the header clock and every age. */
  now?: () => number;
}) {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [selection, setSelection] = useState<InspectorSelection>();
  const [focus, setFocus] = useState<Focus>(() => focusOfRoute(parseRoute(window.location.hash)));
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string>();
  // The unregister gate (F3): which project the confirm is open for, whether
  // the call is in flight, and the daemon's refusal in its own words.
  const [unregistering, setUnregistering] = useState<string>();
  const [unregisterBusy, setUnregisterBusy] = useState(false);
  const [unregisterError, setUnregisterError] = useState<string>();
  // Leaving the in-place form returns focus to the control that opened it, so
  // a keyboard reader is not dropped on the body behind the drawer.
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && editingProjectId === undefined) editButton.current?.focus();
    wasEditing.current = editingProjectId !== undefined;
  }, [editingProjectId]);
  const filter = useProjectFilter();
  const { view, setView } = useViewChoice();
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
  const mainRegion = useRef<HTMLElement>(null);

  /*
   * One clock for the header and every age on the overview. A second is the
   * comps' cadence; the model is cheap enough to rebuild at it.
   */
  const [nowMs, setNowMs] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(now()), 1000);
    return () => clearInterval(timer);
  }, [now]);

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
   * Released, the realtime switch holds the events the overview was showing
   * at that moment while the store keeps accepting and counting. Resuming
   * drops the hold.
   */
  const [heldEvents, setHeldEvents] = useState<DashboardEvent[]>();
  useEffect(() => {
    if (following) setHeldEvents(undefined);
    else setHeldEvents((current) => current ?? displayedActivity.events);
  }, [following, displayedActivity.events]);
  /*
   * The owner's project filter: the overview shows the projects switched on,
   * with quiet ones optionally dropped. The full snapshot still feeds the
   * header, the palette and every detail route; only the overview narrows.
   */
  const activeProjectIds = useMemo(
    () => new Set(snapshot.activeSessions.map((session) => session.projectId)),
    [snapshot.activeSessions],
  );
  const visibleIds = useMemo(
    () =>
      visibleProjectIds(
        filter,
        snapshot.projects.map((project) => ({
          id: project.id,
          active: activeProjectIds.has(project.id),
        })),
      ),
    [filter, snapshot.projects, activeProjectIds],
  );
  const visibleSnapshot = useMemo(
    () => scopePulseSnapshotToProjects(snapshot, visibleIds),
    [snapshot, visibleIds],
  );
  const hiddenProjects = snapshot.projects.length - visibleSnapshot.projects.length;
  const retainedEvents = heldEvents ?? displayedActivity.events;
  const overviewEvents = useMemo(
    () =>
      visibleIds === undefined
        ? retainedEvents
        : retainedEvents.filter(
            (event) => event.projectId === undefined || visibleIds.has(event.projectId),
          ),
    [retainedEvents, visibleIds],
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
      setRegistering(false);
      setEditingProjectId(undefined);
      const next = parseRoute(window.location.hash);
      setRoute(next);
      // A typed or followed `#/pulse/<id>` asks for that project; a bare
      // `#/pulse` is the whole runtime.
      if (next.name === 'pulse') setFocus(focusOfRoute(next));
    };
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);

  /*
   * The focused project rides in the hash so a reload, a link and the back
   * link from a detail route all return to it. Written with `replaceState`:
   * a click is not a history entry, and no `hashchange` fires, so a session
   * focus is not flattened to its project the moment it is set.
   */
  const projectOfFocus = (next: Focus): string | undefined =>
    next.kind === 'project'
      ? next.id
      : next.kind === 'session'
        ? snapshot.sessions.find((session) => session.id === next.id)?.projectId
        : undefined;
  const hrefOfFocus = (next: Focus): string => {
    const projectId = projectOfFocus(next);
    return routeHref({ name: 'pulse', ...(projectId === undefined ? {} : { projectId }) });
  };
  const changeFocus = (next: Focus) => {
    setFocus(next);
    const href = hrefOfFocus(next);
    if (window.location.hash !== href) window.history.replaceState(window.history.state, '', href);
  };

  const realtime = realtimeFace(websocketState, following, displayedActivity.pendingCount);
  // An open tab never learns that a newer build is being served; this does.
  const staleBuild = useBuildWatch();
  const snapshotTag =
    freshness === 'refreshing'
      ? { word: 'REFRESHING', title: 'Refreshing snapshot' }
      : freshness === 'stale'
        ? { word: 'STALE', title: `Stale: ${staleResources.join(', ')}` }
        : freshness === 'unavailable'
          ? { word: 'UNAVAILABLE', title: 'Snapshot unavailable' }
          : snapshot.partial
            ? { word: 'PARTIAL', title: 'Partial snapshot' }
            : undefined;

  const menuProjects = [...snapshot.projects].sort(
    (left, right) => Number(activeProjectIds.has(right.id)) - Number(activeProjectIds.has(left.id)),
  );
  const allIds = snapshot.projects.map((project) => project.id);
  const projectBadge = (projectId: string) =>
    sessionBadge(
      snapshot.activeSessions
        .filter((session) => session.projectId === projectId)
        .map(
          (session) =>
            ({ tone: toneOf(session.status) }) as Parameters<typeof sessionBadge>[0][number],
        ),
    ).label;

  const openInspector = (next: InspectorSelection) => setSelection(next);
  const closeInspector = () => setSelection(undefined);

  /*
   * The project detail drawer is addressed by the hash from both the overview
   * (`#/pulse/<id>/detail`, the overview stays underneath) and the registry
   * (`#/projects/<id>`), so the scoped reads load for either and a reload
   * reopens it. Closing returns to wherever it was opened from.
   */
  const detail =
    route.name === 'projects' && route.projectId !== undefined
      ? { origin: 'projects' as const, projectId: route.projectId, agentId: route.agentId }
      : route.name === 'pulse' && route.projectId !== undefined && route.detail !== undefined
        ? { origin: 'pulse' as const, projectId: route.projectId, agentId: route.detail.agentId }
        : undefined;
  const detailProject =
    detail === undefined
      ? undefined
      : snapshot.projects.find((project) => project.id === detail.projectId);
  const detailHref = (agentId: string | undefined): string =>
    detail === undefined
      ? routeHref({ name: 'pulse' })
      : detail.origin === 'projects'
        ? routeHref({
            name: 'projects',
            projectId: detail.projectId,
            ...(agentId === undefined ? {} : { agentId }),
          })
        : routeHref({
            name: 'pulse',
            projectId: detail.projectId,
            detail: agentId === undefined ? {} : { agentId },
          });

  // Every detail route is a drawer over the always-mounted overview (the
  // owner's single-overview direction): the overview never unmounts, the hash
  // still names the drawer for a deep link and a reload, and closing returns
  // to the focus. A project's own detail (`#/projects/<id>`) is the project
  // drawer above, which takes precedence in the chain below.
  const routeDrawer = route.name === 'pulse' ? undefined : route.name;

  /** The view a folded route renders inside its drawer. */
  const foldedRouteView = (name: Exclude<DashboardRouteName, 'pulse'>) => {
    switch (name) {
      case 'runtime':
        return (
          <RuntimeView
            snapshot={snapshot}
            websocketState={websocketState}
            {...(loadResources === undefined ? {} : { loadResources })}
          />
        );
      case 'activity':
        return (
          <ActivityView
            state={displayedActivity}
            available={snapshot.activityState === 'ready'}
            onStateChange={onActivityStateChange ?? (() => undefined)}
            onOpenEvent={(event) => openInspector({ kind: 'event', streamId: event.streamId })}
          />
        );
      case 'usage':
        return <UsageView snapshot={snapshot} />;
      case 'agents':
        return <AgentsView snapshot={snapshot} />;
      case 'context':
        return (
          <ContextView
            snapshot={snapshot}
            loading={intelligenceLoading}
            sources={
              intelligenceResources.sources?.state === 'ready'
                ? intelligenceResources.sources.data
                : undefined
            }
          />
        );
      case 'optimization':
        return (
          <OptimizationView
            snapshot={snapshot}
            loading={intelligenceLoading}
            proposals={
              intelligenceResources.proposals?.state === 'ready'
                ? intelligenceResources.proposals.data
                : undefined
            }
          />
        );
      case 'graph':
        return (
          <GraphView
            summary={intelligenceResources.graph}
            loading={intelligenceLoading}
            seeds={graphSeeds}
            {...(loadSubgraph === undefined ? {} : { loadSubgraph })}
          />
        );
      case 'sessions':
        return (
          <SessionsView
            snapshot={snapshot}
            {...(messageMutations === undefined ? {} : { messageMutations })}
            onMessageCreated={(correlationId) => {
              window.location.hash = routeHref({ name: 'messages', correlationId });
            }}
            {...(coordinatorMutations === undefined ? {} : { coordinatorMutations })}
            {...(onCoordinatorMutated === undefined ? {} : { onCoordinatorMutated })}
            onOpenSession={(session) => openInspector({ kind: 'session', sessionId: session.id })}
          />
        );
      case 'messages':
        return (
          <MessagesView
            messages={messageResources.messages}
            loading={messagesLoading}
            onCloseRoutedDetail={() => {
              window.location.hash = routeHref({ name: 'messages' });
            }}
            {...(route.name === 'messages' && route.correlationId !== undefined
              ? { selectedCorrelationId: route.correlationId }
              : {})}
          />
        );
      case 'capabilities':
        return (
          <CapabilitiesView
            capabilities={capabilityCatalogResources.capabilities}
            profiles={capabilityCatalogResources.profiles}
            loading={capabilityCatalogLoading}
          />
        );
      case 'config':
        return (
          <ConfigView
            drifts={configResources.drifts}
            plans={configResources.plans}
            snapshots={configResources.snapshots}
            agents={configResources.agents}
            loading={configLoading}
            {...(configMutations === undefined ? {} : { mutations: configMutations })}
            {...(onConfigMutated === undefined ? {} : { onMutated: onConfigMutated })}
          />
        );
      case 'projects':
        // The registry only: a selected project is the project drawer, which
        // the hash addresses as `#/projects/<id>`.
        return (
          <ProjectsView
            snapshot={snapshot}
            resources={projectResources}
            scopeLoading={projectScopeLoading}
            agentPairResources={agentPairResources}
            agentPairLoading={agentPairLoading}
            leaseResources={leaseResources}
            renderDetailInline={false}
            onSelectProject={(projectId) => {
              window.location.hash = routeHref({ name: 'projects', projectId });
            }}
          />
        );
    }
  };

  return (
    <div className="app-shell">
      {/*
       * The href keeps the link meaningful without JavaScript, but the click is
       * handled here: `#main-content` is not a route, so letting it reach the
       * hash would send `parseRoute` to its overview fallback.
       */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRegion.current?.focus();
        }}
      >
        Skip to overview
      </a>

      <header className="topbar">
        <a
          className="topbar__identity"
          href={routeHref({ name: 'pulse' })}
          aria-label="Luwi Runtime overview"
        >
          <span className="identity__mark">
            <BrandMark size={24} />
          </span>
          <span className="topbar__name">Luwi Runtime</span>
        </a>
        {/* One switch for the whole console: pressed follows the feed, released
            holds it and counts what arrives. Its word follows the socket; the
            clock is wall time. */}
        <button
          type="button"
          className={`live live--${realtime.tone}`}
          aria-pressed={following}
          aria-label={realtime.label}
          title={
            following
              ? `${realtime.label} — pause the realtime feed; new events are counted until you resume`
              : 'Resume the realtime feed'
          }
          onClick={() => setFollowing(!following)}
        >
          <span className="live__dot" aria-hidden="true" />
          <span aria-hidden="true">
            {realtime.word}
            {!following && displayedActivity.pendingCount > 0
              ? ` · ${String(displayedActivity.pendingCount)} NEW`
              : ''}
            {' · '}
            {formatClock(nowMs)}
          </span>
        </button>
        {snapshotTag === undefined ? null : (
          <button
            type="button"
            className="snapshot-tag"
            aria-label="Retry snapshot"
            title={`${snapshotTag.title} — retry`}
            onClick={onRetry}
          >
            {snapshotTag.word}
          </button>
        )}
        {staleBuild ? (
          <button
            type="button"
            className="snapshot-tag"
            aria-label="Reload to the newer dashboard build"
            title="The daemon serves a newer dashboard build than this tab loaded — reload to get it"
            onClick={() => window.location.reload()}
          >
            NEW BUILD · RELOAD
          </button>
        ) : null}
        {invalidEventCount > 0 ? (
          <span className="sr-only" role="status">
            {invalidEventCount} invalid realtime messages ignored
          </span>
        ) : null}

        <span className="topbar__spacer" />

        <div className="menu">
          <button
            type="button"
            className="menu__trigger"
            aria-label="Project scope"
            aria-haspopup="true"
            aria-expanded={projectMenuOpen}
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            <span className="menu__eyebrow">PROJECTS</span>
            <span className="menu__value">
              {hiddenProjects === 0
                ? 'All projects'
                : `${String(visibleSnapshot.projects.length)} of ${String(snapshot.projects.length)}`}
            </span>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <Popover
            open={projectMenuOpen}
            onClose={() => setProjectMenuOpen(false)}
            className="menu__list"
          >
            <div role="group" aria-label="Projects">
              <button
                type="button"
                className="menu__item menu__item--switch"
                aria-pressed={filter.hideQuiet}
                onClick={() => filter.setHideQuiet(!filter.hideQuiet)}
              >
                <span className="menu__label">Hide quiet projects</span>
                <span className="switch" aria-hidden="true">
                  <span className="switch__knob" />
                </span>
              </button>
              <button
                type="button"
                className="menu__item"
                aria-pressed={filter.hidden.size === 0}
                aria-label="All projects"
                onClick={() => filter.showAll()}
              >
                <span className="menu__glyph">ALL</span>
                <span className="menu__label">All projects</span>
                <span className="menu__hint">
                  {snapshot.projectCount.state === 'unavailable'
                    ? 'UNAVAILABLE'
                    : `${String(snapshot.projectCount.value)} REGISTERED`}
                </span>
              </button>
              <div className="menu__divider" role="separator" />
              {menuProjects.map((project) => {
                const on = !filter.hidden.has(project.id);
                const quietHidden = filter.hideQuiet && !activeProjectIds.has(project.id);
                return (
                  <div
                    key={project.id}
                    className={`menu__row${on ? '' : ' menu__row--off'}${quietHidden ? ' menu__row--quiet' : ''}`}
                  >
                    <button
                      type="button"
                      className="menu__item menu__item--switch"
                      aria-pressed={on}
                      aria-label={`Show ${project.name}`}
                      title={
                        quietHidden ? 'Quiet: hidden while quiet projects are hidden' : undefined
                      }
                      onClick={() => filter.toggle(project.id)}
                    >
                      <span className="menu__glyph">{monogramInitials(project.name)}</span>
                      <span className="menu__label">{project.name}</span>
                      <span className="menu__hint">{projectBadge(project.id)}</span>
                      <span className="switch" aria-hidden="true">
                        <span className="switch__knob" />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="menu__only"
                      aria-label={`Show only ${project.name}`}
                      onClick={() => filter.only(project.id, allIds)}
                    >
                      only
                    </button>
                  </div>
                );
              })}
              {projectMutations === undefined ? null : (
                <>
                  <div className="menu__divider" role="separator" />
                  <button
                    type="button"
                    className="menu__item"
                    onClick={() => {
                      setProjectMenuOpen(false);
                      setRegistering(true);
                    }}
                  >
                    <span className="menu__glyph">+</span>
                    <span className="menu__label">Register a project</span>
                  </button>
                  {loadProjectDiscovery === undefined ? null : (
                    <button
                      type="button"
                      className="menu__item"
                      onClick={() => {
                        setProjectMenuOpen(false);
                        setDiscovering(true);
                      }}
                    >
                      <span className="menu__glyph">/</span>
                      <span className="menu__label">Scan a folder…</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </Popover>
        </div>
        <div className="segmented segmented--mono" role="group" aria-label="View">
          {VIEW_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              className="segmented__option"
              aria-pressed={view === choice}
              onClick={() => setView(choice)}
            >
              {VIEW_LABELS[choice]}
            </button>
          ))}
        </div>

        <div className="segmented segmented--icons" role="group" aria-label="Theme">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.choice}
              type="button"
              className="segmented__option"
              aria-pressed={themeChoice === option.choice}
              aria-label={option.label}
              title={option.title}
              onClick={() => setThemeChoice(option.choice)}
            >
              <ThemeGlyph choice={option.choice} />
            </button>
          ))}
        </div>
      </header>

      {/* `tabIndex={-1}` makes the region focusable by the skip link without
          adding a tab stop of its own. */}
      <main id="main-content" className="page" ref={mainRegion} tabIndex={-1}>
        <Overview
          snapshot={visibleSnapshot}
          events={overviewEvents}
          hiddenProjects={hiddenProjects}
          nowMs={nowMs}
          view={view}
          focus={focus}
          following={following}
          pendingCount={displayedActivity.pendingCount}
          realtime={realtime.word.toLowerCase()}
          {...(messageResources.messages?.state === 'ready'
            ? { messages: messageResources.messages.data.items }
            : {})}
          messagesUnavailable={messageResources.messages?.state === 'unavailable'}
          onFocus={changeFocus}
          onInspect={openInspector}
          {...(loadSessionUsage === undefined ? {} : { loadSessionUsage })}
          {...(loadKnowledge === undefined ? {} : { loadKnowledge })}
          {...(coordinatorMutations === undefined ? {} : { coordinatorMutations })}
          {...(onCoordinatorMutated === undefined ? {} : { onCoordinatorMutated })}
        />
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
      ) : registering && projectMutations !== undefined ? (
        <DetailDrawer
          eyebrow="Projects"
          title="Register a project"
          onClose={() => setRegistering(false)}
        >
          <ProjectForm
            mode={{ kind: 'register' }}
            mutations={projectMutations}
            onCancel={() => setRegistering(false)}
            onSuccess={(project) => {
              setRegistering(false);
              onProjectMutated?.();
              // A project just registered is what the reader wants to look at next.
              changeFocus({ kind: 'project', id: project.id });
            }}
          />
        </DetailDrawer>
      ) : discovering && projectMutations !== undefined && loadProjectDiscovery !== undefined ? (
        <DetailDrawer
          eyebrow="Projects"
          title="Scan a folder"
          onClose={() => setDiscovering(false)}
        >
          <ProjectDiscoveryPanel
            load={loadProjectDiscovery}
            mutations={projectMutations}
            onCancel={() => setDiscovering(false)}
            onRegistered={(ids) => {
              if (ids.length === 0) return;
              onProjectMutated?.();
              // The panel stays open so each row's outcome is readable; the
              // focus follows the first project just registered.
              const first = ids[0];
              if (first !== undefined) changeFocus({ kind: 'project', id: first });
            }}
          />
        </DetailDrawer>
      ) : detail !== undefined ? (
        <DetailDrawer
          key={detail.projectId}
          eyebrow="Scoped evidence"
          title="Project detail"
          meta={detailProject?.name ?? detail.projectId}
          onClose={() => {
            window.location.hash =
              detail.origin === 'projects'
                ? routeHref({ name: 'projects' })
                : routeHref({ name: 'pulse', projectId: detail.projectId });
          }}
        >
          {projectMutations === undefined ||
          detailProject === undefined ? null : editingProjectId === detail.projectId ? (
            <ProjectForm
              mode={{ kind: 'edit', project: detailProject }}
              mutations={projectMutations}
              onCancel={() => setEditingProjectId(undefined)}
              onSuccess={() => {
                setEditingProjectId(undefined);
                onProjectMutated?.();
              }}
            />
          ) : (
            <p className="project-edit">
              <button
                ref={editButton}
                type="button"
                className="row-action"
                aria-label={`Edit project ${detailProject.name}`}
                onClick={() => setEditingProjectId(detail.projectId)}
              >
                Edit
              </button>
              <button
                type="button"
                className="row-action"
                aria-label={`Unregister project ${detailProject.name}`}
                onClick={() => {
                  setUnregisterError(undefined);
                  setUnregistering(detail.projectId);
                }}
              >
                Unregister…
              </button>
            </p>
          )}
          {projectMutations === undefined ||
          detailProject === undefined ||
          unregistering !== detail.projectId ? null : (
            <ConfirmDialog
              title="Unregister project"
              confirmLabel="Unregister"
              busy={unregisterBusy}
              onCancel={() => setUnregistering(undefined)}
              onConfirm={() => {
                void (async () => {
                  setUnregisterBusy(true);
                  setUnregisterError(undefined);
                  const result = await projectMutations.remove(detail.projectId);
                  setUnregisterBusy(false);
                  if (result.state === 'ok') {
                    setUnregistering(undefined);
                    onProjectMutated?.();
                    changeFocus(RUNTIME_FOCUS);
                    window.location.hash = routeHref({ name: 'projects' });
                    return;
                  }
                  // The daemon names what blocks it; the scalar details ride along.
                  const details =
                    result.reason === 'http' && result.details !== undefined
                      ? ` (${Object.entries(result.details)
                          .map(([key, value]) => `${key}: ${String(value)}`)
                          .join(', ')})`
                      : '';
                  setUnregisterError(
                    result.reason === 'http' || result.reason === 'input'
                      ? `${result.message}${details}`
                      : result.reason === 'transport'
                        ? 'The daemon could not be reached. Check runtime status and try again.'
                        : 'The daemon returned an invalid response. The project was not unregistered.',
                  );
                })();
              }}
            >
              <p>
                LUWI forgets <strong>{detailProject.name}</strong> and the evidence it collected —
                sessions, leases, messages, usage, git observations, packages, findings. Nothing on
                disk changes: the project's files and its <code>.luwi</code> directory stay exactly
                as they are. The daemon refuses while a live session, a held lease, a live
                coordinator or a message in flight still points at the project.
              </p>
              {unregisterError === undefined ? null : (
                <p className="outcome outcome--bad" role="alert">
                  {unregisterError}
                </p>
              )}
            </ConfirmDialog>
          )}
          <ProjectDetail
            snapshot={snapshot}
            selectedProjectId={detail.projectId}
            {...(detail.agentId === undefined ? {} : { selectedAgentId: detail.agentId })}
            resources={projectResources}
            scopeLoading={projectScopeLoading}
            agentPairResources={agentPairResources}
            agentPairLoading={agentPairLoading}
            leaseResources={leaseResources}
            {...(projectMutations === undefined ? {} : { projectMutations })}
            {...(capabilityMutations === undefined ? {} : { capabilityMutations })}
            {...(onProjectMutated === undefined ? {} : { onMutated: onProjectMutated })}
            onSelectAgent={(agentId) => {
              window.location.hash = detailHref(agentId);
            }}
          />
        </DetailDrawer>
      ) : routeDrawer !== undefined ? (
        <DetailDrawer
          eyebrow={routeTitles[routeDrawer].eyebrow}
          title={routeTitles[routeDrawer].heading}
          wide={WIDE_DRAWER_ROUTES.has(routeDrawer)}
          onClose={() => {
            window.location.hash = hrefOfFocus(focus);
          }}
        >
          {foldedRouteView(routeDrawer)}
        </DetailDrawer>
      ) : null}
    </div>
  );
}
