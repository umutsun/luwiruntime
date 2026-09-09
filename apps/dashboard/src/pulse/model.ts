import type { DashboardEvent } from '../realtime/schema.js';
import type {
  BridgeSlot,
  RetainedWakeCollection,
  WakeIntent,
  Workflow,
} from '../api/wake-scope.js';

export type Availability<T> = { state: 'ready'; data: T } | { state: 'unavailable' };
export type ObservedBoolean = boolean | 'unknown';

export type PulseProject = {
  id: string;
  name: string;
  localPath: string;
  repositoryUrl?: string;
  defaultBranch?: string;
};
export type PulseSession = {
  id: string;
  agentId: string;
  projectId: string;
  status: string;
  presence: 'online' | 'offline';
  startedAt: string;
  lastHeartbeatAt: string;
  branch?: string;
  /** Reported by the session about itself; absent when it reported none. */
  taskSummary?: string;
  /** Free-form, as registered (e.g. `{ model }`); optional so older reads still type. */
  metadata?: Record<string, unknown>;
};
export type PulseUsageSource = {
  source: 'agent-exact' | 'agent-reported' | 'adapter-extracted' | 'luwi-estimated' | 'unavailable';
  recordCount: number;
  totalTokens?: number;
};
export type PulseContextContribution = {
  /**
   * Optional in the protocol, and therefore optional here. A contribution that
   * names no session belongs to no session — it is never attributed to one.
   */
  sessionId?: string;
  assigned: ObservedBoolean;
  effective: ObservedBoolean;
  loaded: ObservedBoolean;
  invoked: ObservedBoolean;
};

/**
 * `kind` and `adapterId` are rendered verbatim as data. The dashboard never
 * maps them to per-vendor labels or behaviour: `product-independence.test.ts`
 * forbids vendor names in production source precisely so that no agent can be
 * privileged by the code that displays it.
 */
export type PulseAgent = {
  id: string;
  kind: string;
  displayName: string;
  adapterId: string;
  enabled: boolean;
  detectedVersion?: string;
  updatedAt: string;
};

export type PulseFinding = {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  summary: string;
  state: 'open' | 'dismissed' | 'proposed' | 'resolved';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  sessionCount: number;
  observationCount: number;
  updatedAt: string;
};

export type PulseHealth = {
  status: 'ok' | 'degraded';
  runtimeState: string;
  uptimeMs: number;
  redis:
    | { connected: true; status: 'connected'; latencyMs: number }
    | { connected: false; status: 'disconnected' };
};

/**
 * One project's Git facts, as the daemon's read-only observation reported
 * them. Only stated facts — the mockup's `Release Readiness` judgement was
 * replaced by exactly this list (see the redesign plan's honest replacements).
 */
export type PulseGitFacts = {
  branch?: string;
  headSha?: string;
  clean: boolean;
  untrackedCount: number;
  tagCount: number;
  observedAt: string;
};

/**
 * `not-observed` is a complete answer: no scan was ever recorded. It must not
 * be folded into `unavailable`, which claims a fault.
 */
export type PulseGitEntry = {
  projectId: string;
  git:
    { state: 'ready'; data: PulseGitFacts } | { state: 'not-observed' } | { state: 'unavailable' };
};

export type PulseGitResource = { truncated: boolean; entries: PulseGitEntry[] };

export type PulseRuntimeInfo = {
  workspaceId: string;
  version: string;
  protocolVersion: number;
  runtimeState: string;
  runtimeInstanceId: string;
  startedAt: string;
  uptimeMs: number;
  host: string;
  port: number;
};

export type PulseResources = {
  health: Availability<PulseHealth>;
  projects: Availability<PulseProject[]>;
  sessions: Availability<PulseSession[]>;
  agents: Availability<PulseAgent[]>;
  usage: Availability<PulseUsageSource[]>;
  context: Availability<PulseContextContribution[]>;
  activity: Availability<DashboardEvent[]>;
  findings: Availability<PulseFinding[]>;
  runtime: Availability<PulseRuntimeInfo>;
  git: Availability<PulseGitResource>;
  bridgeSlots: Availability<RetainedWakeCollection<BridgeSlot>>;
  wakeIntents: Availability<RetainedWakeCollection<WakeIntent>>;
  workflows: Availability<RetainedWakeCollection<Workflow>>;
};

