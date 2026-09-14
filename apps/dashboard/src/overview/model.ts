import {
  abbreviateId,
  abbreviateSha,
  formatRelativeTime,
  monogramInitials,
} from '../components/format.js';
import type { SessionUsage } from '../api/session-usage.js';
import type { ResourceState } from '../components/panel.js';
import type { CountValue, PulseSnapshot, SessionContextEvidence } from '../pulse/model.js';
import { bucketRetainedWindow, type RetainedBounds } from '../pulse/retained-window.js';
import { compareStreamIds } from '../realtime/activity-store.js';
import type { DashboardEvent } from '../realtime/schema.js';

/**
 * The overview model: every derivation the four views and the drill-down
 * render, computed once from the Pulse snapshot and the retained activity.
 *
 * It is pure so the honesty rules can be tested without a DOM. The rules it
 * carries are the spec's replacement table: no release readiness, no lifecycle
 * stage, no "running" status, no token total summed across grades, no 7-day
 * trend the runtime never observed. Where the comps drew a number this runtime
 * cannot know, the model says so — `—` and a word, never a zero.
 */

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

/**
 * An animation and border tone, not a status. Labels stay verbatim; the tone
 * only decides whether a dot pulses, blinks or sits still.
 */
export type Tone = 'working' | 'waiting' | 'blocked' | 'quiet' | 'done';

export function toneOf(status: string): Tone {
  if (status === 'thinking' || status === 'tool_running') return 'working';
  if (status === 'blocked') return 'blocked';
  if (status === 'starting' || status.startsWith('waiting')) return 'waiting';
  if (status === 'completed' || status === 'disconnected') return 'done';
  return 'quiet';
}

/** The vocabulary order the breakdown and the Flow status column read in. */
const STATUS_ORDER = [
  'starting',
  'idle',
  'thinking',
  'tool_running',
  'waiting_for_input',
  'waiting_for_agent',
  'blocked',
  'completed',
  'disconnected',
] as const;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0');

export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatHourMinute(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unavailable';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${String(minutes)}m`;
  const days = Math.floor(hours / 24);
  if (days < 1) return `${String(hours)}h ${pad2(minutes % 60)}m`;
  return `${String(days)}d ${pad2(hours % 24)}h`;
}

export function formatUptime(ms: number): string {
  return formatDuration(ms);
}

export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
  return String(total);
}