export type PulseInput = Omit<
  PulseResources,
  'runtime' | 'git' | 'bridgeSlots' | 'wakeIntents' | 'workflows'
> & {
  measuredLatencyMs: number;
  snapshotAt: string;
  /**
   * Optional because most unit tests build an input without the two newest
   * reads; the real loader always supplies them. An absent key means "not
   * requested" and does not mark the snapshot partial — an explicit
   * `unavailable` still does.
   */
  runtime?: Availability<PulseRuntimeInfo>;
  git?: Availability<PulseGitResource>;
  bridgeSlots?: Availability<RetainedWakeCollection<BridgeSlot>>;
  wakeIntents?: Availability<RetainedWakeCollection<WakeIntent>>;
  workflows?: Availability<RetainedWakeCollection<Workflow>>;
};

/**
 * A count that knows whether it was actually observed.
 *
 * A failed read must never surface as `0`. Every count derived from a resource
 * that can fail carries this instead of a bare number, so the view is forced to
 * decide what to render rather than silently printing a zero the runtime never
 * measured.
 */
export type CountValue = { state: 'ready' | 'empty'; value: number } | { state: 'unavailable' };

/** A bounded collection can prove positives, but cannot prove a global zero. */
export type ObservedCount =
  | { state: 'exact'; value: number }
  | { state: 'lower-bound'; value: number }
  | { state: 'unknown' }
  | { state: 'unavailable' };

export type OldestPendingWake =
  | { state: 'exact' | 'lower-bound'; ageMs: number; createdAt: string }
  | { state: 'none' }
  | { state: 'unknown' }
  | { state: 'unavailable' };

export type BridgeSlotHealth = 'active' | 'standby' | 'degraded' | 'stale';

export type SessionBridgeEvidence =
  | {
      state: 'observed';
      provider: BridgeSlot['provider'];
      executionProfile: BridgeSlot['executionProfile'];
      health: BridgeSlotHealth;
      expiresAt: string;
    }
  | { state: 'not-observed' }
  | { state: 'unknown' }
  | { state: 'unavailable' };

const usageOrder = [
  'agent-exact',
  'agent-reported',
  'adapter-extracted',
  'luwi-estimated',
  'unavailable',
] as const;

const usageLabels: Record<(typeof usageOrder)[number], string> = {
  'agent-exact': 'Exact',
  'agent-reported': 'Reported',
  'adapter-extracted': 'Extracted',
  'luwi-estimated': 'Estimated',
  unavailable: 'Unavailable',
};

/**
 * The nine observed session statuses, in the order a breakdown reads them.
 *
 * Ordered rather than a bare set because the Active Work header states the
 * whole vocabulary in this sequence. There is deliberately no "running" entry:
 * it is not a status the runtime records, and folding `thinking` and
 * `tool_running` into one would manufacture it.
 */