function countText(count: CountValue): string {
  return count.state === 'unavailable' ? '—' : String(count.value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Sessions, projects, agents, statuses
// ---------------------------------------------------------------------------

export type OverviewSession = {
  id: string;
  agentId: string;
  agentName: string;
  agentKnown: boolean;
  initials: string;
  projectId: string;
  projectName: string;
  status: string;
  statusLabel: string;
  tone: Tone;
  active: boolean;
  startedAt: string;
  lastHeartbeatAt: string;
  startedMs?: number;
  heartbeatMs?: number;
  branch?: string;
  taskSummary?: string;
  model?: string;
  /** The native GUI chat title (Claude Code desktop), when the attach reported one. */
  title?: string;
  context: SessionContextEvidence;
  eventCount: number;
};

/** A badge derived from sessions only; blocked outranks a count. */
export type Badge = { label: string; tone: 'ink' | 'outline' | 'dim' };

export function sessionBadge(sessions: readonly OverviewSession[]): Badge {
  const blocked = sessions.filter((session) => session.tone === 'blocked').length;
  if (blocked > 0) return { label: `${String(blocked)} BLOCKED`, tone: 'ink' };
  if (sessions.length > 0) return { label: `${String(sessions.length)} ACTIVE`, tone: 'outline' };
  return { label: 'QUIET', tone: 'dim' };
}

type GitState = PulseSnapshot['repositoryFacts'][number]['git'];

export type OverviewProject = {
  id: string;
  name: string;
  initials: string;
  localPath: string;
  /** Active sessions — online and not terminal. */
  sessions: OverviewSession[];
  /** Every observed session, newest first. */
  allSessions: OverviewSession[];
  badge: Badge;
  /** The branch the Git observation reported, or the reason there is none. */
  eyebrow: string;
  git: GitState;
  eventCount: number;
  buckets: number[];
  working: boolean;
  blocked: boolean;
};

export type OverviewAgent = {
  id: string;
  name: string;
  initials: string;
  known: boolean;
  sessions: OverviewSession[];
  projectCount: number;
  working: number;
  waiting: number;
  blocked: number;
  models: string[];
  eventCount: number;
  buckets: number[];
};

export type StatusNode = { status: string; label: string; tone: Tone; sessions: OverviewSession[] };

export type Rate = {
  /** Undefined until the retained span covers at least a minute. */
  perMinute?: number;
  label: string;
  spanLabel?: string;
  buckets: number[];
  total: number;
  /** The newest bucket against the busiest one, for the ring gauges. */
  latestShare: number;
  firstMs?: number;
  lastMs?: number;
};

export type Stat = {
  key: string;
  label: string;
  value: string;
  sub: string;
  unavailable: boolean;
  fraction: number;
  bars?: number[];
};

export type TickerRow = {
  key: string;
  time: string;
  type: string;
  detail: string;
  project: string;
};

export type Health = {
  label: 'HEALTHY' | 'DEGRADED' | 'OFFLINE';
  daemon: string;
  /** Absent when the daemon gave no answer — a Redis verdict needs one behind it. */
  redis?: string;
  uptime?: string;
  latency?: string;
  version?: string;
};

export type Overview = {
  nowMs: number;
  projects: OverviewProject[];
  agents: OverviewAgent[];
  statuses: StatusNode[];
  /** Active sessions, newest first. */
  sessions: OverviewSession[];
  allSessions: OverviewSession[];
  rate: Rate;
  stats: Stat[];
  ticker: TickerRow[];
  health: Health;
  projectsState: 'ready' | 'unavailable';
  sessionsState: 'ready' | 'unavailable';
  activityState: 'ready' | 'unavailable';
  gitTruncated: boolean;
  /** Registered projects the owner's filter keeps off the overview. */
  hiddenProjects: number;
  bounds?: RetainedBounds;
  events: DashboardEvent[];
};

/** The empty state for a lens with no project to draw: the filter, or a real empty registry. */
export function emptyProjectsLabel(overview: Overview): string {
  const hidden = overview.hiddenProjects;
  return hidden > 0
    ? `${String(hidden)} project${hidden === 1 ? '' : 's'} hidden by the filter`
    : 'No registered projects';
}

const RATE_BUCKETS = 30;
const TREND_BUCKETS = 7;
const TICKER_ROWS = 4;

function parseMs(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bucketsFor(
  events: readonly DashboardEvent[],
  count: number,
  bounds: RetainedBounds | undefined,
): number[] {
  if (events.length === 0) return [];
  return bucketRetainedWindow(events, count, bounds).buckets;
}

function rateOf(events: readonly DashboardEvent[]): Rate {
  const window = bucketRetainedWindow(events, RATE_BUCKETS);
  const max = window.buckets.reduce((high, value) => Math.max(high, value), 0);
  const last = window.buckets.at(-1) ?? 0;
  const base = {
    buckets: window.buckets,
    total: window.total,
    latestShare: max === 0 ? 0 : last / max,
  };
  if (window.total === 0) return { ...base, label: '—' };
  const firstMs = Date.parse(window.firstAt ?? '');
  const lastMs = Date.parse(window.lastAt ?? '');
  const span = window.spanLabel === undefined ? {} : { spanLabel: window.spanLabel };
  const stamps = Number.isFinite(firstMs) && Number.isFinite(lastMs) ? { firstMs, lastMs } : {};
  if (window.spanMs < 60_000) {
    return {
      ...base,
      ...span,
      ...stamps,
      label: `${String(window.total)} in ${window.spanLabel ?? 'a moment'}`,
    };
  }
  const perMinute = window.total / (window.spanMs / 60_000);
  return {
    ...base,
    ...span,
    ...stamps,
    perMinute,
    label: perMinute >= 10 ? String(Math.round(perMinute)) : perMinute.toFixed(1),
  };
}

/** The first present payload string that tells a reader what the event touched. */
export function eventDetail(event: DashboardEvent): string {
  for (const key of ['path', 'subject', 'status', 'reason', 'branch', 'headSha', 'kind', 'name']) {
    const value = stringField(event.payload, key);
    if (value !== undefined) return key === 'headSha' ? abbreviateSha(value) : value;
  }
  if (event.sessionId !== undefined) return abbreviateId(event.sessionId);
  return '';
}

function healthOf(snapshot: PulseSnapshot): Health {
  if (snapshot.health.state !== 'ready') return { label: 'OFFLINE', daemon: 'Daemon offline' };
  const health = snapshot.health.data;
  const version =
    snapshot.runtime.state === 'ready' ? { version: snapshot.runtime.data.version } : {};
  const latency = health.redis.connected ? { latency: `${String(health.redis.latencyMs)} ms` } : {};
  return {
    label: health.status === 'ok' ? 'HEALTHY' : 'DEGRADED',
    daemon: health.status === 'ok' ? 'Daemon online' : 'Daemon degraded',
    redis: health.redis.connected
      ? `Redis connected · ${String(health.redis.latencyMs)} ms`
      : 'Redis disconnected',
    uptime: formatUptime(health.uptimeMs),
    ...latency,
    ...version,
  };
}

export function buildOverview(
  snapshot: PulseSnapshot,
  retained: readonly DashboardEvent[],
  nowMs: number,
  hiddenProjects = 0,
): Overview {
  const events = [...retained].sort((left, right) =>
    compareStreamIds(left.streamId, right.streamId),
  );
  const eventsBySession = new Map<string, DashboardEvent[]>();
  const eventsByProject = new Map<string, DashboardEvent[]>();
  const eventsByAgent = new Map<string, DashboardEvent[]>();
  const push = (
    map: Map<string, DashboardEvent[]>,
    key: string | undefined,
    event: DashboardEvent,
  ) => {
    if (key === undefined) return;
    const bucket = map.get(key);
    if (bucket === undefined) map.set(key, [event]);
    else bucket.push(event);
  };
  for (const event of events) {
    push(eventsBySession, event.sessionId, event);
    push(eventsByProject, event.projectId, event);
    push(eventsByAgent, event.agentId, event);
  }

  const rate = rateOf(events);
  const bounds =
    rate.firstMs !== undefined && rate.lastMs !== undefined
      ? { firstMs: rate.firstMs, lastMs: rate.lastMs }
      : undefined;

  const activeIds = new Set(snapshot.activeSessions.map((session) => session.id));
  const allSessions: OverviewSession[] = snapshot.sessions
    .map((session): OverviewSession => {
      const startedMs = parseMs(session.startedAt);
      const heartbeatMs = parseMs(session.lastHeartbeatAt);
      const model = session.metadata?.['model'];
      const title = session.metadata?.['title'];
      return {
        id: session.id,
        agentId: session.agentId,
        agentName: session.agentName,
        agentKnown: session.agentKnown,
        initials: monogramInitials(session.agentName),
        projectId: session.projectId,
        projectName: session.projectName,
        status: session.status,
        statusLabel: session.statusLabel,
        tone: toneOf(session.status),
        active: activeIds.has(session.id),
        startedAt: session.startedAt,
        lastHeartbeatAt: session.lastHeartbeatAt,
        ...(startedMs === undefined ? {} : { startedMs }),
        ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
        ...(session.branch === undefined ? {} : { branch: session.branch }),
        ...(session.taskSummary === undefined ? {} : { taskSummary: session.taskSummary }),
        ...(typeof model === 'string' ? { model } : {}),
        ...(typeof title === 'string' && title.trim() !== '' ? { title } : {}),
        context: session.context,
        eventCount: eventsBySession.get(session.id)?.length ?? 0,
      };
    })
    .sort((left, right) => (right.startedMs ?? 0) - (left.startedMs ?? 0));
  const sessions = allSessions.filter((session) => session.active);

  const gitByProject = new Map(snapshot.repositoryFacts.map((row) => [row.projectId, row.git]));
  const projects: OverviewProject[] = snapshot.projects.map((project) => {
    const own = sessions.filter((session) => session.projectId === project.id);
    const git = gitByProject.get(project.id) ?? { state: 'unavailable' as const };
    const projectEvents = eventsByProject.get(project.id) ?? [];
    return {
      id: project.id,
      name: project.name,
      initials: monogramInitials(project.name),
      localPath: project.localPath,
      sessions: own,
      allSessions: allSessions.filter((session) => session.projectId === project.id),
      badge: sessionBadge(own),
      eyebrow:
        git.state === 'ready'
          ? (git.data.branch ?? 'detached').toUpperCase()
          : git.state === 'not-observed'
            ? 'NOT OBSERVED'
            : 'GIT UNAVAILABLE',
      git,
      eventCount: projectEvents.length,
      buckets: bucketsFor(projectEvents, TREND_BUCKETS, bounds),
      working: own.some((session) => session.tone === 'working'),
      blocked: own.some((session) => session.tone === 'blocked'),
    };
  });
  // Active projects first, in every lens: blocked, then the busiest, then the
  // quiet ones in name order.
  projects.sort(
    (left, right) =>
      Number(right.blocked) - Number(left.blocked) ||
      right.sessions.length - left.sessions.length ||
      left.name.localeCompare(right.name),
  );

  const agents: OverviewAgent[] = [...new Set(sessions.map((session) => session.agentId))]
    .map((agentId) => {
      const own = sessions.filter((session) => session.agentId === agentId);
      const first = own[0];
      const agentEvents = eventsByAgent.get(agentId) ?? [];
      return {
        id: agentId,
        name: first?.agentName ?? agentId,
        initials: monogramInitials(first?.agentName ?? agentId),
        known: first?.agentKnown ?? false,
        sessions: own,
        projectCount: new Set(own.map((session) => session.projectId)).size,
        working: own.filter((session) => session.tone === 'working').length,
        waiting: own.filter((session) => session.tone === 'waiting').length,
        blocked: own.filter((session) => session.tone === 'blocked').length,
        models: [
          ...new Set(
            own.flatMap((session) => (session.model === undefined ? [] : [session.model])),
          ),
        ].sort(),
        eventCount: agentEvents.length,
        buckets: bucketsFor(agentEvents, TREND_BUCKETS, bounds),
      };
    })
    .sort(
      (left, right) =>
        right.sessions.length - left.sessions.length || left.name.localeCompare(right.name),
    );

  const present = new Set(sessions.map((session) => session.status));
  const statuses: StatusNode[] = [
    ...STATUS_ORDER.filter((status) => present.has(status)),
    ...[...present]
      .filter((status) => !STATUS_ORDER.includes(status as (typeof STATUS_ORDER)[number]))
      .sort(),
  ].map((status) => ({
    status,
    label: sessions.find((session) => session.status === status)?.statusLabel ?? status,
    tone: toneOf(status),
    sessions: sessions.filter((session) => session.status === status),
  }));

  const ticker: TickerRow[] = events
    .slice(-TICKER_ROWS)
    .reverse()
    .map((event) => {
      const at = parseMs(event.occurredAt);
      return {
        key: event.streamId,
        time: at === undefined ? '--:--:--' : formatClock(at),
        type: event.type,
        detail: eventDetail(event),
        project:
          event.projectId === undefined
            ? 'runtime'
            : (projects.find((project) => project.id === event.projectId)?.name ??
              abbreviateId(event.projectId)),
      };
    });

  return {
    nowMs,
    projects,
    agents,
    statuses,
    sessions,
    allSessions,
    rate,
    stats: statsOf(snapshot, projects, rate),
    ticker,
    health: healthOf(snapshot),
    projectsState: snapshot.projectCount.state === 'unavailable' ? 'unavailable' : 'ready',
    sessionsState: snapshot.sessionsState,
    activityState: snapshot.activityState,
    gitTruncated: snapshot.gitTruncated,
    hiddenProjects,
    ...(bounds === undefined ? {} : { bounds }),
    events,
  };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function statsOf(snapshot: PulseSnapshot, projects: OverviewProject[], rate: Rate): Stat[] {
  const sessionsUnavailable = snapshot.activeSessionCount.state === 'unavailable';
  const active =
    snapshot.activeSessionCount.state === 'unavailable' ? 0 : snapshot.activeSessionCount.value;
  const breakdown = [...snapshot.statusBreakdown]
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map((entry) => `${String(entry.count)} ${entry.label}`)
    .join(' · ');
  const working = snapshot.statusBreakdown
    .filter((entry) => toneOf(entry.status) === 'working')
    .reduce((sum, entry) => sum + entry.count, 0);

  const projectsUnavailable = snapshot.projectCount.state === 'unavailable';
  const withSessions = projects.filter((project) => project.sessions.length > 0).length;
  const blockedProjects = projects.filter((project) => project.blocked).length;

  const usageRows = snapshot.usage;
  const best = usageRows.find((row) => row.totalTokens !== undefined);
  const others = usageRows
    .filter((row) => row !== best && row.totalTokens !== undefined)
    .map((row) => `${row.label.toLowerCase()} ${formatTokens(row.totalTokens ?? 0)}`);
  const usageUnavailable = snapshot.usageState === 'unavailable';

  const contextUnavailable = snapshot.contextState === 'unavailable';
  const { loaded, invoked } = snapshot.context;

  return [
    {
      key: 'sessions',
      label: 'Sessions',
      value: countText(snapshot.activeSessionCount),
      sub: sessionsUnavailable
        ? 'sessions unavailable'
        : breakdown === ''
          ? 'no active sessions'
          : breakdown,
      unavailable: sessionsUnavailable,
      fraction: active === 0 ? 0 : working / active,
    },
    {
      key: 'projects',
      label: 'Projects',
      value: countText(snapshot.projectCount),
      sub: projectsUnavailable
        ? 'projects unavailable'
        : `${String(withSessions)} with sessions · ${String(blockedProjects)} blocked`,
      unavailable: projectsUnavailable,
      fraction: projects.length === 0 ? 0 : withSessions / projects.length,
    },
    {
      key: 'events',
      label: 'Events / min',
      value: snapshot.activityState === 'unavailable' ? '—' : rate.label,
      sub:
        snapshot.activityState === 'unavailable'
          ? 'activity unavailable'
          : rate.total === 0
            ? 'no retained events'
            : `${String(rate.total)} retained over ${rate.spanLabel ?? 'a moment'}`,
      unavailable: snapshot.activityState === 'unavailable',
      fraction: rate.latestShare,
      bars: rate.buckets,
    },
    {
      key: 'tokens',
      label: best === undefined ? 'Tokens' : `Tokens · ${best.label.toLowerCase()}`,
      value: usageUnavailable || best === undefined ? '—' : formatTokens(best.totalTokens ?? 0),
      sub: usageUnavailable
        ? 'usage unavailable'
        : best === undefined
          ? 'no token totals reported'
          : others.length === 0
            ? `${String(best.records)} records · one grade`
            : others.join(' · '),
      unavailable: usageUnavailable,
      fraction: best === undefined ? 0 : 1,
    },
    {
      key: 'context',
      label: 'Context loaded',
      value: contextUnavailable ? '—' : String(loaded),
      sub: contextUnavailable
        ? 'context unavailable'
        : `${String(invoked)} invoked · ${String(snapshot.contextInsights.loadedNotInvoked)} loaded, never invoked`,
      unavailable: contextUnavailable,
      fraction: loaded === 0 ? 0 : invoked / loaded,
    },
  ];
}

// ---------------------------------------------------------------------------
// Focus and the drill-down panel
// ---------------------------------------------------------------------------

export type Focus =
  | { kind: 'runtime' }
  | { kind: 'project'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'session'; id: string };

export const RUNTIME_FOCUS: Focus = { kind: 'runtime' };

export function sameFocus(left: Focus, right: Focus): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'runtime' || right.kind === 'runtime' || left.id === right.id;
}

/** A focus whose subject vanished from the snapshot falls back to the runtime. */
export function resolveFocus(overview: Overview, focus: Focus): Focus {
  if (focus.kind === 'runtime') return focus;
  if (focus.kind === 'project')
    return overview.projects.some((project) => project.id === focus.id) ? focus : RUNTIME_FOCUS;
  if (focus.kind === 'agent')
    return overview.agents.some((agent) => agent.id === focus.id) ? focus : RUNTIME_FOCUS;
  return overview.allSessions.some((session) => session.id === focus.id) ? focus : RUNTIME_FOCUS;
}

/** The project a focus belongs to, when it belongs to one. */
export function focusProject(overview: Overview, focus: Focus): OverviewProject | undefined {
  if (focus.kind === 'project') return overview.projects.find((project) => project.id === focus.id);
  if (focus.kind === 'session') {
    const session = overview.allSessions.find((candidate) => candidate.id === focus.id);
    return session === undefined
      ? undefined
      : overview.projects.find((project) => project.id === session.projectId);
  }
  return undefined;
}

/** Whether a session is what the focus is about. Runtime relates to everything. */
export function relatedToFocus(session: OverviewSession, focus: Focus): boolean {
  if (focus.kind === 'runtime') return true;
  if (focus.kind === 'project') return session.projectId === focus.id;
  if (focus.kind === 'agent') return session.agentId === focus.id;
  return session.id === focus.id;
}

export type PanelLink =
  | { kind: 'inspect-project'; label: string; id: string; name: string }
  | { kind: 'inspect-session'; label: string; id: string }
  | { kind: 'route'; label: string; href: string };

export type PanelBlock = { title: string; rows: Array<readonly [string, string]> };

/** The per-session usage read, in the states the drill-down must tell apart. */
export type SessionUsageState = { state: 'loading' } | ResourceState<SessionUsage>;

export type PanelExtras = {
  /** Present only when the shell reads usage on focus; absent leaves the facts as dashes. */
  sessionUsage?: { sessionId: string; state: SessionUsageState };
};

export type PanelModel = {
  eyebrow: string;
  title: string;
  badge: Badge;
  sub: string;
  /**
   * The one identifier the head offers to copy, with the word the control
   * names. The head already names the subject; only its full id is missing.
   */
  copyId?: { label: string; id: string };
  block?: PanelBlock;
  /** `detail` is the fuller sentence behind a fact, shown on hover. */
  facts: Array<{ k: string; v: string; detail?: string }>;
  trend: { label: string; buckets: number[]; from: string; to: string };
  list: { label: string; rows: OverviewSession[]; empty: string; selectedId?: string };
  links: PanelLink[];
};

/**
 * Why a session is blocked, as far as the retained stream can say.
 *
 * Session status carries no reason. The nearest evidence is a `lease.denied`
 * event for that session; when there is none in the retained window the block
 * says exactly that rather than inventing a holder.
 */
export function blockedEvidence(
  session: OverviewSession,
  events: readonly DashboardEvent[],
  nowMs: number,
): PanelBlock {
  const denial = [...events]
    .reverse()
    .find((event) => event.sessionId === session.id && event.type === 'lease.denied');
  const heartbeat = `heartbeat ${formatRelativeTime(session.lastHeartbeatAt, nowMs)}`;
  if (denial === undefined) {
    return {
      title: 'Session reports blocked',
      rows: [
        ['Evidence', 'No lease denial in the retained stream'],
        ['Session', heartbeat],
      ],
    };
  }
  const path = stringField(denial.payload, 'path');
  const reason = stringField(denial.payload, 'reason');
  const leaseId = stringField(denial.payload, 'leaseId');
  return {
    title: path === undefined ? 'Lease denied' : `Lease denied on ${path}`,
    rows: [
      ['Denied', formatRelativeTime(denial.occurredAt, nowMs)],
      ...(reason === undefined ? [] : [['Reason', reason] as const]),
      ...(leaseId === undefined ? [] : [['Lease', abbreviateId(leaseId)] as const]),
      ['Session', heartbeat],
    ],
  };
}

function trendOf(
  label: string,
  events: readonly DashboardEvent[],
  overview: Overview,
): PanelModel['trend'] {
  const buckets = bucketsFor(events, TREND_BUCKETS, overview.bounds);
  const from = overview.bounds === undefined ? '—' : formatHourMinute(overview.bounds.firstMs);
  const to = overview.bounds === undefined ? '—' : formatHourMinute(overview.bounds.lastMs);
  const span = overview.rate.spanLabel === undefined ? '' : ` · ${overview.rate.spanLabel}`;
  return { label: `${label}${span}`, buckets, from, to };
}

function gitFacts(project: OverviewProject): Array<{ k: string; v: string }> {
  if (project.git.state !== 'ready') {
    const word = project.git.state === 'not-observed' ? 'not observed' : 'unavailable';
    return [
      { k: 'HEAD', v: word },
      { k: 'State', v: word },
      { k: 'Tags', v: word },
    ];
  }
  const git = project.git.data;
  return [
    { k: 'HEAD', v: git.headSha === undefined ? '—' : abbreviateSha(git.headSha).slice(0, 7) },
    {
      k: 'State',
      v: git.clean ? 'clean' : `${String(git.untrackedCount)} untracked`,
    },
    { k: 'Tags', v: String(git.tagCount) },
  ];
}

const formatCount = (value: number): string => new Intl.NumberFormat('en-US').format(value);

/**
 * A session's three facts. The model is what the session declared at
 * registration, else what its newest attributed usage record names. Tokens is
 * one grade's total when a grade reports one \u2014 never a sum across grades \u2014
 * and otherwise the vendor counters summed each on its own: output, and input
 * (fresh plus cache written), with cache reads in the detail. Context is the
 * newest request's prompt size \u2014 fresh input plus cache written plus cache
 * read \u2014 which is how large the session's context is right now; the skills
 * evidence the runtime observed for the session moves into the detail. `+`
 * marks a read that was cut at its bound.
 */
function sessionFacts(
  session: OverviewSession,
  context: { loaded: string; invoked: string },
  extras: PanelExtras,
): Array<{ k: string; v: string; detail?: string }> {
  const usage =
    extras.sessionUsage?.sessionId === session.id ? extras.sessionUsage.state : undefined;
  const word = (ready: string): string =>
    usage === undefined
      ? '\u2014'
      : usage.state === 'loading'
        ? 'loading\u2026'
        : usage.state === 'unavailable'
          ? 'unavailable'
          : usage.state === 'not-observed'
            ? 'not observed'
            : ready;
  const ready = usage?.state === 'ready' ? usage.data : undefined;
  const cut = ready?.truncated === true ? '+' : '';
  const models = ready?.models ?? [];
  // The real running model, when the transcript/rollout observed one, wins over
  // the launcher's declared `metadata.model` label — the label is only a
  // placeholder until the first run reveals what the vendor actually ran.
  const model =
    ready?.latestModel ??
    (models.length > 0 ? models.join(', ') : undefined) ??
    session.model ??
    word('not observed');

  const best = ready?.sources.find((row) => row.totalTokens !== undefined);
  const counters = ready?.counters ?? {};
  const sent = (counters.input ?? 0) + (counters.cacheCreation ?? 0);
  const counted = counters.output !== undefined || counters.input !== undefined;
  const tokens =
    best !== undefined
      ? { v: `${formatTokens(best.totalTokens ?? 0)} ${best.label}${cut}` }
      : counted
        ? {
            v: `${formatTokens(counters.output ?? 0)} out \u00b7 ${formatTokens(sent)} in${cut}`,
            detail: [
              `output ${formatCount(counters.output ?? 0)}`,
              `input ${formatCount(counters.input ?? 0)}`,
              `cache written ${formatCount(counters.cacheCreation ?? 0)}`,
              `cache read ${formatCount(counters.cacheRead ?? 0)}`,
              `over ${String(ready?.recordCount ?? 0)} records${cut}`,
            ].join(' \u00b7 '),
          }
        : { v: word(ready !== undefined && ready.recordCount > 0 ? 'no totals' : 'not observed') };

  // `loaded` already reads "N loaded"; both read "not observed" when nothing was.
  const skills =
    context.loaded === context.invoked
      ? `skills ${context.loaded}`
      : `skills ${context.loaded} \u00b7 ${context.invoked} invoked`;
  const latest = ready?.latestContext;
  const contextFact =
    latest === undefined
      ? { v: word('not observed'), detail: skills }
      : {
          v: formatTokens(latest.tokens),
          detail: `latest request sent ${formatCount(latest.tokens)} tokens \u00b7 observed ${formatClock(Date.parse(latest.observedAt))} \u00b7 ${skills}`,
        };
  return [
    { k: 'Model', v: model },
    { k: 'Tokens', ...tokens },
    { k: 'Context', ...contextFact },
  ];
}

const sessionsEmpty = (overview: Overview): string =>
  overview.sessionsState === 'unavailable' ? 'Session data unavailable' : 'No active sessions';

export function panelFor(
  overview: Overview,
  rawFocus: Focus,
  realtime: string,
  extras: PanelExtras = {},
): PanelModel {
  const focus = resolveFocus(overview, rawFocus);
  const { events, nowMs } = overview;

  if (focus.kind === 'project') {
    const project = overview.projects.find((candidate) => candidate.id === focus.id);
    if (project === undefined) return panelFor(overview, RUNTIME_FOCUS, realtime);
    const blocked = project.sessions.find((session) => session.tone === 'blocked');
    const sha =
      project.git.state === 'ready' && project.git.data.headSha !== undefined
        ? `HEAD ${abbreviateSha(project.git.data.headSha).slice(0, 7)}`
        : 'HEAD not observed';
    return {
      eyebrow: project.eyebrow,
      title: project.name,
      badge: project.badge,
      sub: `${String(project.sessions.length)} active · ${String(project.allSessions.length)} observed · ${sha}`,
      ...(blocked === undefined ? {} : { block: blockedEvidence(blocked, events, nowMs) }),
      facts: gitFacts(project),
      trend: trendOf(
        'Events · retained',
        events.filter((event) => event.projectId === project.id),
        overview,
      ),
      list: {
        label: 'Sessions',
        rows: project.allSessions.slice(0, 8),
        empty:
          overview.sessionsState === 'unavailable'
            ? 'Session data unavailable'
            : 'No sessions observed',
      },
      links: [
        { kind: 'inspect-project', label: 'Inspect', id: project.id, name: project.name },
        // The detail drawer opens over the overview; editing happens inside it (ADR 0033).
        {
          kind: 'route',
          label: 'Detail',
          href: `#/pulse/${encodeURIComponent(project.id)}/detail`,
        },
      ],
    };
  }

  if (focus.kind === 'agent') {
    const agent = overview.agents.find((candidate) => candidate.id === focus.id);
    if (agent === undefined) return panelFor(overview, RUNTIME_FOCUS, realtime);
    return {
      eyebrow: agent.known ? 'Agent' : 'Unregistered agent id',
      title: agent.name,
      badge: sessionBadge(agent.sessions),
      sub: `${String(agent.sessions.length)} active sessions across ${String(agent.projectCount)} project${agent.projectCount === 1 ? '' : 's'}`,
      facts: [
        { k: 'Models', v: agent.models.length === 0 ? '—' : agent.models.join(', ') },
        { k: 'Waiting', v: String(agent.waiting) },
        { k: 'Blocked', v: String(agent.blocked) },
      ],
      trend: trendOf(
        'Events · retained',
        events.filter((event) => event.agentId === agent.id),
        overview,
      ),
      list: { label: 'Sessions', rows: agent.sessions, empty: sessionsEmpty(overview) },
      links: [{ kind: 'route', label: 'Agents', href: '#/agents' }],
    };
  }

  if (focus.kind === 'session') {
    const session = overview.allSessions.find((candidate) => candidate.id === focus.id);
    if (session === undefined) return panelFor(overview, RUNTIME_FOCUS, realtime);
    const context =
      session.context.state === 'ready'
        ? {
            loaded: `${String(session.context.loaded)} loaded`,
            invoked: String(session.context.invoked),
          }
        : session.context.state === 'not-observed'
          ? { loaded: 'not observed', invoked: 'not observed' }
          : { loaded: 'unavailable', invoked: 'unavailable' };
    const badgeTone: Badge['tone'] =
      session.tone === 'blocked' || session.tone === 'working'
        ? 'ink'
        : session.tone === 'done'
          ? 'dim'
          : 'outline';
    return {
      eyebrow: `${session.projectName} · ${session.agentName}`,
      title: session.title ?? session.taskSummary ?? `Session ${abbreviateId(session.id)}`,
      badge: { label: session.statusLabel.toUpperCase(), tone: badgeTone },
      sub: `${session.branch ?? 'no branch reported'} · started ${formatRelativeTime(session.startedAt, nowMs)} · heartbeat ${formatRelativeTime(session.lastHeartbeatAt, nowMs)}`,
      ...(session.tone === 'blocked' ? { block: blockedEvidence(session, events, nowMs) } : {}),
      copyId: { label: 'session', id: session.id },
      facts: sessionFacts(session, context, extras),
      trend: trendOf(
        'Events · retained',
        events.filter((event) => event.sessionId === session.id),
        overview,
      ),
      list: {
        label: 'Other sessions in project',
        rows: overview.allSessions
          .filter(
            (candidate) => candidate.projectId === session.projectId && candidate.id !== session.id,
          )
          .slice(0, 8),
        empty: 'No other sessions in this project',
        selectedId: session.id,
      },
      links: [{ kind: 'inspect-session', label: 'Inspect', id: session.id }],
    };
  }

  const { health } = overview;
  const badgeTone: Badge['tone'] = health.label === 'HEALTHY' ? 'ink' : 'outline';
  return {
    eyebrow: 'Runtime',
    title: 'Luwi Runtime',
    badge: { label: health.label, tone: badgeTone },
    sub: [
      health.daemon,
      ...(health.redis === undefined ? [] : [health.redis]),
      `Realtime ${realtime}`,
    ].join(' · '),
    facts: [
      { k: 'Uptime', v: health.uptime ?? 'unavailable' },
      {
        k: 'Redis',
        v: health.latency ?? (health.redis === undefined ? 'unavailable' : 'disconnected'),
      },
      { k: 'Version', v: health.version ?? 'unavailable' },
    ],
    trend: trendOf('Events · retained', events, overview),
    list: { label: 'Active sessions', rows: overview.sessions, empty: sessionsEmpty(overview) },
    links: [{ kind: 'route', label: 'Runtime', href: '#/runtime' }],
  };
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export type Tile = { project: OverviewProject; span: 1 | 2; rows: 1 | 2 };

/**
 * Tiles sized by work: the busiest project gets the 2×2, projects with active
 * sessions 2×1, quiet projects 1×1. Blocked outranks busy so it is never small.
 */
export function planTiles(projects: readonly OverviewProject[]): Tile[] {
  const ordered = [...projects].sort(
    (left, right) =>
      Number(right.blocked) - Number(left.blocked) ||
      right.sessions.length - left.sessions.length ||
      left.name.localeCompare(right.name),
  );
  return ordered.map((project, index) => {
    if (project.sessions.length === 0) return { project, span: 1, rows: 1 };
    if (index === 0) return { project, span: 2, rows: 2 };
    return { project, span: 2, rows: 1 };
  });
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const FLOW_WIDTH = 1000;
export const FLOW_HEIGHT = 560;
const FLOW_GAP = 14;
const FLOW_UNIT_MAX = 46;
const FLOW_QUIET_UNITS = 0.6;
const FLOW_COLUMNS = {
  agents: { x: 0, w: 170 },
  projects: { x: 395, w: 210 },
  statuses: { x: 830, w: 170 },
};

export type FlowNode = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  initials: string;
  sub: string;
  count: number;
  focus: Focus;
  selected: boolean;
  dim: boolean;
  quiet: boolean;
  tone?: Tone;
  buckets?: number[];
};

export type FlowRibbon = {
  key: string;
  d: string;
  width: number;
  tone: Tone;
  dim: boolean;
  sessionId: string;
};

export type FlowLayout = {
  agents: FlowNode[];
  projects: FlowNode[];
  statuses: FlowNode[];
  ribbons: FlowRibbon[];
  unit: number;
};

function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (x1 + x2) / 2;
  const f = (value: number) => value.toFixed(1);
  return `M${f(x1)} ${f(y1)} C${f(mid)} ${f(y1)} ${f(mid)} ${f(y2)} ${f(x2)} ${f(y2)}`;
}

export function layoutFlow(overview: Overview, focus: Focus): FlowLayout {
  const anySelection = focus.kind !== 'runtime';
  const agentUnits = overview.agents.map((agent) => agent.sessions.length);
  const projectUnits = overview.projects.map((project) =>
    project.sessions.length === 0 ? FLOW_QUIET_UNITS : project.sessions.length,
  );
  const statusUnits = overview.statuses.map((status) => status.sessions.length);
  const unitFor = (units: number[]): number => {
    const total = units.reduce((sum, value) => sum + value, 0);
    if (total === 0) return FLOW_UNIT_MAX;
    return Math.min(FLOW_UNIT_MAX, (FLOW_HEIGHT - FLOW_GAP * (units.length - 1)) / total);
  };
  const unit = Math.max(
    4,
    Math.min(unitFor(agentUnits), unitFor(projectUnits), unitFor(statusUnits)),
  );

  const stack = (units: number[]): Array<{ y: number; h: number }> => {
    const total =
      units.reduce((sum, value) => sum + value * unit, 0) +
      FLOW_GAP * Math.max(0, units.length - 1);
    let y = (FLOW_HEIGHT - total) / 2;
    return units.map((value) => {
      const box = { y, h: value * unit };
      y += value * unit + FLOW_GAP;
      return box;
    });
  };
  const agentBoxes = stack(agentUnits);
  const projectBoxes = stack(projectUnits);
  const statusBoxes = stack(statusUnits);

  const related = (session: OverviewSession) => relatedToFocus(session, focus);

  const agents: FlowNode[] = overview.agents.map((agent, index) => {
    const box = agentBoxes[index] ?? { y: 0, h: unit };
    const selected = focus.kind === 'agent' && focus.id === agent.id;
    return {
      key: `agent:${agent.id}`,
      x: FLOW_COLUMNS.agents.x,
      y: box.y,
      w: FLOW_COLUMNS.agents.w,
      h: box.h,
      label: agent.name,
      initials: agent.initials,
      sub: `${String(agent.sessions.length)} session${agent.sessions.length === 1 ? '' : 's'} · ${String(agent.working)} working`,
      count: agent.sessions.length,
      focus: { kind: 'agent', id: agent.id },
      selected,
      dim: anySelection && !selected && !agent.sessions.some(related),
      quiet: false,
    };
  });

  const projects: FlowNode[] = overview.projects.map((project, index) => {
    const box = projectBoxes[index] ?? { y: 0, h: unit };
    const selected =
      (focus.kind === 'project' && focus.id === project.id) ||
      focusProject(overview, focus)?.id === project.id;
    return {
      key: `project:${project.id}`,
      x: FLOW_COLUMNS.projects.x,
      y: box.y,
      w: FLOW_COLUMNS.projects.w,
      h: box.h,
      label: project.name,
      initials: project.initials,
      sub: project.badge.label,
      count: project.sessions.length,
      focus: { kind: 'project', id: project.id },
      selected,
      dim: anySelection && !selected && !project.sessions.some(related),
      quiet: project.sessions.length === 0,
      buckets: project.buckets,
    };
  });

  const statuses: FlowNode[] = overview.statuses.map((status, index) => {
    const box = statusBoxes[index] ?? { y: 0, h: unit };
    return {
      key: `status:${status.status}`,
      x: FLOW_COLUMNS.statuses.x,
      y: box.y,
      w: FLOW_COLUMNS.statuses.w,
      h: box.h,
      label: status.label.toUpperCase(),
      initials: '',
      sub: '',
      count: status.sessions.length,
      focus: RUNTIME_FOCUS,
      selected: false,
      dim: anySelection && !status.sessions.some(related),
      quiet: false,
      tone: status.tone,
    };
  });

  const offsets = new Map<string, number>();
  const nextOffset = (key: string): number => {
    const used = offsets.get(key) ?? 0;
    offsets.set(key, used + unit);
    return used + unit / 2;
  };
  const agentIndex = new Map(overview.agents.map((agent, index) => [agent.id, index]));
  const projectIndex = new Map(overview.projects.map((project, index) => [project.id, index]));
  const statusIndex = new Map(overview.statuses.map((status, index) => [status.status, index]));
  const ribbons: FlowRibbon[] = [];
  const width = Math.max(2, unit - 8);
  for (const session of overview.sessions) {
    const agentAt = agentIndex.get(session.agentId);
    const projectAt = projectIndex.get(session.projectId);
    const statusAt = statusIndex.get(session.status);
    if (agentAt === undefined || projectAt === undefined || statusAt === undefined) continue;
    const agentBox = agentBoxes[agentAt];
    const projectBox = projectBoxes[projectAt];
    const statusBox = statusBoxes[statusAt];
    if (agentBox === undefined || projectBox === undefined || statusBox === undefined) continue;
    const dim = anySelection && !related(session);
    ribbons.push({
      key: `${session.id}:in`,
      d: bezier(
        FLOW_COLUMNS.agents.x + FLOW_COLUMNS.agents.w,
        agentBox.y + nextOffset(`agent:${session.agentId}`),
        FLOW_COLUMNS.projects.x,
        projectBox.y + nextOffset(`in:${session.projectId}`),
      ),
      width,
      tone: session.tone,
      dim,
      sessionId: session.id,
    });
    ribbons.push({
      key: `${session.id}:out`,
      d: bezier(
        FLOW_COLUMNS.projects.x + FLOW_COLUMNS.projects.w,
        projectBox.y + nextOffset(`out:${session.projectId}`),
        FLOW_COLUMNS.statuses.x,
        statusBox.y + nextOffset(`status:${session.status}`),
      ),
      width,
      tone: session.tone,
      dim,
      sessionId: session.id,
    });
  }

  return { agents, projects, statuses, ribbons, unit };
}

// ---------------------------------------------------------------------------
// Radial
// ---------------------------------------------------------------------------

export const RADIAL_SIZE = 640;
export const RADIAL_CENTRE = 320;
export const RADIAL_ORBIT = 228;
export const RADIAL_NODE = 36;
const RADIAL_DOT_RING = 29;
const RADIAL_MAX_DOTS = 6;
const RADIAL_MAX_PACKETS = 3;

export type RadialDot = { x: number; y: number; tone: Tone };

export type RadialNode = {
  key: string;
  kind: 'project' | 'session';
  label: string;
  sub: string;
  initials: string;
  x: number;
  y: number;
  angleDeg: number;
  /** Retained events against the busiest node on the orbit, 0..1. */
  share: number;
  dots: RadialDot[];
  packets: number;
  blocked: boolean;
  selected: boolean;
  below: boolean;
  focus: Focus;
};

export type RadialLayout = {
  nodes: RadialNode[];
  centre: { big: string; small: string; ink: boolean; title: string; hint: string; focus: Focus };
};

export function layoutRadial(overview: Overview, focus: Focus): RadialLayout {
  const project = focusProject(overview, focus);
  type Item = {
    key: string;
    kind: 'project' | 'session';
    label: string;
    sub: string;
    initials: string;
    events: number;
    sessions: OverviewSession[];
    selected: boolean;
    focus: Focus;
  };
  const items: Item[] =
    project === undefined
      ? overview.projects.map((candidate) => ({
          key: candidate.id,
          kind: 'project',
          label: candidate.name,
          sub: candidate.badge.label,
          initials: candidate.initials,
          events: candidate.eventCount,
          sessions: candidate.sessions,
          selected: false,
          focus: { kind: 'project', id: candidate.id },
        }))
      : project.sessions.map((session) => ({
          key: session.id,
          kind: 'session',
          label: session.agentName,
          sub: (session.branch ?? session.statusLabel).toUpperCase(),
          initials: session.initials,
          events: session.eventCount,
          sessions: [session],
          selected: focus.kind === 'session' && focus.id === session.id,
          focus: { kind: 'session', id: session.id },
        }));
  const busiest = items.reduce((high, item) => Math.max(high, item.events), 0);
  const count = items.length;
  const nodes: RadialNode[] = items.map((item, index) => {
    const angle = -Math.PI / 2 + index * ((2 * Math.PI) / Math.max(1, count));
    const x = RADIAL_CENTRE + RADIAL_ORBIT * Math.cos(angle);
    const y = RADIAL_CENTRE + RADIAL_ORBIT * Math.sin(angle);
    const shown = item.sessions.slice(0, RADIAL_MAX_DOTS);
    const dots = shown.map((session, dotIndex) => {
      const dotAngle = angle + Math.PI + (dotIndex - (shown.length - 1) / 2) * 0.55;
      return {
        x: Number((x + RADIAL_DOT_RING * Math.cos(dotAngle)).toFixed(1)),
        y: Number((y + RADIAL_DOT_RING * Math.sin(dotAngle)).toFixed(1)),
        tone: session.tone,
      };
    });
    const working = item.sessions.filter((session) => session.tone === 'working').length;
    return {
      key: item.key,
      kind: item.kind,
      label: item.label,
      sub: item.sub,
      initials: item.initials,
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      angleDeg: Number(((angle * 180) / Math.PI).toFixed(2)),
      share: busiest === 0 ? 0 : item.events / busiest,
      dots,
      packets: Math.min(RADIAL_MAX_PACKETS, working),
      blocked: item.sessions.some((session) => session.tone === 'blocked'),
      selected: item.selected,
      below: Math.sin(angle) > 0.2,
      focus: item.focus,
    };
  });
  const centre =
    project === undefined
      ? {
          big: overview.activityState === 'unavailable' ? '—' : overview.rate.label,
          small: 'EVENTS / MIN',
          ink: false,
          title: 'All projects',
          hint: 'projects · click a node to focus',
          focus: RUNTIME_FOCUS,
        }
      : {
          big: project.initials,
          small: project.badge.label,
          ink: true,
          title: project.name,
          hint: 'sessions · click the core to zoom out',
          focus: RUNTIME_FOCUS,
        };
  return { nodes, centre };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TimelineWindow = 90 | 1440 | 10080;
export const TIMELINE_WINDOWS: ReadonlyArray<{ minutes: TimelineWindow; label: string }> = [
  { minutes: 90, label: '90 min' },
  { minutes: 1440, label: '24 h' },
  { minutes: 10080, label: '7 d' },
];
export const NOW_FRACTION = 0.88;
/** The narrowest mark a session leaves: a tick, never a label. */
const TIMELINE_MIN_WIDTH = 0.006;
/**
 * Below this rendered width a bar cannot carry its label. Terminal sessions
 * this narrow fold with their neighbours into one cluster; an active session
 * never folds, because it is what the reader came to see.
 */
const TIMELINE_FOLD_WIDTH = 0.06;
const TIMELINE_GAP = 0.003;

/** Finer buckets for wider windows, so one burst is a spike and not a block. */
function timelineBuckets(minutes: TimelineWindow): number {
  return minutes >= 10080 ? 168 : minutes >= 1440 ? 96 : 30;
}

function timelineTicks(minutes: TimelineWindow): number {
  return minutes >= 10080 ? 7 : 6;
}

function formatDay(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}`;
}

export type TimelineBar = {
  kind: 'bar';
  session: OverviewSession;
  /** Fractions of the lane width. */
  x0: number;
  x1: number;
  row: number;
  duration: string;
  selected: boolean;
  dim: boolean;
};
/** Terminal sessions too narrow to label, folded into one mark with a count. */
export type TimelineCluster = {
  kind: 'cluster';
  key: string;
  sessions: OverviewSession[];
  x0: number;
  x1: number;
  row: number;
  label: string;
  title: string;
  selected: boolean;
  dim: boolean;
};
export type TimelineItem = TimelineBar | TimelineCluster;
export type TimelineMark = { key: string; x: number; row: number; title: string };
export type TimelineLane = {
  project: OverviewProject;
  items: TimelineItem[];
  marks: TimelineMark[];
  rows: number;
  dim: boolean;
  selected: boolean;
};
export type TimelineLayout = {
  lanes: TimelineLane[];
  axis: Array<{ x: number; label: string }>;
  hist: number[];
  total: number;
  rateLabel: string;
  windowLabel: string;
};

type Span = { session: OverviewSession; x0: number; x1: number; startMs: number; endMs: number };

function clusterLabel(sessions: readonly OverviewSession[]): { label: string; summary: string } {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    counts.set(session.initials, (counts.get(session.initials) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([initials, count]) => `${initials} \u00d7${String(count)}`);
  return {
    label: counts.size === 1 ? (parts[0] ?? '') : `\u00d7${String(sessions.length)}`,
    summary: `${String(sessions.length)} sessions \u00b7 ${parts.join(' \u00b7 ')}`,
  };
}

export function layoutTimeline(
  overview: Overview,
  minutes: TimelineWindow,
  focus: Focus,
): TimelineLayout {
  const { nowMs, events } = overview;
  const windowMs = minutes * 60_000;
  const startMs = nowMs - windowMs;
  const xOf = (ms: number): number =>
    Math.max(0, Math.min(NOW_FRACTION, NOW_FRACTION * (1 - (nowMs - ms) / windowMs)));
  const focusedProject = focusProject(overview, focus);
  const focusedSession = focus.kind === 'session' ? focus.id : undefined;

  const inWindow = events.filter((event) => {
    const at = parseMs(event.occurredAt);
    return at !== undefined && at >= startMs && at <= nowMs;
  });
  const denials = inWindow.filter(
    (event) => event.type === 'lease.denied' && event.sessionId !== undefined,
  );

  const lanes: TimelineLane[] = overview.projects.map((project) => {
    const dimFor = (ids: readonly string[]): boolean =>
      focusedSession !== undefined &&
      !ids.includes(focusedSession) &&
      focusedProject?.id !== project.id;
    const spans: Span[] = project.allSessions
      .flatMap((session): Span[] => {
        if (session.startedMs === undefined) return [];
        const endMs = session.active ? nowMs : (session.heartbeatMs ?? session.startedMs);
        if (endMs < startMs || session.startedMs > nowMs) return [];
        const left = xOf(Math.max(session.startedMs, startMs));
        const right = session.active ? NOW_FRACTION : xOf(endMs);
        // A tick at least, and the tick stays inside the window: a session at
        // the edge grows leftwards rather than past NOW.
        const width = Math.max(TIMELINE_MIN_WIDTH, right - left);
        const x1 = Math.min(NOW_FRACTION, Math.max(right, left + width));
        return [{ session, x0: x1 - width, x1, startMs: session.startedMs, endMs }];
      })
      .sort((left, right) => left.x0 - right.x0 || left.x1 - right.x1);

    const bar = (span: Span): TimelineBar => ({
      kind: 'bar',
      session: span.session,
      x0: span.x0,
      x1: span.x1,
      row: 0,
      duration: formatDuration(span.endMs - span.startMs),
      selected: focusedSession === span.session.id,
      dim: dimFor([span.session.id]),
    });
    const items: TimelineItem[] = [];
    let open: { members: Span[]; x0: number; x1: number } | undefined;
    const flush = () => {
      if (open === undefined) return;
      const [only] = open.members;
      if (only !== undefined && open.members.length === 1) {
        items.push(bar(only));
      } else {
        const sessions = open.members.map((member) => member.session);
        const ids = sessions.map((session) => session.id);
        const { label, summary } = clusterLabel(sessions);
        const from = Math.min(...open.members.map((member) => member.startMs));
        const to = Math.max(...open.members.map((member) => member.endMs));
        items.push({
          kind: 'cluster',
          key: `cluster:${ids[0] ?? ''}:${String(ids.length)}`,
          sessions,
          x0: open.x0,
          x1: open.x1,
          row: 0,
          label,
          title: `${summary} \u00b7 ${formatHourMinute(from)}\u2013${formatHourMinute(to)}`,
          selected: focusedSession !== undefined && ids.includes(focusedSession),
          dim: dimFor(ids),
        });
      }
      open = undefined;
    };
    for (const span of spans) {
      const wide = span.x1 - span.x0 >= TIMELINE_FOLD_WIDTH;
      if (wide || span.session.active) {
        items.push(bar(span));
        continue;
      }
      if (open !== undefined && span.x0 <= open.x1 + TIMELINE_GAP) {
        open.members.push(span);
        open.x1 = Math.max(open.x1, span.x1);
      } else {
        flush();
        open = { members: [span], x0: span.x0, x1: span.x1 };
      }
    }
    flush();

    // Rows are packed by what is drawn, not by the clock: two ticks that only
    // touch on screen still get their own rows, so nothing overlaps.
    items.sort((left, right) => left.x0 - right.x0 || left.x1 - right.x1);
    const rows: Array<Array<{ x0: number; x1: number }>> = [];
    for (const item of items) {
      let row = rows.findIndex((occupied) =>
        occupied.every(
          (other) => other.x1 + TIMELINE_GAP <= item.x0 || other.x0 >= item.x1 + TIMELINE_GAP,
        ),
      );
      if (row < 0) {
        rows.push([]);
        row = rows.length - 1;
      }
      rows[row]?.push({ x0: item.x0, x1: item.x1 });
      item.row = row;
    }

    const marks: TimelineMark[] = denials.flatMap((event) => {
      const at = parseMs(event.occurredAt);
      const item = items.find((candidate) =>
        candidate.kind === 'bar'
          ? candidate.session.id === event.sessionId
          : candidate.sessions.some((session) => session.id === event.sessionId),
      );
      if (item === undefined || at === undefined) return [];
      return [
        {
          key: event.streamId,
          x: xOf(at),
          row: item.row,
          title: `lease.denied ${eventDetail(event)}`.trim(),
        },
      ];
    });
    const selected = focusedProject?.id === project.id;
    return {
      project,
      items,
      marks,
      rows: Math.max(1, rows.length),
      dim: focusedProject !== undefined && !selected,
      selected,
    };
  });

  const ticks = timelineTicks(minutes);
  const axis = Array.from({ length: ticks + 1 }, (_, index) => {
    const ms = startMs + (windowMs * index) / ticks;
    return { x: xOf(ms), label: minutes >= 10080 ? formatDay(ms) : formatHourMinute(ms) };
  }).filter((tick) => tick.x > 0.01);

  const window = bucketRetainedWindow(inWindow, timelineBuckets(minutes), {
    firstMs: startMs,
    lastMs: nowMs,
  });
  const perMinute = window.total / minutes;
  const windowLabel =
    TIMELINE_WINDOWS.find((entry) => entry.minutes === minutes)?.label ?? `${String(minutes)} min`;
  return {
    lanes,
    axis,
    hist: window.buckets,
    total: window.total,
    rateLabel:
      window.total === 0
        ? '\u2014'
        : perMinute >= 10
          ? String(Math.round(perMinute))
          : perMinute.toFixed(1),
    windowLabel,
  };
}