const sessionStatusOrder = [
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

const knownSessionStatuses = new Set<string>(sessionStatusOrder);

const waitingStatuses = new Set(['waiting_for_input', 'waiting_for_agent']);

export function labelSessionStatus(status: string): string {
  if (!knownSessionStatuses.has(status)) return 'Unknown';
  return status.replaceAll('_', ' ');
}

/** One entry per status actually present, so an absent status states nothing. */
export type SessionStatusCount = { status: string; label: string; count: number };

function countOf<T>(resource: Availability<T[]>): CountValue {
  if (resource.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: resource.data.length === 0 ? 'empty' : 'ready',
    value: resource.data.length,
  };
}

function observedCount<T>(
  resource: Availability<RetainedWakeCollection<T>>,
  predicate: (item: T) => boolean,
): ObservedCount {
  if (resource.state === 'unavailable') return { state: 'unavailable' };
  const value = resource.data.items.filter(predicate).length;
  if (!resource.data.truncated) return { state: 'exact', value };
  return value === 0 ? { state: 'unknown' } : { state: 'lower-bound', value };
}

function bridgeSlotHealth(slot: BridgeSlot, snapshotAtMs: number): BridgeSlotHealth {
  if (slot.state === 'expired' || Date.parse(slot.expiresAt) <= snapshotAtMs) return 'stale';
  return slot.state;
}

/**
 * The context evidence one session reported.
 *
 * `not-observed` is not `0`: it means the contributions read succeeded and no
 * contribution named this session, which is a different fact from a count of
 * zero loaded sources and a different fact again from a failed read.
 */
export type SessionContextEvidence =
  | { state: 'ready'; assigned: number; loaded: number; invoked: number }
  | { state: 'not-observed' }
  | { state: 'unavailable' };

export function buildPulseSnapshot(input: PulseInput) {
  const bridgeSlots = input.bridgeSlots ?? { state: 'unavailable' as const };
  const snapshotAtMs = Date.parse(input.snapshotAt);
  const sessionBridge = (sessionId: string): SessionBridgeEvidence => {
    if (bridgeSlots.state === 'unavailable') return { state: 'unavailable' };
    const slot = bridgeSlots.data.items.find((candidate) => candidate.sessionId === sessionId);
    if (slot === undefined) {
      return bridgeSlots.data.truncated ? { state: 'unknown' } : { state: 'not-observed' };
    }
    return {
      state: 'observed',
      provider: slot.provider,
      executionProfile: slot.executionProfile,
      health: bridgeSlotHealth(slot, snapshotAtMs),
      expiresAt: slot.expiresAt,
    };
  };
  const projectById = new Map(
    input.projects.state === 'ready'
      ? input.projects.data.map((project) => [project.id, project] as const)
      : [],
  );
  const agentById = new Map(
    input.agents.state === 'ready'
      ? input.agents.data.map((agent) => [agent.id, agent] as const)
      : [],
  );
  const contributionsBySession = new Map<string, PulseContextContribution[]>();
  if (input.context.state === 'ready') {
    for (const contribution of input.context.data) {
      if (contribution.sessionId === undefined) continue;
      const bucket = contributionsBySession.get(contribution.sessionId);
      if (bucket === undefined) contributionsBySession.set(contribution.sessionId, [contribution]);
      else bucket.push(contribution);
    }
  }
  const sessionContext = (sessionId: string): SessionContextEvidence => {
    if (input.context.state === 'unavailable') return { state: 'unavailable' };
    const rows = contributionsBySession.get(sessionId);
    if (rows === undefined) return { state: 'not-observed' };
    return {
      state: 'ready',
      assigned: rows.filter((row) => row.assigned === true).length,
      loaded: rows.filter((row) => row.loaded === true).length,
      invoked: rows.filter((row) => row.invoked === true).length,
    };
  };
  const sessions =
    input.sessions.state === 'ready'
      ? input.sessions.data.map((session) => {
          const definition = agentById.get(session.agentId);
          return {
            ...session,
            projectName: projectById.get(session.projectId)?.name ?? 'Unavailable',
            statusLabel: labelSessionStatus(session.status),
            /*
             * The raw id is the fallback, and the view is told which it got.
             * An opaque agent id must never be presented as though a definition
             * stood behind it — including when the agent read itself failed,
             * which is why this asks the map rather than the read's state.
             */
            agentName: definition?.displayName ?? session.agentId,
            agentKnown: definition !== undefined,
            context: sessionContext(session.id),
            bridge: sessionBridge(session.id),
          };
        })
      : [];
  const activeSessions =
    input.sessions.state === 'ready'
      ? sessions.filter(
          (session) =>
            session.presence === 'online' &&
            session.status !== 'completed' &&
            session.status !== 'disconnected',
        )
      : [];

  const activeSessionCount: CountValue =
    input.sessions.state === 'unavailable'
      ? { state: 'unavailable' }
      : {
          state: activeSessions.length === 0 ? 'empty' : 'ready',
          value: activeSessions.length,
        };

  const perAgentSessionCount = (agentId: string): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = sessions.filter((session) => session.agentId === agentId).length;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  /*
   * A model is a session's statement about itself (`metadata.model`, reported
   * at registration), never a definition's property. Listed per agent as the
   * distinct values its sessions reported; none reported is an empty list, and
   * the row's session count already says when the read was unavailable.
   */
  const modelsOf = (rows: PulseSession[]): string[] =>
    [
      ...new Set(
        rows.flatMap((session) => {
          const model = session.metadata?.['model'];
          return typeof model === 'string' ? [model] : [];
        }),
      ),
    ].sort();
  const perAgentModels = (agentId: string): string[] =>
    modelsOf(sessions.filter((session) => session.agentId === agentId));
  /*
   * Agent ids that sessions carry but no definition covers — a session attached
   * by a launcher hook names its vendor, not a registered definition. Listed
   * rather than folded into a definition, because the definition is what would
   * be invented. Only when both reads succeeded: an unavailable side would make
   * every id look unregistered.
   */
  const definedAgents = input.agents.state === 'ready' ? input.agents.data : undefined;
  const unregisteredAgents =
    definedAgents !== undefined && input.sessions.state === 'ready'
      ? [...new Set(sessions.map((session) => session.agentId))]
          .filter((id) => !definedAgents.some((agent) => agent.id === id))
          .sort()
          .map((id) => {
            const rows = sessions.filter((session) => session.agentId === id);
            return { id, sessionCount: rows.length, models: modelsOf(rows) };
          })
      : [];
  const perProjectActiveSessions = (projectId: string): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = activeSessions.filter((session) => session.projectId === projectId).length;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  /*
   * Distinct agents holding an active session here — not the project's agent
   * bindings, which are a separately scoped read the Pulse batch does not make.
   * The two are different claims and the view labels this one as what it is.
   */
  const perProjectActiveAgents = (projectId: string): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = new Set(
      activeSessions
        .filter((session) => session.projectId === projectId)
        .map((session) => session.agentId),
    ).size;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  const projects =
    input.projects.state === 'ready'
      ? input.projects.data.map((project) => ({
          ...project,
          activeSessions: perProjectActiveSessions(project.id),
          activeAgents: perProjectActiveAgents(project.id),
        }))
      : [];

  const countActive = (matches: (status: string) => boolean): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = activeSessions.filter((session) => matches(session.status)).length;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  const statusBreakdown: SessionStatusCount[] = [];
  for (const status of sessionStatusOrder) {
    const count = activeSessions.filter((session) => session.status === status).length;
    if (count > 0) statusBreakdown.push({ status, label: labelSessionStatus(status), count });
  }
  const unknownStatusCount = activeSessions.filter(
    (session) => !knownSessionStatuses.has(session.status),
  ).length;
  if (unknownStatusCount > 0) {
    statusBreakdown.push({ status: 'unknown', label: 'Unknown', count: unknownStatusCount });
  }

  const usageSources = input.usage.state === 'ready' ? input.usage.data : [];
  const usage =
    input.usage.state === 'ready'
      ? usageOrder.flatMap((source) => {
          const row = usageSources.find((candidate) => candidate.source === source);
          return row === undefined
            ? []
            : [
                {
                  source: row.source,
                  label: usageLabels[source],
                  records: row.recordCount,
                  totalTokens: row.totalTokens,
                },
              ];
        })
      : [];

  const gitResource = input.git ?? { state: 'unavailable' as const };
  const gitEntryByProject = new Map(
    gitResource.state === 'ready'
      ? gitResource.data.entries.map((entry) => [entry.projectId, entry.git] as const)
      : [],
  );
  /*
   * One row per registered project, joined to whatever the per-project Git
   * read returned. A project past the fan-out cap has no entry and is shown
   * as unavailable — with the truncation disclosed — never silently dropped.
   */
  const repositoryFacts = (input.projects.state === 'ready' ? input.projects.data : []).map(
    (project) => ({
      projectId: project.id,
      name: project.name,
      git: gitEntryByProject.get(project.id) ?? { state: 'unavailable' as const },
    }),
  );

  const contributions = input.context.state === 'ready' ? input.context.data : [];
  /*
   * The comp's two insight sentences, kept honest: a pair is counted only when
   * both sides are observed booleans. `unknown` is never counted as unused —
   * that is the ADR 0010 rule the Context route already renders.
   */
  const contextInsights = {
    assignedNeverLoaded: contributions.filter(
      (item) => item.assigned === true && item.loaded === false,
    ).length,
    loadedNotInvoked: contributions.filter((item) => item.loaded === true && item.invoked === false)
      .length,
  };
  const context = {
    assigned: contributions.filter((item) => item.assigned === true).length,
    effective: contributions.filter((item) => item.effective === true).length,
    loaded: contributions.filter((item) => item.loaded === true).length,
    invoked: contributions.filter((item) => item.invoked === true).length,
    unknown: contributions.filter((item) =>
      [item.assigned, item.effective, item.loaded, item.invoked].includes('unknown'),
    ).length,
  };

  const hasWakeDelivery =
    input.bridgeSlots !== undefined ||
    input.wakeIntents !== undefined ||
    input.workflows !== undefined;
  const wakeIntents = input.wakeIntents ?? { state: 'unavailable' as const };
  const workflows = input.workflows ?? { state: 'unavailable' as const };
  const countSlotHealth = (health: BridgeSlotHealth): ObservedCount =>
    observedCount(bridgeSlots, (slot) => bridgeSlotHealth(slot, snapshotAtMs) === health);
  const activeSlots = countSlotHealth('active');
  const pendingWakes =
    wakeIntents.state === 'ready'
      ? wakeIntents.data.items.filter((intent) => intent.state === 'pending')
      : [];
  const oldestObservedPending = pendingWakes.reduce<WakeIntent | undefined>((oldest, intent) => {
    if (oldest === undefined) return intent;
    return Date.parse(intent.createdAt) < Date.parse(oldest.createdAt) ? intent : oldest;
  }, undefined);
  const oldestPendingWake: OldestPendingWake =
    wakeIntents.state === 'unavailable'
      ? { state: 'unavailable' }
      : oldestObservedPending === undefined
        ? wakeIntents.data.truncated
          ? { state: 'unknown' }
          : { state: 'none' }
        : {
            state: wakeIntents.data.truncated ? 'lower-bound' : 'exact',
            ageMs: Math.max(0, snapshotAtMs - Date.parse(oldestObservedPending.createdAt)),
            createdAt: oldestObservedPending.createdAt,
          };
  const supervisorOwnership =
    bridgeSlots.state === 'unavailable' || activeSlots.state === 'unavailable'
      ? ('unavailable' as const)
      : activeSlots.state === 'unknown'
        ? ('unknown' as const)
        : activeSlots.state === 'exact' && activeSlots.value === 0
          ? ('not-observed' as const)
          : ('observed' as const);
  const wakeDelivery = hasWakeDelivery
    ? {
        supervisorReachability: 'unknown' as const,
        supervisorOwnership,
        slotCounts: {
          active: activeSlots,
          standby: countSlotHealth('standby'),
          degraded: countSlotHealth('degraded'),
          stale: countSlotHealth('stale'),
        },
        indeterminateWakes: observedCount(
          wakeIntents,
          (intent) => intent.state === 'indeterminate',
        ),
        activeWorkflows: observedCount(workflows, (workflow) => workflow.state === 'active'),
        oldestPendingWake,
        bridgeSlots,
        wakeIntents,
        workflows,
      }
    : undefined;

  return {
    snapshotAt: input.snapshotAt,
    measuredLatencyMs: input.measuredLatencyMs,
    health: input.health,
    projectCount: countOf(input.projects),
    activeSessionCount,
    statusBreakdown,
    waitingCount: countActive((status) => waitingStatuses.has(status)),
    blockedCount: countActive((status) => status === 'blocked'),
    agentCount: countOf(input.agents),
    agents:
      input.agents.state === 'ready'
        ? input.agents.data.map((agent) => ({
            ...agent,
            sessionCount: perAgentSessionCount(agent.id),
            models: perAgentModels(agent.id),
          }))
        : [],
    agentsState: input.agents.state,
    unregisteredAgents,
    sessions,
    activeSessions,
    projects,
    usage,
    usageState: input.usage.state,
    context,
    contextInsights,
    contextState: input.context.state,
    runtime: input.runtime ?? { state: 'unavailable' as const },
    repositoryFacts,
    gitState: gitResource.state,
    gitTruncated: gitResource.state === 'ready' ? gitResource.data.truncated : false,
    activityState: input.activity.state,
    activity: input.activity.state === 'ready' ? input.activity.data : [],
    findingCount: countOf(input.findings),
    findings: input.findings.state === 'ready' ? input.findings.data : [],
    findingsState: input.findings.state,
    sessionsState: input.sessions.state,
    wakeDelivery,
    partial: [
      input.health,
      input.projects,
      input.sessions,
      input.agents,
      input.usage,
      input.context,
      input.activity,
      input.findings,
      // Absent means "not requested" (unit-test inputs); only an explicit
      // failure marks the snapshot partial.
      ...(input.runtime === undefined ? [] : [input.runtime]),
      ...(input.git === undefined ? [] : [input.git]),
      ...(input.bridgeSlots === undefined ? [] : [input.bridgeSlots]),
      ...(input.wakeIntents === undefined ? [] : [input.wakeIntents]),
      ...(input.workflows === undefined ? [] : [input.workflows]),
    ].some((resource) => resource.state === 'unavailable'),
  };
}

export type PulseSnapshot = ReturnType<typeof buildPulseSnapshot>;

/**
 * The mockup's scope switcher, applied client-side.
 *
 * Narrows the snapshot to one project: rows that carry a `projectId` are
 * filtered, and every count over them is recomputed so the strip and the
 * Active Work header describe the scope, not the runtime. Two rules keep it
 * honest: a failed read stays failed — a scope never turns `unavailable` into
 * an empty list — and an event without a `projectId` is not attributable to
 * the scoped project, so a scoped view may not claim it. Reads that have no
 * per-project shape (usage grades, the context counts, findings) pass through
 * globally; their panels state runtime-wide evidence either way.
 */
export function scopePulseSnapshot(
  snapshot: PulseSnapshot,
  projectId: string | undefined,
): PulseSnapshot {
  if (projectId === undefined) return snapshot;

  const sessions = snapshot.sessions.filter((session) => session.projectId === projectId);
  const activeSessions = snapshot.activeSessions.filter(
    (session) => session.projectId === projectId,
  );
  const projects = snapshot.projects.filter((project) => project.id === projectId);
  const repositoryFacts = snapshot.repositoryFacts.filter((row) => row.projectId === projectId);
  const activity = snapshot.activity.filter((event) => event.projectId === projectId);

  const recount = (source: CountValue, value: number): CountValue =>
    source.state === 'unavailable'
      ? { state: 'unavailable' }
      : { state: value === 0 ? 'empty' : 'ready', value };

  const statusBreakdown: SessionStatusCount[] = [];
  for (const entry of snapshot.statusBreakdown) {
    const count = activeSessions.filter(
      (session) =>
        session.status === entry.status ||
        (entry.status === 'unknown' && labelSessionStatus(session.status) === 'Unknown'),
    ).length;
    if (count > 0) statusBreakdown.push({ ...entry, count });
  }

  return {
    ...snapshot,
    sessions,
    activeSessions,
    projects,
    repositoryFacts,
    activity,
    statusBreakdown,
    projectCount: recount(snapshot.projectCount, projects.length),
    activeSessionCount: recount(snapshot.activeSessionCount, activeSessions.length),
    waitingCount: recount(
      snapshot.waitingCount,
      activeSessions.filter((session) => session.status.startsWith('waiting')).length,
    ),
    blockedCount: recount(
      snapshot.blockedCount,
      activeSessions.filter((session) => session.status === 'blocked').length,
    ),
  };
}
